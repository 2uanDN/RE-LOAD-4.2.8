export function showToast(message, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed top-4 right-4 z-[70] flex flex-col gap-2 pointer-events-none w-[calc(100%-2rem)] max-w-sm sm:max-w-md';
    document.body.appendChild(container);
  }

  // Remove oldest if more than 2 already (we will add one to make it 3)
  const currentToasts = container.children;
  if (currentToasts.length >= 3) {
    container.removeChild(currentToasts[0]);
  }

  const toast = document.createElement('div');
  
  // Icon and Colors based on type
  let icon = 'check-circle';
  let colorClass = 'bg-[var(--success)] text-white';
  
  if (type === 'error') {
    icon = 'alert-circle';
    colorClass = 'bg-[var(--error)] text-white';
  } else if (type === 'warning') {
    icon = 'alert-triangle';
    colorClass = 'bg-[var(--warning)] text-white';
  } else if (type === 'info') {
    icon = 'info';
    colorClass = 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-default)] shadow-[var(--shadow-modal)]';
  }

  toast.className = `flex items-start gap-3 px-4 py-3 rounded-lg shadow-[var(--shadow-card)] font-ui text-sm transform transition-all duration-200 translate-x-full opacity-0 pointer-events-auto w-full ${colorClass}`;
  
  toast.innerHTML = `
    <i data-lucide="${icon}" class="w-5 h-5 flex-shrink-0 mt-0.5"></i>
    <span class="font-medium flex-1 break-words min-w-0 max-h-48 overflow-y-auto hide-scrollbar whitespace-pre-wrap"></span>
    <button class="shrink-0 p-1 -mr-2 -mt-1 opacity-70 hover:opacity-100 transition-opacity" onclick="this.parentElement.style.opacity='0'; setTimeout(() => this.parentElement.remove(), 200);">
        <i data-lucide="x" class="w-4 h-4"></i>
    </button>
  `;
  toast.querySelector('span').textContent = message;

  container.appendChild(toast);
  
  if (window.lucide) {
    window.lucide.createIcons({ root: toast });
  }

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.remove('translate-x-full', 'opacity-0');
    toast.classList.add('translate-x-0', 'opacity-100');
  });

  // Calculate duration: base 4000ms, add 1000ms for every 50 characters. Errors max 10000ms, success max 5000ms.
  let durationMs = 4000 + Math.floor(message.length / 50) * 1000;
  if (type === 'error') {
     durationMs = Math.max(durationMs, 7000);
     durationMs = Math.min(durationMs, 12000); // Caps error to 12s
  } else {
     durationMs = Math.min(durationMs, 5000);  // Caps non-errors to 5s
  }

  // Auto-dismiss
  setTimeout(() => {
    toast.classList.remove('translate-x-0', 'opacity-100');
    toast.classList.add('translate-x-full', 'opacity-0');
    
    // Remove after animation completes
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 200);
  }, durationMs);
}

// Intercept window.alert entirely? No, let's just make it available for the system to use
