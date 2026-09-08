import { getProviderFormat } from '../utils/api-utils.js';
import { eventBus } from './event-bus.js';
import { DEFAULT_EXPERTS } from './default-experts.js';
import { db, DEXIE_MIN_KEY, DEXIE_MAX_KEY } from './db.js';
import { workerBridge } from '../workers/worker-bridge.js';
import { keyRotator } from './key-rotator.js';
import { settingsManager } from './settings-manager.js';
import { EVENTS } from '../core/events.js';
import { REASONING_CLEANUP_REGEX } from './ai-constants.js';

class MemoryManager {
  constructor() {
    this.jobQueue = []; // Use array instead of Promise chaining to prevent memory leak
    this.isSummarizing = false;

    this._cachedExpert = null;
    this._cachedProvider = null;
    this._cacheTime = 0;

    eventBus.on(EVENTS.TURN_COMPLETED, async (data) => {
      const { sessionId, turnIndex } = data;
      try {
        await this.evaluateTriggers(sessionId, turnIndex);
      } catch (err) {
        console.error("[MemoryManager] evaluateTriggers failed:", err);
      }
    });

    eventBus.on(EVENTS.SESSION_LOADED, async (sessionContext) => {
      try {
        await this.detectMissingTriggers(sessionContext.session.id);
      } catch (err) {
        console.error("[MemoryManager] Fallback missing trigger detection failed:", err);
      }
    });

    eventBus.on(EVENTS.SETTINGS_CHANGED, ({ key, expertId }) => {
      // Note: If settings change while a memory job is actively running (e.g., awaiting LLM response),
      // that specific in-flight job will continue using the old configuration it captured when it started.
      // This is acceptable behavior as it ensures request consistency for the in-flight job.
      // The newly invalidated cache below guarantees that the *next* processed job will pick up the updated settings.
      if ((key === 'experts' && expertId === 'EXPERT_SUMMARIZE') || 
          key === 'providers' || key === 'all') {
        this._cachedExpert = null;
        this._cachedProvider = null;
      }
    });
  }

  async getExpertConfig() {
    const now = Date.now();
    
    // Cache configuration for 60 seconds to prevent hammering the DB per turn
    if (!this._cachedExpert || !this._cachedProvider || (now - this._cacheTime > 60000)) {
      const expert = await db.experts.get('EXPERT_SUMMARIZE');
      if (!expert || !expert.providerId) {
        throw new Error("EXPERT_SUMMARIZE is unconfigured. Please assign a provider/model in Settings.");
      }
      
      const provider = await db.providers.get(expert.providerId);
      if (!provider) throw new Error("Provider not found for summarize expert");

      this._cachedExpert = expert;
      this._cachedProvider = provider;
      this._cacheTime = now;
    }

    const expert = this._cachedExpert;
    const provider = this._cachedProvider;
    const apiKey = await keyRotator.getNextKey(provider.id);
    const format = getProviderFormat(provider);

    return {
      model: expert.modelName,
      baseUrl: provider.baseUrl,
      format,
      apiKey,
      thinkingBudget: expert.thinkingBudget,
      capabilities: provider.capabilities,
      params: {
        temperature: expert.temperature !== undefined && expert.temperature !== "" ? Number(expert.temperature) : 0.7,
        topP: expert.topP !== undefined && expert.topP !== "" ? Number(expert.topP) : 0.9,
        topK: expert.topK !== undefined && expert.topK !== "" ? Number(expert.topK) : 0,
        maxTokens: expert.maxTokens !== undefined && expert.maxTokens !== "" ? Number(expert.maxTokens) : 0
      },
      systemPrompt: (DEFAULT_EXPERTS.find(e => e.id === 'EXPERT_SUMMARIZE')?.systemPrompt || "")
    };
  }

  enqueueJob(jobFn) {
    this.jobQueue.push(jobFn);
    this.processMemoryQueue();
  }

