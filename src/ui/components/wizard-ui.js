import { apiClient } from '../../core/api-client.js';
import { workerBridge } from '../../workers/worker-bridge.js';
import { db } from '../../core/db.js';
import { getProviderFormat } from '../../utils/api-utils.js';
import { keyRotator } from '../../core/key-rotator.js';
import { normalizeVector } from '../../utils/vector-math.js';
import { showToast } from '../toast-ui.js';
import { openExpandedTextarea } from '../../utils/textarea-expander.js';
import { escapeHtml as escapeHTML } from '../../utils/validators.js';
import { EntityFormUI } from './entity-form-ui.js';
import { safeMarkedParse } from '../../utils/text-parser.js';

import { DEFAULT_EXPERTS } from '../../core/default-experts.js';
import step1Template from '../templates/components/wizard/step1.html?raw';
import step2Template from '../templates/components/wizard/step2.html?raw';
import step3Template from '../templates/components/wizard/step3.html?raw';
import step4Template from '../templates/components/wizard/step4.html?raw';
import step5Template from '../templates/components/wizard/step5.html?raw';
import step6Template from '../templates/components/wizard/step6.html?raw';
import cpRowTemplate from '../templates/components/wizard/cp-row.html?raw';
import rightPanelWorld from '../templates/components/wizard/right-panel-world.html?raw';
import rightPanelChar from '../templates/components/wizard/right-panel-char.html?raw';
import rightPanelBody from '../templates/components/wizard/right-panel-body.html?raw';

export class WizardUI {
  constructor(appContainer, onComplete, onCancel) {
    this.appContainer = appContainer;
    this.onComplete = onComplete;
    this.onCancel = onCancel;
    
    this.wizardState = {
      step: 1,
      worldName: '',
      worldBibleBefore: '',
      characterName: '',
      userPersona: '',
      userAppearance: '',
      userRelationship: '',
      protagonistCustomFields: [],
      entities: [],
      creativePriorities: [],
      worldBibleAfter: '',
      kbFiles: [] // Store selected files for Step 6
    };
    
    this.isGenerating = false;
    this.currentAbortController = null;
    
    // UI Elements
    this.container = null;
    this.contentArea = null;
    this.rightPanel = null;
    this.stepLabel = null;
    this.backBtn = null;
    this.nextBtn = null;
  }
  
  render() {
    this.appContainer.innerHTML = '';
    
    this.container = document.createElement('div');
    this.container.className = 'w-full min-h-screen bg-[var(--bg-base)] flex flex-col relative text-[var(--text-primary)] font-ui overflow-hidden';
    
    const topBar = document.createElement('div');
    topBar.className = 'p-6 flex justify-between flex-shrink-0 items-center';
    
    this.stepLabel = document.createElement('div');
    this.stepLabel.className = 'font-bold text-xl font-prose text-[var(--accent)]';
    topBar.appendChild(this.stepLabel);
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'p-2 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]';
    closeBtn.innerHTML = '<i data-lucide="x" class="w-6 h-6"></i>';
    closeBtn.addEventListener('click', () => {
      if (this.currentAbortController) this.currentAbortController.abort();
      this.onCancel();
    });
    topBar.appendChild(closeBtn);

    const mainArea = document.createElement('div');
    mainArea.className = 'flex-1 flex overflow-hidden relative';

    this.contentArea = document.createElement('div');
    this.contentArea.className = 'flex-1 overflow-y-auto p-8 relative flex flex-col items-center';

    this.rightPanel = document.createElement('div');
    this.rightPanel.className = 'hidden absolute inset-y-0 right-0 w-full sm:w-[400px] bg-[var(--bg-surface)] border-l border-[var(--border-default)] flex flex-col shadow-2xl z-20';

    const bottomBar = document.createElement('div');
    bottomBar.className = 'p-4 border-t border-[var(--border-default)] bg-[var(--bg-surface)] flex justify-between items-center';

    this.backBtn = document.createElement('button');
    this.backBtn.className = 'px-6 py-2 rounded font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50';
    this.backBtn.textContent = "Back";
    this.backBtn.addEventListener('click', () => this.handleBack());

    const progressDots = document.createElement('div');
    progressDots.className = 'flex gap-2';
    for(let i=1; i<=6; i++) {
        const dot = document.createElement('div');
        dot.id = `dot-${i}`;
        dot.className = 'w-3 h-3 rounded-full bg-[var(--text-muted)] transition-colors';
        progressDots.appendChild(dot);
    }

    this.nextBtn = document.createElement('button');
    this.nextBtn.className = 'px-6 py-2 rounded font-medium bg-[var(--accent)] text-white hover:opacity-90 shadow flex items-center gap-2';
    this.nextBtn.addEventListener('click', () => this.handleNext());

    bottomBar.appendChild(this.backBtn);
    bottomBar.appendChild(progressDots);
    bottomBar.appendChild(this.nextBtn);

    this.container.appendChild(topBar);
    this.container.appendChild(mainArea);
    mainArea.appendChild(this.contentArea);
    mainArea.appendChild(this.rightPanel);
    this.container.appendChild(bottomBar);

    this.appContainer.appendChild(this.container);
    
    this.renderStep();
  }

