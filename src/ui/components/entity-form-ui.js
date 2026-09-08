import { openExpandedTextarea } from '../../utils/textarea-expander.js';
import { escapeHtml as escapeHTML } from '../../utils/validators.js';

import fileUploadTemplate from '../templates/components/entity-form/file-upload.html?raw';
import entityRowTemplate from '../templates/components/entity-form/entity-row.html?raw';
import customFieldRowTemplate from '../templates/components/entity-form/custom-field-row.html?raw';

export class EntityFormUI {
  /**
   * Renders a single entity block.
   * @param {Object} ent User/Char entity
   * @param {HTMLElement} container Parent DOM element to append to
   * @param {Object} options Options: { onDelete, onFileUpload, showFileUpload }
   * @returns {HTMLElement} The created DOM row
   */
  static renderSingleEntity(ent, container, options = {}) {
    const row = document.createElement('div');
    row.className = 'flex flex-col bg-[var(--bg-elevated)] border border-[var(--border-default)] justify-between p-4 rounded-lg shadow-sm w-full gap-3';
    
    let fileUploadHtml = '';
    if (options.showFileUpload) {
      fileUploadHtml = fileUploadTemplate;
    }

    row.innerHTML = entityRowTemplate
      .replace('{{ENT_NAME}}', escapeHTML(ent.full_name || ent.name || ''))
      .replace('{{FILE_UPLOAD_HTML}}', fileUploadHtml)
      .replace('{{ENT_ROLE}}', escapeHTML(ent.role || ''))
      .replace('{{ENT_MINDSET}}', escapeHTML(ent.mindset || ''))
      .replace('{{ENT_MOTIVATION}}', escapeHTML(ent.motivation || ''))
      .replace('{{ENT_APPEARANCE}}', escapeHTML(ent.appearance || ''))
      .replace('{{ENT_RELATIONSHIP}}', escapeHTML(ent.relationship || ''));
      
    container.appendChild(row);

    const cfList = row.querySelector('.cf-list');
    if (ent.customFields && ent.customFields.length > 0) {
      ent.customFields.forEach(cf => {
        EntityFormUI.renderSingleCustomField(cf, cfList, ent);
      });
    }

    row.querySelector('.ent-name').addEventListener('input', (e) => ent.full_name = e.target.value);
    row.querySelector('.ent-role').addEventListener('input', (e) => ent.role = e.target.value);
    
    const taMindset = row.querySelector('.ent-mindset');
    const taMotivation = row.querySelector('.ent-motivation');
    const taApp = row.querySelector('.ent-appearance');
    const taRelationship = row.querySelector('.ent-relationship');
    
    taMindset.addEventListener('input', (e) => ent.mindset = e.target.value);
    taMotivation.addEventListener('input', (e) => ent.motivation = e.target.value);
    taApp.addEventListener('input', (e) => ent.appearance = e.target.value);
    if (taRelationship) taRelationship.addEventListener('input', (e) => ent.relationship = e.target.value);
    
    row.querySelector('.expand-mindset').addEventListener('click', () => openExpandedTextarea(taMindset, `${ent.full_name || ent.name || 'Character'} - Mindset`));
    row.querySelector('.expand-motivation').addEventListener('click', () => openExpandedTextarea(taMotivation, `${ent.full_name || ent.name || 'Character'} - Motivation`));
    row.querySelector('.expand-appearance').addEventListener('click', () => openExpandedTextarea(taApp, `${ent.full_name || ent.name || 'Character'} - Appearance`));
    if (row.querySelector('.expand-relationship')) {
        row.querySelector('.expand-relationship').addEventListener('click', () => openExpandedTextarea(taRelationship, `${ent.full_name || ent.name || 'Character'} - Relationship Dynamics`));
    }

    row.querySelector('.delete-ent').addEventListener('click', () => {
      if (options.onDelete) options.onDelete();
      row.remove();
    });

    if (options.showFileUpload) {
      row.querySelector('.file-upload-ent').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file && options.onFileUpload) {
          options.onFileUpload(file);
        }
        e.target.value = '';
      });
    }

    row.querySelector('.add-cf-btn').addEventListener('click', () => {
       if(!ent.customFields) ent.customFields = [];
       const newCf = { title: '', content: '' };
       ent.customFields.push(newCf);
       EntityFormUI.renderSingleCustomField(newCf, cfList, ent);
       if(window.lucide) window.lucide.createIcons({ root: cfList });
    });

    if (window.lucide) window.lucide.createIcons({ root: row });
    return row;
  }

  /**
   * Renders a custom field in an entity.
   */
  static renderSingleCustomField(cf, cfList, ent) {
    const cfRow = document.createElement('div');
    cfRow.className = 'cf-row flex flex-col gap-2 bg-[var(--bg-base)] p-3 rounded border border-[var(--border-default)] mb-2 group';
    cfRow.innerHTML = customFieldRowTemplate
      .replace('{{CF_TITLE}}', escapeHTML(cf.title || ''))
      .replace('{{CF_CONTENT}}', escapeHTML(cf.content || ''));
      
    cfList.appendChild(cfRow);
    
    const titleInput = cfRow.querySelector('.cf-title');
    const contentTa = cfRow.querySelector('.cf-content');

    titleInput.addEventListener('input', (e) => cf.title = e.target.value);
    contentTa.addEventListener('input', (e) => cf.content = e.target.value);
    
    cfRow.querySelector('.expand-cf').addEventListener('click', () => {
       openExpandedTextarea(contentTa, `${ent.full_name || ent.name || 'Character'} - ${cf.title || 'Field'}`);
    });

    cfRow.querySelector('.delete-cf').addEventListener('click', () => {
       const cfIdx = ent.customFields.indexOf(cf);
       if (cfIdx > -1) {
          ent.customFields.splice(cfIdx, 1);
          cfRow.remove();
       }
    });
  }
}
