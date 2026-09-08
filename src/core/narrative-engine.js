import { db } from './db.js';
import { eventBus } from './event-bus.js';
import { apiClient } from './api-client.js';
import { promptAssembler } from './prompt-assembler.js';
import { ragEngine } from './rag-engine.js';
import { kbRagEngine } from './kb-rag-engine.js';
import { parseBlocks } from '../utils/text-parser.js';
import { StreamingJsonParser } from '../utils/streaming-json-parser.js';
import { settingsManager } from './settings-manager.js';
import { EVENTS } from '../core/events.js';
import { DEFAULT_EXPERTS } from './default-experts.js';
import { ROLE_TO_SALIENCE } from './salience-constants.js';

const DEFAULT_SILENT_REACTION = '*[Silent reaction]*';

let sharedTiktokenEncoding = null;
async function getCachedEncoding() {
    if (!sharedTiktokenEncoding) {
        const { getEncoding } = await import('js-tiktoken');
        sharedTiktokenEncoding = getEncoding("cl100k_base");
    }
    return sharedTiktokenEncoding;
}

class NarrativeEngine {
  constructor() {
    this.isProcessing = false;
  }

  /**
   * Orchestrates the game loop for a single turn.
   */
  async orchestrateGameTurn(sessionContext, userInput, streamCallback, customSignal = null) {
    if (this.isProcessing) {
      console.warn("NarrativeEngine is currently processing a turn. Blocking duplicate request.");
      throw new Error("Game is currently processing a turn (Race Condition Prevented).");
    }
    this.isProcessing = true;
    try {
      const sessionId = sessionContext.session.id;

    // Prevent Context Bloat by excluding the current context window
    const excludeSourceIds = [];
    if (sessionContext.slidingWindow) {
      sessionContext.slidingWindow.forEach((t) => excludeSourceIds.push(t.id));
    }
    if (sessionContext.memoryTree) {
      const a1Sorted = (sessionContext.memoryTree.a1 || []).slice().sort((a, b) => a.createdAt - b.createdAt);
      const a2Sorted = (sessionContext.memoryTree.a2 || []).slice().sort((a, b) => a.createdAt - b.createdAt);
      const a3Sorted = (sessionContext.memoryTree.a3 || []).slice().sort((a, b) => a.createdAt - b.createdAt);
      
      a1Sorted.slice(-5).forEach(m => excludeSourceIds.push(m.id));
      a2Sorted.slice(-3).forEach(m => excludeSourceIds.push(m.id));
      a3Sorted.forEach(m => excludeSourceIds.push(m.id));
    }

    // Retrieve memories
    let ragQuery = userInput;
    if (sessionContext.session.salienceMap) {
        const highChars = Object.entries(sessionContext.session.salienceMap)
            .filter(([uuid, data]) => (typeof data === 'object' ? data.salience === 'high' : data === 'high'))
            .map(([uuid, data]) => (typeof data === 'object' ? data.full_name : uuid));
        if (highChars.length > 0) {
            ragQuery += " " + highChars.join(" ");
        }
    }
    
    const retrievedMemories = await ragEngine.retrieveRelevantMemories(sessionId, ragQuery, 5, excludeSourceIds, { signal: customSignal });
    const retrievedKbMemories = await kbRagEngine.retrieveRelevantMemories(sessionId, ragQuery, 5, { signal: customSignal });

    // Pre-resolve milestone display turn indices to keep PromptAssembler pure (no DB calls)
    let resolvedMilestones = sessionContext.milestones ? [...sessionContext.milestones] : [];
    if (resolvedMilestones.length > 0) {
      const turnIdsToFetch = resolvedMilestones.map(m => m.turnId).filter(id => typeof id === 'string' && id.includes('-'));
      if (turnIdsToFetch.length > 0) {
        const turns = await db.turns.where('id').anyOf(turnIdsToFetch).toArray();
        const turnMap = {};
        turns.forEach(t => turnMap[t.id] = t.turnIndex);
        resolvedMilestones = resolvedMilestones.map(m => {
          if (typeof m.turnId === 'string' && m.turnId.includes('-') && turnMap[m.turnId] !== undefined) {
            return { ...m, displayTurnIndex: turnMap[m.turnId] };
          }
          return { ...m, displayTurnIndex: m.turnId };
        });
      } else {
        resolvedMilestones = resolvedMilestones.map(m => ({ ...m, displayTurnIndex: m.turnId }));
      }
    }
    sessionContext.resolvedMilestones = resolvedMilestones;

    // Build payload
    const payload = await promptAssembler.buildPayload(sessionId, userInput, sessionContext, retrievedMemories, retrievedKbMemories);
    
    // Extract messages and params depending on how promptAssembler responds
    const messages = Array.isArray(payload) ? payload : payload.messages;
    const params = Array.isArray(payload) ? {} : payload.params || {};

    if (customSignal) {
        params.signal = customSignal;
    }

    // Token & Performance Metrics
    let inputTokens = 0;
    try {
        const enc = await getCachedEncoding();
        const joinedContent = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join("\n");
        inputTokens = enc.encode(joinedContent).length;
    } catch (err) {
        console.warn("Failed to count input tokens:", err);
    }

    const startTime = Date.now();
    let ttft = null;
    let localStreamCallback = streamCallback;
    
    if (streamCallback) {
       localStreamCallback = (delta) => {
           if (ttft === null && delta) {
               ttft = Date.now() - startTime;
           }
           streamCallback(delta, ttft);
       };
    }

    // Call LLM
    const defE = DEFAULT_EXPERTS.find(e => e.id === "EXPERT_NARRATIVE");
    if (defE && defE.systemPrompt) {
        const systemMsgIndex = messages.findIndex(m => m.role === 'system');
        if (systemMsgIndex !== -1) {
            messages[systemMsgIndex].content += "\n\n" + defE.systemPrompt;
        } else {
            messages.unshift({ role: "system", content: defE.systemPrompt });
        }
    }

    const fullRawResponse = await apiClient.callExpert("EXPERT_NARRATIVE", messages, localStreamCallback, params);

    let outputTokens = 0;
    try {
        const enc = await getCachedEncoding();
        outputTokens = enc.encode(fullRawResponse || "").length;
    } catch (err) {
        console.warn("Failed to count output tokens:", err);
    }

    // Fallback if no stream occurred
    if (ttft === null) ttft = Date.now() - startTime;
    
    const performanceMetrics = {
        ttft: ttft,
        inputTokens: inputTokens,
        outputTokens: outputTokens
    };

    // Parse out response
    const parsedData = this.parseThreeBlockResponse(fullRawResponse);

    // Save turn & update session context atomically
    const turnIndex = sessionContext.session.turnCount + 1;
    const updatedEntities = sessionContext.session.entities || [];

    // Xây dựng lại JSON tĩnh tuyệt đối an toàn
    let preservedBlock1 = parsedData.block1;
    let temporaryBlock0 = parsedData.block0;

    const cleanJsonObj = {
        block_0_thinking: temporaryBlock0,
        block_1_scene: preservedBlock1,
        block_2_label_and_description: this._normalizeBlock2(parsedData.block2),
        block_3_inner_reaction: typeof parsedData.block3 === 'string' ? parsedData.block3 : String(parsedData.block3 || DEFAULT_SILENT_REACTION),
        character_dynamics: [] // Assigned after smoothing loop
    };

    updatedEntities.forEach(e => {
        if (!e.id) e.id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    });

    const salienceMap = {};
    const aiDynamicsMap = {};
    if (Array.isArray(parsedData.characterDynamics)) {
        parsedData.characterDynamics.forEach(d => {
            const nameKey = (d.full_name || d.name || '').toLowerCase();
            aiDynamicsMap[nameKey] = d;
        });
    }

    updatedEntities.forEach(ent => {
        const nameKey = (ent.full_name || ent.name || '').toLowerCase();
        const d = aiDynamicsMap[nameKey];
        const uuid = ent.id;

        // Retrieve previous turn's salience for this entity
        // Principle of separation: prevSalience takes the default 'high' at the start of the game (turnCount === 0)
        const prevSalienceData = sessionContext.session.salienceMap && sessionContext.session.salienceMap[uuid];
        const prevSalience = prevSalienceData ? prevSalienceData.salience : (sessionContext.session.turnCount === 0 ? 'high' : 'trace');

        // AI Result Baseline: Default currentSalience MUST ALWAYS be 'trace', DO NOT inject turnCount here.
        let currentSalience = 'trace';
        let primaryRole = '';
        let modalityModifiers = {};

        if (d) {
            currentSalience = d.salience;
            primaryRole = d.primary_role;
            modalityModifiers = d.modality_modifiers || {};
        }

        // Apply Soft Downgrade Rule (Salience Decay Buffer)
        if (prevSalience === 'high' && (currentSalience === 'low' || currentSalience === 'trace')) {
            currentSalience = 'medium';
        } else if (prevSalience === 'medium' && currentSalience === 'trace') {
            currentSalience = 'low';
        }

        salienceMap[uuid] = {
            full_name: ent.full_name || ent.name,
            salience: currentSalience,
            primary_role: primaryRole,
            modality_modifiers: modalityModifiers
        };
        
        // Propagate smoothed salience back to the payload to ensure sync across the system
        if (d) {
            d.salience = currentSalience;
        }
    });

    // Assign character_dynamics AFTER smoothing is complete to make the intent explicit
    // rather than relying on object reference mutation.
    cleanJsonObj.character_dynamics = Array.isArray(parsedData.characterDynamics) ? parsedData.characterDynamics : [];

    const turnResult = await this.saveTurn(sessionId, turnIndex, userInput, cleanJsonObj, updatedEntities, salienceMap, performanceMetrics);

    // Decorate turnResult with temporary block0 for UI
    if (temporaryBlock0) {
        turnResult.uiOnlyBlock0 = temporaryBlock0;
    }

    // Update session context in memory
    sessionContext.session.turnCount = turnIndex;
    sessionContext.session.updatedAt = turnResult.createdAt;
    sessionContext.session.salienceMap = salienceMap;

    sessionContext.turns.push(turnResult);
    
    // RAM Memory Synchronization: Ensure RAM GC runs in parallel with DB GC
    // Strip character_dynamics and salienceMap from old turns in RAM to prevent runaway memory bloat
    if (turnIndex % 3 === 0) {
        let ramCleanCount = 0;
        const startIdx = Math.max(0, sessionContext.turns.length - 8); // Window look back
        for (let i = startIdx; i < sessionContext.turns.length - 2; i++) {
            const t = sessionContext.turns[i];
            let cleaned = false;
            if (t.aiResponse && t.aiResponse.character_dynamics && t.aiResponse.character_dynamics.length > 0) {
                t.aiResponse.character_dynamics = [];
                cleaned = true;
            }
            if (t.salienceMap && Object.keys(t.salienceMap).length > 0) {
                t.salienceMap = null;
                cleaned = true;
            }
            if (cleaned) {
                ramCleanCount++;
            }
        }
        if (ramCleanCount > 0) {
            console.log(`[GC RAM] Cleaned character_dynamics and salienceMap from ${ramCleanCount} old turns in memory.`);
        }
    }
    
    // Maintain sliding window based on reactive settings state
    const generalSettings = await settingsManager.loadSetting("general");
    const windowSize = generalSettings?.slidingWindowSize || 10;

    sessionContext.slidingWindow.push(turnResult);
    while (sessionContext.slidingWindow.length > windowSize) {
      sessionContext.slidingWindow.shift();
    }

    eventBus.emit(EVENTS.TURN_COMPLETED, turnResult); // Emitted AFTER session state is synchronized

    return turnResult;
    } finally {
      this.isProcessing = false;
    }
  }

