import { db } from './db.js';
import { keyRotator } from './key-rotator.js';
import { getProviderFormat, fetchEmbeddingAPI, parseEmbeddingResponse, fetchChatCompletionAPI } from '../utils/api-utils.js';
import { EXPERT_SCHEMAS, DEFAULT_EXPERTS } from './default-experts.js';
import { eventBus } from './event-bus.js';

async function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(new DOMException('Aborted', 'AbortError'));
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };
    if (signal) {
      signal.addEventListener('abort', onAbort);
    }
  });
}

class ApiClient {
  /**
   * Builds the thinking payload according to Gemini format if needed.
   * [Removed to favor api-utils]
   */

  /**
   * Tests connection to an expert by using minimalist deterministic payload.
   * Disables formatting, thinking budgets and streaming for fast response.
   */
  async testConnection(expertId) {
    const expert = await db.experts.get(expertId);
    if (!expert) throw new Error(`Expert not found: ${expertId}`);
    if (!expert.providerId) throw new Error(`Expert ${expertId} has no assigned provider.`);

    const provider = await db.providers.get(expert.providerId);
    if (!provider || !provider.baseUrl) throw new Error(`Invalid provider for expert ${expertId}`);

    const apiKey = await keyRotator.getNextKey(provider.id);

    const expertConfig = {
      baseUrl: provider.baseUrl,
      model: expert.modelName,
      apiKey: apiKey,
      format: getProviderFormat(provider),
      temperature: expert.temperature !== undefined && expert.temperature !== "" ? Number(expert.temperature) : 0.7,
      topP: expert.topP !== undefined && expert.topP !== "" ? Number(expert.topP) : 0.9,
      topK: expert.topK !== undefined && expert.topK !== "" ? Number(expert.topK) : 0,
      maxTokens: expert.maxTokens !== undefined && expert.maxTokens !== "" ? Number(expert.maxTokens) : 0,
      thinkingBudget: expert.thinkingBudget,
      stream: false,
      responseFormat: null,
      capabilities: provider.capabilities || {}
    };

    const messages = [{ role: 'user', content: 'Say "Hello"' }];
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    try {
      const response = await fetchChatCompletionAPI(expertConfig, messages, controller.signal);
      
      if (!response.ok) {
         const errorText = await response.text();
         throw new Error(`API Error: ${response.status} - ${errorText}`);
      }
      
      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Connection timed out during diagnostics');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Calls an expert LLM with given messages.
   * @param {string} expertId 
   * @param {Array<{role: string, content: string}>} messages 
   * @param {Function} [streamCallback] 
   */
  async callExpert(expertId, messages, streamCallback = null, params = {}) {
    let attempt = 0;
    const maxAttempts = 2; // Retry once on 429

    while (attempt < maxAttempts) {
      attempt++;
      let controller = null;
      let timeoutId = null;
      let hasStartedStreaming = false;
      let isInternalTimeout = false;

      try {
        const expert = await db.experts.get(expertId);
        if (!expert) throw new Error(`Expert not found: ${expertId}`);
        if (!expert.providerId) throw new Error(`Expert ${expertId} has no assigned provider.`);

        const provider = await db.providers.get(expert.providerId);
        if (!provider || !provider.baseUrl) throw new Error(`Invalid provider for expert ${expertId}`);

        controller = new AbortController();
        
        // Dynamically compute timeout: 
        // 1. If custom expert timeout is configured, use it.
        // 2. Otherwise safely adjust timeout for high-budget thinking models to prevent premature timeout.
        const expertTimeout = expert.timeout && expert.timeout > 0
          ? expert.timeout * 1005 // buffer slightly
          : (expert.thinkingBudget && (expert.thinkingBudget > 0 || expert.thinkingBudget === -1) ? 180000 : 60000);

        timeoutId = setTimeout(() => {
          isInternalTimeout = true;
          if (controller) controller.abort();
        }, expertTimeout);

        const apiKey = await keyRotator.getNextKey(provider.id);
        
        const fullMessages = [];
        let combinedSystemContent = "";

        // Combine any context system messages (e.g. from promptAssembler) FIRST
        for (const msg of messages) {
            if (msg.role === "system") {
                combinedSystemContent += (combinedSystemContent ? "\n\n" : "") + msg.content;
            }
        }

        if (combinedSystemContent) {
            fullMessages.push({ role: "system", content: combinedSystemContent });
        }

        // Add non-system messages
        for (const msg of messages) {
            if (msg.role !== "system") {
                fullMessages.push(msg);
            }
        }

        const { signal: customSignal } = params;

        let fetchSignal = controller.signal;
        let abortHandler = null;
        if (customSignal) {
            // If the browser supports AbortSignal.any, use it
            if (typeof AbortSignal !== 'undefined' && AbortSignal.any) {
                fetchSignal = AbortSignal.any([controller.signal, customSignal]);
            } else {
                // Fallback: mostly prefer the user's cancellation signal if provided
                abortHandler = () => {
                  if (controller) controller.abort();
                };
                customSignal.addEventListener('abort', abortHandler);
            }
        }

        const expertConfig = {
          baseUrl: provider.baseUrl,
          model: expert.modelName,
          apiKey: apiKey,
          format: getProviderFormat(provider),
          temperature: expert.temperature,
          topP: expert.topP,
          topK: expert.topK,
          maxTokens: expert.maxTokens,
          thinkingBudget: expert.thinkingBudget,
          stream: !!streamCallback,
          responseFormat: EXPERT_SCHEMAS[expert.id] || null,
          capabilities: provider.capabilities || {}
        };

        let response;
        try {
          response = await fetchChatCompletionAPI(expertConfig, fullMessages, fetchSignal);

          if (response.status === 429 && attempt < maxAttempts) {
            if (timeoutId) clearTimeout(timeoutId);
            if (abortHandler && customSignal) {
              customSignal.removeEventListener('abort', abortHandler);
            }
            controller.abort();
            controller = null;
            console.warn(`[ApiClient] 429 Rate limit hit, retrying...`);
            eventBus.emit('llm_retry', { attempt, maxAttempts, reason: 'RateLimit' });
            await sleepWithSignal(Math.min(1000 * Math.pow(2, attempt - 1), 30000), customSignal);
            continue;
          }

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error: ${response.status} - ${errorText}`);
          }

          if (streamCallback) {
            return await this._handleStream(
              response,
              (delta) => {
                hasStartedStreaming = true;
                streamCallback(delta);
              },
              () => {
                // Proper solution: Sliding window. Reset on every network chunk to prevent dropping valid streams while respecting stalls.
                if (timeoutId) clearTimeout(timeoutId);
                timeoutId = setTimeout(() => {
                  if (controller) controller.abort();
                }, expertTimeout);
              }
            );
          } else {
            const data = await response.json();
            return data.choices?.[0]?.message?.content || '';
          }
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
          if (abortHandler && customSignal) {
            customSignal.removeEventListener('abort', abortHandler);
          }
        }

      } catch (error) {
        if (timeoutId) clearTimeout(timeoutId);
        
        // Strict AbortError detection (native DOMException only)
        // This prevents native TypeErrors ("BodyStreamBuffer was aborted" due to network drops)
        // from being falsely swallowed as manual cancellations and bypassing the retry loop.
        const isAbortError = error.name === 'AbortError' || (error.message && error.message.includes('abort'));
        
        // Treat internal timeouts as network timeouts (allow retry).
        // Only throw if it's a manual cancellation (isInternalTimeout is false).
        if ((isAbortError && !isInternalTimeout) || hasStartedStreaming) {
          throw error;
        }
        if (attempt >= maxAttempts) {
          throw error;
        }
        console.warn(`[ApiClient] Error on attempt ${attempt}:`, error);
        eventBus.emit('llm_retry', { attempt, maxAttempts, reason: 'NetworkTimeout' });
        continue;
      }
    }
  }

  async _handleStream(response, streamCallback, onChunkRead = null) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullContentChunks = [];
    let buffer = '';

    try {
      while (true) {
        let value, done;
        try {
           const result = await reader.read();
           if (onChunkRead) onChunkRead();
           value = result.value;
           done = result.done;
        } catch (readError) {
           // Rescue partial responses on ANY stream read interruption
           // (whether manual AbortError or a network drop TypeError)
           if (fullContentChunks.length > 0) {
               console.warn("[ApiClient] Stream read interrupted but we have data. Rescuing partial response.", readError);
               break; 
           }
           throw readError;
        }
        
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        let match;
        // Trình phân tích luồng SSE State Machine: gom đủ khối dữ liệu kết thúc bằng \n\n hoặc \r\n\r\n
        while ((match = buffer.match(/\r?\n\r?\n/)) !== null) {
          const splitIndex = match.index;
          const matchLength = match[0].length;
          const chunk = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + matchLength);

          if (!chunk.trim()) continue;

          let currentEvent = 'message';
          let chunkDataParts = [];

          // Also support split by \n or \r\n
          const lines = chunk.split(/\r?\n/);
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            if (trimmedLine.startsWith('event:')) {
              currentEvent = trimmedLine.slice(6).trim();
            } else if (trimmedLine.startsWith('data:')) {
              chunkDataParts.push(trimmedLine.slice(5).trim());
            }
          }

          if (chunkDataParts.length > 0) {
            const cumulativeData = chunkDataParts.join('\n');
            if (cumulativeData === '[DONE]') continue;

            if (currentEvent === 'error') {
              console.error("[ApiClient] Received SSE error event:", cumulativeData);
              throw new Error(`SSE Event Error: ${cumulativeData}`);
            }

            if (currentEvent === 'ping') {
              continue;
            }

            try {
              const data = JSON.parse(cumulativeData);
              const delta = data.choices?.[0]?.delta?.content || '';
              if (delta) {
                fullContentChunks.push(delta);
                streamCallback(delta);
              }
            } catch (e) {
              console.warn("[ApiClient] Stream parse error on data:", cumulativeData, e);
            }
          }
        }
      }

      // Process any remaining chunk that didn't end with \n\n
      const finalChunk = buffer.trim();
      if (finalChunk) {
        let currentEvent = 'message';
        let chunkDataParts = [];
        const lines = finalChunk.split(/\r?\n/);
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          if (trimmedLine.startsWith('event:')) {
            currentEvent = trimmedLine.slice(6).trim();
          } else if (trimmedLine.startsWith('data:')) {
            chunkDataParts.push(trimmedLine.slice(5).trim());
          }
        }
        if (chunkDataParts.length > 0) {
          const cumulativeData = chunkDataParts.join('\n');
          if (cumulativeData !== '[DONE]' && currentEvent !== 'ping' && currentEvent !== 'error') {
            try {
              const data = JSON.parse(cumulativeData);
              const delta = data.choices?.[0]?.delta?.content || '';
              if (delta) {
                fullContentChunks.push(delta);
                streamCallback(delta);
              }
            } catch (e) {
              console.warn("[ApiClient] Stream parse error on final buffer:", cumulativeData, e);
            }
          } else if (currentEvent === 'error') {
            throw new Error(`SSE Event Error (final): ${cumulativeData}`);
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Stream already closed or errored - expected during abort
      }
    }

    return fullContentChunks.join('');
  }

  /**
   * Calls the embedding API.
   * Assumes Gemini endpoint based on Phase 2 & 4 instructions:
   * POST /v1beta/models/{model}:batchEmbedContents
   */
  async callEmbedding(expertId, texts, taskType = "RETRIEVAL_DOCUMENT", options = {}) {
    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
        attempt++;
        let controller = null;
        let timeoutId = null;
        let isInternalTimeout = false;

        try {
            const expert = await db.experts.get(expertId);
            if (!expert) throw new Error(`Expert not found: ${expertId}`);
            if (!expert.providerId) throw new Error(`Expert ${expertId} has no assigned provider.`);

            const provider = await db.providers.get(expert.providerId);
            if (!provider) throw new Error(`Invalid provider for expert ${expertId}`);
            
            controller = new AbortController();

            let fetchSignal = controller.signal;
            let abortHandler = null;
            if (options.signal) {
               if (typeof AbortSignal !== 'undefined' && AbortSignal.any) {
                   fetchSignal = AbortSignal.any([controller.signal, options.signal]);
               } else {
                   abortHandler = () => {
                     if (controller) controller.abort();
                   };
                   options.signal.addEventListener('abort', abortHandler);
               }
            }

            const expertTimeout = expert.timeout && expert.timeout > 0 ? expert.timeout * 1000 : 60000;
            timeoutId = setTimeout(() => {
              isInternalTimeout = true;
              if (controller) controller.abort();
            }, expertTimeout);

            const apiKey = await keyRotator.getNextKey(provider.id);
            const format = getProviderFormat(provider);

            const expertConfig = {
               baseUrl: provider.baseUrl,
               model: expert.modelName,
               apiKey: apiKey,
               format: format
            };

            let response;
            try {
              response = await fetchEmbeddingAPI(expertConfig, texts, taskType, fetchSignal);

              if (response.status === 429 && attempt < maxAttempts) {
                  if (timeoutId) clearTimeout(timeoutId);
                  if (options.signal && abortHandler) {
                     options.signal.removeEventListener('abort', abortHandler);
                  }
                  controller.abort();
                  controller = null;
                  console.warn(`[ApiClient] 429 Rate limit hit, retrying embedding...`);
                  await sleepWithSignal(Math.min(1000 * Math.pow(2, attempt - 1), 30000), options.signal);
                  continue;
              }

              if (!response.ok) {
                  const errorText = await response.text();
                  throw new Error(`Embedding API Error: ${response.status} - ${errorText}`);
              }

              const embeddingsResult = await parseEmbeddingResponse(response, format, provider.baseUrl);

              return {
                  embeddings: embeddingsResult
              };
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
              if (options.signal && abortHandler) {
                 options.signal.removeEventListener('abort', abortHandler);
              }
            }
        } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);
            
            // Stricter AbortError matching for embeddings to allow retries on transient anomalies
            const isAbortError = error.name === 'AbortError' || (error.message && error.message.includes('abort'));
            if (isAbortError && !isInternalTimeout) {
                throw error;
            }
            if (attempt >= maxAttempts) throw error;
            console.warn(`[ApiClient] Embedding Error on attempt ${attempt}:`, error);
            continue;
        }
    }
  }
}

export const apiClient = new ApiClient();
