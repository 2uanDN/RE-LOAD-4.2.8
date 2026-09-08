import { db } from '../core/db.js';
import { LeftSidebarUI } from './components/left-sidebar-ui.js';
import { SessionSettingsModal } from './components/session-settings-modal.js';
import { ChatInputUI } from './components/chat-input-ui.js';
import { HeaderBarUI } from './components/header-bar-ui.js';
import { PaginationManager } from './managers/pagination-manager.js';
import { SessionLifecycleManager } from './managers/session-lifecycle-manager.js';
import { SidebarUI } from './components/sidebar-ui.js';

class GameUI {
  constructor() {
    this.appContainer = document.getElementById('app');
    this.activeSessionId = null;
    this.sessionContext = null;
    this.abortController = null;
    this._escapeHandler = null;
    
    this.paginationManager = new PaginationManager(this);
    this.lifecycleManager = new SessionLifecycleManager(this);
  }

  get turnsPerPage() { return this.paginationManager.turnsPerPage; }
  set turnsPerPage(v) { this.paginationManager.turnsPerPage = v; }
  get currentPage() { return this.paginationManager.currentPage; }
  set currentPage(v) { this.paginationManager.currentPage = v; }

  async init(skipAutoResume = false) {
    return this.lifecycleManager.init(skipAutoResume);
  }

  renderCurrentPage(isNavigation = false) {
    this.paginationManager.renderCurrentPage(isNavigation);
  }

