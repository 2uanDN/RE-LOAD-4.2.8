import { narrativeEngine } from '../../core/narrative-engine.js';
import { db } from '../../core/db.js';
import { openExpandedTextarea } from '../../utils/textarea-expander.js';
import { StreamingJsonParser } from '../../utils/streaming-json-parser.js';
import { TurnCardUI } from './turn-card-ui.js';
import { escapeHtml as escapeHTML } from '../../utils/validators.js';
import { safeMarkedParse } from '../../utils/text-parser.js';
import { eventBus } from '../../core/event-bus.js';

import streamingCardTemplate from '../templates/components/chat-input/streaming-card.html?raw';
import errorBannerTemplate from '../templates/components/chat-input/error-banner.html?raw';

export class ChatInputUI {
  static setup(gameUI, container, chatViewport, inputArea, errorBanner) {
    const inputEl = inputArea.querySelector('#game-input');
    const sendBtn = inputArea.querySelector('#send-btn');
    const expandBtn = inputArea.querySelector('#game-input-expand');
    
    if (!inputEl || !sendBtn || !expandBtn) {
       return; // Timeline is branched/aborted, input elements are not rendered
    }
    
    expandBtn.addEventListener('click', () => {
       openExpandedTextarea(inputEl, "Action Input: Shift+Enter to send", {
           onShiftEnter: () => {
               if (!sendBtn.disabled) submitTurn();
           }
       });
    });
    
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = (inputEl.scrollHeight) + 'px';
      sendBtn.disabled = inputEl.value.trim().length === 0;
    });

    let isSubmitting = false;

    const lockInput = (locked) => {
      inputEl.disabled = locked;
      sendBtn.disabled = locked || inputEl.value.trim().length === 0;
      if (locked) {
        inputArea.classList.add('opacity-50');
      } else {
        inputArea.classList.remove('opacity-50');
      }
    };

    const showError = (msg) => {
      errorBanner.innerHTML = errorBannerTemplate.replace('{{MSG}}', msg);
      errorBanner.classList.remove('hidden');
      if(window.lucide) window.lucide.createIcons({ root: errorBanner });
    };

    const validate = () => {
       const userText = inputEl.value.trim();
       if (!userText) return null;
       return userText;
    };

    const beginSubmit = () => {
       lockInput(true);
       errorBanner.classList.add('hidden');

       const oldChoiceContainers = chatViewport.querySelectorAll('.choice-btn');
       const hiddenContainers = [];
       if (oldChoiceContainers.length > 0) {
           oldChoiceContainers.forEach(btn => {
               const choiceContainer = btn.closest('.choices-container') || btn.parentElement;
               if (choiceContainer && !choiceContainer.classList.contains('hidden')) {
                   choiceContainer.classList.add('hidden');
                   hiddenContainers.push(choiceContainer);
               }
           });
       }
       
       return (success) => {
           lockInput(false);
           if (!success) {
               hiddenContainers.forEach(c => c.classList.remove('hidden'));
           } else {
               hiddenContainers.forEach(c => c.remove());
           }
       };
    };

    const prepareLastTurnForHistory = async (targetTurnIdx) => {
       if (gameUI.sessionContext && gameUI.sessionContext.session && targetTurnIdx > 0) {
           const lastTurnIdxInArray = gameUI.sessionContext.turns.findIndex(t => t.turnIndex === targetTurnIdx);
           if (lastTurnIdxInArray !== -1) {
               const lastTurn = gameUI.sessionContext.turns[lastTurnIdxInArray];
               if (lastTurn.aiResponse) {
                   const clonedTurn = { ...lastTurn };
                   let isCleaned = false;
                   
                   try {
                       let rawAiResponse = clonedTurn.aiResponse || '';
                       const parsedBlocks = narrativeEngine.parseThreeBlockResponse(rawAiResponse);
                       if (parsedBlocks && parsedBlocks.block1) {
                           let preservedBlock1 = parsedBlocks.block1;
                           const cleanJsonObj = {
                               block_0_thinking: parsedBlocks.block0,
                               block_1_scene: preservedBlock1,
                               block_3_inner_reaction: parsedBlocks.block3,
                               character_dynamics: parsedBlocks.characterDynamics || []
                           };
                           clonedTurn.aiResponse = cleanJsonObj;
                           isCleaned = true;
                       } else {
                           console.warn("Failed to clean aiResponse: parsed response did not contain block1. Preserving raw form.");
                       }
                   } catch (err) {
                       console.warn("Failed to parse and clean aiResponse for block_2. Preserving raw form:", err);
                   }
                   
                   if (isCleaned) {
                       try {
                           await db.turns.put(clonedTurn);
                           
                           // DB committed safely, now update memory
                           gameUI.sessionContext.turns[lastTurnIdxInArray] = clonedTurn;
                           const windowIdx = gameUI.sessionContext.slidingWindow.findIndex(t => t.turnIndex === targetTurnIdx);
                           if (windowIdx !== -1) {
                               gameUI.sessionContext.slidingWindow[windowIdx] = clonedTurn;
                           }
                       } catch (dbErr) {
                           console.error("Failed to commit cleaned turn state to DB:", dbErr);
                           throw dbErr;
                       }
                   } else {
                       console.info("Turn payload remains uncleaned (raw). Bypassing spurious DB write for turn:", targetTurnIdx);
                   }
               }
           }
       }
    };

    const createStreamingCard = (userText) => {
       const displayTurn = (gameUI.sessionContext?.session?.turnCount || 0) + 1;
       const charName = escapeHTML(gameUI.sessionContext?.session?.protagonist?.name || 'User');
       const streamingCard = document.createElement('div');
       streamingCard.id = 'streaming-card';
       streamingCard.className = 'w-full max-w-3xl mx-auto flex flex-col gap-6 py-6 px-2 mb-4 relative';
       
       const renderedUserInput = safeMarkedParse(userText);
          
       streamingCard.innerHTML = streamingCardTemplate
         .replace('{{DISPLAY_TURN}}', displayTurn)
         .replace('{{CHAR_NAME}}', charName)
         .replace('{{RENDERED_USER_INPUT}}', renderedUserInput);
       chatViewport.appendChild(streamingCard);
       if(window.lucide) window.lucide.createIcons({ root: streamingCard });

       return streamingCard;
    };

    const executeTurn = async (userText, streamingCard) => {
       const streamingParser = new StreamingJsonParser();
       let lastRendered = 0;
       
       let timerInterval = null;
       let retryListener = null;
       const startTime = Date.now();
       const timerEl = streamingCard.querySelector('#thinking-timer');
       const statusEl = streamingCard.querySelector('#thinking-status');
       
       if (timerEl) {
           timerInterval = setInterval(() => {
               if (document.hidden) return;
               const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
               timerEl.textContent = elapsed + 's';
           }, 100);
       }
       
       if (statusEl) {
           retryListener = eventBus.on('llm_retry', (payload) => {
               if (document.hidden) return;
               const reasonTxt = payload.reason === 'RateLimit' ? 'Rate Limit' : 'Network Timeout';
               statusEl.textContent = `${reasonTxt}. Retrying...`;
               statusEl.classList.remove('animate-pulse');
               // force reflow to restart animation playfully
               void statusEl.offsetWidth;
               statusEl.classList.add('animate-pulse');
           });
       }
       
       const streamCallback = (delta, ttft) => {
          streamingParser.processChunk(delta);
          
          const parsedResult = streamingParser.parsePartialJson();
          
          // Clear timer when we start getting actual scene content, or when thinking is definitely over.
          if (timerInterval && delta) {
             if (parsedResult.block1 || (parsedResult.block0 && !streamingParser.isThinking)) {
                 clearInterval(timerInterval);
                 timerInterval = null;
                 if (retryListener) {
                     retryListener();
                     retryListener = null;
                 }
             }
          }
          
          const now = Date.now();
          if (now - lastRendered > 100) {
             if (document.hidden) return;
             const streamingBox = streamingCard.querySelector('#streaming-content');
             if (streamingBox) {
                 
                const thinkingContainer = streamingCard.querySelector('#streaming-thinking-container');
                const thinkingBox = streamingCard.querySelector('#streaming-thinking');
                 
                if (parsedResult.block0 && thinkingContainer && thinkingBox) {
                    if (!streamingParser.isThinking) {
                        thinkingContainer.classList.remove('hidden');
                        if (thinkingBox.textContent !== parsedResult.block0) {
                            thinkingBox.textContent = parsedResult.block0;
                        }
                    } else {
                        thinkingContainer.classList.add('hidden');
                    }
                } else if (thinkingContainer) {
                    thinkingContainer.classList.add('hidden');
                }

                if (streamingParser.isThinking) {
                    // Do not update streaming box yet, keep the timer visible
                    return;
                }

                let displayTxt = parsedResult.block1;
                
                if (!displayTxt) {
                   displayTxt = "...";
                }

                if (displayTxt && !displayTxt.startsWith('<em')) {
                   displayTxt = displayTxt.replace(/\[([^\]]*)(?:\]|$)/g, (match, p1) => {
                       const isClosed = match.endsWith(']');
                       return `<span class="italic text-[var(--text-secondary)]">[${p1}${isClosed ? ']' : ''}</span>`;
                   });
                }
                
                // If we have content we show it, replacing the timer.
                streamingBox.innerHTML = safeMarkedParse(displayTxt + ' █');
             }
             lastRendered = now;
          }
       };

       try {
           const turnResult = await narrativeEngine.orchestrateGameTurn(gameUI.sessionContext, userText, streamCallback, gameUI.abortController.signal);
           return turnResult;
       } finally {
           if (timerInterval) clearInterval(timerInterval);
           if (retryListener) retryListener();
       }
    };

    const renderTurnResult = async (turnResult, streamingCard) => {
        let isThoughtOpen = false;
        let thoughtScrollTop = 0;
        
        if (streamingCard) {
            const detailsEl = streamingCard.querySelector('#streaming-thinking-container');
            const thinkingBox = streamingCard.querySelector('#streaming-thinking');
            
            if (detailsEl) {
                // Check if 'open' is true (property) or attribute is present
                isThoughtOpen = detailsEl.open || detailsEl.hasAttribute('open');
            }
            if (thinkingBox) {
                thoughtScrollTop = thinkingBox.scrollTop;
            }
            
            if (streamingCard.parentNode) {
                chatViewport.removeChild(streamingCard);
            }
        }

        const action = gameUI.paginationManager.afterTurnAdded(gameUI.sessionContext.turns.length);
        if (action === 'navigate') {
            gameUI.renderCurrentPage();
        } else {
            const cardDom = TurnCardUI.render(chatViewport, turnResult, gameUI.sessionContext, gameUI);
            if (cardDom) {
                const finalDetailsEl = cardDom.querySelector('details');
                if (finalDetailsEl) {
                    if (isThoughtOpen) {
                        finalDetailsEl.setAttribute('open', '');
                    } else {
                        finalDetailsEl.removeAttribute('open');
                    }
                    
                    const finalThinkingBox = finalDetailsEl.querySelector('div.overflow-y-auto');
                    if (finalThinkingBox) {
                        // Set immediately and also push to next frame to ensure details tag layout has processed the open attribute
                        finalThinkingBox.scrollTop = thoughtScrollTop;
                        requestAnimationFrame(() => {
                            finalThinkingBox.scrollTop = thoughtScrollTop;
                        });
                    }
                }
            }
        }

        const hdrCount = document.getElementById('hdr-turn-counter');
        if (hdrCount) hdrCount.textContent = gameUI.sessionContext.session.turnCount;
    };

    const handleSubmitError = (err, streamingCard, isUserAbort = false) => {
        console.error("Turn failed:", err);
        
        if (err.name === 'AbortError' && isUserAbort) {
             // User aborted (e.g. by navigating away). UI is resetting, so no need to clean up here.
             return; 
        }
        
        const errorMsg = (err.name === 'AbortError' && !isUserAbort) 
            ? 'Request timed out.' 
            : err.message;
            
        showError("Failed to process turn: " + errorMsg);
        
        if (streamingCard && streamingCard.parentNode) {
            chatViewport.removeChild(streamingCard);
        }
    };

    const submitTurn = async () => {
        if (isSubmitting) {
            console.warn("Already submitting a turn. Ignoring overlapping request.");
            return;
        }

        const userText = validate();
        if (!userText) return;
        
        isSubmitting = true;
        const cleanup = beginSubmit();
        let streamingCard = null;
        let wasUserAborted = false;
        let isSuccess = false;
        
        gameUI.abortController = new AbortController();
        const currentSignal = gameUI.abortController.signal;
        
        try {
            const previousTurnIdx = gameUI.sessionContext?.session?.turnCount || 0;
            
            streamingCard = createStreamingCard(userText);
            const turnResult = await executeTurn(userText, streamingCard);
            
            // Clean up the choices of the previous turn ONLY after the new turn succeeds
            if (previousTurnIdx > 0) {
                await prepareLastTurnForHistory(previousTurnIdx);
            }
            
            // Clear input only on successful turn execution
            inputEl.value = '';
            inputEl.style.height = 'auto';
            
            await renderTurnResult(turnResult, streamingCard);
            isSuccess = true;
        } catch(err) {
            wasUserAborted = currentSignal.aborted;
            handleSubmitError(err, streamingCard, wasUserAborted);
        } finally {
            cleanup(isSuccess);
            if (gameUI.abortController) {
                gameUI.abortController = null;
            }
            isSubmitting = false;
        }
    };

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) submitTurn();
      }
    });

    sendBtn.addEventListener('click', submitTurn);
  }
}