  async processMemoryQueue() {
    if (this.isSummarizing) return;
    
    this.isSummarizing = true;
    eventBus.emit(EVENTS.MEMORY_SUMMARIZE_START);

    try {
      while (this.jobQueue.length > 0) {
        const jobFn = this.jobQueue.shift();
        try {
          await jobFn();
        } catch (err) {
          console.error("Memory job failed:", err);
          eventBus.emit(EVENTS.MEMORY_TASK_FAILED, { error: err });
        }
      }
    } finally {
      this.isSummarizing = false;
      eventBus.emit(EVENTS.MEMORY_SUMMARIZE_END);
    }
  }

  async evaluateTriggers(sessionId, newTurnIndex) {
    const memSettings = await settingsManager.loadSetting("memory") || { a1TriggerTurns: 5, a2TriggerCount: 5, a3TriggerCount: 5 };
    const { a1TriggerTurns, a2TriggerCount, a3TriggerCount } = memSettings;
    
    let shouldTriggerA1 = false;
    // IF (newTurnIndex % a1TriggerTurns === 0): queue SUMMARIZE_A1 job
    if (newTurnIndex > 0 && newTurnIndex % a1TriggerTurns === 0) {
        const fromTurnIndex = newTurnIndex - a1TriggerTurns + 1;
        
        // ⚠️ EXPEDIENT IMPLEMENTATION
        // Context: DB add() might fail occasionally (quota exceeded, conflicts). 
        // Known issues: We swallow the error and rely on subsequent triggers or session load detection.
        // Proper solution: A persistent job queue runner tracking state external to DB.
        // Ticket: TODO: Add robust persistent background job queue.
        try {
            await db.transaction('rw', db.summary_tasks, db.game_sessions, async () => {
                const sessionExists = await db.game_sessions.get(sessionId);
                if (!sessionExists) return;
                await db.summary_tasks.add({
                    sessionId,
                    fromTurn: fromTurnIndex,
                    toTurn: newTurnIndex,
                    tier: 1,
                    retries: 0
                });
            });
            shouldTriggerA1 = true;
        } catch (err) {
            console.error("[MemoryManager] Failed to insert summary task:", err);
            // shouldTriggerA1 remains false - detectMissingTriggers will catch it on session reload
        }
    }

    const pendingCount = await db.summary_tasks.where('sessionId').equals(sessionId).count();
    if (pendingCount > 0 || shouldTriggerA1) {
        this.enqueueJob(async () => {
            await this.processPendingTasks(sessionId);
        });
    }
  }

  async detectMissingTriggers(sessionId) {
    const memSettings = await settingsManager.loadSetting("memory") || { a1TriggerTurns: 5, a2TriggerCount: 5, a3TriggerCount: 5 };
    const { a1TriggerTurns } = memSettings;

    // Fast indexed query for the maximum turn index in the session
    const lastTurnArr = await db.turns
      .where('[sessionId+turnIndex]')
      .between([sessionId, DEXIE_MIN_KEY()], [sessionId, DEXIE_MAX_KEY()])
      .reverse()
      .limit(1)
      .toArray();

    if (lastTurnArr.length === 0) return;
    
    const maxTurnIndex = lastTurnArr[0].turnIndex;
    let addedTasks = false;
    
    for (let currentMax = a1TriggerTurns; currentMax <= maxTurnIndex; currentMax += a1TriggerTurns) {
        const fromTurn = currentMax - a1TriggerTurns + 1;
        
        // Skip if memory already exists
        const memoryFound = await db.memory_tree
          .where('sessionId').equals(sessionId)
          .and(m => m.tier === 1 && m.coversTurns.to === currentMax)
          .first();
        if (memoryFound) continue;
        
        // Skip if task already exists
        const taskFound = await db.summary_tasks
          .where('sessionId').equals(sessionId)
          .and(t => t.tier === 1 && t.toTurn === currentMax)
          .first();
        if (taskFound) continue;
        
        console.warn(`[MemoryManager] Found missing A1 trigger for turns ${fromTurn}-${currentMax}. Adding recovery task.`);
        try {
            await db.transaction('rw', db.summary_tasks, db.game_sessions, async () => {
                const sessionExists = await db.game_sessions.get(sessionId);
                if (!sessionExists) return;
                await db.summary_tasks.add({
                    sessionId,
                    fromTurn,
                    toTurn: currentMax,
                    tier: 1,
                    retries: 0
                });
            });
        } catch (err) {
            console.error("[MemoryManager] DB insert failed in detectMissingTriggers:", err);
        }
        
        addedTasks = true;
    }
    
    if (addedTasks) {
        this.enqueueJob(async () => {
            await this.processPendingTasks(sessionId);
        });
    }
  }

