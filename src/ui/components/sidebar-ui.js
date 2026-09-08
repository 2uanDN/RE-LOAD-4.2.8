import { eventBus } from '../../core/event-bus.js';
import { db } from '../../core/db.js';
import { memoryManager } from '../../core/memory-manager.js';
import { EVENTS } from '../../core/events.js';
import { escapeHtml } from '../../utils/validators.js';
import { safeMarkedParse } from '../../utils/text-parser.js';

import memoryCardTemplate from '../templates/components/sidebar/memory-card.html?raw';
import milestoneTemplate from '../templates/components/sidebar/milestone.html?raw';
import layoutTemplate from '../templates/components/sidebar/layout.html?raw';
import performanceTemplate from '../templates/components/sidebar/performance.html?raw';
import ragDebugTemplate from '../templates/components/sidebar/rag-debug.html?raw';

export class SidebarUI {
  constructor(container, initialSessionId = null) {
    this.container = container;
    this.currentSessionId = initialSessionId;
    this.isSummarizing = false;

    this.memoryState = {
      a3: [],
      a2: [],
      a1: [],
      milestones: [],
      pendingTasks: []
    };

    this.performanceState = {
      latest: { ttft: 0, inputTokens: 0, outputTokens: 0 },
      total: { ttft: 0, inputTokens: 0, outputTokens: 0, count: 0 }
    };

    this.ragState = {
      lastQuery: null,
      topKResults: [],
      stats: { total: 0, model: '', lastTurn: null },
      isRebuilding: false,
      rebuildProgress: { processed: 0, total: 0 }
    };

    this.listeners = [];
    const registerEvent = (extEvent, extCallback) => {
      eventBus.on(extEvent, extCallback, this);
      this.listeners.push({ event: extEvent, callback: extCallback });
    };

    const urlParams = new URLSearchParams(window.location.search);
    this.isDebugMode = urlParams.get('debug') === 'true';

    if (this.currentSessionId) {
      this.loadMemoryState();
      this.loadPerformanceState();
      if (this.isDebugMode) this.loadRagStats();
    }

    registerEvent(EVENTS.SESSION_LOADED, (sessionContext) => {
      this.currentSessionId = sessionContext.session.id;
      this.loadMemoryState();
      this.loadPerformanceState();
      if (this.isDebugMode) this.loadRagStats();
    });

    registerEvent(EVENTS.MEMORY_A1_CREATED, () => {
      this.loadMemoryState();
      if (this.isDebugMode) this.loadRagStats();
    });
    registerEvent(EVENTS.MEMORY_A2_CREATED, () => this.loadMemoryState());
    registerEvent(EVENTS.MEMORY_A3_CREATED, () => this.loadMemoryState());
    registerEvent(EVENTS.MILESTONE_DETECTED, () => this.loadMemoryState());
    registerEvent(EVENTS.MILESTONE_DELETED, () => this.loadMemoryState());
    registerEvent(EVENTS.TURN_COMPLETED, (turnResult) => {
      if (turnResult && turnResult.metrics) {
        this.performanceState.total.ttft += (turnResult.metrics.ttft || 0);
        this.performanceState.total.inputTokens += (turnResult.metrics.inputTokens || 0);
        this.performanceState.total.outputTokens += (turnResult.metrics.outputTokens || 0);
        this.performanceState.total.count++;
        this.performanceState.latest = { ...turnResult.metrics };
        this.updatePerformanceSection();
      } else {
        this.loadPerformanceState();
      }
      if (this.isDebugMode) setTimeout(() => this.loadRagStats(), 1000); // allow time for worker to complete
    });

    registerEvent(EVENTS.RAG_RETRIEVED, (data) => {
      this.ragState.lastQuery = data.queryText;
      this.ragState.topKResults = data.results;
      this.render();
    });

    registerEvent(EVENTS.RAG_REBUILD_START, () => {
      this.ragState.isRebuilding = true;
      this.render();
    });

    registerEvent(EVENTS.RAG_REBUILD_PROGRESS, (data) => {
      this.ragState.rebuildProgress = data;
      this.render();
    });

    registerEvent(EVENTS.RAG_READY, () => {
      this.ragState.isRebuilding = false;
      this.loadRagStats();
    });

    registerEvent(EVENTS.MEMORY_SUMMARIZE_START, () => {
      this.isSummarizing = true;
      this.render();
    });

    registerEvent(EVENTS.MEMORY_SUMMARIZE_END, () => {
      this.isSummarizing = false;
      this.loadMemoryState();
    });
    registerEvent(EVENTS.MEMORY_TASK_FAILED, () => {
      this.loadMemoryState();
    });
  }