  handleBack() {
    if (this.wizardState.step > 1) {
      this.wizardState.step--;
      this.renderStep();
    }
  }

  async handleNext() {
    const ws = this.wizardState;
    if (ws.step === 1) {
      if (!ws.worldName.trim()) {
        showToast('Please enter a World Name (Session Title).', 'warning');
        return;
      }
      if (!ws.worldBibleBefore.trim()) {
        showToast('Please enter or generate a World Bible before proceeding.', 'warning');
        return;
      }
    } else if (ws.step === 2) {
      if (!ws.characterName.trim()) {
         showToast('Please enter a Character Name.', 'warning');
         return;
      }
      if (!ws.userPersona.trim()) {
         showToast('Please enter a User Persona.', 'warning');
         return;
      }
    } else if (ws.step === 3) {
      ws.entities = ws.entities.filter(ent => (ent.full_name || ent.name || '').trim() !== '');
    } else if (ws.step === 4) {
      ws.creativePriorities = ws.creativePriorities.filter(cp => cp.title.trim() !== '' && cp.description.trim() !== '');
    } else if (ws.step === 5) {
      if (!ws.worldBibleAfter && false) {} // No required fields
    } else if (ws.step === 6) {
      // Step 6 handles its own progress through the Process KB button
      // But if user hits "Skip & Begin Adventure", we catch it here.
      this.finalizeWizard();
      return;
    }
    
    ws.step++;
    this.renderStep();
  }

  async finalizeWizard() {
      const ws = this.wizardState;
      try {
          this.nextBtn.disabled = true;
          this.nextBtn.textContent = "Starting...";
          await this.onComplete({
              worldBibleBefore: ws.worldBibleBefore.trim(),
              worldBibleAfter: ws.worldBibleAfter.trim(),
              userPersona: ws.userPersona.trim(),
              userAppearance: ws.userAppearance.trim(),
              userRelationship: ws.userRelationship.trim(),
              protagonistCustomFields: ws.protagonistCustomFields,
              entities: ws.entities,
              mainCharacterName: ws.characterName.trim(),
              worldName: ws.worldName.trim(),
              creativePriorities: ws.creativePriorities,
              kbFilesData: ws.kbFilesData || []
          });
      } catch(e) {
          showToast("Failed to start session: " + e.message, 'error');
          this.nextBtn.disabled = false;
          this.nextBtn.innerHTML = `<span>Skip & Begin Adventure</span> <i data-lucide="play" class="w-4 h-4"></i>`;
          if (window.lucide) window.lucide.createIcons({ root: this.nextBtn });
      }
  }