  async processPendingTasks(sessionId) {
      let tasks = await db.summary_tasks.where('sessionId').equals(sessionId).toArray();
      tasks.sort((a,b) => (a.tier - b.tier) || (a.id - b.id));

      let needsHigherTierCheck = false;

      for (const t of tasks) {
          if (t.retries >= 3 && !t.manualTrigger) {
              // Retain dead tasks in DB to hold quota reservations.
              // This prevents checkHigherTiers and detectMissingTriggers from endlessly recreating them.
              continue; // Exceeded auto retry max
          }

          try {
             let statusResult = { status: 'COMPLETED' };
             if (t.tier === 1) {
                 statusResult = await this.runSummarizeA1(sessionId, t.toTurn, t.toTurn - t.fromTurn + 1) || { status: 'COMPLETED' };
                 needsHigherTierCheck = true;
             } else if (t.tier === 2) {
                 statusResult = await this.runSummarizeA2(sessionId, t.triggerCount) || { status: 'COMPLETED' };
                 needsHigherTierCheck = true;
             } else if (t.tier === 3) {
                 statusResult = await this.runSummarizeA3(sessionId, t.triggerCount) || { status: 'COMPLETED' };
             }
             
             await db.summary_tasks.delete(t.id);
             
             if (statusResult.status === 'SKIPPED') {
                 eventBus.emit(EVENTS.MEMORY_TASK_SKIPPED, { reason: statusResult.reason, task: t });
             } else {
                 eventBus.emit(EVENTS.MEMORY_TASK_SUCCESS, t);
             }
          } catch(e) {
             console.error("Summary task failed", t, e);
             const newRetries = t.retries + 1;
             
             // Always update retries instead of deleting, converting the task into a dead-letter
             // queue item once it exceeds 3 retries. This is required to prevent rebound task creation.
             await db.summary_tasks.update(t.id, { retries: newRetries, manualTrigger: false });
             eventBus.emit(EVENTS.MEMORY_TASK_FAILED, { task: t, error: e });
          }
      }

      if (needsHigherTierCheck) {
          const addedTasks = await this.checkHigherTiers(sessionId);
          if (addedTasks) {
              // Note: enqueueJob pushes to this.jobQueue. Since this is executed within the 
              // processMemoryQueue() context which runs a `while (this.jobQueue.length > 0)`
              // loop, this job will be processed synchronously at the end of the *current*
              // loop execution rather than spawning a detached parallel process. This 
              // recursive re-enqueue is safe because checkHigherTiers guarantees convergence 
              // by only returning true when unsummarized tiers strictly exceed thresholds.
              this.enqueueJob(async () => {
                  await this.processPendingTasks(sessionId);
              });
          }
      }
  }

  async checkHigherTiers(sessionId) {
        let addedTasks = false;
        const memSettings = await settingsManager.loadSetting("memory") || { a1TriggerTurns: 5, a2TriggerCount: 5, a3TriggerCount: 5 };
        const { a2TriggerCount, a3TriggerCount } = memSettings;
        
        await db.transaction('rw', db.memory_tree, db.summary_tasks, db.game_sessions, async () => {
            const sessionExists = await db.game_sessions.get(sessionId);
            if (!sessionExists) return; // Session has been deleted, abort background write

            let pendingT2Tasks = await db.summary_tasks.where('sessionId').equals(sessionId).and(t => t.tier === 2).toArray();
            let reservedA1 = pendingT2Tasks.reduce((sum, t) => sum + (t.triggerCount || 0), 0);

            let pendingT3Tasks = await db.summary_tasks.where('sessionId').equals(sessionId).and(t => t.tier === 3).toArray();
            let reservedA2 = pendingT3Tasks.reduce((sum, t) => sum + (t.triggerCount || 0), 0);

            let a1Count = await db.memory_tree.where('[sessionId+tier+isSummarized]').equals([sessionId, 1, 0]).count();
            a1Count -= reservedA1;
            while (a1Count >= a2TriggerCount) {
                 await db.summary_tasks.add({ sessionId, tier: 2, triggerCount: a2TriggerCount, retries: 0 });
                 a1Count -= a2TriggerCount;
                 addedTasks = true;
            }

            let a2Count = await db.memory_tree.where('[sessionId+tier+isSummarized]').equals([sessionId, 2, 0]).count();
            a2Count -= reservedA2;
            while (a2Count >= a3TriggerCount) {
                 await db.summary_tasks.add({ sessionId, tier: 3, triggerCount: a3TriggerCount, retries: 0 });
                 a2Count -= a3TriggerCount;
                 addedTasks = true;
            }
        });

        return addedTasks;
  }