  destroy() {
    this._isDestroyed = true;
    eventBus.offAll(this);
    this.listeners = [];
    this.container.innerHTML = '';
  }

  async loadMemoryState() {
    if (!this.currentSessionId) return;

    const memoryItems = await db.memory_tree
        .where('sessionId')
        .equals(this.currentSessionId)
        .toArray();
        
    this.memoryState.a3 = memoryItems.filter(m => m.tier === 3).sort((a,b) => a.createdAt - b.createdAt);
    this.memoryState.a2 = memoryItems.filter(m => m.tier === 2).sort((a,b) => a.createdAt - b.createdAt);
    this.memoryState.a1 = memoryItems.filter(m => m.tier === 1).sort((a,b) => a.createdAt - b.createdAt);
    
    let milestones = await db.milestones
        .where('sessionId')
        .equals(this.currentSessionId)
        .toArray();
        
    // Format turnId for UI presentation (resolve UUIDs to turnIndex)
    const turnIdsToFetch = milestones.map(m => m.turnId).filter(id => typeof id === 'string');
    if (turnIdsToFetch.length > 0) {
      const turns = await db.turns.where('id').anyOf(turnIdsToFetch).toArray();
      const turnMap = {};
      turns.forEach(t => turnMap[t.id] = t.turnIndex);
      milestones = milestones.map(m => {
        if (typeof m.turnId === 'string' && turnMap[m.turnId] !== undefined) {
          return { ...m, displayTurnIndex: turnMap[m.turnId] };
        }
        return { ...m, displayTurnIndex: m.turnId };
      });
    } else {
      milestones = milestones.map(m => ({ ...m, displayTurnIndex: m.turnId }));
    }
        
    this.memoryState.milestones = milestones.sort((a,b) => a.createdAt - b.createdAt);

    this.memoryState.pendingTasks = await db.summary_tasks
        .where('sessionId')
        .equals(this.currentSessionId)
        .toArray();

    const session = await db.game_sessions.get(this.currentSessionId);

    this.render();
  }

  async loadPerformanceState() {
    if (!this.currentSessionId) return;

    const turns = await db.turns
        .where('sessionId')
        .equals(this.currentSessionId)
        .toArray();
    
    let latest = { ttft: 0, inputTokens: 0, outputTokens: 0 };
    let total = { ttft: 0, inputTokens: 0, outputTokens: 0, count: turns.length };

    turns.forEach(t => {
      if (t.metrics) {
        total.ttft += (t.metrics.ttft || 0);
        total.inputTokens += (t.metrics.inputTokens || 0);
        total.outputTokens += (t.metrics.outputTokens || 0);
      }
    });

    if (turns.length > 0) {
      const sorted = turns.sort((a,b) => b.turnIndex - a.turnIndex);
      const latestTurn = sorted[0];
      if (latestTurn.metrics) {
        latest = { ...latestTurn.metrics };
      }
    }

    this.performanceState = { latest, total };
    this.render();
  }

  async loadRagStats() {
    if (!this.currentSessionId || !this.isDebugMode) return;
    
    // Check total count
    const count = await db.embeddings.where('sessionId').equals(this.currentSessionId).count();
    
    // Check latest turn
    const items = await db.embeddings.where('sessionId').equals(this.currentSessionId).toArray();
    let latestTurn = null;
    let currentModel = '';
    
    if (items.length > 0) {
      currentModel = items[items.length - 1].model || 'gemini-embedding-1';
      const turns = items.filter(x => x.sourceType === 'turn' && x.turnIndex != null);
      if (turns.length > 0) {
        turns.sort((a,b) => b.turnIndex - a.turnIndex);
        latestTurn = turns[0].turnIndex;
      }
    }

    this.ragState.stats = {
      total: count,
      model: currentModel,
      lastTurn: latestTurn
    };
    
    this.render();
  }

