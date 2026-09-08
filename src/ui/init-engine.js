import { WizardUI } from './components/wizard-ui.js';
import { db } from '../core/db.js';
import { eventBus } from '../core/event-bus.js';
import { settingsManager } from '../core/settings-manager.js';
import { showToast } from './toast-ui.js';
import { EVENTS } from '../core/events.js';

class InitEngine {
  constructor() {
    this.appContainer = document.getElementById('app');
  }

  // Session Data Contract: Create New Session
  async createNewSession(data) {
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      world: {
        bibleBefore: data.worldBibleBefore,
        bibleAfter: data.worldBibleAfter || ""
      },
      protagonist: {
        name: data.mainCharacterName || "",
        persona: data.userPersona || "",
        appearance: data.userAppearance || "",
        relationship: data.userRelationship || "",
        customFields: data.protagonistCustomFields || []
      },
      entities: data.entities || [],
      creativePriorities: data.creativePriorities || [],
      branchName: data.worldName || (data.worldBibleBefore || '').split('\n')[0].substring(0, 50),
      turnCount: 0,
      status: "active"
    };

    const kbFilesToInsert = [];
    const kbEmbeddingsToInsert = [];
    const kbFilesData = data.kbFilesData || [];
    
    for (const f of kbFilesData) {
        const fileId = f.id || crypto.randomUUID();
        kbFilesToInsert.push({
            id: fileId,
            sessionId: sessionId,
            name: f.name,
            content: f.content,
            size: f.size,
            status: 'processed',
            createdAt: Date.now()
        });
        
        if (f.embeddings && f.embeddings.length > 0) {
            for (const chunk of f.embeddings) {
                kbEmbeddingsToInsert.push({
                    id: crypto.randomUUID(),
                    sessionId: sessionId,
                    docId: fileId,
                    model: chunk.model || "primary",
                    vector: chunk.vector,
                    text: chunk.text,
                    chunkIndex: chunk.chunkIndex,
                    startIdx: chunk.startIdx,
                    endIdx: chunk.endIdx,
                    title: f.name,
                    priority: 1
                });
            }
        }
    }

    await db.transaction('rw', db.game_sessions, db.kb_files, db.kb_embeddings, async () => {
      await db.game_sessions.add(session);
      if (kbFilesToInsert.length > 0) {
        await db.kb_files.bulkAdd(kbFilesToInsert);
      }
      if (kbEmbeddingsToInsert.length > 0) {
        await db.kb_embeddings.bulkAdd(kbEmbeddingsToInsert);
      }
    });