  renderStep() {
    this.contentArea.innerHTML = '';
    this.rightPanel.classList.add('hidden');

    const stepTitles = [
      'Define Your World', 
      'Protagonist Identity', 
      'Character Bible', 
      'Creative Priorities', 
      'Finalize The Stage',
      'Knowledge Base'
    ];
    this.stepLabel.textContent = `Step ${this.wizardState.step} of 6 — ${stepTitles[this.wizardState.step - 1]}`;
    
    for(let i=1; i<=6; i++) {
      const dot = document.getElementById(`dot-${i}`);
      if (!dot) continue;
      if (i === this.wizardState.step) {
        dot.className = 'w-3 h-3 rounded-full bg-[var(--accent)] shadow ring-2 ring-[var(--accent-glow)]';
      } else if (i < this.wizardState.step) {
        dot.className = 'w-3 h-3 rounded-full bg-[var(--accent-dim)]';
      } else {
        dot.className = 'w-3 h-3 rounded-full bg-[var(--text-muted)]';
      }
    }

    this.backBtn.disabled = this.wizardState.step === 1;
    
    if (this.wizardState.step === 6) {
      this.nextBtn.innerHTML = `<span>Skip & Begin</span> <i data-lucide="play" class="w-4 h-4"></i>`;
      this.nextBtn.className = 'px-6 py-2 rounded font-medium bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--text-primary)] transition-colors shadow flex items-center gap-2';
    } else {
      this.nextBtn.innerHTML = `<span>Next Step</span> <i data-lucide="arrow-right" class="w-4 h-4"></i>`;
      this.nextBtn.className = 'px-6 py-2 rounded font-medium bg-[var(--accent)] text-white hover:opacity-90 shadow flex items-center gap-2';
    }

    const stepWrapper = document.createElement('div');
    stepWrapper.className = 'max-w-3xl w-full border border-[var(--border-default)] rounded-xl bg-[var(--bg-surface)] shadow-sm overflow-hidden flex flex-col h-full';

    switch(this.wizardState.step) {
      case 1: this.renderStep1(stepWrapper); break;
      case 2: this.renderStep2(stepWrapper); break;
      case 3: this.renderStep3(stepWrapper); break;
      case 4: this.renderStep4(stepWrapper); break;
      case 5: this.renderStep5(stepWrapper); break;
      case 6: this.renderStep6(stepWrapper); break;
    }
    
    this.contentArea.appendChild(stepWrapper);
    
    if (window.lucide) window.lucide.createIcons({ root: document.getElementById("app") || document.body });
  }

  renderStep1(wrapper) {
    wrapper.innerHTML = step1Template;
    
    const inputWorldName = wrapper.querySelector('#val-world-name');
    inputWorldName.value = this.wizardState.worldName;
    inputWorldName.addEventListener('input', e => this.wizardState.worldName = e.target.value);

    const ta = wrapper.querySelector('#val-world-before');
    ta.value = this.wizardState.worldBibleBefore;
    ta.addEventListener('input', (e) => this.wizardState.worldBibleBefore = e.target.value);
    wrapper.querySelector('#expand-world-before').addEventListener('click', () => openExpandedTextarea(ta, "World Bible"));
    wrapper.querySelector('#assist-world').addEventListener('click', () => {
       this.renderRightPanel('world', ta);
    });
  }

