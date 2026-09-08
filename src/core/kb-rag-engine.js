import { db, DEXIE_MIN_KEY, DEXIE_MAX_KEY } from "./db.js";
import { eventBus } from "./event-bus.js";
import { workerBridge } from "../workers/worker-bridge.js";
import { apiClient } from "./api-client.js";
import { normalizeVector } from "../utils/vector-math.js";
import { EVENTS } from '../core/events.js';
import { EMBEDDING_BATCH_SIZE } from "./rag-constants.js";
import { keyRotator } from "./key-rotator.js";
import { getProviderFormat } from "../utils/api-utils.js";

// RAG Engine for Knowledge Base
class KbRagEngine {
  constructor() {
    this.tokenBudget = 10000;
    this.chunkTargetTokens = 512;
    this.overlapRatio = 0.2;

    this.penaltyFactor = 0.0; // No time decay for KB
    this.similarityThreshold = 0.2;

    this.currentSessionId = null;
    this.oramaDimension = 768;
    this._writeLock = Promise.resolve();
    
    this._initPromiseSession = null;
    this._initPromise = null;

    eventBus.on(EVENTS.SESSION_LOADED, this.handleSessionLoaded.bind(this));
    eventBus.on(EVENTS.TURN_COMPLETED, () => {
      if (this.currentSessionId) {
        this.processBackgroundEmbeddings(this.currentSessionId).catch(console.error);
      }
    });
    eventBus.on(EVENTS.SETTINGS_CHANGED, (data) => {
      if (data.key === "all" || data.key === "memory") {
        this.loadSettings();
      }
      if (data.key === "all" || data.key === "providers" || (data.key === "experts" && data.expertId === "EMBED_PRIMARY")) {
        if (this.currentSessionId) {
          this.sanityCheckKB(this.currentSessionId);
          this.checkModelMismatch(this.currentSessionId).catch(console.error);
        }
      }
    });
    eventBus.on(EVENTS.RAG_KB_TRIGGER_REBUILD, (data) => {
      this.rebuildEmbeddings(data.sessionId);
    });
    eventBus.on(EVENTS.WORKER_RESTARTED, async () => {
      if (this.currentSessionId) {
        this._initPromiseSession = null;
        this._initPromise = null;
        try {
          await db.kb_orama_snapshots.where("sessionId").equals(this.currentSessionId).delete();
        } catch (e) {
          console.error("[KbRagEngine] Failed to delete snapshot on worker restart:", e);
        }
        this.initOramaIndex(this.currentSessionId).catch(console.error);
      }
    });

    eventBus.on(EVENTS.ORAMA_SYNC_KB_SNAPSHOT, async (data) => {
      const snapSessionId = data.sessionId;
      const buffer = data.buffer;
      if (snapSessionId && buffer) {
        try {
          await db.kb_orama_snapshots.put({
            sessionId: snapSessionId,
            buffer: buffer,
            updatedAt: Date.now()
          });
        } catch (e) {
          console.error("Failed to commit KB Orama snapshot", e);
        }
      }
    });
  }

  async _acquireWriteLock(operationFn) {
    const prevLock = this._writeLock || Promise.resolve();
    let resolveLock;
    this._writeLock = new Promise(resolve => resolveLock = resolve);
    
    try {
      await prevLock;
      return await operationFn();
    } finally {
      resolveLock();
    }
  }

  async handleSessionLoaded(sessionContext) {
    const sessionId = sessionContext.session.id;
    await this.loadSettings();
    try {
      await this.checkModelMismatch(sessionId);
    } catch (err) {
      console.error("[KbRagEngine] Error in checkModelMismatch:", err);
    }
    try {
      await this.initOramaIndex(sessionId);
    } catch (err) {
      if (err.message && err.message.includes("DIMENSION_MISMATCH")) {
        console.warn("[KbRagEngine] Dimension mismatch during initialization. Triggering rebuild...");
        this.rebuildEmbeddings(sessionId);
      } else {
        console.error("[KbRagEngine] Failed to init Orama index:", err);
      }
    }
    await this.sanityCheckKB(sessionId);
  }

