export function openExpandedTextarea(textareaEl, title, options = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-black/80 z-[200] flex flex-col p-4 md:p-8 backdrop-blur-sm';
  
  const header = document.createElement('div');
  header.className = 'flex justify-between items-center mb-4';
  header.innerHTML = `
     <h3 class="text-[var(--text-primary)] text-xl font-bold">${title || 'Edit'}</h3>
     <button class="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-2 transition-colors focus:outline-none" title="Minimize (Esc)"><i data-lucide="shrink" class="w-6 h-6"></i></button>
  `;

  const bigTextarea = document.createElement('textarea');
  bigTextarea.className = 'flex-1 w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl p-6 text-[var(--text-primary)] font-mono text-base lg:text-lg resize-none focus:outline-none focus:border-[var(--accent)] shadow-[var(--shadow-modal)] transition-colors leading-relaxed';
  if (textareaEl.readOnly) bigTextarea.readOnly = true;
  bigTextarea.value = textareaEl.value;

  const footer = document.createElement('div');
  footer.className = 'mt-4 flex justify-between items-center text-[var(--text-secondary)] text-sm shrink-0';
  
  if (!textareaEl.readOnly) {
     footer.innerHTML = `<span>Press <kbd class="px-2 py-1 bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded shadow-sm text-xs font-mono font-bold mx-1">Esc</kbd> to minimize</span> <button class="btn-save px-6 py-2 bg-[var(--accent)] text-[#1a1917] hover:bg-[var(--accent-dim)] font-bold rounded-lg transition-colors shadow">Done</button>`;
  } else {
     footer.innerHTML = `<span>Press <kbd class="px-2 py-1 bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded shadow-sm text-xs font-mono font-bold mx-1">Esc</kbd> to minimize</span> <button class="btn-save px-6 py-2 bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] font-bold rounded-lg transition-colors shadow-sm">Close</button>`;
  }

  overlay.appendChild(header);
  overlay.appendChild(bigTextarea);
  overlay.appendChild(footer);
  document.body.appendChild(overlay);
  if (window.lucide) window.lucide.createIcons();

  bigTextarea.focus();
  bigTextarea.setSelectionRange(bigTextarea.value.length, bigTextarea.value.length);

  if (options.onShiftEnter) {
      bigTextarea.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault();
              saveAndClose();
              options.onShiftEnter();
          }
      });
  }

  const saveAndClose = () => {
    if (!textareaEl.readOnly && textareaEl.value !== bigTextarea.value) {
       textareaEl.value = bigTextarea.value;
       textareaEl.dispatchEvent(new Event('input'));
       textareaEl.dispatchEvent(new Event('change'));
       textareaEl.dispatchEvent(new Event('blur')); // For settings UI auto-save
    }
    overlay.remove();
    document.removeEventListener('keydown', escapeHandler);
  };

  const escapeHandler = (e) => {
    if (e.key === 'Escape') {
       saveAndClose();
    }
  };

  document.addEventListener('keydown', escapeHandler);
  header.querySelector('button').addEventListener('click', saveAndClose);
  footer.querySelector('.btn-save').addEventListener('click', saveAndClose);
}
