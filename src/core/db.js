import { DEFAULT_EXPERTS } from './default-experts.js';

// db.js - Dexie schema & all DB operations
// Decoupled from index.html CDN load-order using a lazy Proxy initialization pattern.

let activeDb = null;

function getDbInstance() {
  if (activeDb) {
    return activeDb;
  }

  const DexieClass = typeof window !== 'undefined' ? window.Dexie : null;
  if (!DexieClass) {
    throw new Error(
      "[Dexie Engine] Dexie library is not loaded from CDN yet. " +
      "Please ensure that index.html includes the Dexie CDN script and that it has finished loading before accessing the database."
    );
  }

  const d = new DexieClass("DynamicTextGameDB");

  d.version(1).stores({
    settings: "key",
    providers: "id",
    experts: "id, providerId",
    game_sessions: "id, createdAt, status",
    turns: "id, sessionId, turnIndex",
    memory_tree: "id, sessionId, tier",
    milestones: "id, sessionId, turnId",
    embeddings: "id, sessionId, sourceId, sourceType",
  });

  d.version(2).stores({
    turns: "id, sessionId, turnIndex, [sessionId+turnIndex]",
    memory_tree: "id, sessionId, tier, [sessionId+tier]",
  }).upgrade(async (tx) => {
    // Phase 2 Migration: add WORLDFORGE and CHARFORGE
    const wf = await tx.experts.get("EXPERT_WORLDFORGE");
    if (!wf) {
       await tx.experts.put(DEFAULT_EXPERTS.find(e => e.id === "EXPERT_WORLDFORGE"));
       await tx.experts.put(DEFAULT_EXPERTS.find(e => e.id === "EXPERT_CHARFORGE"));
    }
  });

  d.version(3).stores({
    embeddings: "id, sessionId, sourceId, sourceType, model",
  }).upgrade(async (tx) => {
    // Phase 3 Migration: add SUMMARIZE expert
    const summ = await tx.experts.get("EXPERT_SUMMARIZE");
    if (!summ) {
       await tx.experts.put(DEFAULT_EXPERTS.find(e => e.id === "EXPERT_SUMMARIZE"));
    } else if (!summ.migrated_p3) {
       summ.migrated_p3 = true;
       await tx.experts.put(summ);
    }
  });

  d.version(4).stores({
    orama_snapshots: "sessionId",
  });

  d.version(5).stores({
    summary_tasks: "++id, sessionId, [sessionId+tier]",
  }).upgrade(async (tx) => {
    // Phase 0.6 Migration: Update EXPERT_NARRATIVE
    const narrativeExpert = await tx.experts.get("EXPERT_NARRATIVE");
    if (narrativeExpert && !narrativeExpert.migrated_p07) {
       narrativeExpert.migrated_p07 = true;
       await tx.experts.put(narrativeExpert);
    }
  });

  d.version(6).upgrade(async (tx) => {
    // Migration for Phase 6: reset all maxTokens to 0 (Unlimited)
    const allExperts = await tx.experts.toArray();
    for (const exp of allExperts) {
      if (exp.maxTokens && exp.maxTokens !== 0) {
        exp.maxTokens = 0;
        await tx.experts.put(exp);
      }
    }
  });

  d.version(7).upgrade(async (tx) => {
    // Phase 7 Migration: Fix character dynamics parsing
    const exp = await tx.experts.get("EXPERT_NARRATIVE");
    const defExp = DEFAULT_EXPERTS.find(e => e.id === "EXPERT_NARRATIVE");
    if (exp && defExp) {
       if (!exp.migrated_p07_v2) {
           exp.migrated_p07_v2 = true;
           exp.systemPrompt = defExp.systemPrompt;
           await tx.experts.put(exp);
       }
    }
  });

  d.version(8).upgrade(async (tx) => {
    // Phase 8 Migration: Remove unused experts from the database
    const deprecatedExperts = ["EXPERT_DIALOGUE", "EXPERT_RULES", "EXPERT_WORLD", "EXPERT_CRITIC"];
    for (const id of deprecatedExperts) {
      await tx.experts.where("id").equals(id).delete();
    }
  });

  d.version(9).stores({
    // Keeps existing stores, but triggers upgrade
  }).upgrade(async (tx) => {
    // Phase 9 Migration: Upgrade experts systemPrompt for Separation of Concerns (SOC)
    const narrativeExpert = await tx.experts.get("EXPERT_NARRATIVE");
    const defNarrative = DEFAULT_EXPERTS.find(e => e.id === "EXPERT_NARRATIVE");
    if (narrativeExpert && defNarrative && !narrativeExpert.migrated_soc) {
       narrativeExpert.migrated_soc = true;
       // Note: systemPrompt in DB is seeded but not read at runtime — DEFAULT_EXPERTS is the source of truth.
       // These migration steps only update schema/flags, user customization of systemPrompt is currently unsupported
       // and defaults are always applied via api-client.
       await tx.experts.put(narrativeExpert);
    }

    const summarizeExpert = await tx.experts.get("EXPERT_SUMMARIZE");
    const defSummarize = DEFAULT_EXPERTS.find(e => e.id === "EXPERT_SUMMARIZE");
    if (summarizeExpert && defSummarize && !summarizeExpert.migrated_soc) {
       summarizeExpert.migrated_soc = true;
       await tx.experts.put(summarizeExpert);
    }
  });

  d.version(10).upgrade(async (tx) => {
    // Phase 10 Migration: Upgrade EXPERT_NARRATIVE to use full_name instead of name, remove salience from schema
    const narrativeExpert = await tx.experts.get("EXPERT_NARRATIVE");
    const defNarrative = DEFAULT_EXPERTS.find(e => e.id === "EXPERT_NARRATIVE");
    if (narrativeExpert && defNarrative && !narrativeExpert.migrated_v10_salience) {
       narrativeExpert.migrated_v10_salience = true;
       // Note: systemPrompt in DB is seeded but not read at runtime — DEFAULT_EXPERTS is the source of truth.
       // These migration steps only update schema/flags, user customization of systemPrompt is currently unsupported
       // and defaults are always applied via api-client.
       await tx.experts.put(narrativeExpert);
    }
  });

  d.version(11).upgrade(async (tx) => {
    // Phase 11 Migration: Hybrid Output Format (XML + JSON stream)
    const narrativeExpert = await tx.experts.get("EXPERT_NARRATIVE");
    const defNarrative = DEFAULT_EXPERTS.find(e => e.id === "EXPERT_NARRATIVE");
    if (narrativeExpert && defNarrative && !narrativeExpert.migrated_v11_xml) {
       narrativeExpert.migrated_v11_xml = true;
       // Note: systemPrompt in DB is seeded but not read at runtime — DEFAULT_EXPERTS is the source of truth.
       // These migration steps only update schema/flags, user customization of systemPrompt is currently unsupported
       // and defaults are always applied via api-client.
       await tx.experts.put(narrativeExpert);
    }
  });

  d.version(12).upgrade(async (tx) => {
    // Phase 12 Migration: character_dynamics redesign (initiator, active_reactor, etc. + modality_modifiers)
    const narrativeExpert = await tx.experts.get("EXPERT_NARRATIVE");
    const defNarrative = DEFAULT_EXPERTS.find(e => e.id === "EXPERT_NARRATIVE");
    if (narrativeExpert && defNarrative && !narrativeExpert.migrated_v12_dynamics) {
       narrativeExpert.migrated_v12_dynamics = true;
       // Note: systemPrompt in DB is seeded but not read at runtime — DEFAULT_EXPERTS is the source of truth.
       // These migration steps only update schema/flags, user customization of systemPrompt is currently unsupported
       // and defaults are always applied via api-client.
       await tx.experts.put(narrativeExpert);
    }
  });

  d.version(13).upgrade(async (tx) => {
    // Phase 13 Migration: Deep Schema Refactoring for Protagonist and World data
    const sessions = await tx.game_sessions.toArray();
    for (const session of sessions) {
      if (!session.protagonist) {
        session.protagonist = {
          name: session.mainCharacterName || '',
          persona: session.userPersona || '',
          appearance: session.userAppearance || '',
          relationship: session.userRelationship || '',
          customFields: Array.isArray(session.protagonistCustomFields) ? session.protagonistCustomFields : []
        };
      }
      
      if (!session.world) {
        session.world = {
          bibleAfter: session.worldBibleAfter || ''
        };
      }

      // Remove the old flat fields to clean up
      delete session.mainCharacterName;
      delete session.userPersona;
      delete session.userAppearance;
      delete session.userRelationship;
      delete session.protagonistCustomFields;
      delete session.worldBibleAfter;

      await tx.game_sessions.put(session);
    }
  });

  d.version(14).stores({
    embeddings: "id, sessionId, sourceId, sourceType, model, [sessionId+model]",
    memory_tree: "id, sessionId, tier, [sessionId+tier], [sessionId+tier+isSummarized]"
  }).upgrade(async (tx) => {
      // Phase 14 Migration: Schema updates for high-performance indexing
      // Ensure memory_tree records have a boolean isSummarized to be included in the [sessionId+tier+isSummarized] compound index.
      await tx.memory_tree.toCollection().modify(m => {
         if (m.isSummarized === undefined) {
             m.isSummarized = 0;
         }
      });
  });

  d.version(15).stores({
    embeddings: "id, sessionId, sourceId, sourceType, model, [sessionId+model]",
    memory_tree: "id, sessionId, tier, [sessionId+tier], [sessionId+tier+isSummarized]"
  }).upgrade(async (tx) => {
      // Phase 15 Migration: Explicitly convert boolean isSummarized to numeric (0/1) for strict IndexedDB valid keys
      await tx.memory_tree.toCollection().modify(m => {
          if (m.isSummarized === true) {
              m.isSummarized = 1;
          } else if (m.isSummarized === false) {
              m.isSummarized = 0;
          }
      });
  });

  d.version(16).upgrade(async (tx) => {
      // Phase 16 Migration: Sweep session.entities for normalization (Backwards Compatibility)
      const sessions = await tx.game_sessions.toArray();
      for (const session of sessions) {
         if (session.entities && Array.isArray(session.entities)) {
             let changed = false;
             session.entities = session.entities.map(ent => {
                 if (!ent) return ent;
                 if (ent.relationship === undefined) {
                     ent.relationship = '';
                     changed = true;
                 }
                 return ent;
             });
             if (changed) {
                 await tx.game_sessions.put(session);
             }
         }
      }
  });

  d.version(17).stores({
    kb_files: "id, sessionId, status",
    kb_embeddings: "id, sessionId, docId, chunkIndex",
    kb_orama_snapshots: "sessionId"
  });

  d.version(18).upgrade(async (tx) => {
    // Phase 18 Migration: Move worldBibleBefore into world object and clean up root field
    const sessions = await tx.game_sessions.toArray();
    for (const session of sessions) {
      if (session.worldBibleBefore !== undefined) {
        if (!session.world) {
          session.world = {};
        }
        session.world.bibleBefore = session.worldBibleBefore;
        delete session.worldBibleBefore;
        await tx.game_sessions.put(session);
      }
    }
  });

  d.on("populate", (tx) => {
    console.log("[Dexie] Initializing DynamicTextGameDB Database");
  });

  activeDb = d;
  return activeDb;
}

