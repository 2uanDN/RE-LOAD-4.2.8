export function encodeVectorToBase64(vectorArray) {
  if (!vectorArray || vectorArray.length === 0) return null;
  const bytes = new Uint8Array(new Float32Array(vectorArray).buffer);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64ToVector(base64String) {
  if (!base64String) return [];
  const binary_string = atob(base64String);
  const len = binary_string.length;
  if (len % 4 !== 0) {
    throw new Error(`Invalid vector data: Expected byte length to be a multiple of 4, got ${len}`);
  }
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return Array.from(new Float32Array(bytes.buffer));
}