  async renderGameSession() {
    const displaySettings = await db.settings.get("display");
    this.paginationManager.updateSettings(
        displaySettings?.turnsPerPage || 10,
        this.sessionContext?.turns?.length || 0
    );

    document.querySelectorAll('.drawer-overlay').forEach(el => el.remove());
    this.appContainer.innerHTML = '';
    
    const drawerOverlay = document.createElement('div');
    drawerOverlay.className = 'drawer-overlay';
    document.body.appendChild(drawerOverlay);
    
    if (!document.getElementById('toast-container')) {
      const tc = document.createElement('div');
      tc.id = 'toast-container';
      tc.className = 'fixed top-4 right-4 z-[70] flex flex-col gap-2 pointer-events-none w-[calc(100%-2rem)] max-w-sm sm:max-w-md';
      document.body.appendChild(tc);
    }
    
    const container = document.createElement('div');
    container.className = 'w-full h-[100dvh] bg-[var(--bg-base)] text-[var(--text-primary)] flex overflow-hidden';
    
    // Left Sidebar Container
    const sidebarContainer = document.createElement('div');
    const leftSidebar = new LeftSidebarUI(sidebarContainer, this.sessionContext, {
      onEditSession: () => {
         SessionSettingsModal.open(this.activeSessionId, this.sessionContext);
         leftSidebar.closeDrawer(drawerOverlay);
      },
      onGoHome: async () => {
         if (this.abortController) {
             this.abortController.abort();
             this.abortController = null;
         }
         if (this.activeSessionId) {
           try {
             await db.game_sessions.update(this.activeSessionId, { status: 'aborted' });
           } catch (err) {
             console.error('Error dropping session status:', err);
           }
         }
         this.activeSessionId = null;
         if (this.sidebarUI) {
           this.sidebarUI.destroy();
           this.sidebarUI = null;
         }
         if (this._escapeHandler) {
           document.removeEventListener('keydown', this._escapeHandler);
           this._escapeHandler = null;
         }
         if (drawerOverlay && drawerOverlay.parentNode) drawerOverlay.remove();
         const ro = document.querySelector('.right-drawer-overlay');
         if (ro && ro.parentNode) ro.remove();
         
         this.init();
      }
    });

    leftSidebar.render();
    drawerOverlay.addEventListener('click', () => {
      if (typeof leftSidebar.closeDrawer === 'function') {
        leftSidebar.closeDrawer(drawerOverlay);
      }
    });
    
    // Main Content
    const main = document.createElement('div');
    main.className = 'flex-1 flex flex-col bg-[var(--bg-base)] overflow-hidden relative w-full h-[100dvh]';

    const rightDrawerOverlay = document.createElement('div');
    rightDrawerOverlay.className = 'drawer-overlay right-drawer-overlay lg:hidden';
    rightDrawerOverlay.style.zIndex = '35';
    document.body.appendChild(rightDrawerOverlay);
    
    const rightSidebarContainer = document.createElement('div');
    rightSidebarContainer.id = 'memory-sidebar-container';
    rightSidebarContainer.className = 'fixed lg:relative top-0 right-0 h-full w-[280px] shrink-0 transition-all duration-300 ease-in-out translate-x-full lg:translate-x-0 z-40 lg:z-auto overflow-hidden bg-[var(--bg-base)] shadow-2xl lg:shadow-none';

    // Header extracted to component
    const headerBarUI = new HeaderBarUI(container, this, drawerOverlay, leftSidebar);
    headerBarUI.render(main, rightSidebarContainer, rightDrawerOverlay);
    
    rightDrawerOverlay.addEventListener('click', () => {
      if (headerBarUI && typeof headerBarUI.closeRightSidebar === 'function') {
        headerBarUI.closeRightSidebar(rightSidebarContainer, rightDrawerOverlay);
      }
    });

    const chatViewport = document.createElement('div');
    chatViewport.id = 'chat-viewport';
    chatViewport.className = 'flex-1 overflow-y-auto p-4 md:p-8 flex flex-col gap-6 hide-scrollbar relative scroll-smooth bg-[var(--bg-base)]';

    const inputArea = document.createElement('div');
    inputArea.className = 'shrink-0 p-4 bg-[var(--bg-surface)] border-t border-[var(--border-default)] w-full shadow-[var(--shadow-card)] flex items-end gap-2 relative transition-opacity z-10';

    if (this.sessionContext.session.status === 'aborted') {
      inputArea.innerHTML = `
        <div class="flex-1 text-center py-2 flex flex-col items-center">
          <p class="text-[var(--text-secondary)] mb-2 text-sm italic">This timeline was branched. You are viewing an alternate past.</p>
          <button id="restore-branch-btn" class="px-6 py-2 bg-[var(--accent)] text-[#1d1607] font-bold rounded-lg shadow hover:bg-[var(--accent-dim)] transition-colors">
             Restore this Timeline
          </button>
        </div>
      `;
      setTimeout(() => {
         const restoreBtn = inputArea.querySelector('#restore-branch-btn');
         if (restoreBtn) {
            restoreBtn.addEventListener('click', async () => {
               try {
                  await db.game_sessions.update(this.activeSessionId, { status: 'active' });
                  this.sessionContext.session.status = 'active';
                  this.renderGameSession();
                  // Auto scroll down to the newest turn
                  setTimeout(() => {
                     const chatViewport = document.getElementById('chat-viewport');
                     if (chatViewport) {
                         chatViewport.scrollTo({ top: chatViewport.scrollHeight, behavior: 'smooth' });
                     }
                  }, 150);
               } catch(err) {
                  console.error(err);
               }
            });
         }
      }, 0);
    } else {
      inputArea.innerHTML = `
        <div class="flex-1 relative max-w-4xl mx-auto flex gap-2 items-end">
          <div class="flex-1 relative group">
            <textarea id="game-input" rows="1" class="w-full resize-none overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-base)] text-[var(--text-primary)] p-3 pr-10 focus:ring-2 focus:ring-[var(--border-focus)] focus:border-transparent outline-none max-h-32 transition-colors disabled:opacity-50 font-ui text-base" placeholder="What do you do? (Shift+Enter to send)"></textarea>
            <button type="button" id="game-input-expand" class="absolute top-2 right-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-1 bg-[var(--bg-surface)]/80 rounded opacity-0 group-hover:opacity-100 transition-opacity" title="Expand">
              <i data-lucide="maximize-2" class="w-4 h-4"></i>
            </button>
          </div>
          <button id="send-btn" class="p-3 bg-[var(--accent)] hover:opacity-90 text-white rounded-xl shadow-[var(--shadow-card)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0 flex items-center justify-center">
            <i data-lucide="send" class="w-5 h-5"></i>
          </button>
        </div>
      `;
    }

    main.appendChild(chatViewport);

    const errorBanner = document.createElement('div');
    errorBanner.id = 'error-banner';
    errorBanner.setAttribute('role', 'alert');
    errorBanner.setAttribute('aria-live', 'assertive');
    errorBanner.className = 'hidden shrink-0 w-full bg-red-500/10 text-red-500 p-3 text-sm flex justify-between items-start z-10 border-l-4 border-red-500';
    main.appendChild(errorBanner);

    main.appendChild(inputArea);

    container.appendChild(sidebarContainer);
    container.appendChild(main);
    container.appendChild(rightSidebarContainer);
    this.appContainer.appendChild(container);

    if (this.sidebarUI) {
      this.sidebarUI.destroy();
    }
    this.sidebarUI = new SidebarUI(rightSidebarContainer, this.activeSessionId);
    
    rightSidebarContainer.addEventListener('click', (e) => {
       const btn = e.target.closest('.btn-close-mobile-sidebar');
       if (btn) headerBarUI.closeRightSidebar(rightSidebarContainer, rightDrawerOverlay);
    });

    if (this._escapeHandler) {
      document.removeEventListener('keydown', this._escapeHandler);
    }
    this._escapeHandler = (e) => {
      if (e.key === 'Escape') {
         if (drawerOverlay && drawerOverlay.classList.contains('active')) leftSidebar.closeDrawer(drawerOverlay);
         if (rightDrawerOverlay && rightDrawerOverlay.classList.contains('active')) headerBarUI.closeRightSidebar(rightSidebarContainer, rightDrawerOverlay);
      }
    };
    document.addEventListener('keydown', this._escapeHandler);

    ChatInputUI.setup(this, container, chatViewport, inputArea, errorBanner);

    this.renderCurrentPage();

    if (window.lucide) {
      window.lucide.createIcons({ root: container });
    }
  }
}

export const gameUI = new GameUI();
