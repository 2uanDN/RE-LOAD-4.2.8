/**
 * Extends the global Error object for application-specific validation errors.
 */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validates if a string is a valid HTTP(S) URL.
 * @param {string} url 
 * @returns {boolean}
 */
export function isValidProviderUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/**
 * Validates an API key (basic format, e.g. length and whitespace check).
 * @param {string} key 
 * @returns {boolean}
 */
export function isValidApiKey(key) {
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  // Allow any key that doesn't contain whitespace or newlines, and is at least 1 length.
  // This prevents blocking valid base64 keys or unusual provider formats.
  return trimmed.length > 0 && !/\s/.test(trimmed);
}

/**
 * Escapes characters that may cause HTML injection.
 * @param {string} unsafe 
 * @returns {string}
 */
export function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