  async loadSettings() {
    try {
      const memorySettings = await db.settings.get("memory");
      if (memorySettings) {
        if (memorySettings.ragKbTokenBudget !== undefined) {
          this.tokenBudget = memorySettings.ragKbTokenBudget;
        }
      }
    } catch (e) {
      console.warn("[KbRagEngine] Failed to load RAG settings, using defaults", e);
    }
  }

  async _getExpertWorkerConfig(expert) {
    let baseUrl = "";
    let format = "";
    if (expert.providerId) {
      const provider = await db.providers.get(expert.providerId);
      if (provider) {
        baseUrl = provider.baseUrl;
        format = getProviderFormat(provider);
      }
    }

    let apiKey = "";
    try {
      apiKey = await keyRotator.getNextKey(expert.providerId);
    } catch (e) {
      console.warn('[KbRagEngine] KeyRotator failed:', e.message);
      throw e;
    }

    return { 
      model: expert.modelName, 
      baseUrl, 
      format,
      apiKey,
      taskType: expert.taskType,
      outputDimensionality: 768
    };
  }

  async initOramaIndex(sessionId) {
    if (this._initPromiseSession === sessionId && this._initPromise) {
      return this._initPromise;
    }
    
    this._initPromiseSession = sessionId;
    this._initPromise = this._doInitOramaIndex(sessionId).catch(err => {
      this._initPromise = null;
      throw err;
    });
    
    return this._initPromise;
  }

  async _ensureInit(sessionId) {
    if (this._initPromiseSession !== sessionId || !this._initPromise) {
      return this.initOramaIndex(sessionId);
    }
    return this._initPromise;
  }

  async _doInitOramaIndex(sessionId) {
    console.log("[KbRagEngine] Initializing Orama Vector Index for session:", sessionId);
    this.currentSessionId = sessionId;

    const expert = await db.experts.get("EMBED_PRIMARY");
    let dimension = 768; 
    
    if (expert) {
        const safeModelName = typeof expert.modelName === "string" ? expert.modelName : "";
        const matchingDoc = await db.kb_embeddings
          .where("sessionId")
          .equals(sessionId)
          .filter(doc => doc.vector && doc.vector.length > 0)
          .first();
          
        if (matchingDoc && matchingDoc.vector) {
          dimension = matchingDoc.vector.length;
        }
    }
    this.oramaDimension = dimension;

    const snapshotRecord = await db.kb_orama_snapshots.get(sessionId);
    let snapshotBuffer = null;
    let docs = [];
    let expectedCount = null;

    if (snapshotRecord && snapshotRecord.buffer) {
      console.log("[KbRagEngine] Found Orama snapshot, attempting to load directly from memory buffer...");
      snapshotBuffer = snapshotRecord.buffer;
      expectedCount = await db.kb_embeddings
        .where("sessionId")
        .equals(sessionId)
        .filter(doc => doc.vector && doc.vector.length > 0)
        .count();
    }

    if (!snapshotBuffer) {
      console.log("[KbRagEngine] No snapshot found. Building from DB rows...");
      docs = await db.kb_embeddings
        .where("sessionId")
        .equals(sessionId)
        .filter(doc => doc.vector && doc.vector.length > 0)
        .toArray();
    }

    try {
      const res = await workerBridge.dispatch("INIT_KB_ORAMA", {
        sessionId,
        docs,
        dimension,
        snapshotBuffer,
        expectedCount
      });
      
      if (res && res.snapshotBuffer) {
        await db.kb_orama_snapshots.put({
          sessionId,
          buffer: res.snapshotBuffer,
          updatedAt: Date.now()
        });
      }
      console.log(`[KbRagEngine] Orama indexed / loaded via Worker.`);
    } catch (err) {
      if (err.message && err.message.includes("SNAPSHOT_FAILED")) {
        console.warn("[KbRagEngine] Snapshot load failed, rebuilding from Dexie...");
        docs = await db.kb_embeddings.where("sessionId").equals(sessionId).filter(doc => doc.vector && doc.vector.length > 0).toArray();
        const res = await workerBridge.dispatch("INIT_KB_ORAMA", {
          sessionId,
          docs,
          dimension,
          snapshotBuffer: null
        });
        
        if (res && res.snapshotBuffer) {
          await db.kb_orama_snapshots.put({
            sessionId,
            buffer: res.snapshotBuffer,
            updatedAt: Date.now()
          });
        }
        console.log(`[KbRagEngine] Orama rebuilt via Worker after snapshot failure.`);
      } else {
        throw err;
      }
    }
  }

