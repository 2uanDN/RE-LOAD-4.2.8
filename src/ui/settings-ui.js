import { db } from '../core/db.js';
import { settingsManager } from '../core/settings-manager.js';
import { exportGameState, exportSettings, importGameState, importSettings } from '../utils/json-io.js';
import { showToast } from './toast-ui.js';
import { openExpandedTextarea } from '../utils/textarea-expander.js';
import { apiClient } from '../core/api-client.js';
import { isValidApiKey, isValidProviderUrl, escapeHtml } from '../utils/validators.js';
import { themeManager } from './theme.js';
import { eventBus } from '../core/event-bus.js';

import layoutTemplate from './templates/settings/layout.html?raw';
import tabGeneralTemplate from './templates/settings/tab-general.html?raw';
import tabProvidersTemplate from './templates/settings/tab-providers.html?raw';
import tabPromptsTemplate from './templates/settings/tab-prompts.html?raw';
import tabPromptsExpertTemplate from './templates/settings/tab-prompts-expert.html?raw';
import tabDisplayTemplate from './templates/settings/tab-display.html?raw';
import tabDataTemplate from './templates/settings/tab-data.html?raw';
import { EVENTS } from '../core/events.js';

const debounceTimers = new WeakMap();

class SettingsUI {
  constructor() {
    this.container = null;
    this.activeTab = "general";
    this.providers = [];
    this.experts = [];
    this._isOpen = false;
    this.activeSessionId = null;
    this.activePromptsCategory = "narrative";

    eventBus.on(EVENTS.SESSION_NEW, ({ session }) => {
      this.activeSessionId = session.id;
    });
    eventBus.on(EVENTS.SESSION_LOADED, (sessionContext) => {
      this.activeSessionId = sessionContext.session.id;
    });
  }

  async open() {
    this._isOpen = true;
    this.activeTab = "general";
    this.providers = await settingsManager.loadAllProviders();
    this.experts = await settingsManager.loadAllExperts();
    this.render();
  }

