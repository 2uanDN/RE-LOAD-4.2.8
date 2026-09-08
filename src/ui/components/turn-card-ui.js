import { narrativeEngine } from '../../core/narrative-engine.js';
import { initEngine } from '../init-engine.js';
import { showToast } from '../toast-ui.js';
import { escapeHtml as escapeHTML } from '../../utils/validators.js';
import { safeMarkedParse } from '../../utils/text-parser.js';

import headerTemplate from '../templates/components/turn-card/header.html?raw';
import userTurnTemplate from '../templates/components/turn-card/user-turn.html?raw';
import aiSceneTemplate from '../templates/components/turn-card/ai-scene.html?raw';
import aiInnerReactionTemplate from '../templates/components/turn-card/ai-inner-reaction.html?raw';
import choicesContainerTemplate from '../templates/components/turn-card/choices-container.html?raw';
import customChoiceTemplate from '../templates/components/turn-card/custom-choice.html?raw';
import choiceBtnTemplate from '../templates/components/turn-card/choice-btn.html?raw';
import aiFooterTemplate from '../templates/components/turn-card/ai-footer.html?raw';

const turnParsedCache = new WeakMap();

export class TurnCardUI {
  static render(container, turn, sessionContext, gameUI) {
    const card = document.createElement('div');
    card.className = 'w-full max-w-3xl mx-auto flex flex-col gap-6 py-6 px-2 mb-4 mt-2 relative';
    
    let cache = turnParsedCache.get(turn);
    if (!cache) {
       const parsedRaw = narrativeEngine.parseThreeBlockResponse(turn.aiResponse || '');
       const parsedChoices = narrativeEngine.parseChoices(parsedRaw.block2 || '');
       
       let renderedUserInput = null;
       if (turn.userInput && turn.userInput.trim() !== "") {
           renderedUserInput = safeMarkedParse(turn.userInput);
       }

       let renderedSceneText = null;
       if (parsedRaw.block1) {
          const processedSceneText = parsedRaw.block1.replace(/\[(.*?)\]/g, '<span class="italic text-secondary">[$1]</span>');
          renderedSceneText = safeMarkedParse(processedSceneText);
       }
       
       let renderedBlock3 = null;
       if (parsedRaw.block3) {
           renderedBlock3 = safeMarkedParse(parsedRaw.block3.trim());
       }

       let renderedBlock0 = null;
       const sourceBlock0 = turn.uiOnlyBlock0 || parsedRaw.block0;
       if (sourceBlock0 && sourceBlock0.trim() !== '') {
           renderedBlock0 = sourceBlock0.trim();
       }

       cache = {
           parsedRaw,
           choices: parsedChoices,
           renderedUserInput,
           renderedSceneText,
           renderedBlock3,
           renderedBlock0
       };
       turnParsedCache.set(turn, cache);
    }

    const { parsedRaw: parsed, choices } = cache;

    let html = '';
    const displayTurn = turn.turnIndex || turn.turnCount || "?";
    
    if (turn.id) card.id = `turn-card-${turn.id}`;

    html += headerTemplate.replace('{{DISPLAY_TURN}}', displayTurn);

    if (turn.userInput && turn.userInput.trim() !== "") {
      const charName = escapeHTML(sessionContext?.session?.protagonist?.name || 'User');
      const renderedUserInput = cache.renderedUserInput;
          
      html += userTurnTemplate
        .replace('{{CHAR_NAME}}', charName)
        .replace('{{RENDERED_USER_INPUT}}', renderedUserInput);
    }

    html += `<div class="flex flex-col w-full group/ai relative">`;

    if (parsed.block1) {
       let block0Html = '';
       if (cache.renderedBlock0) {
           const escapedBlock0 = escapeHTML(cache.renderedBlock0);
           block0Html = `
           <details class="group border border-[var(--border-default)] rounded bg-[var(--bg-surface)] shadow-inner overflow-hidden mb-4">
             <summary class="flex items-center gap-2 px-3 py-2 text-xs font-mono text-[var(--text-secondary)] cursor-pointer hover:bg-[var(--bg-hover)] transition-colors list-none">
               <i data-lucide="terminal" class="w-3.5 h-3.5"></i>
               <span class="uppercase tracking-wider">Pre-Scene Undercurrent</span>
               <i data-lucide="chevron-down" class="w-3.5 h-3.5 ml-auto transition-transform group-open:rotate-180"></i>
             </summary>
             <div class="p-3 text-xs font-mono leading-relaxed text-[var(--text-secondary)] border-t border-[var(--border-default)] bg-[var(--bg-base)] max-h-64 overflow-y-auto whitespace-pre-wrap hide-scrollbar">${escapedBlock0}</div>
           </details>`;
       }
       html += aiSceneTemplate
        .replace('{{BLOCK_0_HTML}}', block0Html)
        .replace('{{SCENE_TEXT}}', cache.renderedSceneText);
    }

    const isHistorical = turn.turnIndex < (sessionContext?.session?.turnCount || 0);
    
    if (parsed.block3) {
      html += aiInnerReactionTemplate.replace('{{INNER_REACTION}}', cache.renderedBlock3);
    }

    if (!isHistorical) {
        if (choices.length > 0) {
          let innerChoicesHtml = '';
          choices.forEach(c => {
             if (c.isCustom) {
                 innerChoicesHtml += customChoiceTemplate;
             } else if (c.label && c.label !== "...") {
                 let safeLabel = escapeHTML(c.label);
                 let safeDesc = escapeHTML(c.description || "");
                 let ariaDesc = safeDesc ? safeDesc : safeLabel;
                 let ariaLabel = c.number ? `Choice ${c.number}: ${ariaDesc}` : `Choice: ${ariaDesc}`;
                 let numberHtml = c.number ? `<span class="font-bold accent">${c.number}.</span>` : `<span class="font-bold accent">➤</span>`;
                 let descHtml = safeDesc ? `<span class="text-secondary mt-0.5">${safeDesc}</span>` : '';
                 
                 innerChoicesHtml += choiceBtnTemplate
                   .replace('{{ARIA_LABEL}}', ariaLabel)
                   .replace(/{{SAFE_LABEL}}/g, safeLabel)
                   .replace(/{{SAFE_DESC}}/g, safeDesc)
                   .replace('{{NUMBER_HTML}}', numberHtml)
                   .replace('{{DESC_HTML}}', descHtml);
             }
          });
          html += choicesContainerTemplate.replace('{{CHOICES_HTML}}', innerChoicesHtml);
        }
    }

    html += aiFooterTemplate;

    html += `</div>`; 

    card.innerHTML = html;
    
    container.querySelectorAll('.choice-btn').forEach(btn => btn.disabled = true);
    
    container.appendChild(card);
    if(window.lucide) window.lucide.createIcons({ root: card });

    card.querySelectorAll('.action-copy-user').forEach(btn => {
       btn.addEventListener('click', () => {
          if (turn.userInput) {
             navigator.clipboard.writeText(turn.userInput.trim()).then(() => {
                showToast('Copied to clipboard', 'info');
             });
          }
       });
    });

    card.querySelectorAll('.action-copy-ai').forEach(btn => {
       btn.addEventListener('click', () => {
          if (parsed.block1) {
             navigator.clipboard.writeText(parsed.block1.trim()).then(() => {
                showToast('Copied to clipboard', 'info');
             });
          }
       });
    });

    card.querySelectorAll('.action-branch').forEach(btn => {
       btn.addEventListener('click', async () => {
          const bType = btn.dataset.branchType;
          const success = await initEngine.createBranch(sessionContext, turn.turnIndex, bType);
          if (success) {
             gameUI.activeSessionId = null;
             gameUI.init(true);
          }
       });
    });

    card.querySelectorAll('.choice-btn').forEach(btn => {
       btn.addEventListener('click', () => {
          if (btn.disabled) return;
          const inputEl = document.getElementById('game-input');
          if (inputEl) {
             const lbl = btn.dataset.choiceLabel || '';
             const desc = btn.dataset.choiceDesc || '';
             inputEl.value = desc.trim() ? `${lbl}: ${desc}` : lbl;
             inputEl.focus();
             inputEl.dispatchEvent(new Event('input'));
          }
       });
    });

    return card;
  }
}