  async runManualRetry(sessionId) {
      let tasks = await db.summary_tasks.where('sessionId').equals(sessionId).toArray();
      let updated = false;
      for (let t of tasks) {
          if (t.retries >= 3) {
              await db.summary_tasks.update(t.id, { manualTrigger: true, retries: 0 });
              updated = true;
          }
      }
      if (updated) {
          this.enqueueJob(async () => {
              await this.processPendingTasks(sessionId);
          });
      }
  }

  async runSummarizeA1(sessionId, toTurnIndex, a1Turns) {
    const fromTurnIndex = toTurnIndex - a1Turns + 1;
    
    if (!sessionId || !Number.isFinite(fromTurnIndex) || !Number.isFinite(toTurnIndex)) {
        throw new Error(`[MemoryManager] Invalid bounds for runSummarizeA1: from=${fromTurnIndex}, to=${toTurnIndex}, sessionId=${sessionId}`);
    }

    // Get last N turns
    const turns = await db.turns
      .where('[sessionId+turnIndex]')
      .between([sessionId, fromTurnIndex], [sessionId, toTurnIndex], true, true)
      .toArray();

    if (turns.length === 0) {
      console.warn(`No turns found for A1 summary up to turn ${toTurnIndex}. Aborting.`);
      return { status: 'SKIPPED', reason: 'no_turns' };
    }

    if (turns.length !== a1Turns) {
      console.warn(`Expected ${a1Turns} turns for A1 summary, found ${turns.length}.`);
    }

    const baseExpertConfig = await this.getExpertConfig();
    const systemPrompt = baseExpertConfig.systemPrompt.replace(/\{tier\}/g, "A1");

    const baseSchemaProperties = {
      TIMELINE: { type: "string", description: "Khi nào các sự kiện trong phạm vi này xảy ra?" },
      EVENTS_AND_ACTIONS: { type: "string", description: "Chuyện gì đã xảy ra?" },
      KNOWLEDGE_AND_FACTS: { type: "string", description: "Sự thật đã được thiết lập." },
      CONSTRAINTS: { type: "string", description: "Những điều không được vi phạm khi tiếp tục câu chuyện." },
      OBJECTS_AND_ARTIFACTS: { type: "string", description: "Vật thể quan trọng." }
    };
    const requiredFields = Object.keys(baseSchemaProperties);

    const a1Schema = {
      type: "json_schema",
      json_schema: {
        name: "A1SummaryResponse",
        strict: true,
        schema: {
          type: "object",
          properties: {
            summary: {
              type: "object",
              properties: baseSchemaProperties,
              required: requiredFields,
              additionalProperties: false
            }
          },
          required: ["summary"],
          additionalProperties: false
        }
      }
    };
    
    // Inject the structured formatting configuration
    const expertConfig = {
      ...baseExpertConfig,
      systemPrompt,
      responseFormat: a1Schema
    };

    const result = await workerBridge.summarizeA1({
      turns,
      expertConfig
    });

    const parsed = this.parseA1Response(result.rawResponse);

    await this.onA1Complete(sessionId, {
      summary: parsed.summary
    }, result.coversTurns);
    
    return { status: 'COMPLETED' };
  }

