import { TurnCardUI } from '../components/turn-card-ui.js';

export class PaginationManager {
  constructor(gameUI) {
    this.gameUI = gameUI;
    this.turnsPerPage = 10;
    this.currentPage = 1;
  }

  updateSettings(turnsPerPage, totalTurns) {
    this.turnsPerPage = turnsPerPage;
    this.currentPage = Math.ceil(totalTurns / this.turnsPerPage) || 1;
    if (this.currentPage < 1) this.currentPage = 1;
  }

  afterTurnAdded(totalTurns) {
    const newTotalPages = Math.ceil(totalTurns / this.turnsPerPage) || 1;
    if (this.currentPage !== newTotalPages) {
      this.currentPage = newTotalPages;
      return 'navigate';
    }
    return 'append';
  }

  renderCurrentPage(isNavigation = false) {
    const chatViewport = document.getElementById('chat-viewport');
    if (!chatViewport) return;
    
    const streamingCard = chatViewport.querySelector('#streaming-card');
    if (streamingCard) {
        chatViewport.removeChild(streamingCard);
    }
    
    const allTurns = this.gameUI.sessionContext?.turns || [];
    const totalTurns = allTurns.length;
    const totalPages = Math.ceil(totalTurns / this.turnsPerPage) || 1;
    
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    if (this.currentPage < 1) this.currentPage = 1;

    const startIndex = (this.currentPage - 1) * this.turnsPerPage;
    const endIndex = startIndex + this.turnsPerPage;
    const pageTurns = allTurns.slice(startIndex, endIndex);
    
    // Remove old page navigation markers
    Array.from(chatViewport.children).forEach(node => {
        if (node.classList.contains('page-nav')) {
            node.remove();
        }
    });

    const existingNodes = new Map();
    Array.from(chatViewport.children).forEach(child => {
        if (child.id && child.id.startsWith('turn-card-')) {
            existingNodes.set(child.id, child);
            if (child.dataset?.turnId) {
                existingNodes.set(`turnId-${child.dataset.turnId}`, child);
            }
        }
    });

    let nodeIndex = 0;

    if (this.currentPage > 1) {
        const topNav = document.createElement('div');
        topNav.className = 'w-full flex justify-center pb-4 page-nav';
        topNav.innerHTML = `<button class="btn-prev-page px-4 py-2 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-full text-sm font-bold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-all flex items-center gap-2"><i data-lucide="chevron-up" class="w-4 h-4"></i> Previous Page</button>`;
        topNav.querySelector('.btn-prev-page').addEventListener('click', () => {
            this.currentPage--;
            this.renderCurrentPage(true);
        });
        chatViewport.insertBefore(topNav, chatViewport.children[nodeIndex] || null);
        nodeIndex++;
    }
    
    pageTurns.forEach(turn => {
        const expectedId = turn.id ? `turn-card-${turn.id}` : `turn-card-tmp-${turn.turnIndex}`;
        let existingNode = existingNodes.get(expectedId) || (turn.id ? existingNodes.get(`turnId-${turn.id}`) : null);

        if (existingNode) {
            existingNodes.delete(existingNode.id);
            if (existingNode.dataset?.turnId) {
                existingNodes.delete(`turnId-${existingNode.dataset.turnId}`);
            }

            if (chatViewport.children[nodeIndex] !== existingNode) {
                chatViewport.insertBefore(existingNode, chatViewport.children[nodeIndex] || null);
            }
            if (!existingNode.id) existingNode.id = expectedId;
            existingNode.dataset.turnId = turn.id;
            
            const isHistorical = turn.turnIndex < (this.gameUI.sessionContext?.session?.turnCount || 0);
            if (isHistorical) {
                const choicesContainer = existingNode.querySelector('.choices-container');
                if (choicesContainer) choicesContainer.remove();
            }

            nodeIndex++;
        } else {
            const fragment = document.createDocumentFragment();
            TurnCardUI.render(fragment, turn, this.gameUI.sessionContext, this.gameUI);
            const newNode = fragment.firstElementChild;
            if (newNode) {
                if (!newNode.id) newNode.id = expectedId;
                newNode.dataset.turnId = turn.id;
                chatViewport.insertBefore(newNode, chatViewport.children[nodeIndex] || null);
                nodeIndex++;
            }
        }
    });

    existingNodes.forEach(node => {
        if (node.parentNode) node.parentNode.removeChild(node);
    });

    const nodesToRemove = [];
    for (let i = nodeIndex; i < chatViewport.children.length; i++) {
        if (!chatViewport.children[i].id?.includes('streaming-card')) {
            nodesToRemove.push(chatViewport.children[i]);
        }
    }
    nodesToRemove.forEach(node => node.remove());
    
    if (this.currentPage < totalPages) {
        const botNav = document.createElement('div');
        botNav.className = 'w-full flex justify-center py-4 page-nav';
        botNav.innerHTML = `<button class="btn-next-page px-4 py-2 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-full text-sm font-bold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-all flex items-center gap-2">Next Page <i data-lucide="chevron-down" class="w-4 h-4"></i></button>`;
        botNav.querySelector('.btn-next-page').addEventListener('click', () => {
            this.currentPage++;
            this.renderCurrentPage(true);
        });
        chatViewport.appendChild(botNav);
    }
    
    if (streamingCard) {
        chatViewport.appendChild(streamingCard);
    }
    
    if (window.lucide) window.lucide.createIcons({ root: document.body });
  }
}
