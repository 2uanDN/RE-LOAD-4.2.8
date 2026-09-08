import { db } from '../../core/db.js';
import { eventBus } from '../../core/event-bus.js';
import { initEngine } from '../init-engine.js';
import { SessionListUI } from '../components/session-list-ui.js';
import { EVENTS } from '../../core/events.js';
import { showToast } from '../toast-ui.js';

export class SessionLifecycleManager {
  constructor(gameUI) {
    this.gameUI = gameUI;
    this._bindEvents();
  }

  _bindEvents() {
    eventBus.on(EVENTS.SESSION_NEW, async ({ session }) => {
      this.gameUI.activeSessionId = session.id;
      this.gameUI.sessionContext = {
        session,
        turns: [],
        memoryTree: { a1: [], a2: [], a3: [] },
        milestones: [],
        slidingWindow: []
      };
      this.gameUI.renderGameSession();
    }, this);
    
    eventBus.on(EVENTS.SESSION_LOADED, (sessionContext) => {
      this.gameUI.activeSessionId = sessionContext.session.id;
      this.gameUI.sessionContext = sessionContext;
      this.gameUI.renderGameSession(); 
    }, this);

    eventBus.on(EVENTS.MEMORY_A1_CREATED, (memoryRecord) => {
      if (this.gameUI.sessionContext && this.gameUI.sessionContext.memoryTree) {
        this.gameUI.sessionContext.memoryTree.a1.push(memoryRecord);
      }
    }, this);

    eventBus.on(EVENTS.MEMORY_A2_CREATED, (memoryRecord) => {
      if (this.gameUI.sessionContext && this.gameUI.sessionContext.memoryTree) {
        this.gameUI.sessionContext.memoryTree.a2.push(memoryRecord);
      }
    }, this);

    eventBus.on(EVENTS.MEMORY_A3_CREATED, (memoryRecord) => {
      if (this.gameUI.sessionContext && this.gameUI.sessionContext.memoryTree) {
        this.gameUI.sessionContext.memoryTree.a3.push(memoryRecord);
      }
    }, this);

    eventBus.on(EVENTS.MILESTONE_DETECTED, (milestone) => {
      if (this.gameUI.sessionContext && this.gameUI.sessionContext.milestones) {
         this.gameUI.sessionContext.milestones.push(milestone);
      }
    }, this);

    eventBus.on(EVENTS.MILESTONE_DELETED, ({ milestoneId }) => {
      if (this.gameUI.sessionContext && this.gameUI.sessionContext.milestones) {
         this.gameUI.sessionContext.milestones = this.gameUI.sessionContext.milestones.filter(m => m.id !== milestoneId);
      }
    }, this);

    eventBus.on(EVENTS.WIZARD_CLOSED, () => {
      this.gameUI.init();
    }, this);

    eventBus.on(EVENTS.RAG_MODEL_MISMATCH, (data) => {
      this.showModelMismatchWarning(data.currentModel, data.oldModel);
    }, this);

    eventBus.on(EVENTS.RAG_KB_MODEL_MISMATCH, (data) => {
      this.showKbModelMismatchWarning(data.currentModel, data.oldModel);
    }, this);

    eventBus.on(EVENTS.DISPLAY_TURNS_PER_PAGE_CHANGED, ({ turnsPerPage }) => {
      this.gameUI.paginationManager.updateSettings(turnsPerPage, this.gameUI.sessionContext?.turns?.length || 0);
      if (this.gameUI.sessionContext) {
         this.gameUI.paginationManager.renderCurrentPage();
      }
    }, this);

    eventBus.on(EVENTS.MEMORY_SUMMARIZE_START, () => {
      const indicator = document.getElementById('memory-status-indicator');
      if (indicator) {
        indicator.classList.remove('hidden');
        indicator.classList.add('flex');
        setTimeout(() => indicator.classList.remove('opacity-0'), 10);
      }
    }, this);

    eventBus.on(EVENTS.MEMORY_SUMMARIZE_END, () => {
      const indicator = document.getElementById('memory-status-indicator');
      if (indicator) {
        indicator.classList.add('opacity-0');
        setTimeout(() => {
          indicator.classList.remove('flex');
          indicator.classList.add('hidden');
        }, 200);
      }
    }, this);
  }

  /**
   * Cleans up all registered event subscriptions owned by this instance.
   */
  destroy() {
    eventBus.offAll(this);
  }

