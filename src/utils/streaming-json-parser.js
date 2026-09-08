import { REASONING_TAGS } from '../core/ai-constants.js';

export class StreamingJsonParser {
  constructor() {
    this.buffer = "";
    this._cleanBuffer = "";
    this._thinkingBuffer = "";
    
    // FSM States
    this.state = 'TEXT_MODE'; // TEXT_MODE, EXPECT_TAG_MODE, REASONING_MODE
    this.currentReasoningTag = null;
    
    // Parser Optimizations
    this._lastParsedLength = 0;
    this._lastJsonStructureLength = 0;
    this._lastParsedResult = null;
  }

  get cleanBuffer() {
    return this._cleanBuffer;
  }

  get isThinking() {
    return this.state === 'REASONING_MODE';
  }

  get thinkingBuffer() {
    return this._thinkingBuffer;
  }

  /**
   * Push a new chunk of string, filtering out reasoning tags.
   * Returns the new clean text added.
   * Uses a Finite State Machine to robustly catch <think>, <thinking>, etc.
   */
  processChunk(chunk) {
    this.buffer += chunk;
    let newClean = "";

    while (this.buffer.length > 0) {
      if (this.state === 'REASONING_MODE') {
        const endTag = `</${this.currentReasoningTag}>`;
        const bufferLower = this.buffer.toLowerCase();
        let endIndex = bufferLower.indexOf(endTag);
        
        if (endIndex !== -1) {
          this._thinkingBuffer += this.buffer.substring(0, endIndex);
          this.buffer = this.buffer.substring(endIndex + endTag.length);
          this.state = 'TEXT_MODE';
          this.currentReasoningTag = null;
        } else {
          const lastLt = this.buffer.lastIndexOf('<');
          if (lastLt !== -1 && endTag.startsWith(bufferLower.substring(lastLt))) {
            this._thinkingBuffer += this.buffer.substring(0, lastLt);
            this.buffer = this.buffer.substring(lastLt);
            break;
          }
          this._thinkingBuffer += this.buffer;
          this.buffer = "";
          break;
        }
      } else if (this.state === 'EXPECT_TAG_MODE') {
        const gtIndex = this.buffer.indexOf('>');
        if (gtIndex !== -1) {
          const potentialTag = this.buffer.substring(1, gtIndex).toLowerCase();
          if (REASONING_TAGS.includes(potentialTag)) {
            this.state = 'REASONING_MODE';
            this.currentReasoningTag = potentialTag;
            this.buffer = this.buffer.substring(gtIndex + 1);
          } else {
            newClean += '<';
            this.buffer = this.buffer.substring(1);
            this.state = 'TEXT_MODE';
          }
        } else {
          const bufferLower = this.buffer.toLowerCase();
          let isPrefix = false;
          for (const tag of REASONING_TAGS) {
            const fullTag = `<${tag}>`;
            if (fullTag.startsWith(bufferLower)) {
              isPrefix = true;
              break;
            }
          }
          
          if (isPrefix) {
            break;
          } else {
            newClean += '<';
            this.buffer = this.buffer.substring(1);
            this.state = 'TEXT_MODE';
          }
        }
      } else {
        let startIndex = this.buffer.indexOf('<');
        if (startIndex !== -1) {
          newClean += this.buffer.substring(0, startIndex);
          this.buffer = this.buffer.substring(startIndex);
          this.state = 'EXPECT_TAG_MODE';
        } else {
          newClean += this.buffer;
          this.buffer = "";
          break;
        }
      }
    }

    this._cleanBuffer += newClean;
    
    return newClean;
  }