  close() {
    this._isOpen = false;
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }
    if (this._tabTrapHandler) {
      document.removeEventListener('keydown', this._tabTrapHandler);
      this._tabTrapHandler = null;
    }
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }

  async refreshData() {
    this.providers = await settingsManager.loadAllProviders();
    this.experts = await settingsManager.loadAllExperts();
    if (this._isOpen) this.render();
  }

  render() {
    if (!this.container) {
      this.container = document.createElement("div");
      document.body.appendChild(this.container);
      
      this._escHandler = (e) => {
        if (e.key === 'Escape' && this._isOpen) this.close();
      };
      
      this._tabTrapHandler = (e) => {
        if (e.key === 'Tab' && this._isOpen && this.container) {
          const focusableEls = this.container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (focusableEls.length > 0) {
            const first = focusableEls[0];
            const last = focusableEls[focusableEls.length - 1];
            
            if (e.shiftKey) { // Shift + Tab
              if (document.activeElement === first || document.activeElement === document.body) {
                e.preventDefault();
                last.focus();
              }
            } else { // Tab
              if (document.activeElement === last || document.activeElement === document.body) {
                e.preventDefault();
                first.focus();
              }
            }
          }
        }
      };
      
      document.addEventListener('keydown', this._escHandler);
      document.addEventListener('keydown', this._tabTrapHandler);

      this.container.innerHTML = layoutTemplate;
      
      if (window.lucide) window.lucide.createIcons({ root: this.container });

      // Attach base events
      this.container.querySelector('#settings-close-btn').addEventListener('click', () => this.close());
      
      // Tab switching events
      this.container.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          this.switchTab(e.currentTarget.dataset.tab);
        });
      });
    }

    this.switchTab(this.activeTab); 
  }

  switchTab(tabId) {
    this.activeTab = tabId;
    
    // Update tab classes
    this.container.querySelectorAll('.tab-btn').forEach(btn => {
      const isActive = btn.dataset.tab === tabId;
      btn.setAttribute('aria-selected', isActive.toString());
      if (isActive) {
        btn.classList.add('text-[var(--accent)]', 'border-[var(--accent)]');
        btn.classList.remove('text-secondary', 'border-transparent', 'hover:text-primary');
      } else {
        btn.classList.remove('text-[var(--accent)]', 'border-[var(--accent)]');
        btn.classList.add('text-secondary', 'border-transparent', 'hover:text-primary');
      }
    });

    const contentBox = this.container.querySelector('#settings-tab-content');
    contentBox.setAttribute('aria-labelledby', `tab-${tabId}`);
    
    this.renderActiveTab();
  }

  async renderActiveTab() {
    const contentBox = this.container.querySelector('#settings-tab-content');
    contentBox.innerHTML = ''; 

    switch (this.activeTab) {
      case "general":
        await this.renderTabGeneral(contentBox);
        break;
      case "providers":
        this.renderTabProviders(contentBox);
        break;
      case "prompts":
        this.renderTabPrompts(contentBox);
        break;
      case "display":
        await this.renderTabDisplay(contentBox);
        break;
      case "data":
        this.renderTabData(contentBox);
        break;
    }
    
    if (window.lucide) window.lucide.createIcons({ root: contentBox });
  }

  async renderTabGeneral(target) {
    target.innerHTML = tabGeneralTemplate;
    
    const general = await settingsManager.loadSetting("general");
    const windowSize = general?.slidingWindowSize || 10;
    
    const memory = await settingsManager.loadSetting("memory");
    const a1Turns = memory?.a1TriggerTurns || 5;
    const a2Count = memory?.a2TriggerCount || 5;
    const a3Count = memory?.a3TriggerCount || 5;

    const safeLimit = memory?.safeInputLimit || 160000;
    const sysMsgBudget = memory?.systemTokens || 40000;
    const usrMsgBudget = memory?.userTokens || 100000;
    const ragBudget = memory?.tokenBudget || 10000;
    const ragKbBudget = memory?.ragKbTokenBudget ?? 10000;

    // Apply values to range elements
    target.querySelector('#gen-sws').value = windowSize;
    target.querySelector('#gen-sws-val').textContent = windowSize;

    target.querySelector('#mem-a1').value = a1Turns;
    target.querySelector('#mem-a1-val').textContent = a1Turns;
    target.querySelector('#visual-a1-turns').textContent = a1Turns;

    target.querySelector('#mem-a2').value = a2Count;
    target.querySelector('#mem-a2-val').textContent = a2Count;
    target.querySelector('#visual-a2-count').textContent = a2Count;

    target.querySelector('#mem-a3').value = a3Count;
    target.querySelector('#mem-a3-val').textContent = a3Count;
    target.querySelector('#visual-a3-count').textContent = a3Count;

    // Set token values
    target.querySelector('#ratio-safe-limit').value = safeLimit;
    target.querySelector('#ratio-system-msg').value = sysMsgBudget;
    target.querySelector('#ratio-user-msg').value = usrMsgBudget;
    target.querySelector('#ratio-rag-budget').value = ragBudget;
    target.querySelector('#ratio-rag-kb-budget').value = ragKbBudget;

    // Direct binding for sliding window size
    const genSwsRange = target.querySelector('#gen-sws');
    genSwsRange.addEventListener('input', (e) => {
      target.querySelector('#gen-sws-val').textContent = e.target.value;
    });
    genSwsRange.addEventListener('change', async (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 5) val = 10;
      if (val > 20) val = 20;
      
      const currentGen = await settingsManager.loadSetting("general") || {};
      currentGen.slidingWindowSize = val;
      await settingsManager.saveSetting("general", currentGen);
    });

    // Helper to bind memory slider ranges
    const bindMemoryInput = (sliderId, valueSpanId, visualSpanId, key, minVal, maxVal, defaultVal) => {
      const slider = target.querySelector(sliderId);
      const valSpan = target.querySelector(valueSpanId);
      const visSpan = target.querySelector(visualSpanId);

      slider.addEventListener('input', (e) => {
        valSpan.textContent = e.target.value;
        if (visSpan) visSpan.textContent = e.target.value;
      });

      slider.addEventListener('change', async (e) => {
        let val = parseInt(e.target.value, 10);
        if (isNaN(val) || val < minVal) val = defaultVal;
        if (val > maxVal) val = maxVal;
        
        valSpan.textContent = val;
        if (visSpan) visSpan.textContent = val;

        const currentMemory = await settingsManager.loadSetting("memory") || {};
        currentMemory[key] = val;
        await settingsManager.saveSetting("memory", currentMemory);
      });
    };

    bindMemoryInput('#mem-a1', '#mem-a1-val', '#visual-a1-turns', 'a1TriggerTurns', 1, 20, 5);
    bindMemoryInput('#mem-a2', '#mem-a2-val', '#visual-a2-count', 'a2TriggerCount', 1, 20, 5);
    bindMemoryInput('#mem-a3', '#mem-a3-val', '#visual-a3-count', 'a3TriggerCount', 1, 20, 5);

    // Dynamic Allocation Health Monitor Function
    const updateAllocationHealth = () => {
      const safe = parseInt(target.querySelector('#ratio-safe-limit').value, 10) || 160000;
      const sys = parseInt(target.querySelector('#ratio-system-msg').value, 10) || 40000;
      const usr = parseInt(target.querySelector('#ratio-user-msg').value, 10) || 100000;
      const rag = parseInt(target.querySelector('#ratio-rag-budget').value, 10) || 10000;
      const ragKb = parseInt(target.querySelector('#ratio-rag-kb-budget').value, 10) || 10000;
      const sum = sys + usr + rag + ragKb;
      
      const percent = Math.min(100, Math.max(0, (sum / safe) * 100));
      
      const totalSpan = target.querySelector('#ratio-sum-total');
      const progressDiv = target.querySelector('#ratio-sum-progress');
      const feedbackDiv = target.querySelector('#ratio-sum-feedback');

      totalSpan.textContent = `${sum.toLocaleString()} / ${safe.toLocaleString()} tokens`;
      progressDiv.style.width = `${percent}%`;

      if (sum > safe) {
        progressDiv.style.backgroundColor = '#ef4444'; // Red
        feedbackDiv.className = "text-[11px] font-semibold text-red-400 mt-1 flex items-center gap-1";
        feedbackDiv.innerHTML = `<i data-lucide="alert-triangle" class="w-3.5 h-3.5 inline"></i> Warning: System + User + RAG budgets exceed global Input Limit!`;
      } else if (sum > safe * 0.9) {
        progressDiv.style.backgroundColor = '#f59e0b'; // Amber
        feedbackDiv.className = "text-[11px] font-semibold text-amber-400 mt-1 flex items-center gap-1";
        feedbackDiv.innerHTML = `<i data-lucide="info" class="w-3.5 h-3.5 inline"></i> Budgets close to the global Safe Input Limit (${Math.round(percent)}%).`;
      } else {
        progressDiv.style.backgroundColor = 'var(--accent)';
        feedbackDiv.className = "text-[11px] font-semibold text-emerald-400 mt-1 flex items-center gap-1";
        feedbackDiv.innerHTML = `<i data-lucide="check" class="w-3.5 h-3.5 inline"></i> Budgets fit safely within global Safe Input Limit (${Math.round(percent)}%).`;
      }
      
      if (window.lucide) window.lucide.createIcons({ root: feedbackDiv });
    };

    updateAllocationHealth();

    // Bind token limits input change events
    const bindNumericInput = (id, key, minVal, maxVal, defaultVal) => {
      const inputEl = target.querySelector(id);
      inputEl.addEventListener('change', async (e) => {
        let val = parseInt(e.target.value, 10);
        if (isNaN(val) || val < minVal) val = defaultVal;
        if (val > maxVal) val = maxVal;
        e.target.value = val;
        
        const currentMemory = await settingsManager.loadSetting("memory") || {};
        currentMemory[key] = val;
        await settingsManager.saveSetting("memory", currentMemory);
        updateAllocationHealth();
      });
    };

    bindNumericInput('#ratio-safe-limit', 'safeInputLimit', 1000, 160000, 160000);
    bindNumericInput('#ratio-system-msg', 'systemTokens', 500, 40000, 40000);
    bindNumericInput('#ratio-user-msg', 'userTokens', 1000, 100000, 100000);
    bindNumericInput('#ratio-rag-budget', 'tokenBudget', 100, 10000, 10000);
    bindNumericInput('#ratio-rag-kb-budget', 'ragKbTokenBudget', 0, 10000, 10000);

  }

  renderTabProviders(target) {
    target.innerHTML = tabProvidersTemplate;
    
    const listContainer = target.querySelector('#providers-list');
    
    let listHtml = '';
    this.providers.forEach(p => {
      let savedModelsHtml = '';
      if (p.savedModels && p.savedModels.length) {
         savedModelsHtml = `<div class="mt-2.5 flex flex-wrap gap-1.5">${p.savedModels.map(m => `<span class="bg-[var(--bg-base)] border border-default text-[10px] text-secondary px-2 py-0.5 rounded flex items-center gap-1 font-mono tracking-wide whitespace-nowrap"><i data-lucide="box" class="w-2.5 h-2.5"></i> ${escapeHtml(m)}</span>`).join('')}</div>`;
      }
      
      listHtml += `
        <div class="border border-default bg-surface rounded-xl p-5 flex items-center justify-between group transition-colors hover:border-[var(--accent)] gap-4">
          <div class="min-w-0 flex-1">
            <h4 class="font-prose text-lg text-primary flex items-center gap-3 flex-wrap">
              ${escapeHtml(p.name)}
              <span class="text-[10px] font-mono bg-[var(--accent-glow)] text-[var(--accent)] px-2.5 py-0.5 rounded-full uppercase tracking-widest font-semibold whitespace-nowrap">${p.keys.length} keys</span>
            </h4>
            <p class="text-xs text-secondary truncate w-full mt-1 font-mono opacity-80">${escapeHtml(p.baseUrl)}</p>
            ${savedModelsHtml}
          </div>
          <div class="flex gap-2 md:opacity-0 group-hover:opacity-100 transition-opacity shrink-0 items-start">
            <button data-id="${p.id}" class="edit-btn p-2 transition-colors text-secondary hover:text-[var(--accent)] bg-hover rounded-full"><i data-lucide="edit-2" class="w-4 h-4"></i></button>
            <button data-id="${p.id}" class="del-btn p-2 transition-colors text-secondary hover:text-red-400 bg-hover rounded-full"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
          </div>
        </div>
      `;
    });
    listContainer.innerHTML = listHtml;

    const selectExp = target.querySelector('#diag-exp');
    let diagHtml = this.experts.filter(e => e.providerId).map(e => `<option value="${e.id}">${escapeHtml(e.displayName)} (${escapeHtml(e.modelName)})</option>`).join('');
    if (!this.experts.filter(e => e.providerId).length) diagHtml += '<option value="">No expert configured with provider</option>';
    selectExp.innerHTML = diagHtml;

    if (window.lucide) window.lucide.createIcons({ root: target });

    // Event handlers
    const addBtn = target.querySelector('#add-prov-btn');
    const formPanel = target.querySelector('#add-prov-form');
    
    let keysState = [''];
    let keysVisible = false;
    const keysContainer = target.querySelector('#p-keys-container');
    const addKeyBtn = target.querySelector('#add-p-key-btn');
    
    const renderKeys = () => {
      keysContainer.innerHTML = '';
      keysState.forEach((keyVal, idx) => {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2';
        
        const input = document.createElement('input');
        input.type = keysVisible ? 'text' : 'password';
        input.value = keyVal;
        input.className = 'w-full px-4 py-3 bg-base border border-default rounded-lg text-primary focus:outline-none focus:border-[var(--accent)] transition-colors font-mono text-sm leading-relaxed';
        input.placeholder = 'API Key';
        input.addEventListener('input', (e) => {
           keysState[idx] = e.target.value;
        });

        const rmBtn = document.createElement('button');
        rmBtn.className = 'text-secondary hover:text-red-400 p-2 rounded-lg hover:bg-hover transition-colors focus:outline-none shrink-0 border border-transparent hover:border-subtle';
        rmBtn.innerHTML = '<i data-lucide="minus" class="w-4 h-4"></i>';
        rmBtn.addEventListener('click', () => {
           if (keysState.length > 1) {
             keysState.splice(idx, 1);
             renderKeys();
           } else {
             this.customAlert('At least one key is required.', 'warning');
           }
        });

        row.appendChild(input);
        row.appendChild(rmBtn);
        keysContainer.appendChild(row);
      });
      if (window.lucide) window.lucide.createIcons({ root: keysContainer });
      updateKeysVisibilityUI();
    };

    if (addKeyBtn) {
      addKeyBtn.addEventListener('click', () => {
         keysState.push('');
         renderKeys();
      });
    }

    const showForm = (editingId = null) => {
      formPanel.classList.remove('hidden');
      if (editingId) {
        target.querySelector('#add-prov-title').textContent = 'Edit Provider';
        const p = this.providers.find(x => x.id === editingId);
        target.querySelector('#p-id').value = p.id;
        target.querySelector('#p-name').value = p.name;
        target.querySelector('#p-format').value = p.format || 'google';
        target.querySelector('#p-url').value = p.baseUrl;
        keysState = p.keys && p.keys.length > 0 ? [...p.keys] : [''];
        
        const isGoogle = (p.baseUrl || "").includes("generativelanguage.googleapis.com") || p.format === 'google';
        const emptyCaps = Object.keys(p.capabilities || {}).length === 0;
        
        let caps = p.capabilities || {};
        if (emptyCaps) {
          if (isGoogle) {
             caps = { topK: true, thinking: true, systemRole: true, responseFormat: true };
          } else {
             caps = { topK: false, thinking: false, systemRole: true, responseFormat: false };
          }
        }
        
        target.querySelector('#cap-topk').checked = caps.topK !== false;
        target.querySelector('#cap-thinking').checked = caps.thinking !== false;
        target.querySelector('#cap-system').checked = caps.systemRole !== false;
        target.querySelector('#cap-format').checked = caps.responseFormat !== false;
      } else {
        target.querySelector('#add-prov-title').textContent = 'Add Provider';
        target.querySelector('#p-id').value = '';
        target.querySelector('#p-name').value = '';
        target.querySelector('#p-format').value = 'google';
        target.querySelector('#p-url').value = '';
        keysState = [''];
        
        target.querySelector('#cap-topk').checked = false;
        target.querySelector('#cap-thinking').checked = false;
        target.querySelector('#cap-system').checked = true;
        target.querySelector('#cap-format').checked = false;
      }
      keysVisible = false;
      renderKeys();
    };

    const hideForm = () => {
      formPanel.classList.add('hidden');
    };

    addBtn.addEventListener('click', () => showForm());
    target.querySelector('#p-cancel').addEventListener('click', () => hideForm());

    target.querySelector('#p-save').addEventListener('click', async () => {
      const name = target.querySelector('#p-name').value.trim();
      const format = target.querySelector('#p-format').value;
      const baseUrl = target.querySelector('#p-url').value.trim();
      const keys = keysState.map(k => k.trim()).filter(k => k);

      if (!name || !baseUrl) return this.customAlert("Name and Base URL are required.");
      if (!isValidProviderUrl(baseUrl)) return this.customAlert("Provider URL is invalid. Must be http:// or https://");
      
      if (!keys.length) return this.customAlert("At least one key is required.");
      
      const invalidKeys = keys.filter(k => !isValidApiKey(k));
      if (invalidKeys.length > 0) {
        return this.customAlert("One or more API keys are invalid. Ensure they meet the required format.");
      }

      const capabilities = {
        topK: target.querySelector('#cap-topk').checked,
        thinking: target.querySelector('#cap-thinking').checked,
        systemRole: target.querySelector('#cap-system').checked,
        responseFormat: target.querySelector('#cap-format').checked
      };

      const isEdit = target.querySelector('#p-id').value;
      const id = isEdit ? isEdit : 'prov_' + crypto.randomUUID();

      let existingProvider = null;
      if (isEdit) {
        existingProvider = this.providers.find(p => p.id === id);
      }

      await settingsManager.saveProvider({ 
        id, 
        name, 
        format, 
        baseUrl, 
        keys, 
        capabilities,
        keyIndex: existingProvider ? (existingProvider.keyIndex ?? 0) : 0,
        savedModels: existingProvider ? (existingProvider.savedModels || []) : []
      });
      await this.refreshData();
    });

    target.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        showForm(e.currentTarget.dataset.id);
      });
    });

    target.querySelectorAll('.del-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.dataset.id;
        const usingCount = this.experts.filter(exp => exp.providerId === id).length;
        
        const deleteCb = async (confirmed) => {
          if (!confirmed) return;
          await settingsManager.deleteProvider(id);
          await this.refreshData();
        };

        if (usingCount > 0) {
          this.customConfirm(`${usingCount} experts are using this provider. Delete anyway?`, deleteCb);
        } else {
          this.customConfirm(`Are you sure you want to delete this provider?`, deleteCb);
        }
      });
    });

    // Keys hide/reveal masking mechanism
    const toggleKeysBtn = target.querySelector('#toggle-p-keys-btn');
    
    const updateKeysVisibilityUI = () => {
        if (!toggleKeysBtn) return;
        const iconEl = toggleKeysBtn.querySelector('#eye-icon');
        const textEl = toggleKeysBtn.querySelector('#eye-text');
        
        if (keysVisible) {
          if (iconEl) iconEl.setAttribute('data-lucide', 'eye-off');
          if (textEl) textEl.textContent = 'Hide Keys';
        } else {
          if (iconEl) iconEl.setAttribute('data-lucide', 'eye');
          if (textEl) textEl.textContent = 'Show Keys';
        }
        if (window.lucide) window.lucide.createIcons({ root: toggleKeysBtn });
        
        keysContainer.querySelectorAll('input').forEach(input => {
           input.type = keysVisible ? 'text' : 'password';
        });
    };

    if (toggleKeysBtn) {
      toggleKeysBtn.addEventListener('click', () => {
         keysVisible = !keysVisible;
         updateKeysVisibilityUI();
      });
    }

    // Fetch Models Logic
    const fetchProvSelect = target.querySelector('#fetch-prov-select');
    const fetchModelsBtn = target.querySelector('#fetch-models-btn');
    const fetchedModelsPanel = target.querySelector('#fetched-models-panel');
    const fetchedModelsList = target.querySelector('#fetched-models-list');
    const closeFetchedModelsBtn = target.querySelector('#close-fetched-models-btn');
    
    if (fetchProvSelect) {
      let fetchProvHtml = '<option value="">Select a provider...</option>';
      this.providers.forEach(p => {
        fetchProvHtml += `<option value="${p.id}">${escapeHtml(p.name)}</option>`;
      });
      fetchProvSelect.innerHTML = fetchProvHtml;
      
      const updateFetchBtnState = () => {
        if (!fetchProvSelect.value) {
          fetchModelsBtn.disabled = true;
          fetchModelsBtn.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
          fetchModelsBtn.disabled = false;
          fetchModelsBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
      };
      
      fetchProvSelect.addEventListener('change', updateFetchBtnState);
      updateFetchBtnState();

      let currentFetchedModels = [];
      let currentProviderId = null;

      const renderFetchedModels = async () => {
        fetchedModelsList.innerHTML = '';
        const provider = this.providers.find(p => p.id === currentProviderId);
        if (!provider) return;
        
        provider.savedModels = provider.savedModels || [];
        
        if (currentFetchedModels.length === 0) {
          fetchedModelsList.innerHTML = '<div class="text-secondary italic">No models found.</div>';
          return;
        }

        currentFetchedModels.forEach(modelName => {
          const isSaved = provider.savedModels.includes(modelName);
          const icon = isSaved ? 'minus' : 'plus';
          const btnClass = isSaved ? 'text-red-400 hover:bg-red-500/10' : 'text-green-500 hover:bg-green-500/10';
          const title = isSaved ? 'Remove from saved' : 'Save model';
          
          const row = document.createElement('div');
          row.className = 'flex items-center justify-between p-2 rounded hover:bg-base transition-colors border border-transparent hover:border-subtle';
          row.innerHTML = `
            <span class="truncate pr-2">${escapeHtml(modelName)}</span>
            <button class="toggle-model-btn p-1.5 rounded transition-colors ${btnClass}" data-model="${escapeHtml(modelName)}" title="${title}">
              <i data-lucide="${icon}" class="w-4 h-4"></i>
            </button>
          `;
          fetchedModelsList.appendChild(row);
        });

        if (window.lucide) window.lucide.createIcons({ root: fetchedModelsList });

        fetchedModelsList.querySelectorAll('.toggle-model-btn').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const m = e.currentTarget.dataset.model;
            const p = this.providers.find(x => x.id === currentProviderId);
            if (!p) return;
            p.savedModels = p.savedModels || [];
            
            if (p.savedModels.includes(m)) {
              p.savedModels = p.savedModels.filter(x => x !== m);
            } else {
              p.savedModels.push(m);
            }
            
            // Save provider
            await settingsManager.saveProvider(p);
            
            // Reload providers list in memory so local component knows about the new settings.
            // Avoid calling this.refreshData() as it completely rebuilds the tab DOM, destroying our panel.
            this.providers = await settingsManager.loadAllProviders();
            
            // Re-render the list only
            renderFetchedModels();
          });
        });
      };

      fetchModelsBtn.addEventListener('click', async () => {
        const pId = fetchProvSelect.value;
        const provider = this.providers.find(p => p.id === pId);
        if (!provider || !provider.keys.length) return;

        const originalHtml = fetchModelsBtn.innerHTML;
        fetchModelsBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Fetching...';
        fetchModelsBtn.disabled = true;
        if (window.lucide) window.lucide.createIcons({ root: fetchModelsBtn });

        try {
          // Import here to avoid circular dependency if any, or use api-utils imported top
          const { fetchModelsListAPI } = await import('../utils/api-utils.js');
          currentFetchedModels = await fetchModelsListAPI(provider, provider.keys[0]);
          currentProviderId = pId;
          
          fetchedModelsPanel.classList.remove('hidden');
          renderFetchedModels();
        } catch (err) {
          showToast(`Fetch Models Failed: ${err.message}`, "error");
        } finally {
          fetchModelsBtn.innerHTML = originalHtml;
          fetchModelsBtn.disabled = false;
          if (window.lucide) window.lucide.createIcons({ root: fetchModelsBtn });
        }
      });
      
      closeFetchedModelsBtn.addEventListener('click', () => {
        fetchedModelsPanel.classList.add('hidden');
      });
    }

    // Technical Diagnostic execution with formatted logs
    target.querySelector('#diag-test').addEventListener('click', async () => {
      const eId = target.querySelector('#diag-exp').value;
      const term = target.querySelector('#diag-term');
      if (!eId) return;

      const placeholderText = '// Terminal system active. Waiting for diagnostics call...';
      if (term.innerHTML.includes(placeholderText)) {
        term.innerHTML = '';
      }

      const appendLine = (text, type = 'info') => {
        const line = document.createElement('div');
        line.className = 'font-mono text-xs leading-relaxed mb-0.5';
        
        if (type === 'success') {
          line.classList.add('text-[var(--success)]');
        } else if (type === 'error') {
          line.classList.add('text-[var(--error)]');
        } else if (type === 'warning') {
          line.classList.add('text-[var(--warning)]');
        } else {
          line.classList.add('text-[var(--accent)]');
        }
        
        const timestamp = new Date().toLocaleTimeString();
        line.innerHTML = `<span class="text-zinc-500 mr-2">[${timestamp}]</span> ${escapeHtml(text)}`;
        term.appendChild(line);
        term.scrollTop = term.scrollHeight;
      };

      const diagBtn = target.querySelector('#diag-test');
      const tempHtml = diagBtn.innerHTML;
      diagBtn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Running...`;
      diagBtn.disabled = true;
      if (window.lucide) window.lucide.createIcons({ root: diagBtn });
      
      appendLine(`[Test] Dispatching handshake diagnostic request to: "${eId}"...`, 'info');

      try {
        if (eId === "EMBED_PRIMARY") {
           const res = await apiClient.callEmbedding(eId, ["Test query"]);
           if (res && res.embeddings && res.embeddings.length > 0) {
             appendLine(`[Success] Embeddings compiled! Dimensionality size: ${res.embeddings[0].length}`, 'success');
           } else {
             appendLine(`[Warning] Embedding execution succeeded but returns empty payload details.`, 'warning');
           }
        } else {
           const res = await apiClient.testConnection(eId);
           appendLine(`[Success] Handshake succeeded! Connection status: STABLE.`, 'success');
           appendLine(`[Model Response] "${res.slice(0, 70)}..."`, 'success');
        }
        this.customAlert("Diagnostics completed successfully", "success");
      } catch (err) {
        appendLine(`[Error] Diagnostic connection failure: ${err.message}`, 'error');
        this.customAlert("Diagnostics failed", "error");
      } finally {
        diagBtn.innerHTML = tempHtml;
        diagBtn.disabled = false;
        if (window.lucide) window.lucide.createIcons({ root: diagBtn });
      }
    });
  }

  renderTabPrompts(target) {
    target.innerHTML = tabPromptsTemplate;
    
    if (!this.providers.length) {
      target.querySelector('#prompts-warning').classList.remove('hidden');
    }

    if (!this.activePromptsCategory) {
      this.activePromptsCategory = "narrative";
    }

    // Sync sub-tabs categories
    const subtabs = target.querySelectorAll('.subtab-btn');
    subtabs.forEach(btn => {
      const cat = btn.dataset.cat;
      const isActive = cat === this.activePromptsCategory;
      if (isActive) {
        btn.className = 'subtab-btn px-4 py-2.5 text-xs font-bold tracking-wider uppercase border-b-2 text-[var(--accent)] border-[var(--accent)] focus:outline-none flex items-center gap-2 transition-all';
      } else {
        btn.className = 'subtab-btn px-4 py-2.5 text-xs font-bold tracking-wider uppercase border-b-2 text-secondary border-transparent hover:text-primary focus:outline-none flex items-center gap-2 transition-all';
      }
      
      btn.addEventListener('click', (e) => {
        this.activePromptsCategory = e.currentTarget.dataset.cat;
        this.renderTabPrompts(target);
      });
    });

    const container = target.querySelector('#prompts-container');
    container.innerHTML = '';

    // Filter models
    const filteredExperts = this.experts.filter(expert => {
      if (this.activePromptsCategory === 'narrative') {
        return expert.id === 'EXPERT_NARRATIVE';
      } else if (this.activePromptsCategory === 'creation') {
        return expert.id === 'EXPERT_WORLDFORGE' || expert.id === 'EXPERT_CHARFORGE';
      } else if (this.activePromptsCategory === 'memory') {
        return expert.id === 'EXPERT_SUMMARIZE' || expert.id === 'EMBED_PRIMARY';
      }
      return false;
    });

    filteredExperts.forEach(expert => {
      const isEmbed = expert.id === "EMBED_PRIMARY";
      
      const wrapper = document.createElement('div');
      wrapper.innerHTML = tabPromptsExpertTemplate;
      const node = wrapper.firstElementChild;
      
      node.dataset.expert = expert.id;
      node.querySelector('[data-exp-name]').textContent = expert.displayName;
      node.querySelector('[data-exp-id-label]').textContent = expert.id;
      
      const modelInput = node.querySelector('[data-field="modelName"]');
      modelInput.value = expert.modelName || '';
      
      const providerSelect = node.querySelector('[data-field="providerId"]');
      this.providers.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (expert.providerId === p.id) opt.selected = true;
        providerSelect.appendChild(opt);
      });

      // Select UI setup for saved models
      const savedModelsSelect = node.querySelector('[data-select="savedModels"]');
      
      const updateSavedModelsSelect = () => {
        savedModelsSelect.innerHTML = '<option value="">-- Saved Models --</option>';
        const pId = providerSelect.value;
        const prov = this.providers.find(p => p.id === pId);
        
        let hasModels = false;
        if (prov && prov.savedModels && prov.savedModels.length) {
          prov.savedModels.forEach(m => {
            if (isEmbed && !m.toLowerCase().includes('embed')) return;
            hasModels = true;
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            savedModelsSelect.appendChild(opt);
          });
        }
        
        // Only show select if there are saved models
        if (hasModels) {
           savedModelsSelect.classList.remove('hidden');
        } else {
           savedModelsSelect.classList.add('hidden');
        }
      };
      
      // Update when Provider dropdown changes
      updateSavedModelsSelect();
      providerSelect.addEventListener('change', (e) => {
        updateSavedModelsSelect();
        modelInput.value = '';
        modelInput.dispatchEvent(new Event('blur'));
      });
      
      // When a saved model is selected, populate the input and trigger save
      savedModelsSelect.addEventListener('change', (e) => {
         const val = e.target.value;
         if (val) {
           modelInput.value = val;
           // Trigger blur to save via auto-save logic below
           modelInput.dispatchEvent(new Event('blur'));
           // Reset select to placeholder
           e.target.value = '';
         }
      });

      if (!isEmbed) {
        node.querySelector('[data-normal-expert]').classList.remove('hidden');
        node.querySelector('[data-field="temperature"]').value = expert.temperature ?? 0.7;
        node.querySelector('[data-field="topP"]').value = expert.topP ?? 0.9;
        node.querySelector('[data-field="topK"]').value = expert.topK ?? 40;
        node.querySelector('[data-field="maxTokens"]').value = expert.maxTokens || '';
        node.querySelector('[data-field="timeout"]').value = expert.timeout || '';
        
        const tbSelect = node.querySelector('.tb-select');
        const customContainer = node.querySelector('.tb-custom');
        const customInput = node.querySelector('[data-field="thinkingBudget"]');
        
        customInput.value = expert.thinkingBudget !== undefined ? expert.thinkingBudget : '';
        
        if (expert.thinkingBudget === -1 || expert.thinkingBudget === "auto" || expert.thinkingBudget === "-1") {
          tbSelect.value = "auto";
        } else if (!expert.thinkingBudget && expert.thinkingBudget !== 0) {
          // If undefined, default auto could be chosen if we wanted, but we set it to -1 in defaults. Let's just catch 0
          tbSelect.value = "0";
        } else if (expert.thinkingBudget === 0) {
          tbSelect.value = "0";
        } else if ([8192, 16000, 24000].includes(Number(expert.thinkingBudget))) {
          tbSelect.value = expert.thinkingBudget.toString();
        } else {
          tbSelect.value = "custom";
          customContainer.classList.remove('hidden');
        }
      } else {
        node.querySelector('[data-embed-expert]').classList.remove('hidden');
      }

      container.appendChild(node);
    });

    if (window.lucide) window.lucide.createIcons({ root: target });

    // Bind thinking budget selection
    target.querySelectorAll('.tb-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const val = e.target.value;
        const customContainer = e.target.closest('.pt-2').querySelector('.tb-custom');
        const customInput = customContainer.querySelector('input');
        if (val === 'custom') {
          customContainer.classList.remove('hidden');
        } else {
          customContainer.classList.add('hidden');
          customInput.value = val; 
        }
        customInput.dispatchEvent(new Event('blur'));
      });
    });

    // Auto-save logic
    target.querySelectorAll('.exp-input').forEach(input => {
      const eventName = input.tagName === 'SELECT' ? 'change' : 'blur';
      input.addEventListener(eventName, (e) => {
        const targetElement = e.target;
        const expertId = targetElement.closest('[data-expert]').dataset.expert;
        const field = targetElement.dataset.field;
        let val = targetElement.value;
        const type = targetElement.type;

        if (debounceTimers.has(targetElement)) {
          clearTimeout(debounceTimers.get(targetElement));
        }
        
        const timerId = setTimeout(async () => {
          if (type === 'number') val = parseFloat(val) || 0;
          
          if (field === 'thinkingBudget') {
            if (val === 'auto' || String(val) === '-1') {
              val = -1;
            } else {
              val = parseInt(val, 10) || 0;
            }
          }
          
          const expert = this.experts.find(x => x.id === expertId);
          if (expert) {
            if (expertId === 'EMBED_PRIMARY' && field === 'modelName' && val && val.trim() !== '') {
              if (!val.toLowerCase().includes('embed')) {
                 showToast('Embedding model name must contain "embed".', 'error');
                 targetElement.value = expert[field] || '';
                 return;
              }
            }
            expert[field] = val;
            await settingsManager.saveExpert(expert);
          }
        }, 300);
        
        debounceTimers.set(targetElement, timerId);
      });
    });
  }

  async renderTabDisplay(target) {
    target.innerHTML = tabDisplayTemplate;

    const displaySettings = await settingsManager.loadSetting("display");
    const isDark = displaySettings?.theme !== "light"; 
    const turnsPerPage = displaySettings?.turnsPerPage || 10;
    const proseSize = displaySettings?.proseSize || "standard";
    const fontFamily = displaySettings?.fontFamily || "lora";

    target.querySelector('#theme-toggle').checked = isDark;
    target.querySelector('#disp-turns-per-page').value = turnsPerPage;
    target.querySelector('#disp-font-family').value = fontFamily;

    // Style the segment prose options
    const sizeBtns = target.querySelectorAll('.size-opt-btn');
    const applySizeActiveUI = (selectedSize) => {
      sizeBtns.forEach(btn => {
        const isCurrent = btn.dataset.size === selectedSize;
        if (isCurrent) {
          btn.className = 'size-opt-btn flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all focus:outline-none flex items-center justify-center gap-1.5 bg-surface text-[var(--accent)] border border-subtle shadow-sm font-semibold';
        } else {
          btn.className = 'size-opt-btn flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all focus:outline-none flex items-center justify-center gap-1.5 text-secondary hover:text-primary hover:bg-hover border border-transparent';
        }
      });
    };

    applySizeActiveUI(proseSize);

    if (window.lucide) window.lucide.createIcons({ root: target });

    target.querySelector('#theme-toggle').addEventListener('change', async (e) => {
      const isChecked = e.target.checked;
      const newTheme = isChecked ? "dark" : "light";
      themeManager.applyTheme(newTheme);
      const currentDisplay = await settingsManager.loadSetting("display") || {};
      currentDisplay.theme = newTheme;
      await settingsManager.saveSetting("display", currentDisplay);
    });

    target.querySelector('#disp-turns-per-page').addEventListener('blur', async (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 1) val = 10;
      e.target.value = val;
      const currentDisplay = await settingsManager.loadSetting("display") || {};
      currentDisplay.turnsPerPage = val;
      await settingsManager.saveSetting("display", currentDisplay);
      
      eventBus.emit(EVENTS.DISPLAY_TURNS_PER_PAGE_CHANGED, { turnsPerPage: val });
    });

    target.querySelector('#disp-font-family').addEventListener('change', async (e) => {
      const selectedFont = e.target.value;
      themeManager.applyFontFamily(selectedFont);
      const currentDisplay = await settingsManager.loadSetting("display") || {};
      currentDisplay.fontFamily = selectedFont;
      await settingsManager.saveSetting("display", currentDisplay);
    });

    // Handle segmented font sizes triggers
    sizeBtns.forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const selectedSize = e.currentTarget.dataset.size;
        applySizeActiveUI(selectedSize);
        themeManager.applyProseSize(selectedSize);

        const currentDisplay = await settingsManager.loadSetting("display") || {};
        currentDisplay.proseSize = selectedSize;
        await settingsManager.saveSetting("display", currentDisplay);
      });
    });
  }

  renderTabData(target) {
    target.innerHTML = tabDataTemplate;

    if (window.lucide) window.lucide.createIcons({ root: target });

    target.querySelector('#btn-export-game').addEventListener('click', async () => {
      try {
        const sessions = await db.game_sessions.toArray();
        if (sessions.length === 0) {
          return this.customAlert("No game sessions found to export.");
        }
        
        let targetSessionId = this.activeSessionId;
        
        if (!targetSessionId) {
          sessions.sort((a, b) => b.updatedAt - a.updatedAt);
          targetSessionId = sessions[0].id;
        }
        
        try {
          await exportGameState(targetSessionId);
          this.customAlert("Game state exported successfully!", "success");
        } catch (err) {
          this.customAlert("Export failed: " + err.message);
        }
      } catch (err) {
        this.customAlert("Failed to access sessions: " + err.message);
      }
    });

    target.querySelector('#btn-export-settings').addEventListener('click', () => {
      this.customConfirm("This file contains API keys. Keep it secure!", (confirmed) => {
        if (!confirmed) return;
        exportSettings()
          .then(() => this.customAlert("Settings exported successfully!", "success"))
          .catch(err => this.customAlert("Export failed: " + err.message));
      });
    });

    const fileImportGame = target.querySelector('#file-import-game');
    target.querySelector('#btn-import-game').addEventListener('click', () => fileImportGame.click());
    fileImportGame.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      this.customConfirm("This will add a new session. Existing data is unaffected. Proceed?", (confirmed) => {
        if (!confirmed) return;
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            await importGameState(event.target.result);
            this.customAlert("Import successful! Reloading...");
            setTimeout(() => window.location.reload(), 1200);
          } catch (err) {
            this.customAlert("Import failed: " + err.message);
          }
        };
        reader.readAsText(file);
      });
    });

    const fileImportSettings = target.querySelector('#file-import-settings');
    target.querySelector('#btn-import-settings').addEventListener('click', () => fileImportSettings.click());
    fileImportSettings.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      this.customConfirm("This will REPLACE all current settings and providers. Proceed?", async (confirmed) => {
        if (!confirmed) return;
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            await importSettings(event.target.result);
            this.customAlert("Settings imported successfully! Reloading...");
            await themeManager.initTheme();
            setTimeout(() => window.location.reload(), 1200);
          } catch (err) {
            this.customAlert("Import failed: " + err.message);
          }
        };
        reader.readAsText(file);
      });
    });
  }

  customAlert(msg, type = 'info') {
    if (msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('error')) {
       type = 'error';
    } else if (msg.toLowerCase().includes('success')) {
       type = 'success';
    }
    showToast(msg, type);
  }

  customConfirm(msg, callback) {
    const dialog = document.createElement('div');
    dialog.className = "fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex justify-center items-center p-4 transition-opacity";
    dialog.innerHTML = `
      <div class="bg-elevated p-8 rounded-2xl shadow-[var(--shadow-modal)] max-w-sm w-full border border-subtle">
        <p class="text-primary text-center leading-relaxed mb-8">${escapeHtml(String(msg || '')).replace(/\n/g, '<br>')}</p>
        <div class="flex justify-end gap-3">
          <button id="ccn" class="px-6 py-2.5 border border-default text-primary rounded-lg hover:bg-hover transition-colors font-medium">Cancel</button>
          <button id="cyes" class="px-6 py-2.5 bg-[var(--accent)] text-[#1a1917] font-semibold rounded-lg hover:bg-[var(--accent-dim)] transition-colors">Proceed</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelector('#ccn').addEventListener('click', () => { dialog.remove(); callback(false); });
    dialog.querySelector('#cyes').addEventListener('click', () => { dialog.remove(); callback(true); });
  }

  customPrompt(msg, defaultText, callback) {
    const dialog = document.createElement('div');
    dialog.className = "fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex justify-center items-center p-4 transition-opacity";
    dialog.innerHTML = `
      <div class="bg-elevated p-8 rounded-2xl shadow-[var(--shadow-modal)] max-w-sm w-full border border-subtle">
        <p class="text-primary font-medium mb-4">${escapeHtml(String(msg || ''))}</p>
        <input type="text" class="w-full px-4 py-3 bg-base border border-default rounded-lg text-primary focus:outline-none focus:border-[var(--accent)] transition-colors mb-8" value="${escapeHtml(String(defaultText || ''))}">
        <div class="flex justify-end gap-3">
          <button id="pcn" class="px-6 py-2.5 border border-default text-primary rounded-lg hover:bg-hover transition-colors font-medium">Cancel</button>
          <button id="pyes" class="px-6 py-2.5 bg-[var(--accent)] text-[#1a1917] font-semibold rounded-lg hover:bg-[var(--accent-dim)] transition-colors">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    const input = dialog.querySelector('input');
    input.focus();
    dialog.querySelector('#pcn').addEventListener('click', () => { dialog.remove(); callback(null); });
    dialog.querySelector('#pyes').addEventListener('click', () => { dialog.remove(); callback(input.value); });
  }
}

export const settingsUI = new SettingsUI();