  parseThreeBlockResponse(rawText) {
    if (!rawText) return { block1: '', block2: [], block3: '', characterDynamics: [] };

    // Simply delegate to shared text parser.
    const parsed = parseBlocks(rawText);

    // Apply additional NarrativeEngine-specific sanitation for Character Dynamics
    if (!parsed.block3 || parsed.block3.trim() === '') {
        parsed.block3 = DEFAULT_SILENT_REACTION;
    }
    
    parsed.characterDynamics = this._sanitizeCharacterDynamics(parsed.characterDynamics || []);
    
    // In some cases block2 might be stringified by parseBlocks fallback.
    // parseChoices will handle both string and array.
    return parsed;
  }

  _sanitizeCharacterDynamics(dynamics) {
      if (!Array.isArray(dynamics)) return [];
      return dynamics.map(d => {
          let primaryRoleRaw = d.primary_role || d.primaryRole || d.role || d.primary_state || d.primaryState || '';
          let primary_role = typeof primaryRoleRaw === 'string' ? primaryRoleRaw.toLowerCase() : '';
          
          let modality_modifiers = d.modality_modifiers || d.modalityModifiers || {};

          let salience = ROLE_TO_SALIENCE[primary_role];
          if (!salience) {
              if (['initiator', 'primary_target', 'active_reactor'].includes(primary_role)) {
                  salience = 'high';
              } else if (['supportive_actor', 'silent_observer'].includes(primary_role)) {
                  salience = 'medium';
              } else if (['ambient_presence'].includes(primary_role)) {
                  salience = 'low';
              } else if (['offscreen_catalyst', 'mentioned_entity'].includes(primary_role)) {
                  salience = 'trace';
              } else {
                  // Fallback mapping for legacy models producing older schema values
                  if (primary_role === 'speaking' || primary_role === 'acting') {
                      salience = 'high';
                      primary_role = 'initiator';
                  } else if (primary_role === 'offscreen_relevant' || primary_role === 'reacting') {
                      salience = 'medium';
                      primary_role = 'active_reactor';
                  } else if (primary_role === 'passive_presence') {
                      salience = 'low';
                      primary_role = 'ambient_presence';
                  } else if (primary_role === 'mentioned_only') {
                      salience = 'trace';
                      primary_role = 'mentioned_entity';
                  } else {
                      salience = 'trace'; // default mapped trace
                  }
              }
          }

          // Rule enforcement
          if (['offscreen_catalyst', 'mentioned_entity'].includes(primary_role)) {
              modality_modifiers = {};
          } else if (primary_role === 'ambient_presence' && modality_modifiers) {
              modality_modifiers.emotional_shift = 'neutral';
          }

          return { full_name: d.full_name || d.name || 'Unknown', salience, primary_role, modality_modifiers };
      });
  }

