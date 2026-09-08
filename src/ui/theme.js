import { settingsManager } from '../core/settings-manager.js';

class ThemeManager {
  constructor() {
    // Theme is updated directly by UI to avoid indirect 3-hop trace
  }

  async initTheme() {
    // 1. Đọc từ settings DB key "display.theme"
    const displaySettings = await settingsManager.loadSetting("display");
    let theme = displaySettings?.theme;

    // 2. Nếu không có setting: detect system preference via `prefers-color-scheme`
    if (!theme) {
      const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
      theme = prefersLight ? 'light' : 'dark';
    }

    // 3. Apply
    this.applyTheme(theme);

    // 4. Apply Prose font size and family
    let proseSize = displaySettings?.proseSize || 'standard';
    let fontFamily = displaySettings?.fontFamily || 'lora';
    this.applyProseSize(proseSize);
    this.applyFontFamily(fontFamily);
  }

  applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }

  applyProseSize(size) {
    document.documentElement.setAttribute("data-prose-size", size);
  }

  applyFontFamily(fontFamily) {
    document.documentElement.setAttribute("data-font-family", fontFamily);
  }

  async toggleTheme() {
    // 1. current = document.documentElement.getAttribute("data-theme") || "dark"
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    
    // 2. next = current === "dark" ? "light" : "dark"
    const next = current === "dark" ? "light" : "dark";
    
    // 3. document.documentElement.setAttribute("data-theme", next)
    this.applyTheme(next);
    
    // 4. settings-manager.saveSetting("display", { theme: next })
    const displaySettings = await settingsManager.loadSetting("display") || {};
    await settingsManager.saveSetting("display", { ...displaySettings, theme: next });
  }
}

export const themeManager = new ThemeManager();
