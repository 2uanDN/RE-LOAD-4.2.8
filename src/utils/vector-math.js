/**
 * Calculates the magnitude (Euclidean norm) of a vector.
 */
export function vectorMagnitude(v) {
  return Math.sqrt(v.reduce((sum, val) => sum + val * val, 0));
}

/**
 * Calculates the dot product of two vectors.
 */
export function dotProduct(a, b) {
  if (a.length !== b.length) throw new Error("Vectors must be same length");
  return a.reduce((sum, val, i) => sum + val * b[i], 0);
}

/**
 * Normalizes a vector to a unit vector.
 */
export function normalizeVector(v) {
  const mag = vectorMagnitude(v);
  if (mag === 0) return new Float32Array(v);
  const arr = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    arr[i] = v[i] / mag;
  }
  return arr;
}

/**
 * Calculates the cosine similarity between two vectors.
 * Assumes vectors are already normalized (L2 norm = 1) for performance,
 * which is true for Google Gemini embedding models.
 * Returns a value between -1 and 1.
 */
export function cosineSimilarity(a, b) {
  return dotProduct(a, b);
}
