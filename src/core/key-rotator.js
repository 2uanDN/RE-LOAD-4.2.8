import { db } from './db.js';

class KeyRotator {
  /**
   * Get the next API key for a provider based on round-robin.
   * Increments the internal index for the next call.
   * @param {string} providerId 
   * @returns {Promise<string>}
   */
  async getNextKey(providerId) {
    let currentKey;
    await db.transaction('rw', db.providers, async () => {
      const provider = await db.providers.get(providerId);
      if (!provider || !provider.keys || provider.keys.length === 0) {
        throw new Error(`No keys available for provider: ${providerId}`);
      }

      const keyIndex = provider.keyIndex || 0;
      currentKey = provider.keys[keyIndex % provider.keys.length];

      // Increment and modulo safely
      const nextIndex = (keyIndex + 1) % provider.keys.length;
      
      // Update the index in DB for next run
      await db.providers.update(providerId, { keyIndex: nextIndex });
    });
    
    if (currentKey === 'ENV_API_KEY') {
      const envKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
      if (!envKey) {
        throw new Error("Missing process.env.API_KEY in environment. Check .env configuration.");
      }
      return envKey;
    }

    return currentKey;
  }
}

const keyRotator = new KeyRotator();
export { keyRotator };
