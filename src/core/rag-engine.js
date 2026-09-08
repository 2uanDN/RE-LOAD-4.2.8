import { db, DEXIE_MIN_KEY, DEXIE_MAX_KEY } from "./db.js";
import { eventBus } from "./event-bus.js";
import { workerBridge } from "../workers/worker-bridge.js";
import { apiClient } from "./api-client.js";
import { normalizeVector } from "../utils/vector-math.js";
import { extractBlock1Only } from "../utils/text-parser.js";
import { getProviderFormat } from "../utils/api-utils.js";
import { EVENTS } from '../core/events.js';
import { EMBEDDING_BATCH_SIZE } from "./rag-constants.js";
import { keyRotator } from "./key-rotator.js";

// RAG Engine: Optimized Hybrid Search & Semantic Chunking 
// Powered by Orama indexing and clause-aware segmentation.

class RagEngine {
  constructor() {
    this.tokenBudget = 10000; // max tokens for context
    
    // Magic Number Context: 
    // penaltyFactor (0.005): Deduplicates functionally identical semantic matches across time. A match 200 turns old is heavily penalized relative to a match 5 turns old, ensuring recency bias.
    // similarityThreshold (0.2): Needs to be low enough to allow the penalty-based time decay ranking to fully process a wide net of matches, rather than hard-clipping them early.
    this.penaltyFactor = 0.005; 
    this.similarityThreshold = 0.2; 
    
    this.chunkTargetTokens = 512; // Standard chunk size

    this.currentSessionId = null;
    this.oramaDimension = 768;
    this.processedSourceIds = new Set();
    this.pendingEmbeddings = new Set();
    this._writeLock = Promise.resolve();
    
    this._initPromiseSession = null;
    this._initPromise = null;

    eventBus.on(EVENTS.TURN_COMPLETED, this.handleTurnCompleted.bind(this));
    eventBus.on(EVENTS.RAG_TRIGGER_REBUILD, (data) =>
      this.rebuildEmbeddings(data.sessionId),
    );
    eventBus.on(EVENTS.SESSION_LOADED, this.handleSessionLoaded.bind(this));
    eventBus.on(EVENTS.WORKER_RESTARTED, async () => {
      if (this.currentSessionId) {
        this._initPromiseSession = null;
        this._initPromise = null;
        this.processedSourceIds.clear();
        try {
          await db.orama_snapshots.where("sessionId").equals(this.currentSessionId).delete();
        } catch (e) {
          console.error("[RagEngine] Failed to delete snapshot on worker restart:", e);
        }
        this.initOramaIndex(this.currentSessionId).catch(console.error);
      }
    });
    eventBus.on(EVENTS.SETTINGS_CHANGED, (data) => {
      if (data.key === "all" || data.key === "memory") {
        this.loadSettings();
      }
      if (data.key === "all" || data.key === "providers" || (data.key === "experts" && data.expertId === "EMBED_PRIMARY")) {
        if (this.currentSessionId) {
          this.sanityCheckOrphanedTurns(this.currentSessionId);
          this.checkModelMismatch(this.currentSessionId).catch(console.error);
        }
      }
    });

    eventBus.on(EVENTS.ORAMA_SYNC_SNAPSHOT, async (data) => {
      const snapSessionId = data.sessionId;
      const buffer = data.buffer;
      if (snapSessionId && buffer) {
        try {
          await db.orama_snapshots.put({
            sessionId: snapSessionId,
            buffer: buffer,
            updatedAt: Date.now()
          });
        } catch (e) {
          console.error("Failed to commit Orama snapshot", e);
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

  markSourceProcessed(sourceId) {
    if (this.processedSourceIds.has(sourceId)) {
      this.processedSourceIds.delete(sourceId);
    }
    this.processedSourceIds.add(sourceId);
    if (this.processedSourceIds.size > 2000) {
      // Remove oldest 500 when reaching limit
      let count = 0;
      for (const oldest of this.processedSourceIds) {
        this.processedSourceIds.delete(oldest);
        if (++count >= 500) break;
      }
    }
  }

  _extractBlock1(text) {
    return extractBlock1Only(text);
  }

  async handleSessionLoaded(sessionContext) {
    const sessionId = sessionContext.session.id;
    await this.loadSettings();
    try {
      await this.checkModelMismatch(sessionId);
    } catch (err) {
      console.error("[RagEngine] Error in checkModelMismatch:", err);
    }
    try {
      await this.initOramaIndex(sessionId);
    } catch (err) {
      if (err.message && err.message.includes("DIMENSION_MISMATCH")) {
        console.warn("[RagEngine] Dimension mismatch during initialization. Triggering rebuild...");
        this.rebuildEmbeddings(sessionId);
      } else {
        console.error("[RagEngine] Failed to init Orama index:", err);
      }
    }
    await this.sanityCheckOrphanedTurns(sessionId);
  }

  async sanityCheckOrphanedTurns(sessionId) {
    return this._acquireWriteLock(async () => {
      try {
        const expert = await db.experts.get("EMBED_PRIMARY");
        if (!expert) {
          console.warn("[RagEngine] No EMBED_PRIMARY expert found. Postponing orphaned turn sync.");
          return;
        }

        const session = await db.game_sessions.get(sessionId);
        if (!session) return;
        const lastSyncedTurnIndex = session.ragSyncedTurnIndex != null ? session.ragSyncedTurnIndex : -1;

        const validLastIndex = Number.isFinite(lastSyncedTurnIndex) ? lastSyncedTurnIndex : -1;

        const turnsToScan = await db.turns
          .where("[sessionId+turnIndex]")
          .between([sessionId, validLastIndex + 1], [sessionId, DEXIE_MAX_KEY()], true, true)
          .toArray();

        if (turnsToScan.length === 0) return;

        const existingTypesBySourceId = new Map();
        const turnIds = turnsToScan.map(t => t.id);
        await db.embeddings.where("sourceId").anyOf(turnIds).each(e => {
            if (!existingTypesBySourceId.has(e.sourceId)) {
                existingTypesBySourceId.set(e.sourceId, new Set());
            }
            existingTypesBySourceId.get(e.sourceId).add(e.sourceType);
        });

        const orphanedTurns = turnsToScan.filter(t => {
            const types = existingTypesBySourceId.get(t.id) || new Set();
            const needsUserInput = t.userInput && t.userInput.trim() && !types.has("turn_user_input");
            const block1 = this._extractBlock1(t.aiResponse || "");
            const needsNarrator = block1 && block1.trim() && !types.has("turn_narrator");
            return needsUserInput || needsNarrator;
        });

        if (orphanedTurns.length === 0) {
          // Fix: Update checkpoint even if no missing turns so we don't scan them again
          const maxTurn = Math.max(...turnsToScan.map(t => t.turnIndex || 0));
          await db.game_sessions.update(sessionId, { ragSyncedTurnIndex: maxTurn });
          return;
        }

        if (orphanedTurns.length > 0) {
          console.warn(`[RagEngine] Found ${orphanedTurns.length} orphaned turns. Syncing via batch...`);

          const documents = [];
          
          for (const turn of orphanedTurns) {
            const types = existingTypesBySourceId.get(turn.id) || new Set();
            if (turn.userInput && turn.userInput.trim() && !types.has("turn_user_input")) {
              documents.push({ text: turn.userInput, sourceId: turn.id, sourceType: "turn_user_input", turnIndex: turn.turnIndex, sessionId: turn.sessionId });
            }
            const block1 = this._extractBlock1(turn.aiResponse || "");
            if (block1 && block1.trim() && !types.has("turn_narrator")) {
              documents.push({ text: block1, sourceId: turn.id, sourceType: "turn_narrator", turnIndex: turn.turnIndex, sessionId: turn.sessionId });
            }
          }

          let hasBatchError = false;

          for (let i = 0; i < documents.length; i += EMBEDDING_BATCH_SIZE) {
            if (this.currentSessionId && this.currentSessionId !== sessionId) {
              console.log('[RagEngine] Session changed, aborting orphaned sync');
              hasBatchError = true;
              break;
            }
            const batchDocs = documents.slice(i, i + EMBEDDING_BATCH_SIZE);
            try {
              const result = await workerBridge.dispatch("BATCH_CHUNK_AND_EMBED", {
                documents: batchDocs,
                expertConfig: await this._getExpertWorkerConfig(expert),
                targetTokens: this.chunkTargetTokens
              });

              if (result && result.hadFailures) {
                hasBatchError = true;
              }

              if (result && result.results) {
                const batchDocMap = new Map(batchDocs.map(d => [d.sourceId, d]));
                const newDocs = result.results.map((res) => ({
                  id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
                  sessionId: batchDocMap.get(res.sourceId)?.sessionId || sessionId,
                  sourceId: res.sourceId,
                  sourceType: res.sourceType,
                  model: expert.modelName,
                  vector: normalizeVector(res.vector),
                  text: res.chunkText,
                  turnIndex: res.turnIndex,
                  chunkIndex: res.chunkIndex,
                }));
                
                if (newDocs.length > 0) {
                  await db.embeddings.bulkAdd(newDocs);

                  await this._ensureInit(sessionId);
                  try {
                    if (newDocs[0] && newDocs[0].vector.length !== this.oramaDimension) {
                        const existingCount = await db.embeddings.where("sessionId").equals(sessionId).count();
                        if (existingCount === newDocs.length) {
                            console.log(`[RagEngine] Auto-recovering dimension to ${newDocs[0].vector.length}`);
                            this.oramaDimension = newDocs[0].vector.length;
                            await workerBridge.dispatch("INIT_ORAMA", {
                              sessionId,
                              docs: [],
                              dimension: this.oramaDimension,
                              snapshotBuffer: null
                            });
                        } else {
                            throw new Error("DIMENSION_MISMATCH");
                        }
                    }
                    let addResult = await workerBridge.dispatch("ADD_TO_ORAMA", {
                      docs: newDocs,
                      dimension: this.oramaDimension,
                      sessionId
                    });
                    if (addResult && addResult.success === false && addResult.reason === "NOT_INITIALIZED") {
                        await this.initOramaIndex(sessionId);
                        await workerBridge.dispatch("ADD_TO_ORAMA", {
                            docs: newDocs,
                            dimension: this.oramaDimension,
                            sessionId
                        });
                    }
                  } catch (err) {
                     if (err.message && err.message.includes("DIMENSION_MISMATCH")) {
                        console.warn("[RagEngine] Dimension mismatch in batch. Rolling back batch.");
                        await db.embeddings.bulkDelete(newDocs.map(d => d.id));
                        hasBatchError = true;
                        break;
                     } else {
                        hasBatchError = true;
                        console.warn("[RagEngine] Batch Orama API failure:", err);
                        break;
                     }
                  }
                }

                if (!hasBatchError) {
                  batchDocs.forEach(d => this.markSourceProcessed(d.sourceId));
                  const maxSyncedTurn = Math.max(...batchDocs.map(d => d.turnIndex || 0));
                  const currentSession = await db.game_sessions.get(sessionId);
                  if (currentSession && (!currentSession.ragSyncedTurnIndex || maxSyncedTurn > currentSession.ragSyncedTurnIndex)) {
                    await db.game_sessions.update(sessionId, { ragSyncedTurnIndex: maxSyncedTurn });
                  }
                }
              }
            } catch (e) {
              console.warn("[RagEngine] Halting orphaned sync due to batch chunk/embed API failure:", e);
              hasBatchError = true;
              break;
            }
          }

          // RAG Gap Rollback Mechanism
          if (hasBatchError) {
             console.warn(`[RagEngine] Batch interruption detected. Rolling back ragSyncedTurnIndex to ${validLastIndex} to prevent orphaned turns gap.`);
             await db.game_sessions.update(sessionId, { ragSyncedTurnIndex: validLastIndex });
          }
        }
      } catch (err) {
        console.warn("[RagEngine] Sanity check failed:", err);
      }
    });
  }

  async loadSettings() {
    try {
      const memorySettings = await db.settings.get("memory");
      if (memorySettings) {
        if (memorySettings.tokenBudget) {
          this.tokenBudget = memorySettings.tokenBudget;
        }
        if (memorySettings.penaltyFactor !== undefined) this.penaltyFactor = memorySettings.penaltyFactor;
        if (memorySettings.similarityThreshold !== undefined) this.similarityThreshold = memorySettings.similarityThreshold;
        if (memorySettings.chunkTargetTokens) this.chunkTargetTokens = memorySettings.chunkTargetTokens;
      }
    } catch (e) {
      console.warn("[RagEngine] Failed to load RAG settings, using defaults", e);
    }
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
    console.log(
      "[RagEngine] Initializing Orama Vector Index for session:",
      sessionId,
    );
    if (this.currentSessionId !== sessionId) {
      this.processedSourceIds.clear();
    }
    this.currentSessionId = sessionId;

    // Detect from expert config first
    const expert = await db.experts.get("EMBED_PRIMARY");
    let dimension = 768; // Default to 768
    
    if (expert) {
        const safeModelName = typeof expert.modelName === "string" ? expert.modelName : "";
        const matchingDoc = await db.embeddings
          .where("[sessionId+model]")
          .equals([sessionId, safeModelName])
          .first();
          
        if (matchingDoc && matchingDoc.vector) {
          dimension = matchingDoc.vector.length;
        } else {
          // Fallback 2: Check if we already have any docs embedded
          const firstDoc = await db.embeddings
            .where("sessionId")
            .equals(sessionId)
            .first();
          if (firstDoc && firstDoc.vector) {
            dimension = firstDoc.vector.length;
          }
        }
    } else {
      // Fallback 3: Check if we already have any docs embedded
      const firstDoc = await db.embeddings
        .where("sessionId")
        .equals(sessionId)
        .first();
      if (firstDoc && firstDoc.vector) {
        dimension = firstDoc.vector.length;
      }
    }
    
    this.oramaDimension = dimension;

    // Try loading Snapshot
    const snapshotRecord = await db.orama_snapshots.get(sessionId);
    let snapshotBuffer = null;
    let docs = [];
    let expectedCount = null;

    if (snapshotRecord && snapshotRecord.buffer) {
      console.log("[RagEngine] Found Orama snapshot, attempting to load directly from memory buffer...");
      snapshotBuffer = snapshotRecord.buffer;
      expectedCount = await db.embeddings.where("sessionId").equals(sessionId).count();
    }

    if (!snapshotBuffer) {
      console.log("[RagEngine] No snapshot found. Building from DB rows...");
      const allDocs = await db.embeddings
        .where("sessionId")
        .equals(sessionId)
        .toArray();
      
      const garbageIds = [];
      docs = allDocs.filter(d => {
        if (!d.vector) {
           garbageIds.push(d.id);
           return false;
        }
        if (d.vector.length === dimension) return true;
        
        // Cleanup anomaly garbage for current model or corrupted vectors
        if (d.model === expert?.modelName || d.vector.length < 10) {
            garbageIds.push(d.id);
        }
        return false;
      });

      if (garbageIds.length > 0) {
        console.warn(`[RagEngine] Cleaning up ${garbageIds.length} db embeddings with mismatched dimensions...`);
        await db.embeddings.bulkDelete(garbageIds);
      }

      if (allDocs.length !== docs.length) {
        console.warn(`[RagEngine] Loaded ${docs.length} database embeddings matching dimension ${dimension}. Skipped ${allDocs.length - docs.length} vectors of different dimensions.`);
      }
    }

    try {
      // Init in Web Worker
      const res = await workerBridge.dispatch("INIT_ORAMA", {
        sessionId,
        docs,
        dimension,
        snapshotBuffer,
        expectedCount
      });
      
      if (res && res.snapshotBuffer) {
        await db.orama_snapshots.put({
          sessionId,
          buffer: res.snapshotBuffer,
          updatedAt: Date.now()
        });
      }
  
      console.log(`[RagEngine] Orama indexed / loaded via Worker.`);
    } catch (err) {
      if (err.message && err.message.includes("SNAPSHOT_FAILED")) {
        console.warn("[RagEngine] Snapshot load failed, rebuilding from Dexie...");
        const allDocs = await db.embeddings.where("sessionId").equals(sessionId).toArray();
        docs = allDocs.filter(d => d.vector && d.vector.length === dimension);
        const res = await workerBridge.dispatch("INIT_ORAMA", {
          sessionId,
          docs,
          dimension,
          snapshotBuffer: null
        });
        
        if (res && res.snapshotBuffer) {
          await db.orama_snapshots.put({
            sessionId,
            buffer: res.snapshotBuffer,
            updatedAt: Date.now()
          });
        }
        console.log(`[RagEngine] Orama rebuilt via Worker after snapshot failure.`);
      } else {
        throw err;
      }
    }
  }

  async handleTurnCompleted(turn) {
    if (!turn || !turn.sessionId || !turn.id) return true;
    if (this.processedSourceIds.has(turn.id)) return true;
    if (this.pendingEmbeddings.has(turn.id)) return true;

    this.pendingEmbeddings.add(turn.id);
    try {
      return await this._acquireWriteLock(() => this._doHandleTurnCompleted(turn));
    } finally {
      this.pendingEmbeddings.delete(turn.id);
    }
  }

  async _doHandleTurnCompleted(turn) {
    try {
      const existingEmbeddings = await db.embeddings
        .where("sourceId")
        .equals(turn.id)
        .toArray();
      const existingTypes = new Set(existingEmbeddings.map(e => e.sourceType));

      const block1 = this._extractBlock1(turn.aiResponse || "");

      const needsUserInput = turn.userInput && turn.userInput.trim() && !existingTypes.has("turn_user_input");
      const needsNarrator = block1 && block1.trim() && !existingTypes.has("turn_narrator");

      if (!needsUserInput && !needsNarrator) {
        this.markSourceProcessed(turn.id);
        return true;
      }

      const expert = await db.experts.get("EMBED_PRIMARY");
      if (!expert) return false;

      const newDocs = [];
      let hasBatchError = false;

      if (needsUserInput) {
        const userInputResult = await workerBridge.dispatch("CHUNK_AND_EMBED", {
          text: turn.userInput,
          expertConfig: await this._getExpertWorkerConfig(expert),
          sourceId: turn.id,
          sourceType: "turn_user_input",
          turnIndex: turn.turnIndex,
          targetTokens: 300
        });
        
        if (userInputResult && userInputResult.hadFailures) {
          hasBatchError = true;
        }

        if (userInputResult && userInputResult.results) {
          for (const res of userInputResult.results) {
            newDocs.push({
              id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
              sessionId: turn.sessionId,
              sourceId: turn.id,
              sourceType: "turn_user_input",
              model: expert.modelName,
              vector: normalizeVector(res.vector),
              text: res.chunkText,
              turnIndex: turn.turnIndex,
              chunkIndex: res.chunkIndex,
            });
          }
        }
      }

      if (needsNarrator) {
        const narratorResult = await workerBridge.dispatch("CHUNK_AND_EMBED", {
          text: block1,
          expertConfig: await this._getExpertWorkerConfig(expert),
          sourceId: turn.id,
          sourceType: "turn_narrator",
          turnIndex: turn.turnIndex,
          targetTokens: this.chunkTargetTokens
        });

        if (narratorResult && narratorResult.hadFailures) {
          hasBatchError = true;
        }

        if (narratorResult && narratorResult.results) {
          for (const res of narratorResult.results) {
            newDocs.push({
              id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
              sessionId: turn.sessionId,
              sourceId: turn.id,
              sourceType: "turn_narrator",
              model: expert.modelName,
              vector: normalizeVector(res.vector),
              text: res.chunkText,
              turnIndex: turn.turnIndex,
              chunkIndex: res.chunkIndex,
            });
          }
        }
      }

      if (newDocs.length > 0) {
        await db.embeddings.bulkAdd(newDocs);

        await this._ensureInit(turn.sessionId);

        // Add to Orama dynamically via Worker
        try {
          if (newDocs[0] && newDocs[0].vector.length !== this.oramaDimension) {
              const existingCount = await db.embeddings.where("sessionId").equals(turn.sessionId).count();
              if (existingCount === newDocs.length) {
                  console.log(`[RagEngine] Auto-recovering dimension to ${newDocs[0].vector.length}`);
                  this.oramaDimension = newDocs[0].vector.length;
                  await workerBridge.dispatch("INIT_ORAMA", {
                    sessionId: turn.sessionId,
                    docs: [],
                    dimension: this.oramaDimension,
                    snapshotBuffer: null
                  });
              } else {
                  throw new Error(`DIMENSION_MISMATCH: Expected ${this.oramaDimension}, got ${newDocs[0].vector.length}`);
              }
          }
          let addResult = await workerBridge.dispatch("ADD_TO_ORAMA", {
            docs: newDocs,
            dimension: this.oramaDimension,
            sessionId: turn.sessionId
          });
          
          if (addResult && addResult.success === false && addResult.reason === "NOT_INITIALIZED") {
             await this.initOramaIndex(turn.sessionId);
             await workerBridge.dispatch("ADD_TO_ORAMA", {
                docs: newDocs,
                dimension: this.oramaDimension,
                sessionId: turn.sessionId
             });
          }
        } catch (err) {
          if (err.message && err.message.includes("DIMENSION_MISMATCH")) {
            console.warn("[RagEngine] Orama Dimension mismatch detected.");
            const currentExpert = await db.experts.get("EMBED_PRIMARY");
            
            await db.embeddings.bulkDelete(newDocs.map(d => d.id));
            
            eventBus.emit(EVENTS.RAG_MODEL_MISMATCH, {
               currentModel: currentExpert ? currentExpert.modelName : "unknown",
               oldModel: "unknown (dimension anomaly)",
            });
            hasBatchError = true;
          } else {
            hasBatchError = true;
            console.warn("[RagEngine] Failed to add turn to Orama:", err);
          }
        }
      }

      if (!hasBatchError) {
        this.markSourceProcessed(turn.id);

        const session = await db.game_sessions.get(turn.sessionId);
        if (session) {
            const currentSynced = session.ragSyncedTurnIndex != null ? session.ragSyncedTurnIndex : -1;
            // Contiguous progression check to avoid overwriting gaps from failed previous embeddings
            if (currentSynced === -1 || turn.turnIndex <= currentSynced + 1) {
                await db.game_sessions.update(turn.sessionId, { ragSyncedTurnIndex: Math.max(currentSynced, turn.turnIndex) });
            } else {
                console.log(`[RagEngine] Processed turn ${turn.turnIndex}, but leaving ragSyncedTurnIndex at ${currentSynced} to allow gap filling.`);
            }
        }
      }

      return !hasBatchError;
    } catch (err) {
      console.warn("[RagEngine] Failed to embed turn:", err);
      throw err;
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
      console.warn('[RagEngine] KeyRotator failed:', e.message);
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

  async retrieveRelevantMemories(sessionId, queryText, topK = 3, excludeSourceIds = [], options = {}) {
    if (!queryText || !queryText.trim()) return [];

    try {
      await this._ensureInit(sessionId);

      const expert = await db.experts.get("EMBED_PRIMARY");
      if (!expert) {
        console.warn("[RagEngine] No EMBED_PRIMARY expert found. Skipping memory retrieval natively.");
        return [];
      }

      const generalSettings = await db.settings.get("general");
      const slidingWindowSize = generalSettings?.slidingWindowSize || 10;

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

      // Determine current highest turnIndex for decay without leaking memory (O(1) approach)
      const lastTurn = await db.turns
        .where("[sessionId+turnIndex]")
        .between([sessionId, DEXIE_MIN_KEY()], [sessionId, DEXIE_MAX_KEY()])
        .reverse()
        .first();
      const currentTurnIndex = lastTurn ? lastTurn.turnIndex : 0;

      // Offload entirely to Web Worker
      const result = await workerBridge.dispatch("RETRIEVE_AND_RANK", {
        queryText,
        queryVector,
        currentTurnIndex,
        topK,
        tokenBudget: this.tokenBudget,
        penaltyFactor: this.penaltyFactor,
        similarityThreshold: this.similarityThreshold,
        excludeSourceIds,
        slidingWindowSize,
        sessionId,
      }, options);

      const workerResults = result ? result.results || [] : [];
      let finalResults = [];
      let totalTokens = 0;

      // IPC Waterfall Fix: Fetch all parents concurrently
      const turnSourceIds = workerResults
        .filter(h => h.sourceType === 'turn' || h.sourceType === 'turn_user_input' || h.sourceType === 'turn_narrator')
        .map(h => h.sourceId);

      const fetchedTurns = await db.turns.where('id').anyOf(turnSourceIds).toArray();
      const turnMap = new Map(fetchedTurns.map(t => [t.id, t]));

      const resolvedContents = workerResults.map(hit => {
        let fullParentContent = "";
        if (hit.sourceType === "summary") {
          fullParentContent = ""; // Deprecated: Summaries are not embedded
        } else if (hit.sourceType === "turn" || hit.sourceType === "turn_user_input" || hit.sourceType === "turn_narrator") {
          const turnItem = turnMap.get(hit.sourceId);
          if (turnItem) {
            let aiText = this._extractBlock1(turnItem.aiResponse || "");
            const turnDistance = Math.max(0, currentTurnIndex - turnItem.turnIndex);
            fullParentContent = `[Ký ức từ Turn ${turnItem.turnIndex} - Khoảng ${turnDistance} lượt trước]\nUSER INPUT: ${(turnItem.userInput || "")}\n\nNARRATOR/BLOCK1: ${aiText}`;
          }
        }
        return { hit, fullParentContent };
      });

      const textsToCount = [];
      for (const item of resolvedContents) {
        textsToCount.push(item.fullParentContent || "");
        textsToCount.push(item.hit.text || "");
      }

      let tokenCounts;
      try {
        const countResult = await workerBridge.dispatch("BATCH_COUNT_TOKENS", { texts: textsToCount });
        tokenCounts = countResult?.tokensArray || new Array(textsToCount.length).fill(0);
      } catch (err) {
        console.warn("[RagEngine] BATCH_COUNT_TOKENS failed, fallback to 0", err);
        tokenCounts = new Array(textsToCount.length).fill(0);
      }

      for (let i = 0; i < resolvedContents.length; i++) {
        const { hit } = resolvedContents[i];
        let fullParentContent = resolvedContents[i].fullParentContent;

        let tokens = tokenCounts[i * 2];
        const chunkTokens = tokenCounts[i * 2 + 1];

        // Fallback to raw chunk text if parent context is unavailable (e.g., non-turn docs, missing parent)
        if (!fullParentContent) {
          fullParentContent = hit.text;
          tokens = chunkTokens;
        }
        if (!fullParentContent) continue;

        if (totalTokens + tokens > this.tokenBudget) {
          continue; // Skip oversized turn instead of hard breaking to maximize context window
        }

        finalResults.push({
          ...hit,
          text: fullParentContent, // Override child chunk with Full Parent context
          matchedChunk: hit.text, // Keep the chunk text for debugging/reference
        });
        totalTokens += tokens;

        if (finalResults.length >= topK) break;
      }

      eventBus.emit(EVENTS.RAG_RETRIEVED, {
        queryText,
        results: finalResults,
        expertModel: expert.modelName,
      });
      return finalResults;
    } catch (error) {
      console.warn("[RagEngine] retrieveRelevantMemories failed:", error);
      eventBus.emit(EVENTS.RAG_ERROR, { message: "Failed to retrieve relevant memories. Please check your provider logic or embedding dimensions.", detail: error.message || String(error) });
      return [];
    }
  }

  async checkModelMismatch(sessionId) {
    if (!sessionId) return false;

    const expert = await db.experts.get("EMBED_PRIMARY");
    if (!expert) return false;

    // Guard against undefined/invalid bounds which cause IndexedDB DataErrors
    const safeModelName = typeof expert.modelName === "string" ? expert.modelName : "";

    // Use the [sessionId+model] index to avoid loading the entire table into RAM
    const firstDoc = await db.embeddings
      .where("sessionId").equals(sessionId)
      .first();

    if (!firstDoc || firstDoc.model === safeModelName) {
        // Find if there's any model > expected
        let mismatchedDoc = await db.embeddings
           .where("[sessionId+model]").between([sessionId, safeModelName], [sessionId, "\uffff"], false, true)
           .first();
           
        if (!mismatchedDoc || mismatchedDoc.sessionId !== sessionId) {
            // Find if there's any model < expected
            mismatchedDoc = await db.embeddings
               .where("[sessionId+model]").between([sessionId, ""], [sessionId, safeModelName], true, false)
               .first();
        }
        
        if (!mismatchedDoc || mismatchedDoc.sessionId !== sessionId) return false;
        
        const oldModel = mismatchedDoc.model;
        eventBus.emit(EVENTS.RAG_MODEL_MISMATCH, {
          currentModel: expert.modelName,
          oldModel,
        });
        return true;
    } else {
        const oldModel = firstDoc.model;
        eventBus.emit(EVENTS.RAG_MODEL_MISMATCH, {
          currentModel: expert.modelName,
          oldModel,
        });
        return true;
    }
  }

  async rebuildEmbeddings(sessionId) {
    return this._acquireWriteLock(async () => {
      eventBus.emit(EVENTS.RAG_REBUILD_START, { sessionId });

      try {
        const expert = await db.experts.get("EMBED_PRIMARY");
        if (!expert) throw new Error("No EMBED_PRIMARY expert");

        const turns = await db.turns
          .where("sessionId")
          .equals(sessionId)
          .toArray();

        if (turns.length === 0) {
          await db.transaction('rw', db.embeddings, db.orama_snapshots, db.game_sessions, async () => {
            await db.embeddings.where("sessionId").equals(sessionId).delete();
            await db.orama_snapshots.where("sessionId").equals(sessionId).delete();
            await db.game_sessions.update(sessionId, { ragSyncedTurnIndex: -1 });
          });
          eventBus.emit(EVENTS.RAG_READY, { sessionId });
          return;
        }

        let processed = 0;

        // Group into documents for batching
        const documents = [];

        for (const turn of turns) {
          if (turn.userInput && turn.userInput.trim()) {
            documents.push({
              text: turn.userInput,
              sourceId: turn.id,
              sourceType: "turn_user_input",
              turnIndex: turn.turnIndex,
              sessionId: turn.sessionId
            });
          }

          const block1 = this._extractBlock1(turn.aiResponse || "");
          
          if (block1 && block1.trim()) {
            documents.push({
              text: block1,
              sourceId: turn.id,
              sourceType: "turn_narrator",
              turnIndex: turn.turnIndex,
              sessionId: turn.sessionId
            });
          }
        }

        const allNewDocs = [];
        let hasBatchError = false;

        // Process in batches so we don't overload worker or DB
        for (let i = 0; i < documents.length; i += EMBEDDING_BATCH_SIZE) {
          const batchDocs = documents.slice(i, i + EMBEDDING_BATCH_SIZE);
          
          const result = await workerBridge.dispatch("BATCH_CHUNK_AND_EMBED", {
            documents: batchDocs,
            expertConfig: await this._getExpertWorkerConfig(expert),
            targetTokens: this.chunkTargetTokens
          });

          if (result && result.hadFailures) {
            hasBatchError = true;
          }

          if (result && result.results) {
            const batchDocMap = new Map(batchDocs.map(d => [d.sourceId, d]));
            const newDocs = result.results.map((res) => ({
              id: crypto.randomUUID
                ? crypto.randomUUID()
                : Math.random().toString(36).substring(2),
              sessionId: batchDocMap.get(res.sourceId)?.sessionId || sessionId,
              sourceId: res.sourceId,
              sourceType: res.sourceType,
              model: expert.modelName,
              vector: normalizeVector(res.vector),
              text: res.chunkText,
              turnIndex: res.turnIndex,
              chunkIndex: res.chunkIndex,
            }));
            allNewDocs.push(...newDocs);
          }

          processed += batchDocs.length;
          eventBus.emit(EVENTS.RAG_REBUILD_PROGRESS, {
            processed,
            total: documents.length,
          });
        }

        // Transactional replace to avoid data loss on batch failures
        await db.transaction('rw', db.embeddings, db.orama_snapshots, db.game_sessions, async () => {
          const sessionExists = await db.game_sessions.get(sessionId);
          if (!sessionExists) return; // Session has been deleted, abort background write

          await db.embeddings.where("sessionId").equals(sessionId).delete();
          await db.orama_snapshots.where("sessionId").equals(sessionId).delete();
          if (allNewDocs.length > 0) {
            await db.embeddings.bulkAdd(allNewDocs);
          }
          const maxTurn = allNewDocs.length > 0 && !hasBatchError ? Math.max(...allNewDocs.map(d => d.turnIndex || 0)) : -1;
          await db.game_sessions.update(sessionId, { ragSyncedTurnIndex: maxTurn });
        });

        this._initPromiseSession = null;
        this._initPromise = null;
        await this.initOramaIndex(sessionId);

        eventBus.emit(EVENTS.RAG_READY, { sessionId });
      } catch (e) {
        console.error("[RagEngine] Failed to rebuild embeddings:", e);
        eventBus.emit(EVENTS.RAG_REBUILD_ERROR, { error: e.message });
      }
    });
  }
}

export const ragEngine = new RagEngine();