  async checkModelMismatch(sessionId) {
    const expert = await db.experts.get("EMBED_PRIMARY");
    if (!expert) return false;

    const safeModelName = typeof expert.modelName === "string" ? expert.modelName : "";

    const mismatchedDoc = await db.kb_embeddings
      .where("sessionId")
      .equals(sessionId)
      .filter(doc => doc.model && doc.model !== safeModelName && doc.vector && doc.vector.length > 0)
      .first();

    if (mismatchedDoc) {
        const oldModel = mismatchedDoc.model;
        eventBus.emit(EVENTS.RAG_KB_MODEL_MISMATCH, {
          currentModel: safeModelName,
          oldModel,
        });
        return true;
    }
    return false;
  }

  async rebuildEmbeddings(sessionId) {
    return this._acquireWriteLock(async () => {
      try {
        const expert = await db.experts.get("EMBED_PRIMARY");
        if (!expert) throw new Error("No EMBED_PRIMARY expert");

        // Clear vectors and mark for re-embedding
        await db.transaction('rw', db.kb_embeddings, db.kb_orama_snapshots, async () => {
          const docs = await db.kb_embeddings.where("sessionId").equals(sessionId).toArray();
          const toUpdate = docs.map(d => {
            d.vector = [];
            d.model = "";
            d.priority = 1;
            return d;
          });
          if (toUpdate.length > 0) {
            await db.kb_embeddings.bulkPut(toUpdate);
          }
          await db.kb_orama_snapshots.where("sessionId").equals(sessionId).delete();
        });

        // re-init empty orama
        this._initPromiseSession = null;
        this._initPromise = null;
        await this.initOramaIndex(sessionId);

        // trigger sync
        this.processBackgroundEmbeddings(sessionId).catch(console.error);

      } catch (err) {
        console.error("[KbRagEngine] Failed to rebuild KB embeddings:", err);
      }
    });
  }

  async sanityCheckKB(sessionId) {
    return this.processBackgroundEmbeddings(sessionId);
  }

