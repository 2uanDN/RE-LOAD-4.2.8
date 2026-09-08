import { db } from "../core/db.js";
import { settingsManager } from "../core/settings-manager.js";
import { encodeVectorToBase64, decodeBase64ToVector } from "./vector-codec.js";

export async function exportGameState(sessionId) {
  const session = await db.game_sessions.get(sessionId);
  if (!session) throw new Error("Session not found");

  const turns = await db.turns.where("sessionId").equals(sessionId).toArray();
  turns.sort((a, b) => a.turnIndex - b.turnIndex);
  const memory = await db.memory_tree
    .where("sessionId")
    .equals(sessionId)
    .toArray();
  const milestones = await db.milestones
    .where("sessionId")
    .equals(sessionId)
    .toArray();
  const embeddings = await db.embeddings
    .where("sessionId")
    .equals(sessionId)
    .toArray();
  const summary_tasks = await db.summary_tasks
    .where("sessionId")
    .equals(sessionId)
    .toArray();
  const kb_files = await db.kb_files
    .where("sessionId")
    .equals(sessionId)
    .toArray();
  const kb_embeddings = await db.kb_embeddings
    .where("sessionId")
    .equals(sessionId)
    .toArray();

  // Note: We deliberately exclude `orama_snapshots` and `kb_orama_snapshots` from export payloads.
  // Orama search indexes are treated as ephemeral caches and will be seamlessly
  // rebuilt from `embeddings` when the session is loaded. This minimizes memory 
  // footprint during IO and prevents schema version match errors.
  embeddings.sort((a, b) => {
    const aTurnIndex = a.turnIndex ?? -1;
    const bTurnIndex = b.turnIndex ?? -1;
    
    // 1. Sort by Turn Index
    if (aTurnIndex !== bTurnIndex) return aTurnIndex - bTurnIndex;

    // 2. Sort by Source Type (User Input BEFORE Narrator Output)
    const sourcePriority = {
      'turn_user_input': 1,
      'turn_narrator': 2
    };
    
    const aPriority = sourcePriority[a.sourceType] ?? 99;
    const bPriority = sourcePriority[b.sourceType] ?? 99;
    
    if (aPriority !== bPriority) {
        return aPriority - bPriority;
    }

    if (a.sourceType !== b.sourceType) {
      return (a.sourceType || "").localeCompare(b.sourceType || "");
    }

    // 3. Sort by Chunk Index (within the exact same source type)
    const aChunk = a.chunkIndex ?? -1;
    const bChunk = b.chunkIndex ?? -1;
    if (aChunk !== bChunk) {
      return aChunk - bChunk;
    }

    return 0;
  });

  const exportData = {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    session: (() => {
      const s = { ...session };
      delete s.salienceMap;
      delete s.ragSyncedTurnIndex;
      if (s.world) {
        const w = s.world;
        s.world = {
          bibleBefore: w.bibleBefore || '',
          bibleAfter: w.bibleAfter || ''
        };
      }
      return s;
    })(),
    turns: turns.map((t) => {
      const copy = { ...t };
      if (copy._parsedCache) delete copy._parsedCache;
      if (copy.salienceMap) delete copy.salienceMap;
      if (copy.aiResponse && copy.aiResponse.character_dynamics) {
        copy.aiResponse = { ...copy.aiResponse };
        delete copy.aiResponse.character_dynamics;
      }
      return copy;
    }),
    memory,
    milestones,
    summary_tasks,
    kb_files,
    kb_embeddings: kb_embeddings.map((e) => {
      if (!e.vector) return e;
      const base64Vec = encodeVectorToBase64(e.vector);
      return { ...e, vector: undefined, _vBase64: base64Vec };
    }),
    embeddings: embeddings.map((e) => {
      if (!e.vector) return e;
      const base64Vec = encodeVectorToBase64(e.vector);
      return { ...e, vector: undefined, _vBase64: base64Vec };
    }),
  };

  downloadAsFile(exportData, `game_${sessionId}_${Date.now()}.json`);
}

