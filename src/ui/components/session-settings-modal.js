import { db } from '../../core/db.js';
import { eventBus } from '../../core/event-bus.js';
import { showToast } from '../toast-ui.js';
import { openExpandedTextarea } from '../../utils/textarea-expander.js';
import { escapeHtml as escapeHTML } from '../../utils/validators.js';
import { EntityFormUI } from './entity-form-ui.js';
import { EVENTS } from '../../core/events.js';

import headerTemplate from '../templates/components/session-settings/header.html?raw';
import bibleBeforeTemplate from '../templates/components/session-settings/bible-before.html?raw';
import userPersonaTemplate from '../templates/components/session-settings/user-persona.html?raw';
import bibleAfterTemplate from '../templates/components/session-settings/bible-after.html?raw';
import entitiesTabTemplate from '../templates/components/session-settings/entities-tab.html?raw';
import prioritiesTabTemplate from '../templates/components/session-settings/priorities-tab.html?raw';
import priorityRowTemplate from '../templates/components/session-settings/priority-row.html?raw';

export class SessionSettingsModal {
  constructor(activeSessionId, sessionContext) {
    this.activeSessionId = activeSessionId;
    this.sessionContext = sessionContext;
    this.session = null;
    this.overlay = null;
    this.contentArea = null;
    this.activeTab = 'user-persona';
    this.tabs = null;
    this.entitiesArray = [];
    this.prioritiesArray = [];
    this.keydownHandler = this.handleKeydown.bind(this);
  }

  static async updateSessionField(sessionId, field, value, sessionContext) {
    // Nested update logic
    const session = await db.game_sessions.get(sessionId);
    if (!session) return;

    if (field.startsWith('protagonist.')) {
      const prop = field.split('.')[1];
      session.protagonist[prop] = value;
    } else if (field.startsWith('world.')) {
        const prop = field.split('.')[1];
        if (!session.world) session.world = {};
        session.world[prop] = value;
    } else {
      session[field] = value;
    }

    session.updatedAt = Date.now();
    await db.game_sessions.put(session);

    if (sessionContext && sessionContext.session && sessionContext.session.id === sessionId) {
      if (field.startsWith('protagonist.')) {
          const prop = field.split('.')[1];
          sessionContext.session.protagonist[prop] = value;
      } else if (field.startsWith('world.')) {
          const prop = field.split('.')[1];
          if (!sessionContext.session.world) sessionContext.session.world = {};
          sessionContext.session.world[prop] = value;
      } else {
          sessionContext.session[field] = value;
      }
    }
    eventBus.emit(EVENTS.SETTINGS_CHANGED, { key: "session", sessionId }); 
  }

  static async open(activeSessionId, sessionContext) {
    const modal = new SessionSettingsModal(activeSessionId, sessionContext);
    await modal.init();
  }

  async init() {
    try {
      if (!this.activeSessionId) return;
      this.session = await db.game_sessions.get(this.activeSessionId);
      if (!this.session) return;
      
      this.renderBaseUI();
      this.renderContent();
      
      document.body.appendChild(this.overlay);
      document.addEventListener('keydown', this.keydownHandler);
      
      if (window.lucide) window.lucide.createIcons({ root: this.overlay || document.body });
    } catch (err) {
      console.error('Error opening edit session panel:', err);
      showToast('Failed to open session panel.', 'error');
    }
  }

  renderBaseUI() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-labelledby', 'edit-session-title');
    
    const panel = document.createElement('div');
    panel.className = 'bg-[var(--bg-surface)] rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden border border-[var(--border-default)]';
    
    const header = document.createElement('div');
    header.className = 'flex justify-between items-center p-4 border-b border-[var(--border-default)]';
    header.innerHTML = headerTemplate;
    header.querySelector('.close-btn').addEventListener('click', () => this.close());
  
    this.tabs = document.createElement('div');
    this.tabs.className = 'flex border-b border-[var(--border-default)]';
    this.tabs.setAttribute('role', 'tablist');
    
    const tabNames = [
      { id: 'bible-before', label: 'World Bible Before' },
      { id: 'user-persona', label: 'User Persona' },
      { id: 'entities', label: 'Entities/NPCs' },
      { id: 'creative-priorities', label: 'Creative Priorities' },
      { id: 'bible-after', label: 'World Bible After' }
    ];

    this.tabs.innerHTML = tabNames.map(t => 
      `<button role="tab" aria-selected="${this.activeTab === t.id}" aria-controls="edit-session-tab-content" id="edit-tab-${t.id}" class="tab-btn flex-1 py-3 text-center font-medium text-sm transition-colors" data-id="${t.id}">${t.label}</button>`
    ).join('');
    
    this.updateTabStyles();