// Export the database as a Proxy object to guarantee frictionless lazily resolved operations at runtime
const db = new Proxy({}, {
  get(target, prop) {
    if (prop === 'then') {
      return undefined; // Ensure the proxy is not treated as a Promise
    }
    const instance = getDbInstance();
    const val = instance[prop];
    if (typeof val === 'function') {
      return val.bind(instance);
    }
    return val;
  },
  set(target, prop, value) {
    const instance = getDbInstance();
    instance[prop] = value;
    return true;
  }
});

export const DEXIE_MIN_KEY = () => {
  const DexieClass = typeof window !== 'undefined' ? window.Dexie : null;
  if (!DexieClass) throw new Error('[Dexie] Not loaded');
  return DexieClass.minKey;
};

export const DEXIE_MAX_KEY = () => {
  const DexieClass = typeof window !== 'undefined' ? window.Dexie : null;
  if (!DexieClass) throw new Error('[Dexie] Not loaded');
  return DexieClass.maxKey;
};

/**
 * Repository method to cascade delete a game session.
 * Replaces unreliable hook-based cascading deletes.
 */
export async function deleteGameSession(sessionId) {
  if (!sessionId) return;

  const tables = [
    db.game_sessions,
    db.turns,
    db.memory_tree,
    db.milestones,
    db.embeddings,
    db.orama_snapshots,
    db.summary_tasks,
    db.kb_files,
    db.kb_embeddings,
    db.kb_orama_snapshots
  ];

  await db.transaction('rw', tables, async () => {
    const purgeTurns      = db.turns.where("sessionId").equals(sessionId).delete();
    const purgeMemory     = db.memory_tree.where("sessionId").equals(sessionId).delete();
    const purgeMilestones = db.milestones.where("sessionId").equals(sessionId).delete();
    const purgeEmbeddings = db.embeddings.where("sessionId").equals(sessionId).delete();
    const purgeSnapshots  = db.orama_snapshots.where("sessionId").equals(sessionId).delete();
    const purgeTasks      = db.summary_tasks.where("sessionId").equals(sessionId).delete();
    const purgeKbFiles    = db.kb_files.where("sessionId").equals(sessionId).delete();
    const purgeKbEmbeds   = db.kb_embeddings.where("sessionId").equals(sessionId).delete();
    const purgeKbSnaps    = db.kb_orama_snapshots.where("sessionId").equals(sessionId).delete();

    await Promise.all([
      purgeTurns,
      purgeMemory,
      purgeMilestones,
      purgeEmbeddings,
      purgeSnapshots,
      purgeTasks,
      purgeKbFiles,
      purgeKbEmbeds,
      purgeKbSnaps
    ]);

    await db.game_sessions.delete(sessionId);
  });
}

export { db };
