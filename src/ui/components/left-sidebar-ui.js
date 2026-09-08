import { escapeHtml } from '../../utils/validators.js';

import layoutTemplate from '../templates/components/left-sidebar/layout.html?raw';

export class LeftSidebarUI {
  constructor(container, sessionContext, callbacks) {
    this.container = container;
    this.sessionContext = sessionContext;
    this.callbacks = callbacks; // { onEditSession, onGoHome }
  }

  render() {
    this.container.innerHTML = '';
    this.container.className = 'fixed top-0 left-0 h-full w-[280px] bg-[var(--bg-surface)] border-r border-[var(--border-default)] flex flex-col pt-4 shrink-0 transition-transform duration-250 ease-in-out -translate-x-full z-40';
    
    const branchName = this.sessionContext?.session?.branchName;
    const bibleName = this.sessionContext?.session?.world?.bibleBefore?.split('\n')[0];
    const displayName = branchName ? branchName.substring(0, 30) : (bibleName ? bibleName.substring(0, 30) : 'Adventure');
    const escapedDisplayName = escapeHtml(displayName);

    this.container.innerHTML = layoutTemplate.replace('{{DISPLAY_NAME}}', escapedDisplayName);

    this.container.querySelector('#edit-session-btn').addEventListener('click', (e) => {
      e.preventDefault();
      if (this.callbacks.onEditSession) {
        this.callbacks.onEditSession();
      }
    });

    this.container.querySelector('#home-btn').addEventListener('click', (e) => {
      e.preventDefault();
      if (this.callbacks.onGoHome) {
        this.callbacks.onGoHome();
      }
    });

    if (window.lucide) {
      window.lucide.createIcons({ root: this.container });
    }
  }

  toggleDrawer(drawerOverlay) {
    const isClosed = this.container.classList.contains('-translate-x-full');
    if (isClosed) {
      this.container.classList.remove('-translate-x-full');
      drawerOverlay.classList.add('active');
    } else {
      this.closeDrawer(drawerOverlay);
    }
  }

  closeDrawer(drawerOverlay) {
    this.container.classList.add('-translate-x-full');
    drawerOverlay.classList.remove('active');
  }
}