  /**
   * Try to parse the partial streaming text into the 3 blocks.
   * Optimized for Hybrid Format (block_1_scene XML + JSON).
   * @returns { block1: string, block2: string, block3: string, fullJson: string }
   */
  parsePartialJson() {
    let str = this.cleanBuffer.trim();

    let prefixGarbage = "";
    const block1Start = str.indexOf("<block_1_scene>");
    if (block1Start !== -1) {
      prefixGarbage = str.substring(0, block1Start).trim();
    }

    let finalBlock0 = this._thinkingBuffer.trim();
    if (prefixGarbage) {
        finalBlock0 = finalBlock0 ? prefixGarbage + '\n\n' + finalBlock0 : prefixGarbage;
    }

    if (str.length === this._lastParsedLength && this._lastParsedResult) {
      if (finalBlock0.length > 0) {
          this._lastParsedResult.block0 = finalBlock0;
      }
      return { ...this._lastParsedResult };
    }

    let block1 = "";
    let block2 = "";
    let block3 = "";
    let characterDynamics = [];
    let jsonStr = "";

    // 1. Robust Hybrid Block 1 Extraction
    // If the model correctly uses the tag:
    if (block1Start !== -1) {
      const contentStart = block1Start + 15; // length of <block_1_scene>
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
        // Only trust naked '{' as JSON start if it's near the end or seems like the root object
        endOfProse = firstBracket;
      }
      
      block1 = str.substring(0, endOfProse).trim();
    }

    // 2. Fast JSON extraction (only parse if JSON has likely started)
    const block1EndIndex = str.indexOf("</block_1_scene>");
    const searchStartIndex = block1EndIndex !== -1 ? block1EndIndex + 16 : 0;
    
    const searchStr = block1EndIndex !== -1 ? str.slice(searchStartIndex) : str;
    
    // Look for markdown code block
    const codeBlockMatch = searchStr.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    } else {
      // Fallback: naked JSON after block 1
      const bracketIndex = str.indexOf("{", searchStartIndex);
      if (bracketIndex !== -1) {
        jsonStr = str.substring(bracketIndex).trim();
      } else if (searchStartIndex === 0 && block1Start === -1) {
         // Pure JSON legacy fallback
         const firstBracket = str.indexOf("{");
         if (firstBracket !== -1) {
             jsonStr = str.substring(firstBracket).trim();
             // If we're here, the block1 fallback captured everything before `{`.
         }
      }
    }

    this._lastParsedLength = str.length;

    try {
      if (!jsonStr) {
         this._lastParsedResult = { block0: finalBlock0, block1, block2, block3, characterDynamics, fullJson: str };
         return { ...this._lastParsedResult };
      }

      // Optimization: Only run expensive healJson & JSON.parse if the JSON structure evolved
      const structureStr = jsonStr.replace(/[^,{}[\]]/g, '');
      const structureLength = structureStr.length;
      
      if (
         this._lastParsedResult && 
         this._lastParsedResult.fullJson &&
         structureLength === this._lastJsonStructureLength
      ) {
          // If structure length hasn't changed, do not heal/re-parse JSON.
          // We still update block/think arrays to reflect immediate streaming chunk
          this._lastParsedResult.block0 = finalBlock0;
          this._lastParsedResult.block1 = block1 || this._lastParsedResult.block1;
          this._lastParsedResult.fullJson = jsonStr;
          return { ...this._lastParsedResult };
      }

      this._lastJsonStructureLength = structureLength;

      const healedJson = this.healJson(jsonStr);
      const parsed = JSON.parse(healedJson);
      
      let b2 = parsed.block_2_label_and_description || parsed.choices || [];
      if (!block1) {
         block1 = parsed.block_1_scene || parsed.scene || "";
      }
      block2 = typeof b2 === 'string' ? b2 : JSON.stringify(b2);
      block3 = parsed.block_3_inner_reaction || parsed.monologue || "";
      characterDynamics = parsed.character_dynamics || parsed.characterDynamics || [];
      
      this._lastParsedResult = {
        block0: finalBlock0,
        block1,
        block2,
        block3,
        characterDynamics,
        fullJson: jsonStr,
      };
      
      return { ...this._lastParsedResult };
    } catch (e) {
      this._lastParsedResult = {
        block0: finalBlock0,
        block1,
        block2,
        block3,
        characterDynamics,
        fullJson: jsonStr,
      };
      
      return { ...this._lastParsedResult };
    }
  }

  healJson(str) {
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
    if (inString) {
      healed += '"';
    }

    for (let i = stack.length - 1; i >= 0; i--) {
      healed += stack[i] === '{' ? '}' : ']';
    }
    
    healed = healed.replace(/,\s*([}\]])/g, '$1');

    // Fallback heuristic if it's completely empty but we expect an object
    if (!healed) return "{}";
    
    return healed;
  }
}