  tryParseLLMJson(rawText) {
    if (!rawText || typeof rawText !== 'string') return rawText;
    let cleanText = rawText.trim();
    if (!cleanText) return {};
    
    // Bước 1: Xóa rác suy luận (remove <think>...</think>, <thinking>...</thinking>)
    // Sử dụng Regex có End-of-String (EOS) Tolerance để đề phòng mô hình unclosed tag.
    cleanText = cleanText.replace(REASONING_CLEANUP_REGEX, '').trim();
    
    let jsonStr = cleanText;
    
    // Bước 2: Trích xuất Regex Markdown
    const match = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (match) {
      jsonStr = match[1].trim();
    } else {
      // Bước 3: Trích xuất dấu ngoặc nhọn - Fallback Cực Mạnh
      const firstBrace = cleanText.indexOf('{');
      const lastBrace = cleanText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
        jsonStr = cleanText.substring(firstBrace, lastBrace + 1);
      }
    }
    
    // Bước 3.5: Auto-Heal JSON strings
    // Chống trailing commas (loại bỏ dấu phẩy dư thừa ở cuối object/array)
    // Ví dụ: {"summary": "abc", } -> {"summary": "abc" }
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
    // Chống Invalid Control Characters (loại bỏ control chars ẩn, nguyên nhân gây đứt gãy parse)
    // Lưu ý: Loại bỏ luôn cả unescaped real newlines (vốn làm JSON.parse crash nếu nằm trong chuỗi)
    jsonStr = jsonStr.replace(/[\u0000-\u001F]+/g, "");

    // Bước 4: Parse
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // Tầng Cứu hộ thứ 2 (Second-life Catch): Auto-Heal cấu trúc nếu JSON hỏng
      try {
        console.warn("LLM JSON First Parse Error:", e.message, "-> Attempting Auto-Heal Second-life Catch");
        
        let repairedStr = jsonStr;
        
        // Sửa các ngoặc kép chưa được un-escaped ở giữa chuỗi (Heuristic: tìm ngoặc kép kẹp giữa các ký tự chữ)
        // Ví dụ: "He said "hello" to me" -> "He said \\"hello\\" to me"
        repairedStr = repairedStr.replace(/([a-zA-Z0-9.?!])"([a-zA-Z0-9.?!])/g, '$1\\"$2');
        
        // Cứu hộ block bị đứt gãy bằng cách đếm ngoặc (bracket matching)
        const openBraces = (repairedStr.match(/\{/g) || []).length;
        const closeBraces = (repairedStr.match(/\}/g) || []).length;
        if (openBraces > closeBraces) {
            repairedStr += '}'.repeat(openBraces - closeBraces);
        }

        const openBrackets = (repairedStr.match(/\[/g) || []).length;
        const closeBrackets = (repairedStr.match(/\]/g) || []).length;
        if (openBrackets > closeBrackets) {
             repairedStr += ']'.repeat(openBrackets - closeBrackets);
        }
        
        // Quét lại rule chống trailing comma phòng khi việc thêm ngoặc sinh ra comma mới kẹt lại
        repairedStr = repairedStr.replace(/,\s*([}\]])/g, '$1');

