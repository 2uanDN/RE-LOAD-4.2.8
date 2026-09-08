import { eventBus } from '../core/event-bus.js';
import { EVENTS } from '../core/events.js';

const TASK_CONFIG = {
  // FAST Tasks: CPU-only, or very fast local operations (Increased timeouts for Vite dev cold-start)
  COUNT_TOKENS:           { category: 'FAST', timeout: 60000 },
  BATCH_COUNT_TOKENS:     { category: 'FAST', timeout: 60000 },
  BUILD_PROMPT:           { category: 'FAST', timeout: 60000 },
  INIT_ORAMA:             { category: 'FAST', timeout: 60000 },
  ADD_TO_ORAMA:           { category: 'FAST', timeout: 60000 },
  RETRIEVE_AND_RANK:      { category: 'FAST', timeout: 60000 },
  INIT_KB_ORAMA:          { category: 'FAST', timeout: 60000 },
  ADD_TO_KB_ORAMA:        { category: 'FAST', timeout: 60000 },
  UPDATE_KB_ORAMA:        { category: 'FAST', timeout: 60000 },
  RETRIEVE_AND_RANK_KB:   { category: 'FAST', timeout: 60000 },

  // SLOW Tasks: Async operations hitting external APIS with retries/backoffs
  EMBED_TEXTS:            { category: 'SLOW', timeout: 60000 },
  CHUNK_AND_EMBED:        { category: 'SLOW', timeout: 120000 },
  BATCH_CHUNK_AND_EMBED:  { category: 'SLOW', timeout: 300000 },
  CHUNK_KB_AND_EMBED:     { category: 'SLOW', timeout: 300000 },
  CHUNK_KB_FAST:          { category: 'SLOW', timeout: 300000 },
  
  // Magic Number Context: 180000ms (3 mins) accounts for LLM generation times with complex reasoning models (e.g. Gemini 1.5 Pro) on maximum output length tasks.
  SUMMARIZE_A1:           { category: 'SLOW', timeout: 180000 },
  SUMMARIZE_A2:           { category: 'SLOW', timeout: 180000 },
  SUMMARIZE_A3:           { category: 'SLOW', timeout: 180000 },
};

class WorkerBridge {
  constructor() {
    this.pendingRequests = new Map();
    this.queue = [];
    this.activeCounts = {
      FAST: 0,
      SLOW: 0
    };
    this.limits = {
      FAST: 50,  // Fast tasks can overwhelm if unbounded memory, but generally shouldn't queue long.
      SLOW: 5    // Strict limit on concurrent API calls / heavy task processing
    };
    this.initWorker();
  }

  initWorker() {
    if (this.worker) {
      this.worker.terminate();
    }
    this.worker = new Worker(new URL('./memory.worker.js', import.meta.url), { type: 'module' });
    this.listen();
  }

  listen() {
    this.worker.addEventListener('message', (e) => {
      const { type, requestId, result, error, payload } = e.data;
      
      if (type === 'SYNC_SNAPSHOT') {
        eventBus.emit(EVENTS.ORAMA_SYNC_SNAPSHOT, { buffer: payload, sessionId: e.data.sessionId });
        return;
      }
      
      if (type === 'SYNC_KB_SNAPSHOT') {
        eventBus.emit(EVENTS.ORAMA_SYNC_KB_SNAPSHOT, { buffer: payload, sessionId: e.data.sessionId });
        return;
      }
      
      if (this.pendingRequests.has(requestId)) {
        const { resolve, reject, timeoutId, category, type: taskType } = this.pendingRequests.get(requestId);
        clearTimeout(timeoutId);
        this.pendingRequests.delete(requestId);
        if (category && this.activeCounts[category] > 0) {
          this.activeCounts[category]--;
        }

        if (type === 'SUCCESS') {
          if (category === 'FAST') console.timeEnd(`${taskType}_${requestId}`);
          resolve(result);
        } else {
          if (category === 'FAST') console.timeEnd(`${taskType}_${requestId}`);
          reject(new Error(error || 'Worker task failed'));
        }
        this.processWorkerQueue();
      }
    });

    this.worker.addEventListener('error', (err) => {
      console.error("Worker crashed:", err);
      this.rejectAll(new Error("Worker crashed"));
      this.initWorker();
      eventBus.emit(EVENTS.WORKER_RESTARTED);
    });
  }

  rejectAll(error) {
    for (const [requestId, task] of this.pendingRequests.entries()) {
      clearTimeout(task.timeoutId);
      task.reject(error);
    }
    this.pendingRequests.clear();
    this.queue.forEach(task => task.reject(error));
    this.queue = [];
    this.activeCounts = { FAST: 0, SLOW: 0 };
  }

