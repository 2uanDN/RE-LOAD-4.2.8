import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { REASONING_CLEANUP_REGEX } from '../core/ai-constants.js';

marked.setOptions({ breaks: true });

export const safeMarkedParse = (text) => {
  if (!text) return '';
  let str = text;
  if (Array.isArray(text)) {
    str = text.join('\n');
  } else if (typeof text !== 'string') {
    str = String(text);
  }
  const html = marked.parse(str);
  return DOMPurify.sanitize(html);
};

export function cleanRawResponse(str) {
  if (!str) return '';
  let cleaned = str.trim();
  cleaned = cleaned.replace(REASONING_CLEANUP_REGEX, '').trim();

  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.substring(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.substring(0, cleaned.length - 3).trim();
  }
  return cleaned;
}

export function _constructFromParsed(parsed, block0 = '') {
  let block3Raw = parsed.block_3_inner_reaction || parsed.monologue;
  let block3 = '';
  if (typeof block3Raw === 'string') {
    block3 = block3Raw;
  } else if (block3Raw && typeof block3Raw === 'object') {
    try { block3 = JSON.stringify(block3Raw); } catch (e) {}
  }

  let block2 = parsed.block_2_label_and_description || parsed.choices || [];
  
  return {
    block0: block0 || parsed.block_0_thinking || parsed.block0 || '',
    block1: parsed.block_1_scene || parsed.scene || '',
    block2: block2,
    block3: block3 || '',
    characterDynamics: parsed.character_dynamics || parsed.characterDynamics || []
  };
}

// Minimal healJson for non-streaming fallback (if somehow truncated)
export function _healJson(str) {
    let stack = [];
    let inString = false;
    let escape = false;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === '{') stack.push('{');
        else if (char === '[') stack.push('[');
        else if (char === '}') {
          if (stack[stack.length - 1] === '{') stack.pop();
        }
        else if (char === ']') {
          if (stack[stack.length - 1] === '[') stack.pop();
        }
      }
    }

    let healed = str;
    if (inString) healed += '"';
    for (let i = stack.length - 1; i >= 0; i--) {
      healed += stack[i] === '{' ? '}' : ']';
    }
    healed = healed.replace(/,\s*([}\]])/g, '$1');
    if (!healed) return "{}";
    return healed;
}

export function parseBlocks(rawText) {
  // test script logic
  if (!rawText) return { block0: '', block1: '', block2: [], block3: '', characterDynamics: [] };

  if (typeof rawText === 'object') {
    return _constructFromParsed(rawText);
  }

  let str = rawText.trim();

  let block0 = '';
  const reasoningMatch = str.match(REASONING_CLEANUP_REGEX);
  if (reasoningMatch) {
    block0 = reasoningMatch.map(m => m.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '')).join('\n').trim();
  }

  str = str.replace(REASONING_CLEANUP_REGEX, '').trim();

  let block1 = '';
  let prefixGarbage = '';
  // 1. Robust Hybrid Block 1 Extraction (XML tags without Regex overhead if possible)
  const block1Start = str.indexOf("<block_1_scene>");
  if (block1Start !== -1) {
    prefixGarbage = str.substring(0, block1Start).trim();
    const contentStart = block1Start + 15;
    const block1End = str.indexOf("</block_1_scene>", contentStart);
    if (block1End !== -1) {
      block1 = str.substring(contentStart, block1End).trim();
    } else {
      let endOfProse = str.length;
      const firstCodeBlock = str.indexOf("```", contentStart);
      if (firstCodeBlock !== -1) {
        endOfProse = firstCodeBlock;
      } else {
        const firstBracket = str.indexOf("{", contentStart);
        if (firstBracket !== -1) {
          endOfProse = firstBracket;
        }
      }
      block1 = str.substring(contentStart, endOfProse).trim();
    }
  } else {
    // Fallback: If no tag found, assume everything before the JSON block starts is block1 prose.
    const firstCodeBlock = str.indexOf("```");
    const firstBracket = str.indexOf("{");
    let endOfProse = str.length;

    if (firstCodeBlock !== -1) {
      endOfProse = firstCodeBlock;
    } else if (firstBracket !== -1) {
      endOfProse = firstBracket;
    }
    block1 = str.substring(0, endOfProse).trim();
  }

  if (prefixGarbage) {
      block0 = block0 ? prefixGarbage + '\n\n' + block0 : prefixGarbage;
  }

  // 2. Extract JSON payload
  let jsonStr = '';
  const block1EndIdx = str.indexOf('</block_1_scene>');
  const jsonSearchStart = block1EndIdx !== -1 ? block1EndIdx + 16 : 0;
  const jsonSearchStr = str.slice(jsonSearchStart);

  const jsonMatch = jsonSearchStr.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  if (jsonMatch) {
     jsonStr = jsonMatch[1].trim();
  } else {
     const bracketIndex = str.indexOf('{', jsonSearchStart);
     if (bracketIndex !== -1) {
         jsonStr = str.substring(bracketIndex).trim();
     } else if (jsonSearchStart === 0 && block1Start === -1) {
         const firstBracket = str.indexOf('{');
         jsonStr = firstBracket !== -1 ? str.substring(firstBracket).trim() : str;
     }
  }

  if (jsonStr) {
      jsonStr = cleanRawResponse(jsonStr);
  }

  try {
    const parsed = JSON.parse(jsonStr || "{}");
    const result = _constructFromParsed(parsed, block0);
    // If block1 was successfully extracted via fallback or tag, prioritize it over JSON's block1
    if (block1) {
        result.block1 = block1;
    }
    return result;
  } catch (e) {
    try {
        const healed = _healJson(jsonStr || "");
        const parsed = JSON.parse(healed);
        const result = _constructFromParsed(parsed, block0);
        if (block1) {
            result.block1 = block1;
        }
        return result;
    } catch(err) {
        console.error("Critical JSON Parser Failure", err, "Raw:", jsonStr);
        return { block0: block0, block1: block1 || str, block2: [], block3: '', characterDynamics: [] };
    }
  }
}

export function extractBlock1Only(rawText) {
  return parseBlocks(rawText).block1;
}

