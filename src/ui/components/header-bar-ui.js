import { eventBus } from '../../core/event-bus.js';
import { settingsUI } from '../settings-ui.js';
import { MinimapUI } from './minimap-ui.js';

import layoutTemplate from '../templates/components/header-bar/layout.html?raw';

export class HeaderBarUI {
  constructor(container, gameUI, leftSidebarDrawerOverlay, leftSidebar) {
    this.container = container;
    this.gameUI = gameUI;
    this.leftSidebarDrawerOverlay = leftSidebarDrawerOverlay;
    this.leftSidebar = leftSidebar;
    this.rightSidebarOpenDesktop = window.innerWidth >= 1024;
  }

  render(mainContainer, rightSidebarContainer, rightDrawerOverlay) {
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between p-4 bg-[var(--bg-surface)] border-b border-[var(--border-default)] shadow-sm shrink-0 z-10';
    header.innerHTML = layoutTemplate.replace('{{TURN_COUNT}}', this.gameUI.sessionContext?.session?.turnCount || 0);

    mainContainer.appendChild(header);

    // Event Bindings
    header.querySelector('#settings-btn').addEventListener('click', () => {
       settingsUI.open();
    });
    
    header.querySelector('#btn-toggle-minimap').addEventListener('click', () => {
       MinimapUI.open(this.gameUI.activeSessionId, this.gameUI.sessionContext, this.gameUI.paginationManager.currentPage, this.gameUI.paginationManager.turnsPerPage);
    });
    
    header.querySelector('#btn-toggle-sidebar').addEventListener('click', () => this.leftSidebar.toggleDrawer(this.leftSidebarDrawerOverlay));
    
    const toggleRightSidebar = () => {
       const isMobile = window.innerWidth < 1024;
       if (isMobile) {
         const isClosed = rightSidebarContainer.classList.contains('translate-x-full');
         if (isClosed) {
            rightSidebarContainer.classList.remove('translate-x-full');
            rightDrawerOverlay.classList.add('active');
         } else {
            this.closeRightSidebar(rightSidebarContainer, rightDrawerOverlay);
         }
       } else {
         this.rightSidebarOpenDesktop = !this.rightSidebarOpenDesktop;
         if (this.rightSidebarOpenDesktop) {
            rightSidebarContainer.classList.remove('lg:hidden');
            void rightSidebarContainer.offsetWidth; // force reflow
            rightSidebarContainer.classList.remove('lg:translate-x-full', 'lg:w-0', 'lg:min-w-0', 'opacity-0');
            rightSidebarContainer.classList.add('lg:translate-x-0');
         } else {
            rightSidebarContainer.classList.remove('lg:translate-x-0');
            rightSidebarContainer.classList.add('lg:translate-x-full', 'lg:w-0', 'lg:min-w-0', 'opacity-0');
            setTimeout(() => { if(!this.rightSidebarOpenDesktop) rightSidebarContainer.classList.add('lg:hidden'); }, 300);
         }
       }
    };

    header.querySelector('#btn-toggle-right-sidebar').addEventListener('click', toggleRightSidebar);
    header.querySelector('#btn-toggle-right-sidebar-mobile').addEventListener('click', toggleRightSidebar);
    rightDrawerOverlay.addEventListener('click', () => this.closeRightSidebar(rightSidebarContainer, rightDrawerOverlay));
    
    return header;
  }
  
  closeRightSidebar(rightSidebarContainer, rightDrawerOverlay) {
     rightSidebarContainer.classList.add('translate-x-full');
     rightDrawerOverlay.classList.remove('active');
  }
}