export async function importGameState(fileContent) {
  const MAX_IMPORT_SIZE = 100 * 1024 * 1024; // 100MB
  if (fileContent.length > MAX_IMPORT_SIZE) {
    throw new Error(`Import file too large (${(fileContent.length / 1024 / 1024).toFixed(1)}MB). Maximum is 100MB.`);
  }
  const data = JSON.parse(fileContent);
  const [major] = (data.version || "1.0").split(".");
  if (major !== "1") {
    throw new Error(`File was created with an incompatible version: ${data.version}`);
  }

  if (!data.session || !data.session.id) {
    throw new Error("Invalid file format: missing session.");
  }

  // Schema validation checks
  const isArrayValid = (arr) => Array.isArray(arr) || !arr;
  if (!isArrayValid(data.turns) || !isArrayValid(data.memory) || !isArrayValid(data.milestones) || !isArrayValid(data.embeddings) || !isArrayValid(data.summary_tasks) || !isArrayValid(data.kb_files) || !isArrayValid(data.kb_embeddings)) {
    throw new Error("Invalid file format: bad array data");
  }

  // Ensure unique ID for imported session if there's a conflict
  const existingSession = await db.game_sessions.get(data.session.id);
  let targetSessionId = data.session.id;

  // Resolve target session ID early to guarantee correct assignment to sub-entities.
  if (existingSession) {
    targetSessionId = crypto.randomUUID();
    data.session.id = targetSessionId;
  }
  
  // Backwards compatibility for old save files (pre-V13 schema)
  if (!data.session.protagonist) {
    data.session.protagonist = {
      name: data.session.mainCharacterName || '',
      persona: data.session.userPersona || '',
      appearance: data.session.userAppearance || '',
      relationship: data.session.userRelationship || '',
      customFields: Array.isArray(data.session.protagonistCustomFields) ? data.session.protagonistCustomFields : []
    };
  }
  if (!data.session.world) {
    data.session.world = {
      bibleBefore: data.session.worldBibleBefore || '',
      bibleAfter: data.session.worldBibleAfter || ''
    };
  } else {
    const oldWorld = data.session.world;
    data.session.world = {
      bibleBefore: oldWorld.bibleBefore !== undefined ? oldWorld.bibleBefore : (data.session.worldBibleBefore || ''),
      bibleAfter: oldWorld.bibleAfter !== undefined ? oldWorld.bibleAfter : (data.session.worldBibleAfter || '')
    };
  }
  // Cleanup old keys from imported payload
  delete data.session.mainCharacterName;
  delete data.session.userPersona;
  delete data.session.userAppearance;
  delete data.session.userRelationship;
  delete data.session.protagonistCustomFields;
  delete data.session.worldBibleBefore;
  delete data.session.worldBibleAfter;
  delete data.session.ragSyncedTurnIndex;

  // Backwards compatibility for entities (pre-V16 schema)
  if (data.session.entities && Array.isArray(data.session.entities)) {
    data.session.entities = data.session.entities.map(ent => {
        if (!ent) return ent;
        if (ent.relationship === undefined) {
            ent.relationship = '';
        }
        return ent;
    });
  }

  if (data.embeddings) {
    data.embeddings = data.embeddings.map((e) => {
      if (e._vBase64) {
        e.vector = decodeBase64ToVector(e._vBase64);
        delete e._vBase64;
      }
      return e;
    });
  }

  if (data.kb_embeddings) {
    data.kb_embeddings = data.kb_embeddings.map((e) => {
      if (e._vBase64) {
        e.vector = decodeBase64ToVector(e._vBase64);
        delete e._vBase64;
      }
      return e;
    });
  }

  // Pre-process memory: Normalize isSummarized: boolean → number (guard against pre-v15 exports)
  if (data.memory?.length) {
    data.memory = data.memory.map(m => ({
      ...m,
      isSummarized: m.isSummarized ? 1 : 0
    }));
  }

  // Pre-process summary_tasks: always strip integer IDs to let auto-increment generate clean non-overlapping IDs
  if (data.summary_tasks?.length) {
    data.summary_tasks.forEach((item) => {
      item.sessionId = targetSessionId;
      delete item.id;
    });
  }

  if (existingSession) {
    // ID Resolution Map to preserve Referential Integrity
    const idMap = new Map();

    if (data.turns?.length) {
      data.turns.forEach((item) => {
        item.sessionId = targetSessionId;
        const newId = crypto.randomUUID();
        idMap.set(item.id, newId);
        item.id = newId;
      });
    }

    if (data.memory?.length) {
      data.memory.forEach((item) => {
        item.sessionId = targetSessionId;
        const newId = crypto.randomUUID();
        idMap.set(item.id, newId);
        item.id = newId;
      });

      // Restore Foreign Keys
      data.memory.forEach((item) => {
        if (item.coversTurns?.fromId && idMap.has(item.coversTurns.fromId)) {
          item.coversTurns.fromId = idMap.get(item.coversTurns.fromId);
        }
        if (item.coversTurns?.toId && idMap.has(item.coversTurns.toId)) {
          item.coversTurns.toId = idMap.get(item.coversTurns.toId);
        }
      });
    }

    if (data.milestones?.length) {
      data.milestones.forEach((item) => {
        item.sessionId = targetSessionId;
        const newId = crypto.randomUUID();
        idMap.set(item.id, newId);
        item.id = newId;

        // Restore Foreign Key
        if (item.turnId && idMap.has(item.turnId)) {
          item.turnId = idMap.get(item.turnId);
        }
      });
    }

    if (data.embeddings?.length) {
      data.embeddings.forEach((item) => {
        item.sessionId = targetSessionId;
        const newId = crypto.randomUUID();
        idMap.set(item.id, newId);
        item.id = newId;

        // Restore Foreign Key
        if (item.sourceId && idMap.has(item.sourceId)) {
          item.sourceId = idMap.get(item.sourceId);
        }
      });
    }

    if (data.kb_files?.length) {
      data.kb_files.forEach((item) => {
        item.sessionId = targetSessionId;
        const newId = crypto.randomUUID();
        idMap.set(item.id, newId);
        item.id = newId;
      });
    }

    if (data.kb_embeddings?.length) {
      data.kb_embeddings.forEach((item) => {
        item.sessionId = targetSessionId;
        const newId = crypto.randomUUID();
        idMap.set(item.id, newId);
        item.id = newId;

        // Restore Foreign Key
        if (item.docId && idMap.has(item.docId)) {
          item.docId = idMap.get(item.docId);
        }
      });
    }
  }

  // Transaction explicitly includes `db.orama_snapshots` because Dexie hooks
  // (such as game_sessions `deleting`) might cascade down into it when overwriting.
  await db.transaction(
    "rw",
    db.game_sessions,
    db.turns,
    db.memory_tree,
    db.milestones,
    db.embeddings,
    db.summary_tasks,
    db.orama_snapshots,
    db.kb_files,
    db.kb_embeddings,
    db.kb_orama_snapshots,
    async () => {
      await db.game_sessions.put(data.session);
      if (data.turns?.length) await db.turns.bulkPut(data.turns);
      if (data.memory?.length) await db.memory_tree.bulkPut(data.memory);
      if (data.milestones?.length) await db.milestones.bulkPut(data.milestones);
      if (data.embeddings?.length) await db.embeddings.bulkPut(data.embeddings);
      if (data.summary_tasks?.length) await db.summary_tasks.bulkAdd(data.summary_tasks);
      if (data.kb_files?.length) await db.kb_files.bulkPut(data.kb_files);
      if (data.kb_embeddings?.length) await db.kb_embeddings.bulkPut(data.kb_embeddings);
    },
  );
}

export async function exportSettings() {
  const providers = await settingsManager.loadAllProviders();
  const experts = (await settingsManager.loadAllExperts()).map(exp => {
    const clone = { ...exp };
    delete clone.systemPrompt;
    return clone;
  });

  const general = await settingsManager.loadSetting("general");
  const display = await settingsManager.loadSetting("display");
  const memory = await settingsManager.loadSetting("memory");

  const exportData = {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    providers,
    experts,
    settings: {
      general,
      display,
      memory,
    },
  };

  downloadAsFile(exportData, `settings_${Date.now()}.json`);
}

export async function importSettings(fileContent) {
  const MAX_IMPORT_SIZE = 100 * 1024 * 1024; // 100MB
  if (fileContent.length > MAX_IMPORT_SIZE) {
    throw new Error(`Import file too large (${(fileContent.length / 1024 / 1024).toFixed(1)}MB). Maximum is 100MB.`);
  }
  const data = JSON.parse(fileContent);
  const [major] = (data.version || "1.0").split(".");
  if (major !== "1") {
    throw new Error(`File was created with an incompatible version: ${data.version}`);
  }

  await settingsManager.bulkImportSettings(data);
}

function downloadAsFile(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
