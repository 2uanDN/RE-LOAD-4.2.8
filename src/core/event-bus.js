/**
 * EventBus - A robust, high-performance event publisher-subscriber system.
 * 
 * Features defensive architecture to guarantee zero memory leaks:
 * 1. Optional subscription ownership linking via `owner`.
 * 2. Automatic dead-listener sweeping during event emission using `WeakRef`.
 * 3. Deterministic batch cleanup via `.offAll(owner)`.
 * 4. Inline, zero-boilerplate unsubscription handles returned on registration.
 */
class EventBus {
  constructor() {
    this.listeners = {};
    
    // Periodically sweep dead WeakRefs to alleviate GC pressure instead of doing it during high-frequency emits
    this._sweepTimer = setInterval(() => this._sweepDeadRefs(), 30000);
  }

  /**
   * Cleans up the EventBus instance, stopping the periodic sweep timer.
   */
  destroy() {
    clearInterval(this._sweepTimer);
    this.clear();
  }

  _sweepDeadRefs() {
    for (const event of Object.keys(this.listeners)) {
      this.listeners[event] = this.listeners[event].filter(listener => {
        if (listener.ownerRef && listener.ownerRef.deref() === undefined) {
          listener.unsubscribed = true; // Protect in-flight emit loops
          return false;
        }
        return true;
      });
      if (this.listeners[event].length === 0) {
        delete this.listeners[event];
      }
    }
  }

  /**
   * Subscribe to an event.
   * @param {string} event - Unique namespace/type of the event.
   * @param {function} callback - Callable executed when the event is emitted.
   * @param {object} [owner=null] - Optional owner reference for automatic/batch lifecycle management.
   * @returns {function} Cleanup function that unregisters this specific callback on call.
   */
  on(event, callback, owner = null, _isOnce = false) {
    if (typeof callback !== 'function') {
      throw new Error(`[EventBus] Callback must be a function. Received: ${typeof callback}`);
    }

    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }

    const listenerObj = {
      callback,
      ownerRef: owner ? new WeakRef(owner) : null,
      isOnce: _isOnce
    };

    this.listeners[event].push(listenerObj);

    // Return self-contained cleanup routine for single-line inline usage
    return () => {
      if (listenerObj.unsubscribed) return;
      if (!this.listeners[event]) return;
      listenerObj.unsubscribed = true; // Protect in-flight emit loops
      this.listeners[event] = this.listeners[event].filter(l => l !== listenerObj);
      if (this.listeners[event].length === 0) {
        delete this.listeners[event];
      }
    };
  }

  /**
   * Subscribe to an event that only triggers once.
   * @param {string} event - Unique namespace/type of the event.
   * @param {function} callback - Callable executed once.
   * @param {object} [owner=null] - Optional owner reference.
   * @returns {function} Cleanup function.
   */
  once(event, callback, owner = null) {
    if (!owner) {
      console.warn(`[EventBus] once() called without an owner for event '${event}'. This creates a potential memory leak if the event never fires. Provide an owner to enable automatic lifecycle sweeping.`);
    }
    return this.on(event, callback, owner, true);
  }

  /**
   * Unsubscribe a specific callback from an event.
   * @param {string} event - Unique namespace/type of the event.
   * @param {function} callback - Callback instance to remove.
   */
  off(event, callback) {
    if (!this.listeners[event]) return;
    
    // Find and mark as unsubscribed for in-flight emit loops referring to the old array
    for (let i = 0; i < this.listeners[event].length; i++) {
        if (this.listeners[event][i].callback === callback) {
            this.listeners[event][i].unsubscribed = true;
        }
    }

    this.listeners[event] = this.listeners[event].filter(
      listener => listener.callback !== callback
    );
    if (this.listeners[event].length === 0) {
      delete this.listeners[event];
    }
  }

  /**
   * Bulk-unregister all listeners bound to a specific owner object.
   * Provides deterministic cleanup when components/managers are destroyed.
   * @param {object} owner - The object instance that previously subscribed to events.
   */
  offAll(owner) {
    if (!owner) return;

    for (const event of Object.keys(this.listeners)) {
      this.listeners[event] = this.listeners[event].filter(listener => {
        if (listener.ownerRef) {
          const derefOwner = listener.ownerRef.deref();
          // Remove if it matches the requested owner or if the owner was already garbage collected
          if (derefOwner === owner || derefOwner === undefined) {
             listener.unsubscribed = true;
             return false;
          }
        }
        return true;
      });
      if (this.listeners[event].length === 0) {
        delete this.listeners[event];
      }
    }
  }

  /**
   * Emit an event triggering all registered listeners.
   * @param {string} event - Unique namespace/type of the event.
   * @param {any} [payload] - Parameters to forward to listeners.
   */
  emit(event, payload) {
    const activeListeners = this.listeners[event];
    if (!activeListeners) return;

    // Cache length to prevent Ghost Call Trigger if new listeners are appended during loop
    const limit = activeListeners.length;
    let hasOnce = false;

    for (let i = 0; i < limit; i++) {
      const listener = activeListeners[i];
      if (listener.unsubscribed) continue;

      if (listener.isOnce) {
        listener.unsubscribed = true;
        hasOnce = true;
      }

      try {
        const result = listener.callback(payload);
        
        // Gracefully handle rejection of promise-returning event handlers
        if (result && typeof result.then === 'function') {
          result.catch(err => {
            console.error(`[EventBus] Async error in event listener for [${event}]:`, err);
          });
        }
      } catch (err) {
        console.error(`[EventBus] Synchronous error in event listener for [${event}]:`, err);
      }
    }

    if (hasOnce && this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(l => !l.unsubscribed);
      if (this.listeners[event].length === 0) {
        delete this.listeners[event];
      }
    }
  }

  /**
   * Standard reset of internal registry. Useful for unit tests or application reset.
   */
  clear() {
    this.listeners = {};
  }
}

// Global Singleton Application Event Bus
const eventBus = new EventBus();
export { eventBus };
