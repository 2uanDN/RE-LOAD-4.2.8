import { extractBlock1Only } from "../utils/text-parser.js";
import { getEncoding } from "js-tiktoken";
import { create, insert, search, insertMultiple, save, load, updateMultiple, count } from "@orama/orama";
import { fetchChatCompletionAPI, fetchEmbeddingAPI, parseEmbeddingResponse } from "../utils/api-utils.js";
import { EMBEDDING_BATCH_SIZE } from "../core/rag-constants.js";

import { promptAssemblerCore } from "./prompt-assembler-core.js";

let encoding = null;
function getTiktoken() {
  if (!encoding) encoding = getEncoding("cl100k_base");
  return encoding;
}

class LRUOramaCache {
  constructor(maxSize = 3) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, val);
  }
}

const oramaInstances = new LRUOramaCache(3);
const taskControllers = new Map();

const sessionLocks = new Map();

async function withSessionLock(sessionId, fn) {
  if (!sessionId) return fn();
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  const executeFn = prev.then(() => fn(), () => fn());
  const unlock = executeFn.catch(() => {});
  
  let lockEntry;
  lockEntry = unlock.then(() => {
    if (sessionLocks.get(sessionId) === lockEntry) {
      sessionLocks.delete(sessionId);
    }
  });
  sessionLocks.set(sessionId, lockEntry);
  
  return executeFn;
}

// Semantic chunking parameters
const CHUNK_TARGET_TOKENS = 512;

function semanticChunk(text, maxTokens = CHUNK_TARGET_TOKENS, overlapRatio = 0.2) {
  const enc = getTiktoken();
  
  // Step 1: Tokenize preserving structure and whitespace
  let rawSegments = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    let segmenter;
    try {
      segmenter = new Intl.Segmenter('vi', { granularity: 'sentence' });
    } catch {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    }
    for (const s of segmenter.segment(text)) {
      rawSegments.push({ text: s.segment, startIdx: s.index });
    }
  } else {
    let match;
    const regex = /[^.!?\n]+[.!?]*\s*|\n+/g;
    while ((match = regex.exec(text)) !== null) {
      rawSegments.push({ text: match[0], startIdx: match.index });
    }
    if (rawSegments.length === 0 && text.length > 0) {
       rawSegments.push({ text: text, startIdx: 0 });
    }
  }

  // Step 2: Refine segments to ensure none exceed maxTokens
  const items = [];
  for (const segment of rawSegments) {
    const tokens = enc.encode(segment.text).length;
    if (tokens > maxTokens && segment.text.trim().length > 0) {
      // Hard fallback to words preserving whitespace
      const wordRegex = /\S+\s*/g;
      let wordMatch;
      let wordFound = false;
      while ((wordMatch = wordRegex.exec(segment.text)) !== null) {
        wordFound = true;
        const word = wordMatch[0];
        const wordTokens = enc.encode(word).length;
        if (wordTokens > 0) {
          items.push({ text: word, tokens: wordTokens, startIdx: segment.startIdx + wordMatch.index });
        }
      }
      if (!wordFound) {
          items.push({ text: segment.text, tokens, startIdx: segment.startIdx });
      }
    } else if (tokens > 0) {
      items.push({ text: segment.text, tokens, startIdx: segment.startIdx });
    }
  }

  // Step 3: Sliding window merge
  const mergedChunks = [];
  let startIndex = 0;

  while (startIndex < items.length) {
    let currentChunkText = "";
    let currentChunkTokens = 0;
    let i = startIndex;
    let chunkStartIdx = items[i].startIdx;
    let chunkEndIdx = chunkStartIdx;

    while (i < items.length) {
      const item = items[i];
      if (currentChunkTokens + item.tokens > maxTokens && currentChunkText.trim().length > 0) {
        break; // Chunk is full
      }
      currentChunkText += item.text;
      currentChunkTokens += item.tokens;
      chunkEndIdx = item.startIdx + item.text.length;
      i++;
    }

    const trimmedText = currentChunkText.trim();
    if (trimmedText.length > 0) {
        // Adjust start and end to account for trim
        const leadTrim = currentChunkText.length - currentChunkText.trimStart().length;
        const tailTrim = currentChunkText.length - currentChunkText.trimEnd().length;
        mergedChunks.push({
            text: trimmedText,
            startIdx: chunkStartIdx + leadTrim,
            endIdx: chunkEndIdx - tailTrim
        });
    }

    if (i >= items.length) break;

    // Calculate next startIndex to ensure overlap
    const overlapTargetTokens = Math.floor(maxTokens * overlapRatio);
    let overlapTokens = 0;
    let backtrackIndex = i - 1;
    
    while (backtrackIndex >= startIndex) {
      overlapTokens += items[backtrackIndex].tokens;
      if (overlapTokens >= overlapTargetTokens) {
        break;
      }
      backtrackIndex--;
    }

    // Always advance to avoid infinite loop
    if (backtrackIndex <= startIndex) {
      startIndex = startIndex + 1;
    } else {
      startIndex = backtrackIndex;
    }
  }

  return mergedChunks;
}

