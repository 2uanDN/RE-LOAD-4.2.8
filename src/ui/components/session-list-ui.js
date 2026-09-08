import { db, deleteGameSession } from '../../core/db.js';
import { initEngine } from '../init-engine.js';
import { settingsUI } from '../settings-ui.js';
import { showToast } from '../toast-ui.js';
import { escapeHtml } from '../../utils/validators.js';

import headerTemplate from '../templates/components/session-list/header.html?raw';
import searchBarTemplate from '../templates/components/session-list/search-bar.html?raw';
import newGameBtnTemplate from '../templates/components/session-list/new-game-btn.html?raw';
import cardTemplate from '../templates/components/session-list/card.html?raw';
import emptySearchTemplate from '../templates/components/session-list/empty-search.html?raw';
import emptySessionsTemplate from '../templates/components/session-list/empty-sessions.html?raw';
import deleteModalTemplate from '../templates/components/session-list/delete-modal.html?raw';

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const now = new Date();
  const date = new Date(timestamp);
  const seconds = Math.floor((now - date) / 1000);
  
  if (isNaN(seconds) || seconds < 0) return date.toLocaleDateString();
  
  const intervals = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'week', seconds: 604800 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 }
  ];
  
  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count > 1 ? 's' : ''} ago`;
    }
  }
  return 'Just now';
}

export class SessionListUI {
  constructor(appContainer, gameUI) {
    this.appContainer = appContainer;
    this.gameUI = gameUI; // To call this.gameUI.init() after delete
    this.sessions = [];
    this.grid = null;
  }

  render(sessions) {
    this.sessions = sessions;
    this.appContainer.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'w-full min-h-screen bg-[var(--bg-base)] text-[var(--text-primary)] p-8 font-ui';

    const header = document.createElement('div');
    header.className = 'flex justify-between items-center mb-6 max-w-4xl mx-auto';
    header.innerHTML = headerTemplate;

    // Search & Filter Box
    const searchBarContainer = document.createElement('div');
    searchBarContainer.className = 'max-w-4xl mx-auto mb-8';
    searchBarContainer.innerHTML = searchBarTemplate;

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-4xl mx-auto';
    this.grid = grid;

    container.appendChild(header);
    container.appendChild(searchBarContainer);
    container.appendChild(grid);
    this.appContainer.appendChild(container);

    header.querySelector('#main-settings-btn').addEventListener('click', () => {
      settingsUI.open();
    });

    const searchInput = searchBarContainer.querySelector('#adventure-search');
    const clearBtn = searchBarContainer.querySelector('#clear-search-btn');

    searchInput.addEventListener('input', (e) => {
      const q = e.target.value;
      if (q.trim()) {
        clearBtn.classList.remove('hidden');
      } else {
        clearBtn.classList.add('hidden');
      }
      this.renderGrid(q);
    });

    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.classList.add('hidden');
      this.renderGrid('');
      searchInput.focus();
    });

    // Initial render of grid cards
    this.renderGrid('');

    if (window.lucide) {
      window.lucide.createIcons({ root: container });
    }
  }

  renderGrid(filterText = '') {
    this.grid.innerHTML = '';

    // "+ New Adventure" card is always visible
    const newGameBtn = document.createElement('button');
    newGameBtn.className = 'flex flex-col items-center justify-center p-8 border-2 border-dashed border-[var(--border-default)] rounded-xl hover:border-[var(--accent)] hover:bg-[var(--accent-glow)] transition-all duration-300 text-[var(--text-secondary)] hover:text-[var(--accent)] font-semibold min-h-[200px] cursor-pointer shadow-sm hover:shadow-md';
    newGameBtn.innerHTML = newGameBtnTemplate;
    newGameBtn.addEventListener('click', () => {
      initEngine.startWizard();
    });
    this.grid.appendChild(newGameBtn);

    const query = filterText.toLowerCase().trim();
    const filteredSessions = this.sessions.filter(session => {
      if (!query) return true;
      const titleLine = session.branchName ? session.branchName : (session.world?.bibleBefore ? session.world.bibleBefore.split('\n')[0].substring(0, 50) : '');
      const character = session.protagonist?.name || 'Unknown';
      const promptExcerpt = session.world?.bibleBefore || '';
      return titleLine.toLowerCase().includes(query) || 
             character.toLowerCase().includes(query) ||
             promptExcerpt.toLowerCase().includes(query);
    });

    if (this.sessions.length > 0) {
      if (filteredSessions.length > 0) {
        filteredSessions.forEach(session => {
          const titleLine = session.branchName ? session.branchName : (session.world?.bibleBefore ? session.world.bibleBefore.split('\n')[0].substring(0, 50) : `Session from ${new Date(session.createdAt).toLocaleDateString()}`);
          const escapedTitleLine = escapeHtml(titleLine);
          const escapedCharacterName = escapeHtml(session.protagonist?.name || 'Unknown');
          
          const timeText = formatRelativeTime(session.updatedAt || session.createdAt);
          
          const isAborted = session.status === 'aborted';
          let classNames = 'p-6 bg-[var(--bg-surface)] rounded-xl shadow border border-[var(--border-default)] flex flex-col justify-between min-h-[220px] relative transition-all duration-300 hover:shadow-lg hover:-translate-y-1 hover:border-[var(--accent)] group/card';
          if (isAborted) {
             classNames += ' opacity-60 hover:opacity-100 grayscale hover:grayscale-0';
          }
          
          const card = document.createElement('div');
          card.className = classNames;
          
          let htmlContent = cardTemplate
            .replace('{{TIME_TEXT}}', timeText)
            .replace('{{TITLE}}', escapedTitleLine)
            .replace('{{CHARACTER_NAME_RAW}}', escapedCharacterName)
            .replace('{{CHARACTER_NAME}}', escapedCharacterName)
            .replace('{{TURN_COUNT}}', session.turnCount || 0);

          if (isAborted) {
             htmlContent = htmlContent.replace('Continue', 'Restore / View');
          }
          card.innerHTML = htmlContent;
          
          card.querySelector('.continue-btn').addEventListener('click', () => {
            initEngine.loadSession(session.id);
          });

          card.querySelector('.delete-btn').addEventListener('click', () => {
            this.showDeleteConfirmation(session.id);
          });

          this.grid.appendChild(card);
        });
      } else {
        const emptyState = document.createElement('div');
        emptyState.className = 'col-span-1 md:col-span-2 lg:col-span-2 flex flex-col items-center justify-center text-center p-12 opacity-80 min-h-[220px]';
        emptyState.innerHTML = emptySearchTemplate;
        this.grid.appendChild(emptyState);
      }
    } else {
      const emptyState = document.createElement('div');
      emptyState.className = 'col-span-1 md:col-span-2 lg:col-span-2 flex flex-col items-center justify-center text-center p-12 opacity-80';
      emptyState.innerHTML = emptySessionsTemplate;
      this.grid.appendChild(emptyState);
    }

    if (window.lucide) {
      window.lucide.createIcons({ root: this.grid });
    }
  }

  showDeleteConfirmation(sessionId) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]';
    
    const modal = document.createElement('div');
    modal.className = 'bg-[var(--bg-surface)] border border-[var(--border-default)] p-6 rounded-xl shadow-2xl max-w-sm w-full mx-4 text-center';
    
    modal.innerHTML = deleteModalTemplate;
    
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    if (window.lucide) window.lucide.createIcons({ root: overlay });

    overlay.querySelector('#cancel-delete-btn').addEventListener('click', () => {
      overlay.remove();
    });

    overlay.querySelector('#confirm-delete-btn').addEventListener('click', async () => {
      overlay.remove();
      try {
        await deleteGameSession(sessionId);
        this.gameUI.init(true);
      } catch (err) {
        console.error('Failed to fully delete session data:', err);
        showToast('Failed to delete adventure. Please try again.', 'error');
      }
    });
  }
}