  _normalizeBlock2(block2Data) {
    if (!block2Data) return [];
    try {
      let choices;
      if (typeof block2Data === 'string') {
        try {
          let parsed = JSON.parse(block2Data);
          choices = Array.isArray(parsed) ? parsed : (parsed.block_2_label_and_description || parsed.choices || []);
        } catch (e) {
          // If it fails to parse as JSON, treat it as a single string choice
          choices = [{ label: block2Data, description: '' }];
        }
      } else if (Array.isArray(block2Data)) {
        choices = block2Data;
      } else if (typeof block2Data === 'object') {
        choices = block2Data.block_2_label_and_description || block2Data.choices || [];
      } else {
        choices = [];
      }

      return Array.isArray(choices) ? choices.map(c => {
         if (typeof c === 'string') {
           return { label: c, description: '' };
         }
         return {
           label: String(c.label || ''),
           description: String(c.description || '')
         };
      }) : [];
    } catch (e) {
      console.warn("Failed to normalize block2:", e);
      return [];
    }
  }

  parseChoices(block2Data) {
    const normalized = this._normalizeBlock2(block2Data);
    return this._padChoices(normalized);
  }

  _padChoices(parsedChoices) {
    const choices = [];
    for (let i = 0; i < 4; i++) {
       if (parsedChoices[i]) {
         choices.push({ ...parsedChoices[i], number: i + 1 });
       } else {
         // Default empty option if AI outputs < 4 choices
         choices.push({ number: i + 1, label: "...", description: "" });
       }
    }
    choices.push({ isCustom: true, label: "Custom Choice", description: "Type anything for custom action..." });
    return choices;
  }