// Skeleton for Memory Worker - Logic to be filled in Phase 3
self.addEventListener("message", async (e) => {
  const { type, requestId, payload } = e.data;
  
  if (type === "CANCEL_TASK") {
    console.log(`[Worker] Cancelling task requestId: ${requestId}`);
    const controller = taskControllers.get(requestId);
    if (controller) {
      controller.abort();
    }
    return;
  }
  
  console.log(`[Worker] Received task ${type} (requestId: ${requestId})`);
  const t0 = performance.now();
  const controller = new AbortController();
  taskControllers.set(requestId, controller);
  const signal = controller.signal;

  try {
    let result = null;

    switch (type) {
      case "SUMMARIZE_A1":
        result = await processSummarizeA1(payload, signal);
        break;
      case "SUMMARIZE_A2":
        result = await processSummarizeA2(payload, signal);
        break;
      case "SUMMARIZE_A3":
        result = await processSummarizeA3(payload, signal);
        break;
      case "COUNT_TOKENS":
        result = await processCountTokens(payload);
        break;
      case "BATCH_COUNT_TOKENS":
        result = await processBatchCountTokens(payload);
        break;
      case "CHUNK_AND_EMBED":
        result = await processChunkAndEmbed(payload, signal);
        break;
      case "BATCH_CHUNK_AND_EMBED":
        result = await processBatchChunkAndEmbed(payload, signal);
        break;
      case "CHUNK_KB_AND_EMBED":
        result = await processChunkKbAndEmbed(payload, signal);
        break;
      case "CHUNK_KB_FAST":
        result = await processChunkKbFast(payload, signal);
        break;
      case "EMBED_TEXTS":
        result = await processEmbedTexts(payload, signal);
        break;
      case "INIT_ORAMA":
        result = await withSessionLock(payload.sessionId, () => processInitOrama(payload));
        break;
      case "ADD_TO_ORAMA":
        result = await withSessionLock(payload.sessionId, () => processAddToOrama(payload));
        break;
      case "RETRIEVE_AND_RANK":
        result = await withSessionLock(payload.sessionId, () => processRetrieveAndRank(payload));
        break;
      case "INIT_KB_ORAMA":
        result = await withSessionLock(payload.sessionId + "_kb", () => processInitKbOrama(payload));
        break;
      case "ADD_TO_KB_ORAMA":
        result = await withSessionLock(payload.sessionId + "_kb", () => processAddToKbOrama(payload));
        break;
      case "UPDATE_KB_ORAMA":
        result = await withSessionLock(payload.sessionId + "_kb", () => processUpdateKbOrama(payload));
        break;
      case "RETRIEVE_AND_RANK_KB":
        result = await withSessionLock(payload.sessionId + "_kb", () => processRetrieveAndRankKb(payload));
        break;
      case "BUILD_PROMPT":
        result = await promptAssemblerCore.buildPayload(payload);
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }

    if (signal.aborted) {
      console.log(`[Worker] Task ${type} (requestId: ${requestId}) was cancelled, dropping result.`);
      taskControllers.delete(requestId);
      return;
    }

    console.log(`[Worker] Task ${type} (requestId: ${requestId}) finished in ${performance.now() - t0}ms`);
    taskControllers.delete(requestId);
    self.postMessage({
      type: "SUCCESS",
      requestId,
      result,
    });
  } catch (error) {
    if (signal.aborted || error.name === 'AbortError') {
      console.log(`[Worker] Task ${type} (requestId: ${requestId}) failed but was cancelled.`);
      taskControllers.delete(requestId);
      return;
    }
    
    console.error(`[Worker] Task ${type} (requestId: ${requestId}) failed in ${performance.now() - t0}ms:`, error);
    taskControllers.delete(requestId);
    self.postMessage({
      type: "ERROR",
      requestId,
      result: null,
      error: error.message || String(error),
    });
  }
});

