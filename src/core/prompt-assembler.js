import { workerBridge } from '../workers/worker-bridge.js';
import { settingsManager } from './settings-manager.js';

class PromptAssembler {
  async buildPayload(sessionId, userInput, sessionContext, retrievedMemories, retrievedKbMemories = []) {
    let memory = await settingsManager.loadSetting("memory") || {};
    let safeInputLimit = memory.safeInputLimit ?? 160000;
    let systemTokens = memory.systemTokens ?? 40000;
    let userTokens = memory.userTokens ?? 100000;
    let tokenBudget = memory.tokenBudget ?? 10000;
    let ragKbTokenBudget = memory.ragKbTokenBudget ?? 10000;

    // Fallback if system + user tokens exceed safe limit (RAG budgets are sub-limits of userTokens)
    if (systemTokens + userTokens > safeInputLimit) {
      console.warn('[PromptAssembler] Budget sum exceeded safeInputLimit. Resetting to defaults.');
      safeInputLimit = 160000;
      systemTokens = 40000;
      userTokens = 100000;
      tokenBudget = 10000;
      ragKbTokenBudget = 10000;
      
      memory.safeInputLimit = safeInputLimit;
      memory.systemTokens = systemTokens;
      memory.userTokens = userTokens;
      memory.tokenBudget = tokenBudget;
      memory.ragKbTokenBudget = ragKbTokenBudget;
      await settingsManager.saveSetting("memory", memory);
    }

    return await workerBridge.dispatch('BUILD_PROMPT', {
      sessionId,
      userInput,
      sessionContext: {
        session: sessionContext.session,
        memoryTree: sessionContext.memoryTree,
        resolvedMilestones: sessionContext.resolvedMilestones,
        milestones: sessionContext.milestones,
        slidingWindow: sessionContext.slidingWindow
      },
      retrievedMemories,
      retrievedKbMemories,
      safeInputLimit,
      systemTokens,
      userTokens,
      tokenBudget,
      ragKbTokenBudget
    });
  }
}

export const promptAssembler = new PromptAssembler();