  showModelMismatchWarning(currentModel, oldModel) {
    const banner = document.createElement('div');
    banner.className = 'w-full max-w-4xl bg-[var(--bg-elevated)] border border-[var(--warning)] text-[var(--text-primary)] rounded-lg p-4 py-3 flex justify-between items-center text-sm shadow mb-4 z-10 shrink-0';
    banner.innerHTML = `
      <div class="flex items-center gap-2">
         <i data-lucide="alert-triangle" class="w-5 h-5 shrink-0 text-[var(--warning)]"></i>
         <span><strong class="text-[var(--warning)]">Embedding model changed</strong> (from ${oldModel} to ${currentModel}). Existing memories use a different model. RAG results may be inaccurate until all memories are re-embedded.</span>
      </div>
      <div class="flex gap-2 shrink-0 border-l border-[var(--border-default)] pl-4 ml-2">
         <button id="btn-re-embed" class="bg-[var(--warning)] text-white font-bold px-3 py-1.5 rounded hover:opacity-90 transition-opacity">Re-embed All</button>
         <button id="btn-dismiss-mismatch" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-1"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
    `;
    
    const mainArea = document.querySelector('.flex-1.flex.flex-col.pt-8, #chat-viewport');
    if (mainArea) {
       mainArea.insertBefore(banner, mainArea.firstChild);
       
       banner.querySelector('#btn-re-embed').addEventListener('click', () => {
         eventBus.emit(EVENTS.RAG_TRIGGER_REBUILD, { sessionId: this.gameUI.activeSessionId });
         banner.remove();
       });
       
       banner.querySelector('#btn-dismiss-mismatch').addEventListener('click', () => {
         banner.remove();
       });
       
       if (window.lucide) window.lucide.createIcons({ root: document.body });
    }
  }

  showKbModelMismatchWarning(currentModel, oldModel) {
    const banner = document.createElement('div');
    banner.className = 'w-full max-w-4xl bg-[var(--bg-elevated)] border border-[var(--warning)] text-[var(--text-primary)] rounded-lg p-4 py-3 flex justify-between items-center text-sm shadow mb-4 z-10 shrink-0';
    banner.innerHTML = `
      <div class="flex items-center gap-2">
         <i data-lucide="alert-triangle" class="w-5 h-5 shrink-0 text-[var(--warning)]"></i>
         <span><strong class="text-[var(--warning)]">KB Embedding model changed</strong> (from ${oldModel} to ${currentModel}). Knowledge Base results may be inaccurate until all documents are re-embedded.</span>
      </div>
      <div class="flex gap-2 shrink-0 border-l border-[var(--border-default)] pl-4 ml-2">
         <button id="btn-re-embed-kb" class="bg-[var(--warning)] text-white font-bold px-3 py-1.5 rounded hover:opacity-90 transition-opacity">Re-embed KB</button>
         <button id="btn-dismiss-mismatch-kb" class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-1"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
    `;
    
    const mainArea = document.querySelector('.flex-1.flex.flex-col.pt-8, #chat-viewport');
    if (mainArea) {
       mainArea.insertBefore(banner, mainArea.firstChild);
       
       banner.querySelector('#btn-re-embed-kb').addEventListener('click', () => {
         eventBus.emit(EVENTS.RAG_KB_TRIGGER_REBUILD, { sessionId: this.gameUI.activeSessionId });
         banner.remove();
       });
       
       banner.querySelector('#btn-dismiss-mismatch-kb').addEventListener('click', () => {
         banner.remove();
       });
       
       if (window.lucide) window.lucide.createIcons({ root: document.body });
    }
  }

  async init(skipAutoResume = false) {
    const sessions = await db.game_sessions.toArray();
    if (sessions.length > 0) {
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      const lastSession = sessions[0];
      if (lastSession.status === 'active' && !skipAutoResume) {
        const turnsCount = await db.turns.where({ sessionId: lastSession.id }).count();
        if (turnsCount > 0) {
           console.log(`Resuming adventure from Turn ${turnsCount}...`);
           showToast('Resuming your adventure...', 'info');
           
           initEngine.loadSession(lastSession.id);
           return;
        }
      }
    }
    
    // Render session list using extracted component
    const sessionListUI = new SessionListUI(this.gameUI.appContainer, this.gameUI);
    sessionListUI.render(sessions);
  }
}
