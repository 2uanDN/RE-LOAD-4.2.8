import { extractBlock1Only } from '../utils/text-parser.js';
import { tc, SAFE_INPUT_LIMIT } from '../utils/prompt-tags.js';
import { SYSTEM_PRESETS } from '../core/system-presets.js';

export class PromptAssemblerCore {
  get responseSchema() {
    return {
      type: "object",
      properties: {
        block_1_scene: {
          type: "string"
        },
        block_2_label_and_description: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" }
            },
            required: ["label", "description"],
            additionalProperties: false
          },
          minItems: 4,
          maxItems: 4
        },
        block_3_inner_reaction: {
          type: "string", 
          pattern: "[Name]: *Text*"
        },
        character_dynamics: {
          type: "array",
          items: {
             type: "object",
             properties: {
                 full_name: { type: "string" },
                 primary_role: {
                     type: "string",
                     enum: ["initiator", "primary_target", "active_reactor", "supportive_actor", "silent_observer", "ambient_presence", "offscreen_catalyst", "mentioned_entity"]
                 },
                     additionalProperties: false
                 }
             },
             required: ["full_name", "primary_role", "modality_modifiers"],
             additionalProperties: false
          }
      },
      required: ["block_1_scene", "block_2_label_and_description", "block_3_inner_reaction", "character_dynamics"],
      additionalProperties: false
    };
  }

  extractBlock1Only(aiResponse) {
    return extractBlock1Only(aiResponse);
  }

  _formatMacroContext(memoryTree) {
    if (!memoryTree) return "";
    
    // Apply Sliding Summary Window to prevent Context Bloat
    const a1Sorted = (memoryTree.a1 || []).slice().sort((a, b) => a.createdAt - b.createdAt);
    const a2Sorted = (memoryTree.a2 || []).slice().sort((a, b) => a.createdAt - b.createdAt);
    const a3Sorted = (memoryTree.a3 || []).slice().sort((a, b) => a.createdAt - b.createdAt);

    let macroContextBuilder = "";
    if (a3Sorted.length > 0) {
      macroContextBuilder += `<a3_grand_narrative>\n${a3Sorted.map(m => m.content).join('\n')}\n</a3_grand_narrative>\n`;
    }
    if (a2Sorted.length > 0) {
      const a2Recent = a2Sorted.slice(-3);
      macroContextBuilder += `<a2_chapters>\n${a2Recent.map(m => m.content).join('\n')}\n</a2_chapters>\n`;
    }
    if (a1Sorted.length > 0) {
      const a1Recent = a1Sorted.slice(-5);
      macroContextBuilder += `<a1_scenes>\n${a1Recent.map(m => m.content).join('\n')}\n</a1_scenes>\n`;
    }
    return macroContextBuilder ? `<macro_context>\n${macroContextBuilder}</macro_context>\n` : "";
  }

  _routeAndFormatMemories(retrievedMemories) {
    const topMemories = [];
    const injectedMemories = [];
    
    if (retrievedMemories && retrievedMemories.length > 0) {
       retrievedMemories.forEach((m, idx) => {
           // Top 2 most relevant injected at Depth 1
           if (idx < 2) injectedMemories.push(m);
           // Rest thrown to the top background context
           else topMemories.push(m);
       });
    }

    let backgroundContextStr = "";
    if (topMemories.length > 0) {
      backgroundContextStr = `<retrieved_memories_background>\n` + 
        topMemories.map(m => `[${m.sourceType === 'summary' ? 'Summary' : 'Turn'} ${m.turnIndex || m.sourceId}]\n${m.text}`).join('\n\n') +
        `\n</retrieved_memories_background>\n`;
    }
    
    return { backgroundContextStr, injectedMemories };
  }

  _formatMilestones(resolvedMilestones) {
    let milestonesStr = "<pinned_milestones>\n";
    if (resolvedMilestones && resolvedMilestones.length > 0) {
      milestonesStr += resolvedMilestones.map(m => `- [Turn ${m.displayTurnIndex !== undefined ? m.displayTurnIndex : m.turnId}] ${m.content}`).join('\n') + '\n';
    } else {
      milestonesStr += "(No milestones recorded yet)\n";
    }
    milestonesStr += "</pinned_milestones>\n";
    return milestonesStr;
  }

  _formatSystemPresets(presets) {
    if (!presets) return "";
    
    if (typeof presets === 'string') {
        return presets.endsWith('\n') ? presets : presets + '\n';
    }

    let str = "<system_presets>\nCore system constraints and foundational rules guiding the narrative simulation:\n";
    presets.forEach(p => {
      if (p.title || p.description) {
         str += `\n[${p.title || 'System Rule'}]\n${p.description}\n`;
      }
    });
    str += "</system_presets>\n";
    return str;
  }

  _formatCreativePriorities(priorities) {
    if (!priorities || priorities.length === 0) return "";
    
    let str = "<creative_priorities>\nCrucial rules and instructions for this narrative step:\n";
    priorities.forEach(cp => {
      if (cp.title || cp.description) {
         str += `\n[${cp.title || 'Instruction'}]\n${cp.description}\n`;
      }
    });
    str += "</creative_priorities>\n";
    return str;
  }

  _formatActiveEntityContext(entity, userInput, inputWordsSet, knownSaliences) {
    const originalName = (entity.full_name || entity.name || "").trim();
    if (!originalName) return "";

    const rawNameLower = originalName.toLowerCase();
    const nameTokens = originalName.split(/\s+/).filter(t => t.length > 0);
    const lowerNameTokens = rawNameLower.split(/\s+/).filter(t => t.length > 0);
    
    let isDirectlyReferenced = false;

    if (nameTokens.length > 1) {
        const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fullSequenceRegex = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(originalName)}(?![\\p{L}\\p{N}_])`, 'ui');
        if (userInput && fullSequenceRegex.test(userInput)) {
            isDirectlyReferenced = true;
        }
    } else if (nameTokens.length === 1) {
        if (inputWordsSet.has(lowerNameTokens[0])) {
            isDirectlyReferenced = true;
        }
    }

    const uuid = entity.id;
    let statusData = null;
    const isFreshBranch = !knownSaliences || Object.keys(knownSaliences).length === 0;

    let details = `- [${originalName}]:\n`;

    if (!isFreshBranch && uuid && knownSaliences && knownSaliences[uuid]) {
        statusData = knownSaliences[uuid];
        let contextualSalience = typeof statusData === 'object' ? statusData.salience : statusData;

        if (isDirectlyReferenced && (contextualSalience === 'trace' || contextualSalience === 'low')) {
           contextualSalience = 'high';
        }

        if (typeof statusData === 'object') {
            const { primary_role, modality_modifiers } = statusData;
            details += `  * Last Turn Status: ${JSON.stringify({ salience: contextualSalience, primary_role, modality_modifiers })}\n`;
        } else {
            details += `  * Last Turn Status: {"salience": "${contextualSalience}", "primary_role": "", "modality_modifiers": {}}\n`;
        }
    } else {
        details += `  * Last Turn Status: Uninitialized\n`;
    }

    if (entity.role) details += `  * Role: ${entity.role}\n`;
    if (entity.mindset) details += `  * Mindset: ${entity.mindset}\n`;
    if (entity.motivation) details += `  * Motivation: ${entity.motivation}\n`;
    if (entity.appearance) details += `  * Appearance: ${entity.appearance}\n`;
    if (entity.relationship) details += `  * Relationship Dynamics: ${entity.relationship}\n`;
    if (entity.customFields && entity.customFields.length > 0) {
        entity.customFields.forEach(cf => {
            if (cf.title && cf.content) details += `  * ${cf.title}: ${cf.content}\n`;
        });
    }

    return details;
  }

  _formatSlidingWindow(slidingWindow, injectedMemories, mainCharName) {
    let str = "<sliding_window>\n";
    const speakerName = (mainCharName || 'USER').toUpperCase();
    
    if (slidingWindow && slidingWindow.length > 0) {
      for (let i = 0; i < slidingWindow.length; i++) {
        const t = slidingWindow[i];
        
        // Depth 1 Injection: Placed immediately before the most recent turn (index N-1)
        // to maximize attention score on the retrieved context.
        if (i === slidingWindow.length - 1 && injectedMemories.length > 0) {
           str += `<in_context_memory_injection>\n` + 
              injectedMemories.map(m => `[Recalled ${m.sourceType === 'summary' ? 'Summary' : 'Turn'} ${m.turnIndex || m.sourceId}]:\n${m.text}`).join('\n\n') + 
              `\n</in_context_memory_injection>\n\n`;
        }

        const uText = t.userInput || t.content || '';
        const u = `[Turn ${t.turnIndex}] ${speakerName}: ${uText}`; 
        const n = `[Turn ${t.turnIndex}] NARRATOR: ${this.extractBlock1Only(t.aiResponse || '')}`;
        str += `${u}\n${n}\n\n`;
      }
    } else if (injectedMemories.length > 0) {
       str += `<in_context_memory_injection>\n` + 
          injectedMemories.map(m => `[Recalled ${m.sourceType === 'summary' ? 'Summary' : 'Turn'} ${m.turnIndex || m.sourceId}]:\n${m.text}`).join('\n\n') + 
          `\n</in_context_memory_injection>\n\n`;
    }
    
    str += "</sliding_window>\n";
    return str;
  }

  _formatKbMemories(retrievedKbMemories) {
    if (!retrievedKbMemories || retrievedKbMemories.length === 0) return "";
    let str = "<knowledge_base_context>\nRelevant reference material retrieved from Knowledge Base files:\n\n";
    str += retrievedKbMemories.map(m => `[Reference from File ${m.docId || 'Unknown'}]\n${m.text}`).join('\n\n');
    str += "\n</knowledge_base_context>\n";
    return str;
  }

  async buildPayload({ sessionId, userInput, sessionContext, retrievedMemories, retrievedKbMemories, safeInputLimit, systemTokens, userTokens, tokenBudget, ragKbTokenBudget }) {
    const { session, memoryTree, resolvedMilestones, milestones, slidingWindow } = sessionContext;
    
    const macroContextStr = this._formatMacroContext(memoryTree);
    const { backgroundContextStr, injectedMemories } = this._routeAndFormatMemories(retrievedMemories);
    const kbMemoriesStr = this._formatKbMemories(retrievedKbMemories);
    
    const effectiveMilestones = resolvedMilestones || milestones || [];
    const milestonesStr = this._formatMilestones(effectiveMilestones);
    
    const systemPresetsStr = this._formatSystemPresets(SYSTEM_PRESETS);
    const creativePrioritiesStr = this._formatCreativePriorities(session.creativePriorities);
    
    let activeEntitiesStr = "";
    if (session.entities && session.entities.length > 0) {
      const knownSaliences = session.salienceMap || {};
      const lowerInput = (userInput || "").toLowerCase();
      const inputWordsSet = new Set(lowerInput.split(/[^\p{L}]+/u).filter(w => w.length > 0));
 
      session.entities.forEach(ent => {
         activeEntitiesStr += this._formatActiveEntityContext(ent, userInput, inputWordsSet, knownSaliences);
      });
    }
 
    let dynamicEntitiesStr = "";
    if (activeEntitiesStr) {
        dynamicEntitiesStr = `<current_scene_entities>\nEntities highly active or relevant in this specific turn:\n${activeEntitiesStr}</current_scene_entities>\n`;
    }
 
    const slidingWindowStr = this._formatSlidingWindow(slidingWindow, injectedMemories, session.protagonist?.name);
 
    let protagonistCfStr = "";
    if (session.protagonist?.customFields && session.protagonist.customFields.length > 0) {
      protagonistCfStr = "\n\n" + session.protagonist.customFields.map(cf => `${cf.title}:\n${cf.content}`).join("\n\n");
    }

    const systemTokensToUse = systemTokens ?? 50000;
    const userTokensToUse = userTokens ?? 100000;
 
    const megaSystemMessage = tc({ maxTokens: systemTokensToUse })`
${{ content: systemPresetsStr, priority: 'critical' }}
${{ content: creativePrioritiesStr, priority: 'critical' }}

<world_bible_before>
${{ content: session.world?.bibleBefore, priority: 'high', truncate: 'tail' }}
</world_bible_before>

<user_persona>
Name: ${{ content: session.protagonist?.name || 'Protagonist', priority: 'critical' }}
${{ content: session.protagonist?.persona || '', priority: 'critical' }}
${{ content: session.protagonist?.appearance ? `\nAppearance:\n${session.protagonist.appearance}` : '', priority: 'critical' }}
${{ content: session.protagonist?.relationship ? `\nRelationship Dynamics:\n${session.protagonist.relationship}` : '', priority: 'critical' }}
${{ content: protagonistCfStr, priority: 'critical' }}
</user_persona>

<output_format_enforcement>
CRITICAL MANDATE: Before generating the <block_1_scene> and JSON blocks, you MUST begin your response with an XML tag <block_0_thinking>...</block_0_thinking>. Provide your internal scratchpad, reasoning, step-by-step logic, and narrative planning inside this tag. This is your private thought space and will not be saved as narrative.
</output_format_enforcement>

<world_bible_after>
${{ content: session.world?.bibleAfter || "(No world changes yet)", priority: 'critical' }}
</world_bible_after>
`;

    const megaUserMessage = tc({ maxTokens: userTokensToUse })`
${{ content: macroContextStr, priority: 'high', truncate: 'tail' }}
${{ content: kbMemoriesStr, priority: 'high', maxTokens: ragKbTokenBudget, truncate: 'tail' }}
${{ content: milestonesStr, priority: 'critical' }}
${{ content: backgroundContextStr, priority: 'low', maxTokens: tokenBudget, truncate: 'tail' }}
${{ content: dynamicEntitiesStr, priority: 'critical' }}
${{ content: slidingWindowStr, priority: 'critical', truncate: 'head' }}
<current_input>
${{ content: `${(session.protagonist?.name || 'USER').toUpperCase()}: ${userInput}`, priority: 'critical' }}
</current_input>
`;

    return { 
      messages: [ 
          { role: "system", content: megaSystemMessage.trim() },
          { role: "user", content: megaUserMessage.trim() } 
      ],
      params: {} // Removed response_format to allow for XML+JSON hybrid format
    };
  }
}

export const promptAssemblerCore = new PromptAssemblerCore();