    this.tabs.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.activeTab = e.currentTarget.dataset.id;
        this.updateTabStyles();
        this.renderContent();
      });
    });

    this.contentArea = document.createElement('div');
    this.contentArea.id = 'edit-session-tab-content';
    this.contentArea.setAttribute('role', 'tabpanel');
    this.contentArea.className = 'flex-1 overflow-y-auto p-6 bg-[var(--bg-base)]';

    panel.appendChild(header);
    panel.appendChild(this.tabs);
    panel.appendChild(this.contentArea);
    this.overlay.appendChild(panel);
  }

  updateTabStyles() {
    this.tabs.querySelectorAll('.tab-btn').forEach(btn => {
      const isActive = btn.dataset.id === this.activeTab;
      btn.setAttribute('aria-selected', isActive.toString());
      if (isActive) {
        btn.className = 'tab-btn flex-1 py-3 text-center font-medium text-sm transition-colors border-b-2 border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-glow)]';
      } else {
        btn.className = 'tab-btn flex-1 py-3 text-center font-medium text-sm transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]';
      }
    });
  }

  renderContent() {
    this.contentArea.setAttribute('aria-labelledby', `edit-tab-${this.activeTab}`);
    this.contentArea.innerHTML = '';
    
    const form = document.createElement('div');
    form.className = 'space-y-4 flex flex-col h-full min-h-[300px]';
    
    if (this.activeTab === 'bible-before') {
      this.renderBibleBeforeTab(form);
    } else if (this.activeTab === 'user-persona') {
      this.renderUserPersonaTab(form);
    } else if (this.activeTab === 'entities') {
      this.renderEntitiesTab(form);
    } else if (this.activeTab === 'creative-priorities') {
      this.renderCreativePrioritiesTab(form);
    } else if (this.activeTab === 'bible-after') {
      this.renderBibleAfterTab(form);
    }
    
    this.contentArea.appendChild(form);
    if (window.lucide) window.lucide.createIcons({ root: this.overlay || document.body });
  }

  renderBibleBeforeTab(form) {
    form.innerHTML = bibleBeforeTemplate.replace('{{WORLD_BIBLE_BEFORE}}', escapeHTML(this.session.world?.bibleBefore || ''));
    const expandBtn = form.querySelector('.btn-expand');
    const ta = form.querySelector('textarea');
    expandBtn.addEventListener('click', () => openExpandedTextarea(ta, 'Edit World Bible Before'));

    form.querySelector('#save-before').addEventListener('click', async () => {
      const val = form.querySelector('#edit-world-before').value;
      await SessionSettingsModal.updateSessionField(this.session.id, 'world.bibleBefore', val, this.sessionContext);
      showToast('World Bible Before saved!', 'success');
    });
  }

  renderUserPersonaTab(form) {
    // Safely ensure nested objects exist in case of old runtime data before migration
    if (!this.session.protagonist) this.session.protagonist = { customFields: [] };
    this.session.protagonist.customFields = Array.isArray(this.session.protagonist.customFields) ? [...this.session.protagonist.customFields] : [];
    
    form.innerHTML = userPersonaTemplate
      .replace('{{USER_PERSONA}}', escapeHTML(this.session.protagonist.persona || ''))
      .replace('{{USER_APPEARANCE}}', escapeHTML(this.session.protagonist.appearance || ''))
      .replace('{{USER_RELATIONSHIP}}', escapeHTML(this.session.protagonist.relationship || ''));
    
    const expandPersonaBtn = form.querySelector('.btn-expand-persona');
    const taPersona = form.querySelector('#edit-persona');
    expandPersonaBtn.addEventListener('click', () => openExpandedTextarea(taPersona, 'Character Codex'));

    const expandAppearanceBtn = form.querySelector('.btn-expand-appearance');
    const taAppearance = form.querySelector('#edit-appearance');
    if (expandAppearanceBtn && taAppearance) {
      expandAppearanceBtn.addEventListener('click', () => openExpandedTextarea(taAppearance, 'Physical Appearance'));
    }

    const expandRelationshipBtn = form.querySelector('.btn-expand-relationship');
    const taRelationship = form.querySelector('#edit-relationship');
    if (expandRelationshipBtn && taRelationship) {
      expandRelationshipBtn.addEventListener('click', () => openExpandedTextarea(taRelationship, 'Relationship Dynamics'));
    }

    const uploadFileBtn = form.querySelector('#upload-protagonist-file-settings');
    if (uploadFileBtn) {
      uploadFileBtn.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
           await this.processProtagonistFile(file, taPersona, taAppearance, taRelationship, form);
        }
        e.target.value = '';
      });
    }

    const cfList = form.querySelector('#protagonist-cf-list');
    const renderProtagonistCfs = () => {
      cfList.innerHTML = '';
      this.session.protagonist.customFields.forEach(cf => {
         this.renderSingleProtagonistCfEdit(cf, cfList);
      });
      if(window.lucide) window.lucide.createIcons({ root: cfList });
    };

    const addCfBtn = form.querySelector('#add-protagonist-cf-btn');
    if (addCfBtn && cfList) {
       addCfBtn.addEventListener('click', () => {
         const newCf = { title: '', content: '' };
         this.session.protagonist.customFields.push(newCf);
         this.renderSingleProtagonistCfEdit(newCf, cfList);
         if(window.lucide) window.lucide.createIcons({ root: cfList });
       });
       renderProtagonistCfs();
    }

    form.querySelector('#save-persona').addEventListener('click', async () => {
      const personaVal = taPersona.value;
      const appearanceVal = taAppearance.value;
      const relationshipVal = taRelationship ? taRelationship.value : '';
      const filteredCfs = this.session.protagonist.customFields.filter(cf => cf.title.trim() !== '' || cf.content.trim() !== '');
      
      await SessionSettingsModal.updateSessionField(this.session.id, 'protagonist.persona', personaVal, this.sessionContext);
      await SessionSettingsModal.updateSessionField(this.session.id, 'protagonist.appearance', appearanceVal, this.sessionContext);
      await SessionSettingsModal.updateSessionField(this.session.id, 'protagonist.relationship', relationshipVal, this.sessionContext);
      await SessionSettingsModal.updateSessionField(this.session.id, 'protagonist.customFields', filteredCfs, this.sessionContext);
      
      showToast('Protagonist Identity saved!', 'success');
    });
  }

  async processProtagonistFile(file, personaInput, appearanceInput, relationshipInput, form) {
    if (file.size > 1024 * 1024) {
      showToast('File size exceeds 1MB limit.', 'error');
      return;
    }
    try {
      const text = await file.text();
      const tagRegex = /<([^>]+)>([\s\S]*?)<\/\1>/gi;
      let match;
      const parsedData = {};
      let foundAny = false;
      
      while ((match = tagRegex.exec(text)) !== null) {
         foundAny = true;
         const rawTag = match[1].toLowerCase().trim();
         const content = match[2].trim();
         
         let normalizedTag = rawTag;
         if (/name/i.test(rawTag)) normalizedTag = 'name'; // Even if name is ignored, standardizing helps
         else if (/person|mindset|psyche|background/i.test(rawTag)) normalizedTag = 'persona';
         else if (/appear|look|desc/i.test(rawTag)) normalizedTag = 'appearance';
         else if (/relation|dynamic|connect/i.test(rawTag)) normalizedTag = 'relationship';
         
         parsedData[normalizedTag] = content;
      }
      
      if (!foundAny) {
         showToast('No valid XML tags found in file.', 'warning');
         return;
      }

      delete parsedData['name']; // Not setting protagonist name from this interface currently due to schema

      if (parsedData['persona']) {
        personaInput.value = parsedData['persona'];
        delete parsedData['persona'];
      }
      if (parsedData['appearance']) {
        appearanceInput.value = parsedData['appearance'];
        delete parsedData['appearance'];
      }
      if (parsedData['relationship']) {
        if (relationshipInput) relationshipInput.value = parsedData['relationship'];
        delete parsedData['relationship'];
      }

      for (const [key, value] of Object.entries(parsedData)) {
         if (value) {
             const formattedTitle = key.split(/[-_\s]+/)
                                      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                                      .join(' ');
             this.session.protagonist.customFields.push({ title: formattedTitle, content: value });
         }
      }
      
      const cfList = form.querySelector('#protagonist-cf-list');
      if (cfList) {
        cfList.innerHTML = '';
        this.session.protagonist.customFields.forEach(cf => {
           this.renderSingleProtagonistCfEdit(cf, cfList);
        });
        if(window.lucide) window.lucide.createIcons({ root: cfList });
      }

      showToast('Protagonist profile loaded successfully', 'success');
    } catch (error) {
      console.error(error);
      showToast('Error reading the file', 'error');
    }
  }

  renderSingleProtagonistCfEdit(cf, listContainer) {
    if (!EntityFormUI) return;
    const fakeEnt = {
        customFields: this.session.protagonist.customFields,
        full_name: this.session.protagonist?.name || 'Protagonist'
    };
    EntityFormUI.renderSingleCustomField(cf, listContainer, fakeEnt);
  }

  renderBibleAfterTab(form) {
    form.innerHTML = bibleAfterTemplate.replace('{{WORLD_BIBLE_AFTER}}', escapeHTML(this.session.world?.bibleAfter || ''));
    
    const expandBtn = form.querySelector('.btn-expand');
    const ta = form.querySelector('textarea');
    expandBtn.addEventListener('click', () => openExpandedTextarea(ta, 'Edit World Bible After'));

    form.querySelector('#save-after').addEventListener('click', async () => {
      const val = form.querySelector('#edit-bible-after').value;
      await SessionSettingsModal.updateSessionField(this.session.id, 'world.bibleAfter', val, this.sessionContext);
      showToast('World Bible After saved!', 'success');
    });
  }

  renderEntitiesTab(form) {
    this.entitiesArray = Array.isArray(this.session.entities) ? JSON.parse(JSON.stringify(this.session.entities)) : [];
    form.innerHTML = entitiesTabTemplate;

    const entEditList = form.querySelector('#ent-edit-list');
    
    const renderEntEditList = () => {
      entEditList.innerHTML = '';
      this.entitiesArray.forEach(ent => this.renderSingleEntEdit(ent, entEditList));
      if (window.lucide) window.lucide.createIcons({ root: this.overlay || document.body });
    };

    form.querySelector('#add-ent-edit-btn').addEventListener('click', () => {
      const newEnt = { id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2), full_name: '', role: '', mindset: '', motivation: '', appearance: '', relationship: '', customFields: [] };
      this.entitiesArray.push(newEnt);
      this.renderSingleEntEdit(newEnt, entEditList);
      if (window.lucide) window.lucide.createIcons({ root: this.overlay || document.body });
      entEditList.scrollTop = entEditList.scrollHeight;
    });

    renderEntEditList();

    form.querySelector('#save-ent').addEventListener('click', async () => {
      const cleaned = this.entitiesArray.filter(ent => (ent.full_name || ent.name || '').trim() !== '');
      await SessionSettingsModal.updateSessionField(this.session.id, 'entities', cleaned, this.sessionContext);
      showToast('Entities saved!', 'success');
    });
  }

  renderSingleEntEdit(ent, container) {
    EntityFormUI.renderSingleEntity(ent, container, {
      showFileUpload: false,
      onDelete: () => {
        const idx = this.entitiesArray.indexOf(ent);
        if (idx > -1) {
          this.entitiesArray.splice(idx, 1);
        }
      }
    });
  }

  renderCreativePrioritiesTab(form) {
    this.prioritiesArray = Array.isArray(this.session.creativePriorities) ? [...this.session.creativePriorities] : [];
    form.innerHTML = prioritiesTabTemplate;

    const cpEditList = form.querySelector('#cp-edit-list');
    
    const renderCpEditList = () => {
      cpEditList.innerHTML = '';
      this.prioritiesArray.forEach(cp => this.renderSingleCpEdit(cp, cpEditList));
      if (window.lucide) window.lucide.createIcons({ root: this.overlay || document.body });
    };

    form.querySelector('#add-cp-edit-btn').addEventListener('click', () => {
      const newCp = { title: '', description: '' };
      this.prioritiesArray.push(newCp);
      this.renderSingleCpEdit(newCp, cpEditList);
      if (window.lucide) window.lucide.createIcons({ root: this.overlay || document.body });
      cpEditList.scrollTop = cpEditList.scrollHeight;
    });

    renderCpEditList();

    form.querySelector('#save-cp').addEventListener('click', async () => {
      const cleaned = this.prioritiesArray.filter(cp => cp.title.trim() !== '' && cp.description.trim() !== '');
      await SessionSettingsModal.updateSessionField(this.session.id, 'creativePriorities', cleaned, this.sessionContext);
      showToast('Creative Priorities saved!', 'success');
    });
  }

  renderSingleCpEdit(cp, container) {
    const row = document.createElement('div');
    row.className = 'flex flex-col bg-[var(--bg-elevated)] border border-[var(--border-default)] justify-between p-3 rounded-lg shadow-sm w-full gap-2 shrink-0';
    row.innerHTML = priorityRowTemplate
      .replace('{{CP_TITLE}}', escapeHTML(cp.title || ''))
      .replace('{{CP_DESC}}', escapeHTML(cp.description || ''));
      
    container.appendChild(row);

    row.querySelector('.cp-title').addEventListener('input', (e) => cp.title = e.target.value);
    row.querySelector('.cp-desc').addEventListener('input', (e) => cp.description = e.target.value);
    row.querySelector('.delete-cp').addEventListener('click', () => {
      const idx = this.prioritiesArray.indexOf(cp);
      if (idx > -1) {
         this.prioritiesArray.splice(idx, 1);
         row.remove();
      }
    });
  }

  close() {
    if (this.overlay && this.overlay.parentNode) {
      document.body.removeChild(this.overlay);
    }
    document.removeEventListener('keydown', this.keydownHandler);
  }
  
  handleKeydown(e) {
    if (e.key === 'Escape') {
      this.close();
    } else if (e.key === 'Tab') {
      if (!this.overlay) return;
      const focusableEls = this.overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusableEls.length > 0) {
        const first = focusableEls[0];
        const last = focusableEls[focusableEls.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || document.activeElement === document.body) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || document.activeElement === document.body) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }
  }
}