  toggleSection(id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden');
  }

  async onAddManualMilestone(text) {
    if (!text.trim() || !this.currentSessionId) return;

    const turns = await db.turns
        .where('sessionId')
        .equals(this.currentSessionId)
        .toArray();
        
    if (turns.length === 0) {
        console.warn("Cannot add milestone: No turns exist yet to attach ID.");
        return;
    }
    
    turns.sort((a,b) => b.turnIndex - a.turnIndex);
    const currentTurn = turns[0];

    const milestoneRecord = {
      id: crypto.randomUUID(),
      sessionId: this.currentSessionId,
      content: text.trim(),
      turnId: currentTurn.id,
      source: "user",
      createdAt: Date.now()
    };

    await db.milestones.add(milestoneRecord);
    eventBus.emit(EVENTS.MILESTONE_DETECTED, milestoneRecord);
  }

  async onMilestoneDelete(id) {
    const confirmOverlay = document.createElement('div');
    confirmOverlay.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center';
    confirmOverlay.innerHTML = `
      <div class="bg-[var(--bg-surface)] border border-[var(--border-default)] p-6 rounded-xl shadow-2xl max-w-sm w-full mx-4 text-center transform scale-95 opacity-0 transition-all duration-200">
        <div class="flex justify-center mb-4 text-[var(--error)]">
          <i data-lucide="alert-triangle" class="w-10 h-10"></i>
        </div>
        <h3 class="text-xl font-bold text-[var(--text-primary)] mb-2 font-prose">Delete Milestone?</h3>
        <p class="text-[var(--text-secondary)] text-sm mb-6">Are you sure you want to permanently delete this milestone? This action cannot be undone.</p>
        <div class="flex gap-3">
          <button class="cancel-btn flex-1 px-4 py-2 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] font-bold hover:bg-[var(--bg-hover)] transition-colors">Cancel</button>
          <button class="confirm-btn flex-1 px-4 py-2 bg-[var(--error)] text-white rounded-lg font-bold hover:opacity-90 transition-opacity">Delete</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(confirmOverlay);
    if (window.lucide) window.lucide.createIcons({ root: confirmOverlay });

    // Animate in
    requestAnimationFrame(() => {
      const modal = confirmOverlay.querySelector('div');
      modal.classList.remove('scale-95', 'opacity-0');
      modal.classList.add('scale-100', 'opacity-100');
    });

    const closeOverlay = () => {
      const modal = confirmOverlay.querySelector('div');
      modal.classList.remove('scale-100', 'opacity-100');
      modal.classList.add('scale-95', 'opacity-0');
      setTimeout(() => confirmOverlay.remove(), 200);
    };

    confirmOverlay.querySelector('.cancel-btn').addEventListener('click', closeOverlay);
    confirmOverlay.querySelector('.confirm-btn').addEventListener('click', async () => {
      closeOverlay();
      await db.milestones.delete(id);
      eventBus.emit(EVENTS.MILESTONE_DELETED, { milestoneId: id });
    });
  }

  renderCard(record, titlePrefix) {
    const preview = escapeHtml(record.content.length > 80 ? record.content.substring(0, 80) + '...' : record.content);
    const safe = safeMarkedParse(record.content);
    const range = record.coversTurns ? `(Turns ${record.coversTurns.from}-${record.coversTurns.to})` : '';
    
    // Determine border color class
    let borderClass = 'border-l-[var(--text-muted)]';
    if (record.tier === 2) borderClass = 'border-l-[var(--accent-dim)]';
    else if (record.tier === 3) borderClass = 'border-l-[var(--accent)]';

    return memoryCardTemplate
      .replace('{{BORDER_CLASS}}', borderClass)
      .replace('{{TITLE_PREFIX}}', titlePrefix)
      .replace('{{RANGE}}', range)
      .replace('{{PREVIEW}}', preview)
      .replace('{{SAFE_CONTENT}}', safe);
  }

  renderMilestone(milestone) {
    const sourceBadgeClass = milestone.source === 'ai' 
      ? 'text-[var(--accent)] bg-[var(--accent-glow)]' 
      : 'text-muted bg-surface border border-default';
      
    return milestoneTemplate
      .replace('{{TURN_INDEX}}', milestone.displayTurnIndex !== undefined ? milestone.displayTurnIndex : milestone.turnId)
      .replace('{{SOURCE_BADGE_CLASS}}', sourceBadgeClass)
      .replace('{{SOURCE}}', milestone.source)
      .replace('{{CONTENT}}', escapeHtml(milestone.content))
      .replace('{{ID}}', milestone.id);
  }

  render() {
    if (this._renderQueued || this._isDestroyed) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      if (this._isDestroyed || !this.container) return; // safety check
      if (!this.container.querySelector('#sidebar-ui-root')) {
        this.initDOM();
      }
      this.updateMemorySection();
      this.updateMilestonesSection();
      this.updatePerformanceSection();
      if (this.isDebugMode) {
        this.updateRagSection();
      }
    });
  }

  initDOM() {
    const ragDebugHtml = this.isDebugMode ? `
      <!-- RAG Debug Panel -->
      <div class="p-4 bg-gray-900/50">
        <h2 class="text-lg font-bold text-yellow-500 flex items-center justify-between cursor-pointer" id="btn-toggle-rag-debug">
          <span class="flex items-center gap-2"><i data-lucide="database" class="w-4 h-4"></i> RAG Debug</span>
          <i data-lucide="chevron-down" class="w-4 h-4"></i>
        </h2>

        <div id="section-rag-debug" class="mt-4 flex flex-col gap-3">
        </div>
      </div>
    ` : '';
    
    this.container.innerHTML = layoutTemplate
      .replace('{{DEBUG_CLASS}}', this.isDebugMode ? 'border-b border-default' : '')
      .replace('{{RAG_DEBUG_HTML}}', ragDebugHtml);

    if (window.lucide) {
      window.lucide.createIcons({ root: this.container });
    }

    this.container.querySelector('#btn-toggle-memory').addEventListener('click', () => {
      this.toggleSection('section-memory');
      const icon = this.container.querySelector('#icon-toggle-memory');
      if (icon) icon.classList.toggle('rotate-90');
    });
    this.container.querySelector('#btn-toggle-milestones').addEventListener('click', () => {
      this.toggleSection('section-milestones');
      const icon = this.container.querySelector('#icon-toggle-milestones');
      if (icon) icon.classList.toggle('rotate-90');
    });
    this.container.querySelector('#btn-toggle-performance').addEventListener('click', () => {
      this.toggleSection('section-performance');
      const icon = this.container.querySelector('#icon-toggle-performance');
      if (icon) icon.classList.toggle('rotate-90');
    });
    if (this.isDebugMode) {
      this.container.querySelector('#btn-toggle-rag-debug')?.addEventListener('click', () => this.toggleSection('section-rag-debug'));
    }
    
    this.container.querySelector('#milestones-container').addEventListener('click', (e) => {
      const btn = e.target.closest('.milestone-delete-btn');
      if (btn) {
        const id = btn.getAttribute('data-id');
        this.onMilestoneDelete(id);
      }
    });

    const btnAddMilestone = this.container.querySelector('#btn-add-milestone');
    const inputMilestone = this.container.querySelector('#manual-milestone-input');
    
    if (btnAddMilestone && inputMilestone) {
      btnAddMilestone.addEventListener('click', () => {
        this.onAddManualMilestone(inputMilestone.value);
        inputMilestone.value = '';
      });
      inputMilestone.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          this.onAddManualMilestone(inputMilestone.value);
          inputMilestone.value = '';
        }
      });
    }

    this.container.addEventListener('click', (e) => {
      if (e.target.closest('#btn-retry-memory')) {
         const btn = e.target.closest('#btn-retry-memory');
         btn.innerHTML = '<i data-lucide="loader" class="w-3 h-3 animate-spin"></i>';
         memoryManager.runManualRetry(this.currentSessionId).catch(console.error);
      }
    });
  }

  updateMemorySection() {
    const el = this.container.querySelector('#section-memory');
    if (!el) return;

    let html = '';
    
    const indicator = this.container.querySelector('#memory-error-indicator');
    if (indicator) {
        if (this.memoryState.pendingTasks && this.memoryState.pendingTasks.length > 0) {
            indicator.classList.remove('hidden');
            const failedManual = this.memoryState.pendingTasks.some(t => t.retries >= 3 || t.manualTrigger);
            if (failedManual) {
                html += `
                  <div class="flex items-center justify-between gap-2 text-xs text-error font-medium bg-error/10 border border-error/20 px-3 py-2 rounded mb-3">
                    <span class="flex items-center gap-1"><i data-lucide="alert-triangle" class="w-3 h-3"></i> Sync paused</span>
                    <button id="btn-retry-memory" class="px-2 py-1 bg-error text-white font-bold rounded hover:opacity-80 transition-opacity">Retry</button>
                  </div>
                `;
            }
        } else {
            indicator.classList.add('hidden');
        }
    }

    if (this.isSummarizing) {
      html += `
        <div class="flex items-center gap-2 text-xs accent animate-pulse mb-1 font-medium bg-[var(--accent-glow)] px-3 py-2 rounded">
          <i data-lucide="loader" class="w-3 h-3 animate-spin"></i> Processing memories...
        </div>
      `;
    }

    if (this.memoryState.a3.length > 0) {
      html += `
        <div>
          <h3 class="text-[10px] uppercase text-muted font-bold mb-2 tracking-wider">Tier 3 — Grand Narrative</h3>
          ${this.memoryState.a3.map((a, i) => this.renderCard(a, `Macro-Summary ${i+1}`)).join('')}
        </div>
      `;
    }
    if (this.memoryState.a2.length > 0) {
      html += `
        <div>
          <h3 class="text-[10px] uppercase text-muted font-bold mb-2 tracking-wider">Tier 2 — Chapter Summaries</h3>
          ${this.memoryState.a2.map((a, i) => this.renderCard(a, `Meso-Summary ${i+1}`)).join('')}
        </div>
      `;
    }
    if (this.memoryState.a1.length > 0) {
      html += `
        <div>
          <h3 class="text-[10px] uppercase text-muted font-bold mb-2 tracking-wider">Tier 1 — Scene Summaries</h3>
          ${this.memoryState.a1.map((a, i) => this.renderCard(a, `Micro-Summary ${i+1}`)).join('')}
        </div>
      `;
    }
    if (this.memoryState.a1.length === 0 && this.memoryState.a2.length === 0 && this.memoryState.a3.length === 0) {
      html += `
        <div class="flex flex-col items-center gap-2 py-6 opacity-50">
          <i data-lucide="brain" class="w-8 h-8 text-muted"></i>
          <p class="text-xs text-center text-muted italic">Memories form after the 5th turn.</p>
        </div>
      `;
    }
    
    el.innerHTML = html;
    if (window.lucide) window.lucide.createIcons({ root: el });
  }

  updateMilestonesSection() {
    const el = this.container.querySelector('#milestones-container');
    if (!el) return;
    
    if (this.memoryState.milestones.length > 0) {
      el.innerHTML = this.memoryState.milestones.map(m => this.renderMilestone(m)).join('');
    } else {
      el.innerHTML = `<div class="py-4 text-center text-xs text-muted italic opacity-70">No milestones yet. <br>The story is still unwritten.</div>`;
    }
    if (window.lucide) window.lucide.createIcons({ root: el });
  }

  updatePerformanceSection() {
    const el = this.container.querySelector('#section-performance');
    if (!el) return;

    const { latest, total } = this.performanceState;
    const latestTime = latest.ttft ? (latest.ttft / 1000).toFixed(1) + 's' : '0.0s';
    const totalTime = total.ttft ? (total.ttft / 1000).toFixed(1) + 's' : '0.0s';

    el.innerHTML = performanceTemplate
      .replace('{{LATEST_TIME}}', latestTime)
      .replace('{{LATEST_INPUT}}', latest.inputTokens.toLocaleString())
      .replace('{{LATEST_OUTPUT}}', latest.outputTokens.toLocaleString())
      .replace('{{TOTAL_TIME}}', totalTime)
      .replace('{{TOTAL_INPUT}}', total.inputTokens.toLocaleString())
      .replace('{{TOTAL_OUTPUT}}', total.outputTokens.toLocaleString());
      
    if (window.lucide) window.lucide.createIcons({ root: el });
  }

  updateRagSection() {
    const el = this.container.querySelector('#section-rag-debug');
    if (!el) return;
    
    let rebuildHtml = '';
    if (this.ragState.isRebuilding) {
      rebuildHtml = `
          <div class="text-blue-400 mt-2 font-semibold animate-pulse">
            Rebuilding: ${this.ragState.rebuildProgress.processed} / ${this.ragState.rebuildProgress.total} turns
          </div>
      `;
    } else {
      rebuildHtml = `
          <button id="btn-rag-rebuild" class="mt-2 text-[10px] w-full text-center bg-gray-700 hover:bg-gray-600 rounded py-1">
            Rebuild Index (Test)
          </button>
      `;
    }
    
    let queryHtml = '';
    if (this.ragState.lastQuery) {
        queryHtml = `
          <div class="text-xs italic text-gray-400 mb-2 p-2 bg-gray-800 rounded">
            "...${escapeHtml(this.ragState.lastQuery.length > 50 ? this.ragState.lastQuery.substring(0,50) + '...' : this.ragState.lastQuery)}"
          </div>
        `;
    } else {
        queryHtml = '<div class="text-xs text-gray-500">No queries yet</div>';
    }
    
    let resultsHtml = '';
    if (this.ragState.lastQuery) {
        if (this.ragState.topKResults.length === 0) {
            resultsHtml += '<div class="text-xs text-gray-500">No results > threshold</div>';
        }
        resultsHtml += this.ragState.topKResults.map((res, i) => `
            <div class="border border-gray-700 bg-gray-850 rounded p-2 mb-2 text-xs">
              <div class="flex justify-between items-center mb-1">
                <span class="bg-gray-700 px-1 rounded font-bold">${res.sourceType.toUpperCase()} ${res.turnIndex != null ? `T${res.turnIndex}` : ''}</span>
                <span class="text-${res.similarity > 0.8 ? 'green' : 'yellow'}-400 font-mono">${res.similarity.toFixed(3)}</span>
              </div>
              <div class="text-gray-300 line-clamp-3">
                ${escapeHtml(res.text)}
              </div>
            </div>
        `).join('');
    }

    el.innerHTML = ragDebugTemplate
      .replace('{{STATS_TOTAL}}', this.ragState.stats.total)
      .replace('{{STATS_MODEL}}', this.ragState.stats.model || 'N/A')
      .replace('{{STATS_LAST_TURN}}', this.ragState.stats.lastTurn !== null ? this.ragState.stats.lastTurn : 'None')
      .replace('{{REBUILD_HTML}}', rebuildHtml)
      .replace('{{QUERY_HTML}}', queryHtml)
      .replace('{{RESULTS_HTML}}', resultsHtml);

    if (window.lucide) window.lucide.createIcons({ root: el });

    const rebuildBtn = el.querySelector('#btn-rag-rebuild');
    if (rebuildBtn) {
      rebuildBtn.addEventListener('click', () => {
        eventBus.emit(EVENTS.RAG_TRIGGER_REBUILD, { sessionId: this.currentSessionId });
      });
    }
  }
}
