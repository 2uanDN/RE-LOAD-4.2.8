import { db } from '../../core/db.js';
import { narrativeEngine } from '../../core/narrative-engine.js';
import { escapeHtml } from '../../utils/validators.js';

import headerTemplate from '../templates/components/minimap/header.html?raw';
import nodeTemplate from '../templates/components/minimap/node.html?raw';

export class MinimapUI {
  static async open(activeSessionId, sessionContext, currentPage, turnsPerPage) {
    if (!activeSessionId) return;
    
    const isDesktop = window.innerWidth >= 1024;
    
    // Toggle existing minimap
    if (isDesktop) {
       const existingFloating = document.getElementById('floating-minimap-pc');
       if (existingFloating) {
          existingFloating.style.opacity = '0';
          existingFloating.style.transform = 'scale(0.95)';
          setTimeout(() => existingFloating.remove(), 200);
          return;
       }
    } else {
       const existingOverlay = document.getElementById('minimap-overlay-mobile');
       if (existingOverlay) {
          existingOverlay.style.opacity = '0';
          setTimeout(() => existingOverlay.remove(), 200);
          return;
       }
    }
    
    let allTurns = [];
    if (sessionContext && sessionContext.turns) {
        allTurns = sessionContext.turns;
    } else {
        allTurns = await db.turns.where('sessionId').equals(activeSessionId).toArray();
    }
    
    const startIndex = (currentPage - 1) * turnsPerPage;
    const endIndex = startIndex + turnsPerPage;
    const pageTurns = allTurns.slice(startIndex, endIndex);

    // Layout configuration: non-blocking floating card on PC vs backdrop overlay on mobile/tablet
    let overlay = null;
    let panelContainer = null;
    
    if (isDesktop) {
       panelContainer = document.createElement('div');
       panelContainer.id = 'floating-minimap-pc';
       panelContainer.className = 'absolute right-6 bottom-24 w-96 max-h-[55vh] h-[400px] flex flex-col rounded-xl shadow-2xl bg-[var(--bg-elevated)] border border-[var(--border-default)] transition-all duration-300 ease-in-out transform scale-95 opacity-0 z-[45] overflow-hidden';
    } else {
       overlay = document.createElement('div');
       overlay.id = 'minimap-overlay-mobile';
       overlay.className = 'fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-[100]';
       overlay.style.opacity = '0';
       overlay.style.transition = 'opacity 200ms ease';
       
       panelContainer = document.createElement('div');
       panelContainer.className = 'bg-[var(--bg-surface)] border border-[var(--border-default)] w-full max-w-4xl max-h-[85vh] h-full flex flex-col rounded-xl shadow-2xl relative overflow-hidden transform scale-95 transition-transform duration-200';
    }
    
    const header = document.createElement('div');
    header.className = 'flex justify-between items-center p-4 md:p-6 border-b border-[var(--border-default)] shrink-0 bg-[var(--bg-elevated)]';
    header.innerHTML = headerTemplate;
    
    // Scale close button and titles nicely for PC floating context
    if (isDesktop) {
       const titleEl = header.querySelector('h3');
       if (titleEl) {
          titleEl.className = 'text-base font-bold text-[var(--text-primary)] flex items-center gap-2';
          const iconEl = titleEl.querySelector('i');
          if (iconEl) iconEl.className = 'w-5 h-5 text-[var(--accent)]';
       }
       const closeBtn = header.querySelector('.close-minimap-btn');
       if (closeBtn) {
          closeBtn.className = 'close-minimap-btn p-1.5 hover:bg-[var(--bg-hover)] rounded-lg transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)]';
          const iconEl = closeBtn.querySelector('i');
          if (iconEl) iconEl.className = 'w-5 h-5';
       }
    }
    
    const contentArea = document.createElement('div');
    contentArea.className = 'flex-1 overflow-y-auto p-4 md:p-8 relative scroll-smooth hide-scrollbar';
    
    const timelineContainer = document.createElement('div');
    timelineContainer.className = 'flex flex-col gap-6 relative z-10 isolate';
    
    const timelineLine = document.createElement('div');
    timelineLine.className = 'absolute left-4 md:left-[1.875rem] top-2 bottom-2 w-1 bg-[var(--border-default)] rounded-full z-[-1]';
    timelineContainer.appendChild(timelineLine);
    
    const addNode = (idx, label, snippet, turnId) => {
       const node = document.createElement('div');
       node.className = 'flex items-center gap-4 md:gap-6 group cursor-pointer relative z-10';
       if (turnId) node.dataset.turnId = turnId;
       
       node.innerHTML = nodeTemplate
         .replace('{{IDX}}', idx)
         .replace('{{LABEL}}', label)
         .replace('{{SNIPPET_HTML}}', snippet ? `<p class="text-xs md:text-sm text-[var(--text-secondary)] line-clamp-2 md:line-clamp-3 font-prose italic opacity-80 mt-1">"${snippet}"</p>` : '');
       
       node.addEventListener('click', () => {
          const dismiss = () => {
             if (isDesktop) {
                panelContainer.style.opacity = '0';
                panelContainer.style.transform = 'scale(0.95)';
                setTimeout(() => panelContainer.remove(), 200);
             } else {
                overlay.style.opacity = '0';
                setTimeout(() => overlay.remove(), 200);
             }
          };
          
          dismiss();
          setTimeout(() => {
              if (turnId) {
                  const domTurnId = `turn-card-${turnId}`;
                  const turnCard = document.getElementById(domTurnId);
                  const chatViewport = document.getElementById('chat-viewport');
                  if (turnCard && chatViewport) {
                     const offsetTop = turnCard.offsetTop;
                     chatViewport.scrollTo({ top: offsetTop - 20, behavior: 'smooth' });
                     
                     turnCard.classList.add('transition-all', 'duration-500');
                     turnCard.style.boxShadow = '0 0 0 2px var(--accent)';
                     setTimeout(() => turnCard.style.boxShadow = '', 2000);
                  }
              } else if (idx === 0) {
                 const chatViewport = document.getElementById('chat-viewport');
                 if (chatViewport) chatViewport.scrollTo({ top: 0, behavior: 'smooth' });
              }
          }, 200);
       });
       
       timelineContainer.appendChild(node);
    };
    
    addNode(0, "Adventure Genesis", escapeHtml(sessionContext?.session?.branchName || "A new world begins"), null);
    
    pageTurns.forEach((turn, i) => {
        const turnNum = turn.turnIndex || (startIndex + i + 1);
        let title = `Turn ${turnNum}`;
        
        let snippet = turn.userInput || "";
        if (!snippet && turn.aiResponse) {
           const parsed = narrativeEngine.parseThreeBlockResponse(turn.aiResponse);
           snippet = parsed.block1 || "";
        }
        
        if (snippet) {
           snippet = snippet.replace(/<[^>]*>?/gm, ''); 
           if (snippet.length > 150) snippet = snippet.substring(0, 150) + '...';
        }
        
        addNode(turnNum, title, snippet, turn.id);
    });
    
    contentArea.appendChild(timelineContainer);
    
    panelContainer.appendChild(header);
    panelContainer.appendChild(contentArea);
    
    if (isDesktop) {
       const chatViewport = document.getElementById('chat-viewport');
       const mainTarget = chatViewport ? chatViewport.parentNode : document.body;
       mainTarget.appendChild(panelContainer);
    } else {
       overlay.appendChild(panelContainer);
       document.body.appendChild(overlay);
    }
    
    if (window.lucide) {
       window.lucide.createIcons({ root: isDesktop ? panelContainer : overlay });
    }
    
    requestAnimationFrame(() => {
        if (isDesktop) {
            panelContainer.style.opacity = '1';
            panelContainer.classList.remove('scale-95');
        } else {
            overlay.style.opacity = '1';
            panelContainer.classList.remove('scale-95');
        }
        contentArea.scrollTop = contentArea.scrollHeight;
    });
    
    header.querySelector('.close-minimap-btn').addEventListener('click', () => {
        if (isDesktop) {
            panelContainer.style.opacity = '0';
            panelContainer.style.transform = 'scale(0.95)';
            setTimeout(() => panelContainer.remove(), 200);
        } else {
            overlay.style.opacity = '0';
            panelContainer.classList.add('scale-95');
            setTimeout(() => overlay.remove(), 200);
        }
    });
    
    if (!isDesktop) {
        overlay.addEventListener('click', (e) => {
           if (e.target === overlay) {
               overlay.style.opacity = '0';
               panelContainer.classList.add('scale-95');
               setTimeout(() => overlay.remove(), 200);
           }
        });
    }
  }
}