async function invokeChatCompletion(expertConfig, messages, signal) {
  const fullMessages = [
    { role: "system", content: expertConfig.systemPrompt },
    ...messages,
  ];

  /* expertConfig already contains everything needed: 
     baseUrl, model, apiKey, format, params (temperature, topP, topK, maxTokens, response_format), thinkingBudget
  */
  // Flatten params into the config structure expected by fetchChatCompletionAPI
  const configForApi = {
      baseUrl: expertConfig.baseUrl,
      model: expertConfig.model,
      apiKey: expertConfig.apiKey,
      format: expertConfig.format,
      capabilities: expertConfig.capabilities,
      responseFormat: expertConfig.responseFormat,
      temperature: expertConfig.params?.temperature,
      topP: expertConfig.params?.topP,
      topK: expertConfig.params?.topK,
      maxTokens: expertConfig.params?.maxTokens,
      thinkingBudget: expertConfig.thinkingBudget,
      stream: false
  };

  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    attempt++;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const response = await fetchChatCompletionAPI(configForApi, fullMessages, signal);

      if (response.status === 429 && attempt < maxAttempts) {
        // Exponential backoff
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) throw error;
      if (attempt >= maxAttempts) throw error;
    }
  }
}

async function processSummarizeA1(payload, signal) {
  const { turns, expertConfig } = payload;

  // Format turns for the prompt - handling the correct shape of stored turn (userInput and aiResponse)
  const turnsText = turns
    .map((t) => {
      let aiText = extractBlock1Only(t.aiResponse || "");
      const uText = t.userInput || "";
      return `Turn ${t.turnIndex}:\nUSER: ${uText}\nNARRATOR: ${aiText.trim()}`;
    })
    .join("\n\n");

  const userPrompt = `Please summarize the following ${turns.length} turns.\n\n${turnsText}`;

  const rawResponse = await invokeChatCompletion(expertConfig, [
    { role: "user", content: userPrompt },
  ], signal);

  const fromTurn = turns[0].turnIndex;
  const toTurn = turns[turns.length - 1].turnIndex;

  return {
    rawResponse,
    coversTurns: { 
      from: fromTurn, 
      to: toTurn,
      fromId: turns[0].id,
      toId: turns[turns.length - 1].id
    },
  };
}

async function processSummarizeA2(payload, signal) {
  const { a1Summaries, expertConfig } = payload;

  const formatted = a1Summaries
    .map(
      (a1, idx) =>
        `Micro-Summary ${idx + 1} (Turns ${a1.coversTurns.from}-${a1.coversTurns.to}):\n${a1.content}`,
    )
    .join("\n\n");
  const userPrompt = `Please synthesize the following micro-summaries into a meso-summary.\n\n${formatted}`;

  const rawResponse = await invokeChatCompletion(expertConfig, [
    { role: "user", content: userPrompt },
  ], signal);

  return {
    summary: rawResponse.trim(),
  };
}

async function processSummarizeA3(payload, signal) {
  const { a2Summaries, expertConfig } = payload;

  const formatted = a2Summaries
    .map((a2, idx) => `Meso-Summary ${idx + 1}:\n${a2.content}`)
    .join("\n\n");
  const userPrompt = `Please synthesize these meso-summaries into a grand narrative macro-summary.\n\n${formatted}`;

  const rawResponse = await invokeChatCompletion(expertConfig, [
    { role: "user", content: userPrompt },
  ], signal);

  return {
    summary: rawResponse.trim(),
  };
}

