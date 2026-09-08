import { db } from './core/db.js';
import { eventBus } from './core/event-bus.js';
import { workerBridge } from './workers/worker-bridge.js';
import { keyRotator } from './core/key-rotator.js';
import { settingsManager } from './core/settings-manager.js';
import { memoryManager } from './core/memory-manager.js';
import { ragEngine } from './core/rag-engine.js';
import { themeManager } from './ui/theme.js';
import { settingsUI } from './ui/settings-ui.js';
import { gameUI } from './ui/game-ui.js';
import { EVENTS } from './core/events.js';
import { showToast } from './ui/toast-ui.js';

// Setup phase 0 & 1 & 2 & 3 verification
async function initApplication() {
  try {
    // 0. Ensure settings initialization
    await settingsManager.init();
    await themeManager.initTheme();

    // 1. Verify Dexie Connection & Migration
    await db.open();
    console.log('[Engine] Dexie DB initialized successfully!');
    
    // Listen to global AI / Engine errors
    eventBus.on(EVENTS.RAG_ERROR, (data) => {
      showToast(data.message || 'An error occurred', 'error');
    });
    
    // 2. Start UI
    await gameUI.init();
    
    // Page Visibility API handler to pause animations when hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        document.body.classList.add('pause-animations');
      } else {
        document.body.classList.remove('pause-animations');
      }
    });

    // 3. Dismiss splash screen
    const splash = document.getElementById('splash-screen');
    if (splash) {
      splash.style.opacity = '0';
      setTimeout(() => splash.remove(), 300);
    }
    
    // Refresh icons
    if (window.lucide) {
      window.lucide.createIcons({ root: document.getElementById('app') || document.body });
    }
  } catch (err) {
    console.error('[Engine] Initialization Error:', err);
    document.getElementById('app').innerHTML = `
      <div class="flex justify-center items-center min-h-screen">
        <div class="p-8 max-w-sm bg-white dark:bg-gray-800 rounded-xl shadow-md space-y-4 text-center border-t-4 border-red-500">
          <h1 class="text-xl font-bold text-red-600">Engine Initialization Failed</h1>
          <p class="text-gray-600 dark:text-gray-300">${err.message}</p>
        </div>
      </div>
    `;
  }
}

// Boot application
initApplication();