  postRequest(type, payload, options = {}) {
    return new Promise((resolve, reject) => {
      let givenTimeoutMs = null;
      let signal = null;
      
      if (typeof options === 'number') {
        givenTimeoutMs = options;
      } else if (options) {
        givenTimeoutMs = options.timeoutMs;
        signal = options.signal;
      }

      // Magic Number Context: 180000ms is the default 3-minute timeout for untyped slow tasks.
      const config = TASK_CONFIG[type] || { category: 'SLOW', timeout: 180000 };
      const timeoutMs = givenTimeoutMs || config.timeout;
      const category = config.category;

      const requestId = crypto.randomUUID();
      const queuedAt = Date.now();
      
      const abortHandler = () => {
         if (signal) signal.removeEventListener('abort', abortHandler);
         if (this.pendingRequests.has(requestId)) {
            const task = this.pendingRequests.get(requestId);
            clearTimeout(task.timeoutId);
            this.pendingRequests.delete(requestId);
            if (this.activeCounts[category] > 0) {
               this.activeCounts[category]--;
            }
            if (this.worker) {
               try {
                 this.worker.postMessage({ type: 'CANCEL_TASK', requestId: requestId });
               } catch(e) {}
            }
            reject(new DOMException('Aborted', 'AbortError'));
            this.processWorkerQueue();
         } else {
            // Task is in queue but not started yet
            const idx = this.queue.findIndex(t => t.requestId === requestId);
            if (idx !== -1) {
               this.queue.splice(idx, 1);
               reject(new DOMException('Aborted', 'AbortError'));
            }
         }
      };
      
      if (signal) {
        if (signal.aborted) {
           return reject(new DOMException('Aborted', 'AbortError'));
        }
        signal.addEventListener('abort', abortHandler);
      }

      const cleanUpAndResolve = (res) => {
         if (signal) signal.removeEventListener('abort', abortHandler);
         resolve(res);
      };
      const cleanUpAndReject = (err) => {
         if (signal) signal.removeEventListener('abort', abortHandler);
         reject(err);
      };

      this.queue.push({ type, payload, timeoutMs, category, requestId, resolve: cleanUpAndResolve, reject: cleanUpAndReject, queuedAt });
      this.processWorkerQueue();
    });
  }
  
  processWorkerQueue() {
    // Pick tasks from the queue based on their category limits, prioritizing FAST tasks
    // Prevent starvation: move the starved SLOW task to the front of the queue
    const now = Date.now();
    
    const starvedIdx = this.queue.findIndex(t => t.category === 'SLOW' && (now - t.queuedAt > 30000));
    if (starvedIdx !== -1) {
      const stavedTask = this.queue.splice(starvedIdx, 1)[0];
      this.queue.unshift(stavedTask);
    }

    const processOrder = ['FAST', 'SLOW'];

    for (const category of processOrder) {
      for (let i = 0; i < this.queue.length; i++) {
        const task = this.queue[i];
        if (task.category === category && this.activeCounts[category] < this.limits[category]) {
          this.queue.splice(i, 1);
          this._startTask(task);
          i--; // adjust index after removal
        }
      }
    }
  }

  _startTask(task) {
    this.activeCounts[task.category]++;
    
    const timeoutId = setTimeout(() => {
      if (this.pendingRequests.has(task.requestId)) {
        this.pendingRequests.delete(task.requestId);
        if (this.activeCounts[task.category] > 0) {
           this.activeCounts[task.category]--;
        }

        try {
          if (this.worker) {
            this.worker.postMessage({ type: 'CANCEL_TASK', requestId: task.requestId });
          }
        } catch (e) {
          console.error("Worker cancel postMessage failed:", e);
        }

        task.reject(new Error(`Worker request ${task.type} timed out after ${task.timeoutMs}ms`));
        this.processWorkerQueue();
      }
    }, task.timeoutMs);

    this.pendingRequests.set(task.requestId, { ...task, timeoutId });

    if (task.category === 'FAST') {
      console.time(`${task.type}_${task.requestId}`);
    }

    if (task.type === 'BUILD_PROMPT') {
      console.log(`[WorkerBridge] Sending BUILD_PROMPT to worker, requestId: ${task.requestId}`);
    }

    try {
      this.worker.postMessage({
        type: task.type,
        requestId: task.requestId,
        payload: task.payload
      });
    } catch (e) {
      console.error("Worker postMessage failed:", e);
      clearTimeout(timeoutId);
      this.pendingRequests.delete(task.requestId);
      if (this.activeCounts[task.category] > 0) {
         this.activeCounts[task.category]--;
      }
      task.reject(new Error(`Worker postMessage failed: ${e.message}`));
      this.processWorkerQueue();
    }
  }
  
  // Expose API Methods
  summarizeA1(payload) { return this.postRequest('SUMMARIZE_A1', payload); }
  summarizeA2(payload) { return this.postRequest('SUMMARIZE_A2', payload); }
  summarizeA3(payload) { return this.postRequest('SUMMARIZE_A3', payload); }
  embedTexts(payload)  { return this.postRequest('EMBED_TEXTS', payload); }
  dispatch(type, payload, options) { return this.postRequest(type, payload, options); }
}

const workerBridge = new WorkerBridge();
export { workerBridge };