  async saveTurn(sessionId, turnIndex, userInput, fullRawResponse, entities = null, salienceMap = null, metrics = null) {
    const turn = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
      sessionId,
      turnIndex,
      userInput,
      aiResponse: fullRawResponse,
      salienceMap: salienceMap ? JSON.parse(JSON.stringify(salienceMap)) : null,
      metrics: metrics,
      createdAt: Date.now()
    };

    await db.transaction('rw', db.turns, db.game_sessions, async () => {
      const sessionExists = await db.game_sessions.get(sessionId);
      if (!sessionExists) return; // Session has been deleted, abort background write

      await db.turns.add(turn);
      
      const updatePayload = {
        turnCount: turnIndex,
        updatedAt: Date.now(),
        status: 'active'
      };
      if (entities !== null) {
        updatePayload.entities = entities;
      }
      if (salienceMap !== null) {
        updatePayload.salienceMap = salienceMap;
      }
      
      await db.game_sessions.update(sessionId, updatePayload);
    });

    // GC Lifecycle: Cleanup character_dynamics and salienceMap every 3 turns to prevent DB bloat
    // Executed in a separate, isolated transaction to prevent GC failures from rolling back the main turn insertion.
    if (turnIndex % 3 === 0) {
        try {
            await db.transaction('rw', db.turns, async () => {
                const gcFromIndex = Math.max(1, turnIndex - 6); // Look back 6 turns (2 GC cycles)
                const gcToIndex = turnIndex - 2;

                if (gcFromIndex <= gcToIndex) {
                    const allRecentTurns = await db.turns
                        .where('[sessionId+turnIndex]')
                        .between([sessionId, gcFromIndex], [sessionId, gcToIndex], true, true)
                        .toArray();
                        
                    const oldTurns = allRecentTurns.filter(t => 
                        (t.aiResponse?.character_dynamics?.length > 0) || 
                        (t.salienceMap && Object.keys(t.salienceMap).length > 0)
                    );
                        
                    if (oldTurns.length > 0) {
                        const updates = oldTurns.map(t => {
                            let safeCopy = null;
                            if (t.aiResponse) {
                                safeCopy = JSON.parse(JSON.stringify(t.aiResponse));
                                safeCopy.character_dynamics = [];
                            }
                            
                            return { 
                                ...t, 
                                aiResponse: safeCopy || t.aiResponse,
                                salienceMap: null
                            };
                        });
                        await db.turns.bulkPut(updates);
                        console.log(`[GC] Cleaned character_dynamics and salienceMap from ${oldTurns.length} old turns.`);
                    }
                }
            });
        } catch (gcErr) {
            console.error(`[GC] Background cleanup failed for session ${sessionId}:`, gcErr);
        }
    }

    return turn;
  }
}

export const narrativeEngine = new NarrativeEngine();