async function processEmbedTexts(payload, signal) {
  const { texts, expertConfig } = payload;
  let attempt = 0;
  const maxAttempts = 2;

  while (attempt < maxAttempts) {
    attempt++;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const response = await fetchEmbeddingAPI(expertConfig, texts, expertConfig.taskType, signal);

      if (response.status === 429 && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Embedding API Error: ${response.status} - ${errorText}`,
        );
      }

      const embeddingsResult = await parseEmbeddingResponse(response, expertConfig.format, expertConfig.baseUrl);

      return {
        embeddings: embeddingsResult,
      };
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) throw error;
      if (attempt >= maxAttempts) throw error;
    }
  }
}

async function processCountTokens(payload) {
  const { text } = payload;
  const enc = getTiktoken();
  return { tokens: enc.encode(text).length };
}

async function processBatchCountTokens(payload) {
  const { texts } = payload;
  const enc = getTiktoken();
  return { tokensArray: texts.map(t => enc.encode(t || "").length) };
}

async function processChunkAndEmbed(payload, signal) {
  const { text, expertConfig, sourceId, sourceType, turnIndex, targetTokens = CHUNK_TARGET_TOKENS } = payload;

  const chunks = semanticChunk(text, targetTokens).filter(c => c.text.trim().length > 0);
  if (chunks.length === 0) return { results: [] };

  const allEmbeddings = new Array(chunks.length).fill(null);
  let hadFailures = false;

  for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const batchTexts = chunks.slice(i, i + EMBEDDING_BATCH_SIZE).map(c => c.text);
    
    let batchSuccess = false;
    let batchAttempts = 0;
    const maxBatchAttempts = 3;

    while (!batchSuccess && batchAttempts < maxBatchAttempts) {
      batchAttempts++;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const embedRes = await processEmbedTexts({ texts: batchTexts, expertConfig }, signal);
        for (let j = 0; j < embedRes.embeddings.length; j++) {
          allEmbeddings[i + j] = embedRes.embeddings[j];
        }
        batchSuccess = true;
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw err;
        console.warn(`Batch embedding failed on attempt ${batchAttempts}:`, err);
        if (batchAttempts >= maxBatchAttempts) {
          console.error(`Batch embedding completely failed. Skipping these chunks.`);
          hadFailures = true;
        } else {
          // Exponential backoff
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, batchAttempts)));
        }
      }
    }
  }

  const results = [];
  chunks.forEach((chunk, idx) => {
    if (allEmbeddings[idx]) {
      results.push({
        chunkText: chunk.text,
        vector: allEmbeddings[idx],
        chunkIndex: idx,
        startIdx: chunk.startIdx,
        endIdx: chunk.endIdx
      });
    }
  });

  return { results, hadFailures };
}

async function processChunkKbAndEmbed(payload, signal) {
  const { text, expertConfig, docId, targetTokens = CHUNK_TARGET_TOKENS, overlapRatio = 0.2 } = payload;

  const chunks = semanticChunk(text, targetTokens, overlapRatio).filter(c => c.text.trim().length > 0);
  if (chunks.length === 0) return { results: [] };

  const allEmbeddings = new Array(chunks.length).fill(null);
  let hadFailures = false;

  for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const batchTexts = chunks.slice(i, i + EMBEDDING_BATCH_SIZE).map(c => c.text);
    
    let batchSuccess = false;
    let batchAttempts = 0;
    const maxBatchAttempts = 3;

    while (!batchSuccess && batchAttempts < maxBatchAttempts) {
      batchAttempts++;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const embedRes = await processEmbedTexts({ texts: batchTexts, expertConfig }, signal);
        for (let j = 0; j < embedRes.embeddings.length; j++) {
          allEmbeddings[i + j] = embedRes.embeddings[j];
        }
        batchSuccess = true;
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw err;
        console.warn(`KB Batch embedding failed on attempt ${batchAttempts}:`, err);
        if (batchAttempts >= maxBatchAttempts) {
          console.error(`KB Batch embedding completely failed. Skipping these chunks.`);
          hadFailures = true;
        } else {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, batchAttempts)));
        }
      }
    }
  }

  const results = [];
  chunks.forEach((chunk, idx) => {
    if (allEmbeddings[idx]) {
      results.push({
        chunkText: chunk.text,
        vector: allEmbeddings[idx],
        chunkIndex: idx,
        startIdx: chunk.startIdx,
        endIdx: chunk.endIdx
      });
    }
  });

  return { results, hadFailures };
}

async function processChunkKbFast(payload, signal) {
  const { text, expertConfig, docId, targetTokens = CHUNK_TARGET_TOKENS, overlapRatio = 0.2, fastEmbedLimit = 100 } = payload;

  const chunks = semanticChunk(text, targetTokens, overlapRatio).filter(c => c.text.trim().length > 0);
  if (chunks.length === 0) return { results: [] };

  const results = chunks.map((chunk, idx) => ({
    chunkText: chunk.text,
    chunkIndex: idx,
    vector: null,
    startIdx: chunk.startIdx,
    endIdx: chunk.endIdx
  }));

  // Fast embed the first `fastEmbedLimit` chunks
  const chunksToEmbed = chunks.slice(0, fastEmbedLimit);
  let hadFailures = false;
  if (chunksToEmbed.length > 0) {
    for (let i = 0; i < chunksToEmbed.length; i += EMBEDDING_BATCH_SIZE) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const batchTexts = chunksToEmbed.slice(i, i + EMBEDDING_BATCH_SIZE).map(c => c.text);
      
      let batchSuccess = false;
      let batchAttempts = 0;
      const maxBatchAttempts = 3;

      while (!batchSuccess && batchAttempts < maxBatchAttempts) {
        batchAttempts++;
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
          const embedRes = await processEmbedTexts({ texts: batchTexts, expertConfig }, signal);
          for (let j = 0; j < embedRes.embeddings.length; j++) {
            results[i + j].vector = embedRes.embeddings[j];
          }
          batchSuccess = true;
        } catch (err) {
          if (err.name === 'AbortError' || signal?.aborted) throw err;
          console.warn(`KB Fast Batch embedding failed on attempt ${batchAttempts}:`, err);
          if (batchAttempts >= maxBatchAttempts) {
            console.error(`KB Fast Batch embedding completely failed. Skipping these chunks.`);
            hadFailures = true;
          } else {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, batchAttempts)));
          }
        }
      }
    }
  }

  return { results, hadFailures };
}

async function processBatchChunkAndEmbed(payload, signal) {
  const { documents, expertConfig, targetTokens = CHUNK_TARGET_TOKENS } = payload;

  const allChunks = [];
  const chunkMapping = []; // map global chunk index to original document

  documents.forEach((doc, docIdx) => {
    let docTargetTokens = targetTokens;
    if (doc.sourceType === "summary") docTargetTokens = 1536;
    else if (doc.sourceType === "turn_user_input") docTargetTokens = 300;
    
    const chunks = semanticChunk(doc.text, docTargetTokens);
    chunks.forEach((chunk, chunkLocalIdx) => {
      allChunks.push(chunk.text);
      chunkMapping.push({
        sourceId: doc.sourceId,
        sourceType: doc.sourceType,
        turnIndex: doc.turnIndex,
        chunkLocalIdx: chunkLocalIdx,
        startIdx: chunk.startIdx,
        endIdx: chunk.endIdx
      });
    });
  });

  if (allChunks.length === 0) return { results: [] };

  // Note: API might have limits on batch size, so we should chunk the requests if necessary,
  // but typically Gemini batchEmbedContents handles up to 100-250 chunks.
  // We'll chunk them into sizes of EMBEDDING_BATCH_SIZE just to be safe.
  const allEmbeddings = new Array(allChunks.length).fill(null);
  let hadFailures = false;

  for (let i = 0; i < allChunks.length; i += EMBEDDING_BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const batchTexts = allChunks.slice(i, i + EMBEDDING_BATCH_SIZE);
    
    let batchSuccess = false;
    let batchAttempts = 0;
    const maxBatchAttempts = 3;

    while (!batchSuccess && batchAttempts < maxBatchAttempts) {
      batchAttempts++;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const embedRes = await processEmbedTexts({ texts: batchTexts, expertConfig }, signal);
        for (let j = 0; j < embedRes.embeddings.length; j++) {
          allEmbeddings[i + j] = embedRes.embeddings[j];
        }
        batchSuccess = true;
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw err;
        console.warn(`Batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1} embedding failed on attempt ${batchAttempts}:`, err);
        if (batchAttempts >= maxBatchAttempts) {
          console.error(`Batch completely failed. Skipping these chunks.`);
          hadFailures = true;
        } else {
          // Exponential backoff
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, batchAttempts)));
        }
      }
    }
  }

  const results = [];
  allChunks.forEach((chunkText, globalIdx) => {
    if (allEmbeddings[globalIdx]) {
      const mapping = chunkMapping[globalIdx];
      results.push({
        sourceId: mapping.sourceId,
        sourceType: mapping.sourceType,
        turnIndex: mapping.turnIndex,
        chunkText: chunkText,
        vector: allEmbeddings[globalIdx],
        chunkIndex: mapping.chunkLocalIdx,
        startIdx: mapping.startIdx,
        endIdx: mapping.endIdx
      });
    }
  });

  return { results, hadFailures };
}

async function processInitKbOrama(payload) {
  let { sessionId, docs, dimension, snapshotBuffer, expectedCount } = payload;
  const kbSessionId = sessionId + "_kb";
  
  if (snapshotBuffer) {
    try {
      const db = await create({
        schema: {
          id: "string",
          text: "string",
          docId: "string",
          chunkIndex: "number",
          vector: `vector[${dimension}]`,
        },
        components: {
          tokenizer: {
            stemming: false,
            stopWords: false
          }
        }
      });
      
      await load(db, snapshotBuffer);
      
      if (typeof expectedCount === "number") {
        const actualDbCount = await count(db);
        if (actualDbCount !== expectedCount) {
          throw new Error(`SNAPSHOT_FAILED: expected ${expectedCount}, got ${actualDbCount}`);
        }
      }
      
      oramaInstances.set(kbSessionId, db);
      return { success: true, fromSnapshot: true };
    } catch (e) {
      console.warn("Failed to load KB Orama Snapshot", e);
      throw new Error("SNAPSHOT_FAILED");
    }
  }

  if (!docs) docs = [];

  const db = await create({
    schema: {
      id: "string",
      text: "string",
      docId: "string",
      chunkIndex: "number",
      vector: `vector[${dimension}]`,
    },
    components: {
      tokenizer: {
        stemming: false,
        stopWords: false
      }
    }
  });

  const docsToInsert = [];
  for (const doc of docs) {
    const docToInsert = {
      id: doc.id,
      text: doc.text,
      docId: doc.docId,
      chunkIndex: doc.chunkIndex || 0,
    };
    if (doc.vector && doc.vector.length === dimension) {
      docToInsert.vector = Array.from(doc.vector);
    }
    docsToInsert.push(docToInsert);
  }

  if (docsToInsert.length > 0) {
    await insertMultiple(db, docsToInsert);
  }

  oramaInstances.set(kbSessionId, db);
  const rawData = await save(db);

  return { success: true, count: docs.length, snapshotBuffer: rawData };
}

async function processAddToKbOrama(payload) {
  const { sessionId, docs, dimension } = payload;
  const kbSessionId = sessionId + "_kb";
  let db = oramaInstances.get(kbSessionId);
  
  if (!db) return { success: false, reason: "NOT_INITIALIZED" };
  
  const docsToInsert = [];
  for (const doc of docs) {
    const docToInsert = {
      id: doc.id,
      text: doc.text,
      docId: doc.docId,
      chunkIndex: doc.chunkIndex || 0,
    };
    if (doc.vector && doc.vector.length === dimension) {
      docToInsert.vector = Array.from(doc.vector);
    }
    docsToInsert.push(docToInsert);
  }
  
  if (docsToInsert.length > 0) {
    await insertMultiple(db, docsToInsert);
  }
  
  if (!self._snapshotKbDebounceTimers) {
    self._snapshotKbDebounceTimers = new Map();
  }
  if (self._snapshotKbDebounceTimers.has(kbSessionId)) {
    clearTimeout(self._snapshotKbDebounceTimers.get(kbSessionId));
  }

  const timerId = setTimeout(async () => {
    try {
      const currentDb = oramaInstances.get(kbSessionId);
      if (currentDb) {
        const rawData = await save(currentDb);
        self.postMessage({
          type: "SYNC_KB_SNAPSHOT",
          payload: rawData,
          sessionId: sessionId
        });
      }
    } catch (e) {
      console.warn("Failed to generate KB deferred snapshot", e);
    }
    self._snapshotKbDebounceTimers.delete(kbSessionId);
  }, 5000);
  
  self._snapshotKbDebounceTimers.set(kbSessionId, timerId);

  return { success: true, added: docs.length };
}

async function processUpdateKbOrama(payload) {
  const { sessionId, docs, dimension } = payload;
  const kbSessionId = sessionId + "_kb";
  let db = oramaInstances.get(kbSessionId);
  
  if (!db) return { success: false, reason: "NOT_INITIALIZED" };
  
  const idsToUpdate = [];
  const docsToUpdate = [];
  for (const doc of docs) {
    const docToUpdate = {
      id: doc.id,
      text: doc.text,
      docId: doc.docId,
      chunkIndex: doc.chunkIndex || 0,
    };
    if (doc.vector && doc.vector.length === dimension) {
      docToUpdate.vector = Array.from(doc.vector);
    }
    idsToUpdate.push(doc.id);
    docsToUpdate.push(docToUpdate);
  }
  
  if (docsToUpdate.length > 0) {
    await updateMultiple(db, idsToUpdate, docsToUpdate);
  }
  
  if (!self._snapshotKbDebounceTimers) {
    self._snapshotKbDebounceTimers = new Map();
  }
  if (self._snapshotKbDebounceTimers.has(kbSessionId)) {
    clearTimeout(self._snapshotKbDebounceTimers.get(kbSessionId));
  }

  const timerId = setTimeout(async () => {
    try {
      const currentDb = oramaInstances.get(kbSessionId);
      if (currentDb) {
        const rawData = await save(currentDb);
        self.postMessage({
          type: "SYNC_KB_SNAPSHOT",
          payload: rawData,
          sessionId: sessionId
        });
      }
    } catch (e) {
      console.warn("Failed to generate KB deferred snapshot", e);
    }
    self._snapshotKbDebounceTimers.delete(kbSessionId);
  }, 5000);
  
  self._snapshotKbDebounceTimers.set(kbSessionId, timerId);

  return { success: true, updated: docs.length };
}

async function processRetrieveAndRankKb(payload) {
  const { sessionId, queryText, queryVector, topK, tokenBudget, penaltyFactor, similarityThreshold = 0.5 } = payload;
  const kbSessionId = sessionId + "_kb";
  let db = oramaInstances.get(kbSessionId);
  if (!db) return { results: [] };

  const searchPromises = [
    search(db, {
      mode: "fulltext",
      term: queryText,
      properties: ["text"],
      limit: Math.max(topK * 10, 60),
    })
  ];

  if (queryVector && queryVector.length > 0) {
    searchPromises.push(
      search(db, {
        mode: "vector",
        vector: {
          value: Array.from(queryVector),
          property: "vector",
        },
        limit: Math.max(topK * 10, 60),
        similarity: similarityThreshold,
      })
    );
  }

  const searchResults = await Promise.all(searchPromises);
  const bm25Result = searchResults[0];
  const vectorResult = searchResults.length > 1 ? searchResults[1] : { hits: [] };

  const k = 60;
  const rrfScores = new Map();
  const docMap = new Map();

  if (bm25Result && bm25Result.hits) {
    bm25Result.hits.forEach((hit, index) => {
      const rank = index + 1;
      const score = 1 / (k + rank);
      rrfScores.set(hit.document.id, score);
      docMap.set(hit.document.id, hit.document);
    });
  }

  if (vectorResult && vectorResult.hits) {
    vectorResult.hits.forEach((hit, index) => {
      const rank = index + 1;
      const score = (rrfScores.get(hit.document.id) || 0) + (1 / (k + rank));
      rrfScores.set(hit.document.id, score);
      docMap.set(hit.document.id, hit.document);
    });
  }

  let scoredResults = [];
  for (const [id, score] of rrfScores.entries()) {
    const doc = docMap.get(id);
    scoredResults.push({
      id: doc.id,
      text: doc.text,
      score: doc.vector ? score : score * 2,
      docId: doc.docId,
      chunkIndex: doc.chunkIndex,
      needsEmbedding: !doc.vector // Flag for BM25 hits missing vectors
    });
  }

  scoredResults.sort((a, b) => b.score - a.score);

  return { results: scoredResults };
}

async function processInitOrama(payload) {
  let { sessionId, docs, dimension, snapshotBuffer, expectedCount } = payload;
  
  if (snapshotBuffer) {
    try {
      const db = await create({
        schema: {
          id: "string",
          text: "string",
          sourceType: "string",
          sourceId: "string",
          turnIndex: "number",
          vector: `vector[${dimension}]`,
        },
        components: {
          tokenizer: {
            stemming: false,
            stopWords: false
          }
        }
      });
      
      await load(db, snapshotBuffer);

      if (typeof expectedCount === "number") {
        const actualDbCount = await count(db);
        if (actualDbCount !== expectedCount) {
          throw new Error(`SNAPSHOT_FAILED: expected ${expectedCount}, got ${actualDbCount}`);
        }
      }

      oramaInstances.set(sessionId, db);
      return { success: true, fromSnapshot: true };
    } catch (e) {
      console.warn("Failed to load Orama Snapshot, falling back to rebuild", e);
      // BUG FIX: Avoid falling through with empty docs if snapshot fails.
      // We throw a specific error so rag-engine can fetch the docs from DB and retry.
      throw new Error("SNAPSHOT_FAILED");
    }
  }

  // Allow empty docs array (e.g. for new sessions context)
  if (!docs) {
    docs = [];
  }

  const db = await create({
    schema: {
      id: "string",
      text: "string",
      sourceType: "string",
      sourceId: "string",
      turnIndex: "number",
      vector: `vector[${dimension}]`,
    },
    components: {
      tokenizer: {
        stemming: false,
        stopWords: false
      }
    }
  });

  const docsToInsert = [];
  for (const doc of docs) {
    if (doc.vector && doc.vector.length === dimension) {
      docsToInsert.push({
        id: doc.id,
        text: doc.text,
        sourceType: doc.sourceType,
        sourceId: doc.sourceId,
        turnIndex: doc.turnIndex || 0,
        vector: Array.from(doc.vector),
      });
    } else if (doc.vector) {
      throw new Error(`DIMENSION_MISMATCH: expected ${dimension}, got ${doc.vector.length}`);
    }
  }

  if (docsToInsert.length > 0) {
    await insertMultiple(db, docsToInsert);
  }

  oramaInstances.set(sessionId, db);
  const rawData = await save(db);

  return { success: true, count: docs.length, snapshotBuffer: rawData };
}

async function processAddToOrama(payload) {
  const { sessionId, docs, dimension } = payload;
  let db = oramaInstances.get(sessionId);
  
  // If db doesn't exist, we can't add to it safely without knowing dimension and doing full init
  if (!db) return { success: false, reason: "NOT_INITIALIZED" };
  
  const docsToInsert = [];
  for (const doc of docs) {
    if (doc.vector && doc.vector.length === dimension) {
      docsToInsert.push({
        id: doc.id,
        text: doc.text,
        sourceType: doc.sourceType,
        sourceId: doc.sourceId,
        turnIndex: doc.turnIndex || 0,
        vector: Array.from(doc.vector),
      });
    } else if (doc.vector) {
      throw new Error(`DIMENSION_MISMATCH: expected ${dimension}, got ${doc.vector.length}`);
    }
  }
  
  if (docsToInsert.length > 0) {
    await insertMultiple(db, docsToInsert);
  }
  
  if (!self._snapshotDebounceTimers) {
    self._snapshotDebounceTimers = new Map();
  }
  if (self._snapshotDebounceTimers.has(sessionId)) {
    clearTimeout(self._snapshotDebounceTimers.get(sessionId));
  }

  const timerId = setTimeout(async () => {
    try {
      const currentDb = oramaInstances.get(sessionId);
      if (currentDb) {
        const rawData = await save(currentDb);
        self.postMessage({
          type: "SYNC_SNAPSHOT",
          payload: rawData,
          sessionId: sessionId
        });
      }
    } catch (e) {
      console.warn("Failed to generate deferred snapshot", e);
    }
    self._snapshotDebounceTimers.delete(sessionId);
  }, 5000);
  
  self._snapshotDebounceTimers.set(sessionId, timerId);

  return { success: true, added: docs.length };
}

async function processRetrieveAndRank(payload) {
  const { sessionId, queryText, queryVector, currentTurnIndex, topK, tokenBudget, penaltyFactor, similarityThreshold = 0.5, excludeSourceIds = [], slidingWindowSize = 10 } = payload;

  let db = oramaInstances.get(sessionId);
  if (!db) return { results: [] };

  const excludedSet = new Set(excludeSourceIds);

  const searchPromises = [
    search(db, {
      mode: "fulltext",
      term: queryText,
      properties: ["text"],
      limit: Math.max(topK * 10, 60),
    })
  ];

  if (queryVector && queryVector.length > 0) {
    searchPromises.push(
      search(db, {
        mode: "vector",
        vector: {
          value: Array.from(queryVector),
          property: "vector",
        },
        limit: Math.max(topK * 10, 60),
        similarity: similarityThreshold,
      })
    );
  }

  const searchResults = await Promise.all(searchPromises);
  const bm25Result = searchResults[0];
  const vectorResult = searchResults.length > 1 ? searchResults[1] : { hits: [] };

  const k = 60;
  const rrfScores = new Map();
  const docMap = new Map();

  if (bm25Result && bm25Result.hits) {
    bm25Result.hits.forEach((hit, index) => {
      const rank = index + 1;
      const score = 1 / (k + rank);
      rrfScores.set(hit.document.id, score);
      docMap.set(hit.document.id, hit.document);
    });
  }

  if (vectorResult && vectorResult.hits) {
    vectorResult.hits.forEach((hit, index) => {
      const rank = index + 1;
      const score = (rrfScores.get(hit.document.id) || 0) + (1 / (k + rank));
      rrfScores.set(hit.document.id, score);
      docMap.set(hit.document.id, hit.document);
    });
  }

  let scoredResults = [];
  for (const [id, score] of rrfScores.entries()) {
    const doc = docMap.get(id);
    
    // FIX 2: Context Bloat Duplication
    if (doc.sourceType === "turn" || doc.sourceType === "turn_user_input" || doc.sourceType === "turn_narrator") {
      const turnDiff = Math.max(0, currentTurnIndex - (doc.turnIndex || 0));
      if (turnDiff < slidingWindowSize) continue;
    }

    if (excludedSet.has(doc.sourceId)) continue;

    let turnDiff = 0;
    if (doc.turnIndex !== undefined && doc.turnIndex !== null) {
      turnDiff = Math.max(0, currentTurnIndex - doc.turnIndex);
    }
    
    // Time-Decay applied to RRF score
    // Since RRF scores are typically small (e.g. 0.01 - 0.033), we scale penalty factor to match this range
    // A penalty of 0.005 applied to an RRF score of 0.016 (rank 1) would wipe it out in 3 turns.
    // So we apply a modified time decay for RRF. Let's scale down penaltyFactor by 100 for RRF.
    const rrfPenaltyFactor = penaltyFactor / 100;
    const finalScore = score - turnDiff * rrfPenaltyFactor;

    scoredResults.push({
      id: doc.id,
      text: doc.text,
      similarity: score, // Use RRF score as similarity
      decayedScore: finalScore,
      sourceType: doc.sourceType,
      sourceId: doc.sourceId,
      turnIndex: doc.turnIndex,
    });
  }

  scoredResults.sort((a, b) => b.decayedScore - a.decayedScore);

  // Group by sourceId (Hierarchical RAG deduplication)
  // We keep the highest decay score child chunk as the representative.
  const uniqueGroups = new Map();
  for (let match of scoredResults) {
    if (!uniqueGroups.has(match.sourceId)) {
      uniqueGroups.set(match.sourceId, match);
    }
  }

  // We return a larger pool so rag-engine can fetch Parents and filter by token budget
  let topResults = Array.from(uniqueGroups.values()).slice(0, Math.max(topK * 3, 10));

  return { results: topResults };
}