        const finalParsed = JSON.parse(repairedStr);
        console.info("LLM JSON Auto-Heal Second-life Catch SUCCESS.");
        return finalParsed;
      } catch (e2) {
        console.warn("LLM JSON Auto-Heal Final Parse Error:", e2.message);
        return null;
      }
    }
  }

  formatMemoryFields(summaryObj) {
    if (!summaryObj || typeof summaryObj !== 'object') return String(summaryObj || '');
    
    const targetObj = summaryObj.summary || summaryObj;

    const fields = [
      "TIMELINE", "EVENTS_AND_ACTIONS", "KNOWLEDGE_AND_FACTS", "CONSTRAINTS", "OBJECTS_AND_ARTIFACTS"
    ];
    let result = [];
    for (const field of fields) {
      if (targetObj[field]) {
        result.push(`### [${field.replace(/_/g, ' ')}]\n${targetObj[field]}`);
      }
    }
    
    // Support fallback for old format if it occurs
    if (result.length === 0) {
      if (targetObj.Summary_Name && targetObj.Summary_Content) {
         return `**${targetObj.Summary_Name}**\n\n${targetObj.Summary_Content}`;
      }
      return String(targetObj);
    }
    return result.join('\n\n');
  }

  parseA1Response(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return { 
        summary: rawText?.summary ? this.formatMemoryFields(rawText.summary) : String(rawText || '') 
      };
    }
    
    const parsed = this.tryParseLLMJson(rawText);
    if (parsed) {
      return { 
        summary: this.formatMemoryFields(parsed.summary || parsed)
      };
    }
    return { summary: rawText };
  }

  async onA1Complete(sessionId, result, coversTurnRange) {
    const memoryRecord = {
      id: crypto.randomUUID(),
      sessionId,
      tier: 1,
      content: result.summary,
      coversTurns: coversTurnRange,
      createdAt: Date.now(),
      isSummarized: 0
    };

    let shouldAbort = false;
    await db.transaction('rw', db.memory_tree, db.game_sessions, async () => {
      const sessionExists = await db.game_sessions.get(sessionId);
      if (!sessionExists) {
        shouldAbort = true;
        return;
      }
      await db.memory_tree.add(memoryRecord);
    });

    if (shouldAbort) return;

    eventBus.emit(EVENTS.MEMORY_A1_CREATED, memoryRecord);
  }

  async runSummarizeA2(sessionId, a2Count) {
    // Get oldest unsummarized A1s safely without OOM
    const allUnsummarizedA1s = await db.memory_tree
      .where('[sessionId+tier+isSummarized]')
      .equals([sessionId, 1, 0])
      .toArray();

    allUnsummarizedA1s.sort((a, b) => a.coversTurns.from - b.coversTurns.from);
    const targetA1s = allUnsummarizedA1s.slice(0, a2Count);
      
    if (targetA1s.length < a2Count) {
      return { status: 'SKIPPED', reason: 'insufficient_records' };
    }

    const baseExpertConfig = await this.getExpertConfig();
    const systemPrompt = baseExpertConfig.systemPrompt.replace(/\{tier\}/g, "A2");

    const baseSchemaProperties = {
      TIMELINE: { type: "string", description: "Khi nào các sự kiện trong phạm vi này xảy ra?" },
      EVENTS_AND_ACTIONS: { type: "string", description: "Chuyện gì đã xảy ra?" },
      KNOWLEDGE_AND_FACTS: { type: "string", description: "Sự thật đã được thiết lập." },
      CONSTRAINTS: { type: "string", description: "Những điều không được vi phạm khi tiếp tục câu chuyện." },
      OBJECTS_AND_ARTIFACTS: { type: "string", description: "Vật thể quan trọng." }
    };
    const requiredFields = Object.keys(baseSchemaProperties);

    const a2Schema = {
      type: "json_schema",
      json_schema: {
        name: "A2SummaryResponse",
        strict: true,
        schema: {
          type: "object",
          properties: {
            summary: {
              type: "object",
              properties: baseSchemaProperties,
              required: requiredFields,
              additionalProperties: false
            }
          },
          required: ["summary"],
          additionalProperties: false
        }
      }
    };
    const expertConfig = {
      ...baseExpertConfig,
      systemPrompt,
      responseFormat: a2Schema
    };

    const result = await workerBridge.summarizeA2({
      a1Summaries: targetA1s,
      expertConfig
    });

    const parsed = this.tryParseLLMJson(result.summary);
    if (parsed && parsed.summary) result.summary = this.formatMemoryFields(parsed.summary);

    const consumedA1Ids = targetA1s.map(a => a.id);
    const coversTurnRange = {
      from: targetA1s[0].coversTurns.from,
      to: targetA1s[targetA1s.length - 1].coversTurns.to,
      fromId: targetA1s[0].coversTurns.fromId,
      toId: targetA1s[targetA1s.length - 1].coversTurns.toId
    };

    await this.onA2Complete(sessionId, result, consumedA1Ids, coversTurnRange);
    
    return { status: 'COMPLETED' };
  }

  async onA2Complete(sessionId, result, consumedA1Ids, coversTurnRange) {
    const memoryRecord = {
      id: crypto.randomUUID(),
      sessionId,
      tier: 2,
      content: result.summary,
      coversTurns: coversTurnRange,
      createdAt: Date.now(),
      isSummarized: 0
    };
    
    let shouldAbort = false;
    await db.transaction('rw', db.memory_tree, db.game_sessions, async () => {
      const sessionExists = await db.game_sessions.get(sessionId);
      if (!sessionExists) {
        shouldAbort = true;
        return;
      }
      await db.memory_tree.add(memoryRecord);
      // Instead of deleting, mark them as summarized so they stay in DB but aren't re-processed
      await db.memory_tree.where('id').anyOf(consumedA1Ids).modify({ isSummarized: 1 });
    });
    
    if (shouldAbort) return;

    eventBus.emit(EVENTS.MEMORY_A2_CREATED, memoryRecord);
  }

  async runSummarizeA3(sessionId, a3Count) {
    // Get oldest unsummarized A2s safely without OOM
    const allUnsummarizedA2s = await db.memory_tree
      .where('[sessionId+tier+isSummarized]')
      .equals([sessionId, 2, 0])
      .toArray();

    allUnsummarizedA2s.sort((a, b) => a.coversTurns.from - b.coversTurns.from);
    const targetA2s = allUnsummarizedA2s.slice(0, a3Count);
      
    if (targetA2s.length < a3Count) {
      return { status: 'SKIPPED', reason: 'insufficient_records' };
    }

    const baseExpertConfig = await this.getExpertConfig();
    const systemPrompt = baseExpertConfig.systemPrompt.replace(/\{tier\}/g, "A3");

    const baseSchemaProperties = {
      TIMELINE: { type: "string", description: "Khi nào các sự kiện trong phạm vi này xảy ra?" },
      EVENTS_AND_ACTIONS: { type: "string", description: "Chuyện gì đã xảy ra?" },
      KNOWLEDGE_AND_FACTS: { type: "string", description: "Sự thật đã được thiết lập." },
      CONSTRAINTS: { type: "string", description: "Những điều không được vi phạm khi tiếp tục câu chuyện." },
      OBJECTS_AND_ARTIFACTS: { type: "string", description: "Vật thể quan trọng." }
    };
    const requiredFields = Object.keys(baseSchemaProperties);

    const a3Schema = {
      type: "json_schema",
      json_schema: {
        name: "A3SummaryResponse",
        strict: true,
        schema: {
          type: "object",
          properties: {
            summary: {
              type: "object",
              properties: baseSchemaProperties,
              required: requiredFields,
              additionalProperties: false
            }
          },
          required: ["summary"],
          additionalProperties: false
        }
      }
    };
    const expertConfig = {
      ...baseExpertConfig,
      systemPrompt,
      responseFormat: a3Schema
    };

    const result = await workerBridge.summarizeA3({
      a2Summaries: targetA2s,
      expertConfig
    });

    const parsed = this.tryParseLLMJson(result.summary);
    if (parsed && parsed.summary) result.summary = this.formatMemoryFields(parsed.summary);

    const consumedA2Ids = targetA2s.map(a => a.id);
    const coversTurnRange = {
      from: targetA2s[0].coversTurns.from,
      to: targetA2s[targetA2s.length - 1].coversTurns.to,
      fromId: targetA2s[0].coversTurns.fromId,
      toId: targetA2s[targetA2s.length - 1].coversTurns.toId
    };

    await this.onA3Complete(sessionId, result, consumedA2Ids, coversTurnRange);
    
    return { status: 'COMPLETED' };
  }

  async onA3Complete(sessionId, result, consumedA2Ids, coversTurnRange) {
    const memoryRecord = {
      id: crypto.randomUUID(),
      sessionId,
      tier: 3,
      content: result.summary,
      coversTurns: coversTurnRange,
      createdAt: Date.now(),
      isSummarized: 0
    };
    
    let shouldAbort = false;
    await db.transaction('rw', db.memory_tree, db.game_sessions, async () => {
      const sessionExists = await db.game_sessions.get(sessionId);
      if (!sessionExists) {
        shouldAbort = true;
        return;
      }
      await db.memory_tree.add(memoryRecord);
      // Instead of deleting, mark them as summarized
      await db.memory_tree.where('id').anyOf(consumedA2Ids).modify({ isSummarized: 1 });
    });
    
    if (shouldAbort) return;

    eventBus.emit(EVENTS.MEMORY_A3_CREATED, memoryRecord);
  }
}

export const memoryManager = new MemoryManager();