  renderStep2(wrapper) {
    wrapper.innerHTML = step2Template;
    const inputName = wrapper.querySelector('#val-char-name');
    inputName.value = this.wizardState.characterName;
    inputName.addEventListener('input', e => this.wizardState.characterName = e.target.value);
    
    const taPersona = wrapper.querySelector('#val-persona');
    taPersona.value = this.wizardState.userPersona;
    taPersona.addEventListener('input', e => this.wizardState.userPersona = e.target.value);

    const taAppearance = wrapper.querySelector('#val-appearance');
    taAppearance.value = this.wizardState.userAppearance;
    taAppearance.addEventListener('input', e => this.wizardState.userAppearance = e.target.value);

    const taRelationship = wrapper.querySelector('#val-relationship');
    if (taRelationship) {
        taRelationship.value = this.wizardState.userRelationship;
        taRelationship.addEventListener('input', e => this.wizardState.userRelationship = e.target.value);
    }

    wrapper.querySelector('#expand-persona').addEventListener('click', () => openExpandedTextarea(taPersona, "Character Persona"));
    wrapper.querySelector('#expand-appearance').addEventListener('click', () => openExpandedTextarea(taAppearance, "Physical Appearance"));
    if (wrapper.querySelector('#expand-relationship') && taRelationship) {
        wrapper.querySelector('#expand-relationship').addEventListener('click', () => openExpandedTextarea(taRelationship, "Relationship Dynamics"));
    }

    wrapper.querySelector('#assist-char').addEventListener('click', () => {
       this.renderRightPanel('char', taPersona);
    });

    const uploadFileBtn = wrapper.querySelector('#upload-protagonist-file');
    if (uploadFileBtn) {
      uploadFileBtn.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          this.processProtagonistFile(file, inputName, taPersona, taAppearance, wrapper);
        }
        e.target.value = '';
      });
    }

    const addCfBtn = wrapper.querySelector('#add-protagonist-cf-btn');
    const cfList = wrapper.querySelector('#protagonist-cf-list');
    
    if (addCfBtn && cfList) {
      addCfBtn.addEventListener('click', () => {
         const newCf = { title: '', content: '' };
         this.wizardState.protagonistCustomFields.push(newCf);
         this.renderSingleProtagonistCf(newCf, cfList);
         if(window.lucide) window.lucide.createIcons({ root: cfList });
      });

      cfList.innerHTML = '';
      this.wizardState.protagonistCustomFields.forEach(cf => {
         this.renderSingleProtagonistCf(cf, cfList);
      });
    }
  }

  async processProtagonistFile(file, nameInput, personaInput, appearanceInput, wrapper) {
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
         if (/name/i.test(rawTag)) normalizedTag = 'name';
         else if (/person|mindset|psyche|background/i.test(rawTag)) normalizedTag = 'persona';
         else if (/appear|look|desc/i.test(rawTag)) normalizedTag = 'appearance';
         else if (/relation|dynamic|connect/i.test(rawTag)) normalizedTag = 'relationship';
         
         parsedData[normalizedTag] = content;
      }
      
      if (!foundAny) {
         showToast('No valid XML tags found in file.', 'warning');
         return;
      }

      if (parsedData['name']) {
        this.wizardState.characterName = parsedData['name'];
        nameInput.value = parsedData['name'];
        delete parsedData['name'];
      }
      if (parsedData['persona']) {
        this.wizardState.userPersona = parsedData['persona'];
        personaInput.value = parsedData['persona'];
        delete parsedData['persona'];
      }
      if (parsedData['appearance']) {
        this.wizardState.userAppearance = parsedData['appearance'];
        appearanceInput.value = parsedData['appearance'];
        delete parsedData['appearance'];
      }
      if (parsedData['relationship']) {
        this.wizardState.userRelationship = parsedData['relationship'];
        const relInput = wrapper.querySelector('#val-relationship');
        if (relInput) relInput.value = parsedData['relationship'];
        delete parsedData['relationship'];
      }

      for (const [key, value] of Object.entries(parsedData)) {
         if (value) {
             const formattedTitle = key.split(/[-_\s]+/)
                                      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                                      .join(' ');
             this.wizardState.protagonistCustomFields.push({ title: formattedTitle, content: value });
         }
      }
      
      const cfList = wrapper.querySelector('#protagonist-cf-list');
      if (cfList) {
        cfList.innerHTML = '';
        this.wizardState.protagonistCustomFields.forEach(cf => {
           this.renderSingleProtagonistCf(cf, cfList);
        });
        if(window.lucide) window.lucide.createIcons({ root: cfList });
      }

      showToast('Protagonist profile loaded successfully', 'success');
    } catch (error) {
      console.error(error);
      showToast('Error reading the file', 'error');
    }
  }

  renderSingleProtagonistCf(cf, cfList) {
      if (!EntityFormUI) return;
      const fakeEnt = {
          customFields: this.wizardState.protagonistCustomFields,
          full_name: this.wizardState.characterName || 'Protagonist'
      };
      EntityFormUI.renderSingleCustomField(cf, cfList, fakeEnt);
  }

  renderStep3(wrapper) {
    wrapper.innerHTML = step3Template;
    const addEntityBtn = wrapper.querySelector('#add-entity-btn');
    addEntityBtn.addEventListener('click', () => {
      const newEnt = { id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2), full_name: '', role: '', mindset: '', motivation: '', appearance: '', relationship: '', customFields: [] };
      this.wizardState.entities.push(newEnt);
      this.renderSingleEntity(newEnt, wrapper.querySelector('#entity-list'));
      const listEl = wrapper.querySelector('#entity-list').parentElement;
      setTimeout(() => listEl.scrollTop = listEl.scrollHeight, 10);
    });
    this.renderEntityList(wrapper.querySelector('#entity-list'));
  }

  renderStep4(wrapper) {
    wrapper.innerHTML = step4Template;
    const addCpBtn = wrapper.querySelector('#add-cp-btn');
    addCpBtn.addEventListener('click', () => {
      const newCp = { title: '', description: '' };
      this.wizardState.creativePriorities.push(newCp);
      this.renderSingleCp(newCp, wrapper.querySelector('#cp-list'));
      if (window.lucide) window.lucide.createIcons({ root: document.getElementById("app") || document.body });
      const listEl = wrapper.querySelector('#cp-list').parentElement;
      setTimeout(() => listEl.scrollTop = listEl.scrollHeight, 10);
    });
    this.renderCpList(wrapper.querySelector('#cp-list'));
  }

  renderStep5(wrapper) {
    wrapper.innerHTML = step5Template;
    const taAfter = wrapper.querySelector('#val-world-after');
    taAfter.value = this.wizardState.worldBibleAfter;
    taAfter.addEventListener('input', e => this.wizardState.worldBibleAfter = e.target.value);
    wrapper.querySelector('#expand-world-after').addEventListener('click', () => openExpandedTextarea(taAfter, "World Bible After"));
  }

  renderStep6(wrapper) {
    wrapper.innerHTML = step6Template;
    
    const dropzone = wrapper.querySelector('#kb-dropzone');
    const fileInput = wrapper.querySelector('#kb-file-input');
    const fileList = wrapper.querySelector('#kb-file-list');
    const processBtn = wrapper.querySelector('#kb-process-btn');

    const updateFileList = () => {
       fileList.innerHTML = '';
       if (this.wizardState.kbFiles.length === 0) {
           processBtn.disabled = true;
           return;
       }
       processBtn.disabled = false;
       this.wizardState.kbFiles.forEach((file, index) => {
           const row = document.createElement('div');
           row.className = 'flex items-center justify-between p-3 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg';
           const sizeKb = (file.size / 1024).toFixed(1);
           row.innerHTML = `
              <div class="flex items-center gap-3 overflow-hidden">
                 <i data-lucide="file-text" class="w-4 h-4 text-[var(--accent)] flex-shrink-0"></i>
                 <span class="truncate text-sm font-medium" title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</span>
                 <span class="text-xs text-[var(--text-secondary)] whitespace-nowrap">(${sizeKb} KB)</span>
              </div>
              <button class="delete-file text-[var(--text-secondary)] hover:text-[var(--error)] p-1 rounded-md" data-index="${index}">
                 <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
           `;
           fileList.appendChild(row);
       });
       if(window.lucide) window.lucide.createIcons({ root: fileList });

       fileList.querySelectorAll('.delete-file').forEach(btn => {
           btn.addEventListener('click', (e) => {
               const idx = parseInt(e.currentTarget.getAttribute('data-index'));
               this.wizardState.kbFiles.splice(idx, 1);
               updateFileList();
           });
       });
    };

    dropzone.addEventListener('click', () => fileInput.click());
    
    dropzone.addEventListener('dragover', (e) => {
       e.preventDefault();
       dropzone.classList.add('border-[var(--accent)]', 'bg-[var(--bg-hover)]');
    });
    dropzone.addEventListener('dragleave', (e) => {
       e.preventDefault();
       dropzone.classList.remove('border-[var(--accent)]', 'bg-[var(--bg-hover)]');
    });
    dropzone.addEventListener('drop', (e) => {
       e.preventDefault();
       dropzone.classList.remove('border-[var(--accent)]', 'bg-[var(--bg-hover)]');
       if (e.dataTransfer.files.length) {
           const newFiles = Array.from(e.dataTransfer.files).filter(f => 
              f.name.endsWith('.txt') || f.name.endsWith('.md') || f.name.endsWith('.json')
           );
           this.wizardState.kbFiles.push(...newFiles);
           updateFileList();
       }
    });

    fileInput.addEventListener('change', (e) => {
       if (e.target.files.length) {
           const newFiles = Array.from(e.target.files);
           this.wizardState.kbFiles.push(...newFiles);
           updateFileList();
       }
       e.target.value = '';
    });

    updateFileList();

    processBtn.addEventListener('click', async () => {
       const overlay = wrapper.querySelector('#kb-progress-overlay');
       const bar = wrapper.querySelector('#kb-progress-bar');
       const text = wrapper.querySelector('#kb-progress-text');
       
       overlay.classList.remove('hidden');
       this.backBtn.disabled = true;
       this.nextBtn.disabled = true;

       text.textContent = 'Extracting and reading files...';
       bar.style.width = '10%';

       // Actually we just set kbFiles and finalize the wizard, 
       // but we want to simulate or delegate the heavy lifting 
       // to session creation step. 
       // The requirement says: "khởi chạy quá trình Batch Embedding. Nút Begin Adventure sẽ bị vô hiệu hóa cho đến khi hoàn tất 100%."
       // So we should do the KB processing here OR inside finalizeWizard/SessionManager and stream progress back.
       // Let's delegate processing to onComplete, but onComplete doesn't have progress callbacks easily.
       // Wait, onComplete in GameUI handles session generation. We can pass kbFiles, but the processing needs to show here?
       // Let's implement reading files here, building an array of {fileName, text}, then passing to finalizeWizard.
       // Wait, the plan says: "Nút Process Knowledge Base để khởi chạy quá trình Batch Embedding... Cho phép người dùng chọn Bỏ qua nếu không muốn tải lên."
       try {
           const expert = await db.experts.get("EMBED_PRIMARY");
           if (!expert) throw new Error("Primary embedding expert not configured.");
           const provider = await db.providers.get(expert.providerId);
           if (!provider) throw new Error("Embedding provider not found.");
           
           const apiKey = await keyRotator.getNextKey(expert.providerId);
           const expertConfig = {
               model: expert.modelName,
               baseUrl: provider.baseUrl,
               format: getProviderFormat(provider),
               apiKey,
               taskType: expert.taskType,
               outputDimensionality: 768
           };

           const fileData = [];
           const totalFiles = this.wizardState.kbFiles.length;
           
           for (let i = 0; i < totalFiles; i++) {
               const file = this.wizardState.kbFiles[i];
               text.textContent = `Reading and embedding file ${i+1}/${totalFiles}...`;
               
               const content = await file.text();
               const docId = crypto.randomUUID();
               
               const result = await workerBridge.dispatch("CHUNK_KB_FAST", {
                   text: content,
                   docId: docId,
                   expertConfig: expertConfig,
                   targetTokens: 512,
                   overlapRatio: 0.2,
                    fastEmbedLimit: 100
               });
               
               const embeddings = [];
               if (result && result.results) {
                   for (const res of result.results) {
                       embeddings.push({
                           vector: res.vector ? normalizeVector(res.vector) : null,
                           text: res.chunkText,
                           chunkIndex: res.chunkIndex,
                           startIdx: res.startIdx,
                           endIdx: res.endIdx
                       });
                   }
               }
               
               fileData.push({ 
                   id: docId,
                   name: file.name, 
                   content, 
                   size: file.size,
                   embeddings 
               });
               
               bar.style.width = `${5 + ((i + 1) / totalFiles) * 95}%`;
           }
           
           this.wizardState.kbFilesData = fileData;
           
           bar.style.width = '100%';
           text.textContent = 'Files processed successfully! You may now begin the adventure.';
           
           // Re-enable navigation
           this.nextBtn.disabled = false;
           this.nextBtn.innerHTML = `<span>Begin Adventure</span> <i data-lucide="play" class="w-4 h-4"></i>`;
           this.nextBtn.className = 'px-6 py-2 rounded font-medium bg-[var(--accent)] text-white hover:opacity-90 shadow flex items-center gap-2';
           if (window.lucide) window.lucide.createIcons({ root: this.nextBtn });
           
           // Hide process button and dropzone to prevent re-processing
           processBtn.classList.add('hidden');
           wrapper.querySelector('#kb-dropzone').classList.add('hidden');
           
       } catch (err) {
           console.error(err);
           showToast('Failed to process KB files: ' + err.message, 'error');
           overlay.classList.add('hidden');
           this.backBtn.disabled = false;
           this.nextBtn.disabled = false;
       }
    });
  }

  renderEntityList(entityList) {
    if (!entityList) entityList = this.contentArea.querySelector('#entity-list');
    if (!entityList) return;

    entityList.innerHTML = '';
    this.wizardState.entities.forEach((ent) => {
      this.renderSingleEntity(ent, entityList);
    });
    if (window.lucide) window.lucide.createIcons({ root: document.getElementById("app") || document.body });
  }

  renderSingleEntity(ent, entityList) {
    EntityFormUI.renderSingleEntity(ent, entityList, {
      showFileUpload: true,
      onFileUpload: (file) => {
        const index = this.wizardState.entities.indexOf(ent);
        if (index > -1) {
            this.processCharacterFile(file, index);
        }
      },
      onDelete: () => {
        const idx = this.wizardState.entities.indexOf(ent);
        if (idx > -1) {
          this.wizardState.entities.splice(idx, 1);
        }
      }
    });
  }

  async processCharacterFile(file, index) {
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
         if (/name/i.test(rawTag)) normalizedTag = 'full_name';
         else if (/role|class|archetype/i.test(rawTag)) normalizedTag = 'role';
         else if (/person|mindset|psyche/i.test(rawTag)) normalizedTag = 'mindset';
         else if (/goal|motivat|motive/i.test(rawTag)) normalizedTag = 'motivation';
         else if (/appear|look|desc/i.test(rawTag)) normalizedTag = 'appearance';
         else if (/relation|dynamic|connect/i.test(rawTag)) normalizedTag = 'relationship';
         
         parsedData[normalizedTag] = content;
      }
      
      if (!foundAny) {
         showToast('No valid XML tags found in file.', 'warning');
         return;
      }

      const entity = { id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2), full_name: '', role: '', mindset: '', motivation: '', appearance: '', relationship: '', customFields: [] };
      const defaultKeys = ['full_name', 'name', 'role', 'mindset', 'motivation', 'appearance', 'relationship'];

      for (const [key, value] of Object.entries(parsedData)) {
         if (defaultKeys.includes(key)) {
            entity[key] = value;
         } else {
            if (value) {
                const formattedTitle = key.split(/[-_\s]+/)
                                         .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                                         .join(' ');
                entity.customFields.push({ title: formattedTitle, content: value });
            }
         }
      }
      
      this.wizardState.entities[index] = entity;
      this.renderEntityList();
      showToast('Character loaded successfully', 'success');
    } catch (error) {
      console.error(error);
      showToast('Error reading the file', 'error');
    }
  }

  renderCpList(cpList) {
    if (!cpList) cpList = this.contentArea.querySelector('#cp-list');
    if (!cpList) return;

    cpList.innerHTML = '';
    this.wizardState.creativePriorities.forEach((cp) => {
       this.renderSingleCp(cp, cpList);
    });
    if (window.lucide) window.lucide.createIcons({ root: document.getElementById("app") || document.body });
  }

  renderSingleCp(cp, cpList) {
      const row = document.createElement('div');
      row.className = 'flex flex-col bg-[var(--bg-elevated)] border border-[var(--border-default)] justify-between p-4 rounded-lg shadow-sm w-full gap-3';
      row.innerHTML = cpRowTemplate
        .replace('{{TITLE}}', escapeHTML(cp.title || ''))
        .replace('{{DESCRIPTION}}', escapeHTML(cp.description || ''));
      cpList.appendChild(row);

      const titleInput = row.querySelector('.cp-title');
      const descInput = row.querySelector('.cp-desc');
      const delBtn = row.querySelector('.delete-cp');
      const expandBtn = row.querySelector('.expand-cp');

      titleInput.addEventListener('input', (e) => cp.title = e.target.value);
      descInput.addEventListener('input', (e) => cp.description = e.target.value);
      expandBtn.addEventListener('click', () => openExpandedTextarea(descInput, `${cp.title || 'Priority'}`));
      delBtn.addEventListener('click', () => {
        const idx = this.wizardState.creativePriorities.indexOf(cp);
        if (idx > -1) {
          this.wizardState.creativePriorities.splice(idx, 1);
          row.remove();
        }
      });
  }

  renderRightPanel(type, targetTextarea) {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.isGenerating = false;
    
    this.rightPanel.classList.remove('hidden');
    this.rightPanel.innerHTML = '';
    
    const header = document.createElement('div');
    header.className = 'p-4 border-b border-[var(--border-default)] font-bold flex justify-between items-center';
    header.innerHTML = `
      <span class="text-[var(--accent)] flex gap-2 items-center"><i data-lucide="sparkles" class="w-5 h-5"></i> ${type === 'world' ? 'WorldForge AI' : 'CharacterForge AI'}</span>
      <button class="close-panel text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><i data-lucide="x" class="w-4 h-4"></i></button>
    `;

    const body = document.createElement('div');
    body.className = 'p-4 flex-1 overflow-y-auto flex flex-col gap-4';

    let formHtml = '';
    if (type === 'world') {
      formHtml = rightPanelWorld;
    } else {
      formHtml = rightPanelChar;
    }

    body.innerHTML = rightPanelBody.replace('{{FORM_HTML}}', formHtml);

    this.rightPanel.appendChild(header);
    this.rightPanel.appendChild(body);

    if(window.lucide) window.lucide.createIcons({ root: document.getElementById("app") || document.body });

    const previewBox = body.querySelector('#ai-preview');
    const useBtn = body.querySelector('#ai-use-btn');
    let currentResult = '';

    header.querySelector('.close-panel').addEventListener('click', () => {
      this.rightPanel.classList.add('hidden');
    });

    body.querySelector('#ai-generate-btn').addEventListener('click', async () => {
      if (this.isGenerating) return;
      this.isGenerating = true;
      this.currentAbortController = new AbortController();
      const btn = body.querySelector('#ai-generate-btn');
      btn.textContent = "Generating...";
      btn.classList.add('opacity-50', 'cursor-not-allowed');
      useBtn.classList.add('hidden');
      previewBox.textContent = '';
      currentResult = '';

      try {
        if (type === 'world') {
          const prompt = `Genre: ${body.querySelector('#ai-genre').value}\nEra/Setting: ${body.querySelector('#ai-era').value}\nMood: ${body.querySelector('#ai-mood').value}\nKey Themes: ${body.querySelector('#ai-themes').value}\n\nGenerate a World Bible.`;
          const defE = DEFAULT_EXPERTS.find(e => e.id === "EXPERT_WORLDFORGE");
          const messages = [];
          if (defE && defE.systemPrompt) messages.push({ role: "system", content: defE.systemPrompt });
          messages.push({ role: "user", content: prompt });
          
          await apiClient.callExpert("EXPERT_WORLDFORGE", messages, (chunk) => {
            currentResult += chunk;
            previewBox.innerHTML = safeMarkedParse(currentResult);
            previewBox.scrollTop = previewBox.scrollHeight;
          }, { signal: this.currentAbortController.signal });
        } else {
          const prompt = `Role: ${body.querySelector('#ai-role').value}\nArchetype: ${body.querySelector('#ai-archetype').value}\nOne Strength: ${body.querySelector('#ai-strength').value}\nOne Flaw: ${body.querySelector('#ai-flaw').value}\n\nGenerate a character persona.`;
          const defE = DEFAULT_EXPERTS.find(e => e.id === "EXPERT_CHARFORGE");
          const messages = [];
          if (defE && defE.systemPrompt) messages.push({ role: "system", content: defE.systemPrompt });
          messages.push({ role: "user", content: prompt });

          await apiClient.callExpert("EXPERT_CHARFORGE", messages, (chunk) => {
            currentResult += chunk;
            previewBox.innerHTML = safeMarkedParse(currentResult);
            previewBox.scrollTop = previewBox.scrollHeight;
          }, { signal: this.currentAbortController.signal });
        }
        useBtn.classList.remove('hidden');
      } catch (err) {
        if (err.name === 'AbortError') return;
        previewBox.textContent = "Error: " + err.message;
      } finally {
        this.isGenerating = false;
        if (document.body.contains(btn)) {
          btn.textContent = "Regenerate";
          btn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
      }
    });

    useBtn.addEventListener('click', () => {
      if (targetTextarea) {
        targetTextarea.value = currentResult;
        // Trigger input event to update model
        targetTextarea.dispatchEvent(new Event('input'));
      }
      this.rightPanel.classList.add('hidden');
    });
  }
}
