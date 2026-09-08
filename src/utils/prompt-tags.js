import { getEncoding } from 'js-tiktoken';

// Dependency Injectable Engine
let defaultTokenizer = null;

/**
 * Allows injecting a custom tokenizer engine (e.g., local WASM Gemini tokenizer in the future)
 * @param {{ encode: (text: string) => number[], decode: (tokens: number[]) => string }} engine 
 */
export function setTokenizerEngine(engine) {
  defaultTokenizer = engine;
}

export function getTokenizerEngine() {
  if (!defaultTokenizer) {
    const enc = getEncoding("cl100k_base");
    const decoder = new TextDecoder();
    defaultTokenizer = {
      encode: (text) => enc.encode(text),
      decode: (tokens) => decoder.decode(enc.decode(tokens))
    };
  }
  return defaultTokenizer;
}

// In-Memory LRU Helper to prevent I/O bottlenecks during heavy loops
class LRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val); // move to most recently used
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // evict least recently used (first item)
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, val);
  }
}

const encodeCache = new LRUCache(500);

function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

function getCachedEncode(text, engine) {
  if (typeof text !== 'string') return [];
  const keyLength = text.length;
  if (keyLength === 0) return [];
  
  // Memoization constraint optimization
  // Prevent retaining huge strings in LRU cache to save MBs of RAM
  const key = keyLength > 256 
    ? `${keyLength}_${simpleHash(text)}_${text.slice(0, 64)}_${text.slice(-64)}`
    : text;
  
  const cached = encodeCache.get(key);
  if (cached) return cached;
  
  const encoded = engine.encode(text);
  encodeCache.set(key, encoded);
  return encoded;
}

const PRIORITIES = {
  critical: 3,
  high: 2,
  low: 1
};

export const SAFE_INPUT_LIMIT = 150_000;

/**
 * Token Controlled Tagged Template Literal Factory
 * @param {{ maxTokens?: number, engine?: any }} config 
 * @returns {Function} Tagged Template function
 */
export function tc({ maxTokens = SAFE_INPUT_LIMIT, engine = null } = {}) {
  const tokenizer = engine || getTokenizerEngine();

  return function(strings, ...values) {
    // Phase 1: Bootstrapping & Fixed Cost
    let fixedTokens = 0;
    strings.forEach(s => {
      fixedTokens += getCachedEncode(s, tokenizer).length;
    });

    // Phase 2: Pre-sizing Values
    let availableTokens = Math.max(0, maxTokens - fixedTokens);

    const valuesInfo = values.map((val, index) => {
      let content = '';
      let priority = 'critical';
      let truncate = 'tail';

      let itemMaxTokens = null;
      if (val !== null && typeof val === 'object' && 'content' in val) {
        content = String(val.content);
        if (val.priority) priority = val.priority;
        if (val.truncate) truncate = val.truncate;
        if (typeof val.maxTokens === 'number') itemMaxTokens = val.maxTokens;
      } else {
        content = String(val ?? '');
      }

      const tokens = getCachedEncode(content, tokenizer);
      return {
        index,
        content,
        priorityScore: PRIORITIES[priority] || PRIORITIES.critical,
        truncate,
        originalTokens: tokens,
        allocatedTokens: 0,
        desiredTokens: itemMaxTokens !== null ? Math.min(tokens.length, itemMaxTokens) : tokens.length
      };
    });

    const totalDesired = valuesInfo.reduce((sum, item) => sum + item.desiredTokens, 0);

    // Phase 3: Allocation & Truncation
    if (totalDesired <= availableTokens) {
      // Fast path: everything fits perfectly
      valuesInfo.forEach(item => { item.allocatedTokens = item.desiredTokens; });
    } else {
      const sortedBuckets = [
        valuesInfo.filter(v => v.priorityScore === 3), // Critical
        valuesInfo.filter(v => v.priorityScore === 2), // High
        valuesInfo.filter(v => v.priorityScore === 1)  // Low
      ];

      for (const bucket of sortedBuckets) {
        let bucketDesired = bucket.reduce((sum, item) => sum + item.desiredTokens, 0);
        
        if (bucketDesired <= availableTokens) {
          bucket.forEach(item => {
            item.allocatedTokens = item.desiredTokens;
            availableTokens -= item.desiredTokens;
          });
        } else {
          // Proportional allocation for the remaining budget
          let bucketRemainingTokens = availableTokens;
          let activeItems = [...bucket];
          
          while (activeItems.length > 0 && bucketRemainingTokens > 0) {
            const fairShare = Math.floor(bucketRemainingTokens / activeItems.length);
            
            if (fairShare === 0) {
              // Distribute leftover tokens 1 by 1
              for (let i = 0; i < bucketRemainingTokens && i < activeItems.length; i++) {
                activeItems[i].allocatedTokens += 1;
              }
              bucketRemainingTokens = 0;
              break;
            }

            const stillNeedingTokens = [];
            for (const item of activeItems) {
              const shortfall = item.desiredTokens - item.allocatedTokens;
              const toAllocate = Math.min(fairShare, shortfall);
              item.allocatedTokens += toAllocate;
              bucketRemainingTokens -= toAllocate;
              
              if (item.allocatedTokens < item.desiredTokens) {
                stillNeedingTokens.push(item);
              }
            }
            activeItems = stillNeedingTokens;
          }
          availableTokens = bucketRemainingTokens; // Pass remaining tokens down
        }
      }
    }

    // Phase 4: Interpolation
    let result = '';
    for (let i = 0; i < strings.length; i++) {
      result += strings[i];
      
      if (i < valuesInfo.length) {
        const item = valuesInfo[i];
        if (item.allocatedTokens === item.originalTokens.length) {
          result += item.content; // No truncation needed
        } else if (item.allocatedTokens > 0) {
          // Safe Token Truncation
          let tokenSubset;
          if (item.truncate === 'head') {
            tokenSubset = item.originalTokens.slice(item.originalTokens.length - item.allocatedTokens);
          } else {
            tokenSubset = item.originalTokens.slice(0, item.allocatedTokens);
          }
          result += tokenizer.decode(tokenSubset);
        }
      }
    }

    return result;
  };
}