    // Lưu vào memory state sẽ được quản lý bởi gameUI
    eventBus.emit(EVENTS.SESSION_NEW, { session });
  }

  // Session Data Contract: Load Session
  async loadSession(sessionId) {
    const session = await db.game_sessions.get(sessionId);
    if (!session) {
      console.error("Session not found:", sessionId);
      return;
    }
    const turns = await db.turns.where("sessionId").equals(sessionId).toArray();
    // Legacy DB Cleanup: Prevent bloated saves from prior bugs
    turns.forEach(t => { if (t._parsedCache) delete t._parsedCache; });
    turns.sort((a, b) => a.turnIndex - b.turnIndex);

    const memoryNodes = await db.memory_tree.where("sessionId").equals(sessionId).toArray();
    const milestones = await db.milestones.where("sessionId").equals(sessionId).toArray();

    const memoryTree = { a1: [], a2: [], a3: [] };
    memoryNodes.forEach(node => {
      const tierKey = `a${node.tier}`;
      if (memoryTree[tierKey]) {
        memoryTree[tierKey].push(node);
      }
    });

    const generalSettings = await settingsManager.loadSetting("general");
    const slidingWindowSize = generalSettings?.slidingWindowSize || 10;
    const slidingWindow = turns.slice(-slidingWindowSize);
    
    const sessionContext = {
      session,
      turns,
      memoryTree,
      milestones,
      slidingWindow
    };

    eventBus.emit(EVENTS.SESSION_LOADED, sessionContext);
  }

  // Branch Creation
  async createBranch(sessionContext, turnIndex, branchType) {
    if (!sessionContext || !sessionContext.session) return false;
    
    const includeTurnsUpTo = branchType === 'user' ? turnIndex - 1 : turnIndex;
    const currSession = sessionContext.session;
    
    const newSessionId = crypto.randomUUID();
    const newSessionName = `Branch of ${currSession.branchName || currSession.protagonist?.name || 'Adventure'} - Turn ${includeTurnsUpTo}`;
    
    const turnsToCopy = await db.turns
        .where('sessionId').equals(currSession.id)
        .filter(t => t.turnIndex <= includeTurnsUpTo)
        .toArray();
        
    turnsToCopy.sort((a, b) => a.turnIndex - b.turnIndex);

    // Deep clone the session to break references, then override branch-specific properties.
    // The previous salience map is intentionally discarded to start fresh in the new branch.
    const newSession = {
      ...JSON.parse(JSON.stringify(currSession)),
      salienceMap: {},
      id: newSessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCount: includeTurnsUpTo,
      branchName: newSessionName,
      status: 'active',
      ragSyncedTurnIndex: Math.min(currSession.ragSyncedTurnIndex || 0, includeTurnsUpTo)
    };
    
    const newTurns = turnsToCopy.map(t => ({
      ...t,
      id: crypto.randomUUID(),
      sessionId: newSessionId
    }));
    
    const turnIdMap = {};
    for (let i = 0; i < turnsToCopy.length; i++) {
        turnIdMap[turnsToCopy[i].id] = newTurns[i].id;
    }
    
    const memoryToCopy = await db.memory_tree
        .where('sessionId').equals(currSession.id)
        .toArray();
    
    const filteredMemory = memoryToCopy.filter(m => !m.coversTurns || !m.coversTurns.to || m.coversTurns.to <= includeTurnsUpTo);
    const newMemory = filteredMemory.map(m => ({
       ...m,
       id: crypto.randomUUID(),
       sessionId: newSessionId
    }));
    
    const memIdMap = {};
    for (let i = 0; i < newMemory.length; i++) {
        memIdMap[filteredMemory[i].id] = newMemory[i].id;
    }
    
    // Mitigate Dangling Memory Summarization hole:
    // Orphaned lower-tier nodes may inherit an invalid isSummarized state if their parent was pruned during branching.
    for (const mem of newMemory) {
        if (mem.isSummarized) {
            if (!mem.coversTurns || typeof mem.coversTurns.from === 'undefined') {
                mem.isSummarized = 0;
                continue;
            }
            
            const hasParent = newMemory.some(parent => 
                parent.tier === mem.tier + 1 && 
                parent.coversTurns &&
                typeof parent.coversTurns.from !== 'undefined' &&
                parent.coversTurns.from <= mem.coversTurns.from &&
                (!mem.coversTurns.to || (parent.coversTurns.to && parent.coversTurns.to >= mem.coversTurns.to))
            );
            if (!hasParent) {
                mem.isSummarized = 0;
            }
        }
    }
    
    const milestonesToCopy = await db.milestones
        .where('sessionId').equals(currSession.id)
        .toArray();
        
    const newMilestones = milestonesToCopy
        .map(m => {
            const isUuidTurnId = typeof m.turnId === 'string'; // Drop strict '-' check for crypto fallback support
            
            if (isUuidTurnId) {
                // Consistent UUID turning resolution
                if (!turnIdMap[m.turnId]) return null; // Turn không nằm trong branch range
                return { ...m, id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2), sessionId: newSessionId, turnId: turnIdMap[m.turnId] };
            } else {
                // Legacy Manual milestone fallback tracking format (Integer turnIndex)
                if (m.turnId > includeTurnsUpTo) return null; // Sau branch point
                return { ...m, id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2), sessionId: newSessionId }; // Giữ nguyên integer turnId
            }
        })
        .filter(Boolean);
        
    const embeddingsToCopy = await db.embeddings
        .where('sessionId').equals(currSession.id)
        .toArray();
        
    const TURN_SOURCE_TYPES = new Set(['turn', 'turn_user_input', 'turn_narrator']);
        
    const newEmbeddings = embeddingsToCopy
        .filter(e => {
            if (TURN_SOURCE_TYPES.has(e.sourceType)) return !!turnIdMap[e.sourceId];
            if (e.sourceType === 'memory' || e.sourceType === 'summary') return !!memIdMap[e.sourceId];
            return true;
        })
        .map(e => {
            let newSourceId = e.sourceId;
            if (TURN_SOURCE_TYPES.has(e.sourceType)) {
                newSourceId = turnIdMap[e.sourceId];
            } else if (e.sourceType === 'memory' || e.sourceType === 'summary') {
                newSourceId = memIdMap[e.sourceId];
            }
            return {
                ...e,
                id: crypto.randomUUID(),
                sessionId: newSessionId,
                sourceId: newSourceId
            };
        });
        
    const summaryTasksToCopy = await db.summary_tasks
        .where('sessionId').equals(currSession.id)
        .filter(t => t.tier === 1 && t.toTurn <= includeTurnsUpTo)
        .toArray();

    const newSummaryTasks = summaryTasksToCopy.map(t => {
        const { id, ...rest } = t;
        return {
            ...rest,
            sessionId: newSessionId
        };
    });
        
    try {
        await db.transaction('rw', db.game_sessions, db.turns, db.memory_tree, db.milestones, db.embeddings, db.summary_tasks, async () => {
            await db.game_sessions.add(newSession);
            if (newTurns.length) await db.turns.bulkAdd(newTurns);
            if (newMemory.length) await db.memory_tree.bulkAdd(newMemory);
            if (newMilestones.length) await db.milestones.bulkAdd(newMilestones);
            if (newEmbeddings.length) await db.embeddings.bulkAdd(newEmbeddings);
            if (newSummaryTasks.length) await db.summary_tasks.bulkAdd(newSummaryTasks);
            
            currSession.status = 'aborted';
            currSession.turnCount = await db.turns.where('sessionId').equals(currSession.id).count();
            await db.game_sessions.put(currSession);
        });
        
        showToast('Branch created. Returning to Adventures list.', 'success');
        return true;
    } catch (err) {
        console.error('Failed to create branch:', err);
        showToast('Failed to create branch.', 'error');
        return false;
    }
  }

  // UI Flow - New Game Wizard
  startWizard() {
    const wizardUI = new WizardUI(
      this.appContainer,
      async (sessionData) => {
        await this.createNewSession(sessionData);
      },
      () => {
        import('./game-ui.js').then(({ gameUI }) => {
            // maybe? Wait, eventBus is taking care of it if we emit closed, or session_new
            eventBus.emit(EVENTS.WIZARD_CLOSED, {});
        });
      }
    );
    wizardUI.render();
  }

}

export const initEngine = new InitEngine();
