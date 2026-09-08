import { db } from './db.js';
import { eventBus } from './event-bus.js';
import { DEFAULT_EXPERTS } from './default-experts.js';
import { EVENTS } from '../core/events.js';

class SettingsManager {
  constructor() {
    this.initPromise = this._init();
    // Maintain backwards compatibility fallback
    this.initP = this.initPromise;
  }

  async init() {
    return await this.initPromise;
  }

  async _init() {
    try {
      // Seed default providers if DB is empty
      const providersCount = await db.providers.count();
      if (providersCount === 0) {
        console.log('[SettingsManager] Seeding default provider...');
        await db.providers.put({
          id: 'provider_env_gemini',
          name: 'Environment API Key (Gemini)',
          baseUrl: 'https://generativelanguage.googleapis.com',
          format: 'google',
          keys: ['ENV_API_KEY'],
          capabilities: {
            topK: true,
            thinking: true,
            systemRole: true,
            responseFormat: true
          }
        });
      }

      // Seed default experts if DB is empty
      const expertsCount = await db.experts.count();
      if (expertsCount === 0) {
        console.log('[SettingsManager] Seeding default experts...');
        const configuredExperts = DEFAULT_EXPERTS.map(e => ({
          ...e,
          providerId: 'provider_env_gemini',
          modelName: e.id === 'EMBED_PRIMARY' ? 'text-embedding-004' : 'gemini-2.5-flash'
        }));
        await db.experts.bulkPut(configuredExperts);
      }
      
      // Default memory settings
      const memory = await db.settings.get("memory");
      if (!memory) {
        await db.settings.put({ 
          key: "memory", 
          a1TriggerTurns: 5, 
          a2TriggerCount: 5, 
          a3TriggerCount: 5, 
          tokenBudget: 10000, 
          ragKbTokenBudget: 10000,
          chunkTargetTokens: 512,
          safeInputLimit: 160000,
          systemTokens: 40000,
          userTokens: 100000
        });
      } else {
        let changed = false;
        if (!memory.tokenBudget) {
          memory.tokenBudget = 10000;
          changed = true;
        }
        if (!memory.ragKbTokenBudget && memory.ragKbTokenBudget !== 0) {
          memory.ragKbTokenBudget = 10000;
          changed = true;
        }
        if (!memory.chunkTargetTokens) {
          memory.chunkTargetTokens = 512;
          changed = true;
        }
        if (!memory.safeInputLimit) {
          memory.safeInputLimit = 160000;
          changed = true;
        }
        if (!memory.systemTokens) {
          memory.systemTokens = 40000;
          changed = true;
        }
        if (!memory.userTokens) {
          memory.userTokens = 100000;
          changed = true;
        }
        if (changed) {
          await db.settings.put(memory);
        }
      }

      // Default general settings
      const general = await db.settings.get("general");
      if (!general) {
        await db.settings.put({ key: "general", slidingWindowSize: 10 });
      }

      // Default display settings
      const display = await db.settings.get("display");
      if (!display) {
        await db.settings.put({ key: "display", theme: "dark", turnsPerPage: 10, proseSize: "standard", fontFamily: "lora" });
      } else {
        let displayChanged = false;
        if (!("turnsPerPage" in display)) {
          display.turnsPerPage = 10;
          displayChanged = true;
        }
        if (!("proseSize" in display)) {
          display.proseSize = "standard";
          displayChanged = true;
        }
        if (!("fontFamily" in display)) {
          display.fontFamily = "lora";
          displayChanged = true;
        }
        if (displayChanged) {
          await db.settings.put(display);
        }
      }
    } catch (err) {
      console.error("[SettingsManager] Init error:", err);
      throw err;
    }
  }

  async loadSetting(key) {
    await this.initPromise;
    return await db.settings.get(key);
  }

  async saveSetting(key, valueObj) {
    await this.initPromise;
    await db.settings.put({ key, ...valueObj });
    eventBus.emit(EVENTS.SETTINGS_CHANGED, { key, value: valueObj });
  }

  async loadAllProviders() {
    await this.initPromise;
    return await db.providers.toArray();
  }

  async saveProvider(provider) {
    await this.initPromise;
    await db.providers.put(provider);
    eventBus.emit(EVENTS.SETTINGS_CHANGED, { key: "providers" });
  }

  async deleteProvider(id) {
    await this.initPromise;
    await db.transaction('rw', db.providers, db.experts, async () => {
      await db.providers.delete(id);
      // Also explicitly remove providerId from attached experts
      const expertsToUpdate = await db.experts.where('providerId').equals(id).toArray();
      for (const expert of expertsToUpdate) {
        expert.providerId = null;
        await db.experts.put(expert);
      }
    });
    eventBus.emit(EVENTS.SETTINGS_CHANGED, { key: "providers" });
  }

  async loadAllExperts() {
    await this.initPromise;
    // ensure they come out in the predictable list order defined by DEFAULT_EXPERTS
    const experts = await db.experts.toArray();
    const orderMap = new Map(DEFAULT_EXPERTS.map((val, idx) => [val.id, idx]));
    experts.sort((a, b) => (orderMap.get(a.id) ?? 99) - (orderMap.get(b.id) ?? 99));
    return experts;
  }

  async saveExpert(expert) {
    await this.initPromise;
    await db.experts.put(expert);
    eventBus.emit(EVENTS.SETTINGS_CHANGED, { key: "experts", expertId: expert.id });
  }

  async bulkImportSettings(data) {
    await this.initPromise;
    await db.transaction('rw', db.providers, db.experts, db.settings, async () => {
      if (Array.isArray(data.providers) && data.providers.length > 0) {
        await db.providers.clear();
        const validProviders = data.providers.filter(p => 
          p && typeof p.id === 'string' && 
          typeof p.baseUrl === 'string' && 
          Array.isArray(p.keys)
        );
        if (validProviders.length) await db.providers.bulkPut(validProviders);
      }

      if (Array.isArray(data.experts) && data.experts.length > 0) {
        await db.experts.clear();
        
        const currentProviders = await db.providers.toArray();
        const validProviderIds = new Set(currentProviders.map(p => p.id));

        const cleanExperts = data.experts.map(expert => {
          const e = { ...expert };
          delete e.systemPrompt;
          if (e.providerId && !validProviderIds.has(e.providerId)) {
            return { ...e, providerId: null };
          }
          return e;
        });

        await db.experts.bulkPut(cleanExperts);
        
        // Ensure all default experts exist (import may be partial or missing core logic experts like EXPERT_NARRATIVE)
        for (const defaultExpert of DEFAULT_EXPERTS) {
          const exists = await db.experts.get(defaultExpert.id);
          if (!exists) {
            const { systemPrompt, ...expertWithoutPrompt } = defaultExpert;
            await db.experts.put(expertWithoutPrompt);
          }
        }
      }

      if (data.settings?.general) await db.settings.put({ key: "general", ...data.settings.general });
      if (data.settings?.display) await db.settings.put({ key: "display", ...data.settings.display });
      if (data.settings?.memory) await db.settings.put({ key: "memory", ...data.settings.memory });
    });
    eventBus.emit(EVENTS.SETTINGS_CHANGED, { key: "all" });
  }
}

export const settingsManager = new SettingsManager();