  async processBackgroundEmbeddings(sessionId) {
    return this._acquireWriteLock(async () => {
      try {
        const expert = await db.experts.get("EMBED_PRIMARY");
        if (!expert) return;

        const session = await db.game_sessions.get(sessionId);
        if (!session) return;

        const batchSize = 20; // Turn-based chunk size

        // Push filter to Dexie to reduce JS heap usage
        const pendingChunksCollection = db.kb_embeddings
          .where("sessionId")
          .equals(sessionId)
          .filter(e => (!e.vector || e.vector.length === 0) && !e.syncError);

        const totalPendingCount = await pendingChunksCollection.count();
        if (totalPendingCount === 0) return;

        const pendingChunks = await pendingChunksCollection.toArray();

        // Sort: priority first, then ordered by docId and chunkIndex
        pendingChunks.sort((a, b) => {
           if (a.priority && !b.priority) return -1;
           if (!a.priority && b.priority) return 1;
           if (a.docId !== b.docId) return a.docId.localeCompare(b.docId);
           return a.chunkIndex - b.chunkIndex;
        });

        const batch = pendingChunks.slice(0, batchSize);
        
        console.log(`[KbRagEngine] Processing background embedding for ${batch.length} chunks (remaining: ${totalPendingCount})...`);
        eventBus.emit(EVENTS.RAG_KB_SYNC_START, { total: totalPendingCount });

        const texts = batch.map(c => c.text);
        
        const embedRes = await workerBridge.dispatch("EMBED_TEXTS", {
            texts,
            expertConfig: await this._getExpertWorkerConfig(expert)
        });

        let batchSuccess = false;

        if (embedRes && embedRes.embeddings && embedRes.embeddings.length === batch.length) {
            batchSuccess = true;
            this.syncRetries = 0;
            const updatedDocs = [];
            for (let i = 0; i < batch.length; i++) {
                batch[i].vector = normalizeVector(embedRes.embeddings[i]);
                batch[i].model = expert.modelName;
                batch[i].priority = 0; // clear priority
                updatedDocs.push(batch[i]);
            }
            
            await this._ensureInit(sessionId);
            try {
                if (updatedDocs[0] && updatedDocs[0].vector.length !== this.oramaDimension) {
                     // Check if this is the first embedded batch
                     const existingCount = await db.kb_embeddings
                        .where("sessionId")
                        .equals(sessionId)
                        .filter(d => d.vector && d.vector.length > 0 && !updatedDocs.find(u => u.id === d.id))
                        .count();
                        
                     if (existingCount === 0) {
                         console.log(`[KbRagEngine] Auto-recovering dimension to ${updatedDocs[0].vector.length}`);
                         this.oramaDimension = updatedDocs[0].vector.length;
                         await workerBridge.dispatch("INIT_KB_ORAMA", {
                           sessionId,
                           docs: [],
                           dimension: this.oramaDimension,
                           snapshotBuffer: null
                         });
                     } else {
                         throw new Error(`DIMENSION_MISMATCH: Expected ${this.oramaDimension}, got ${updatedDocs[0].vector.length}`);
                     }
                }

                await workerBridge.dispatch("UPDATE_KB_ORAMA", {
                  docs: updatedDocs,
                  dimension: this.oramaDimension,
                  sessionId
                });
                
                await db.transaction('rw', db.kb_embeddings, async () => {
                    await db.kb_embeddings.bulkPut(updatedDocs);
                });
            } catch(e) {
                if (e.message && e.message.includes("DIMENSION_MISMATCH")) {
                    console.warn("[KbRagEngine] Orama Dimension mismatch detected in background embedding.");
                    eventBus.emit(EVENTS.RAG_KB_MODEL_MISMATCH, {
                       currentModel: expert ? expert.modelName : "unknown",
                       oldModel: "unknown (dimension anomaly)",
                    });
                    return; // Stop processing this batch further, let user rebuild
                } else {
                    console.warn("Failed to update KB Orama", e);
                }
            }
        } else {
            this.syncRetries = (this.syncRetries || 0) + 1;
            console.warn(`[KbRagEngine] Background embedding mismatch or failure. Retry ${this.syncRetries}`);
            if (this.syncRetries >= 3) {
                console.error("[KbRagEngine] Max retries reached for batch. Marking as failed.");
                const failedDocs = batch.map(d => {
                    d.syncError = true;
                    return d;
                });
                await db.kb_embeddings.bulkPut(failedDocs);
                this.syncRetries = 0;
            } else {
                const backoffMs = this.syncRetries * 2000;
                setTimeout(() => this.processBackgroundEmbeddings(sessionId), backoffMs);
                return; // Stop processing this turn, let backoff handle next attempt
            }
        }
        
        eventBus.emit(EVENTS.RAG_KB_SYNC_PROGRESS, { current: batchSize, total: pendingChunks.length });
        
        if (pendingChunks.length <= batchSize) {
            eventBus.emit(EVENTS.RAG_KB_SYNC_COMPLETE, { sessionId });
        } else {
            setTimeout(() => this.processBackgroundEmbeddings(sessionId), 100);
        }
      } catch (err) {
        console.warn("[KbRagEngine] Background embedding failed:", err);
      }
    });
  }

  _mergeText(s1, s2) {
    const minLen = Math.min(s1.length, s2.length);
    for (let i = minLen; i > 0; i--) {
        if (s1.substring(s1.length - i) === s2.substring(0, i)) {
            return s1 + s2.substring(i);
        }
    }
    return s1 + "\n" + s2;
  }

  async retrieveRelevantMemories(sessionId, queryText, topK = 3, options = {}) {
    if (!queryText || !queryText.trim()) return [];

    try {
      await this._ensureInit(sessionId);

      const expert = await db.experts.get("EMBED_PRIMARY");
      if (!expert) return [];

      const res = await apiClient.callEmbedding(
        "EMBED_PRIMARY",
        [queryText],
        "RETRIEVAL_QUERY",
        { signal: options.signal }
      );
      
      if (!res.embeddings || !res.embeddings[0]) {
        throw new Error("Invalid or empty response from embedding provider.");
      }

      const queryVector = normalizeVector(res.embeddings[0]);

      const result = await workerBridge.dispatch("RETRIEVE_AND_RANK_KB", {
        queryText,
        queryVector,
        topK,
        tokenBudget: this.tokenBudget,
        penaltyFactor: this.penaltyFactor,
        similarityThreshold: this.similarityThreshold,
        sessionId,
      }, options);

      const workerResults = result ? result.results || [] : [];
      
      // Hierarchical Deduplication and Parent Context Restoration
      // Group by docId, merge adjacent chunks
      let finalResults = [];
      let totalTokens = 0;

      const groupedByDoc = new Map();
      const priorityUpdates = [];

      // Fetch embeddings to get startIdx and endIdx
      const hitIds = workerResults.map(h => h.id);
      let embeddingsMap = new Map();
      try {
        const embeddingsList = await db.kb_embeddings.where('id').anyOf(hitIds).toArray();
        embeddingsMap = new Map(embeddingsList.map(e => [e.id, e]));
      } catch (err) {
        console.warn("Failed to fetch embeddings for merge", err);
      }

      for (const hit of workerResults) {
        if (hit.needsEmbedding) {
          priorityUpdates.push(hit.id);
        }

        const embedData = embeddingsMap.get(hit.id) || {};
        hit.startIdx = embedData.startIdx;
        hit.endIdx = embedData.endIdx;

        if (!groupedByDoc.has(hit.docId)) {
          groupedByDoc.set(hit.docId, []);
        }
        groupedByDoc.get(hit.docId).push(hit);
      }
      
      // We will count tokens to ensure we stay in budget
      const textsToCount = [];

      // Sort by chunkIndex and merge adjacent
      const mergedHits = [];
      for (const [docId, hits] of groupedByDoc.entries()) {
        hits.sort((a, b) => a.chunkIndex - b.chunkIndex);
        
        let parentText = null;
        try {
           const parentDoc = await db.kb_files.get(docId);
           if (parentDoc) parentText = parentDoc.text;
        } catch (e) {
           console.warn("Failed to fetch parent doc for merge", e);
        }
        
        let currentMerge = null;
        let searchFromIdx = 0;

        for (const hit of hits) {
           if (!currentMerge) {
              currentMerge = { ...hit };
              if (parentText) {
                 if (currentMerge.startIdx !== undefined && currentMerge.endIdx !== undefined) {
                     // We have absolute coordinates
                 } else {
                     currentMerge.startIdx = parentText.indexOf(hit.text.trim(), searchFromIdx);
                     if (currentMerge.startIdx !== -1) {
                         currentMerge.endIdx = currentMerge.startIdx + hit.text.trim().length;
                         searchFromIdx = currentMerge.startIdx;
                     }
                 }
              }
           } else {
              if (hit.chunkIndex <= currentMerge.chunkIndex + 1) { // adjacent or overlap
                 if (parentText && currentMerge.startIdx !== -1 && currentMerge.startIdx !== undefined) {
                    let nextEndIdx;
                    if (hit.startIdx !== undefined && hit.endIdx !== undefined) {
                        nextEndIdx = hit.endIdx;
                    } else {
                        const hitTrimmed = hit.text.trim();
                        // Overlap means the next chunk might start before the previous one ends,
                        // so we search from currentMerge.startIdx (the known start of the cluster)
                        const endIdxObj = parentText.indexOf(hitTrimmed, currentMerge.startIdx);
                        if (endIdxObj !== -1) {
                            nextEndIdx = endIdxObj + hitTrimmed.length;
                            searchFromIdx = endIdxObj;
                        }
                    }

                    if (nextEndIdx !== undefined) {
                        currentMerge.endIdx = Math.max(currentMerge.endIdx || 0, nextEndIdx);
                        currentMerge.text = parentText.substring(currentMerge.startIdx, currentMerge.endIdx);
                    } else {
                        currentMerge.text = this._mergeText(currentMerge.text, hit.text);
                        currentMerge.startIdx = -1; // disable further parentText merges for this sequence
                    }
                 } else {
                    currentMerge.text = this._mergeText(currentMerge.text, hit.text);
                 }
                 currentMerge.chunkIndex = hit.chunkIndex; // update end index
              } else {
                 mergedHits.push(currentMerge);
                 currentMerge = { ...hit };
                 if (parentText) {
                    if (currentMerge.startIdx !== undefined && currentMerge.endIdx !== undefined) {
                        // Keep absolute coords
                    } else {
                        currentMerge.startIdx = parentText.indexOf(hit.text.trim(), searchFromIdx);
                        if (currentMerge.startIdx !== -1) {
                            currentMerge.endIdx = currentMerge.startIdx + hit.text.trim().length;
                            searchFromIdx = currentMerge.startIdx;
                        }
                    }
                 }
              }
           }
        }
        if (currentMerge) {
           mergedHits.push(currentMerge);
        }
      }
      
      // Rank merged hits by highest score among its constituent parts? 
      // Actually we should sort merged hits by their original score, but merged score could be the max of its parts
      mergedHits.sort((a, b) => b.score - a.score);

      for (const item of mergedHits) {
        textsToCount.push(item.text || "");
      }

      // Mark un-embedded chunks as priority
      if (priorityUpdates.length > 0) {
         try {
            await db.transaction('rw', db.kb_embeddings, async () => {
                const docs = await db.kb_embeddings.where('id').anyOf(priorityUpdates).toArray();
                const toUpdate = [];
                for (const d of docs) {
                    if (!d.vector || d.vector.length === 0) {
                        d.priority = 1;
                        toUpdate.push(d);
                    }
                }
                if (toUpdate.length > 0) {
                    await db.kb_embeddings.bulkPut(toUpdate);
                }
            });
         } catch(e) {
            console.warn("Failed to set chunk priority:", e);
         }
      }

      let tokenCounts = [];
      if (textsToCount.length > 0) {
        try {
          const countResult = await workerBridge.dispatch("BATCH_COUNT_TOKENS", { texts: textsToCount });
          tokenCounts = countResult?.tokensArray || new Array(textsToCount.length).fill(0);
        } catch (err) {
          tokenCounts = new Array(textsToCount.length).fill(0);
        }
      }

      for (let i = 0; i < mergedHits.length; i++) {
        const hit = mergedHits[i];
        let tokens = tokenCounts[i];

        if (totalTokens + tokens > this.tokenBudget) {
          continue; 
        }

        finalResults.push({
          ...hit,
          title: hit.title || "Knowledge Base",
        });
        totalTokens += tokens;

        if (finalResults.length >= topK) break;
      }

      return finalResults;
    } catch (error) {
      console.warn("[KbRagEngine] retrieveRelevantMemories failed:", error);
      return [];
    }
  }
}

export const kbRagEngine = new KbRagEngine();
