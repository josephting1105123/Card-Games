/**
 * Deterministic pseudo-random number generation.
 *
 * Every shuffle and every bot decision draws from a seeded generator so that a
 * game can be replayed exactly from its seed. That matters for two things:
 * reproducing bug reports, and keeping the LAN server authoritative (the server
 * deals, clients never need to agree on randomness).
 *
 * mulberry32: 32-bit state, one multiply-xor-shift round per draw. O(1) per
 * call, period 2^32. Good enough for card games, not for anything security
 * related.
 */

/** @typedef {() => number} Rng A function returning a float in [0, 1). */

/**
 * @param {number|string} seed
 * @returns {Rng}
 */
export function makeRng(seed) {
  let state = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
  if (state === 0) state = 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, 32-bit. O(n) in string length. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Random integer in [0, max). */
export function randInt(rng, max) {
  return Math.floor(rng() * max);
}

/** Pick one element. Returns undefined for an empty array. */
export function pick(rng, arr) {
  return arr.length ? arr[randInt(rng, arr.length)] : undefined;
}

/**
 * Fisher-Yates, in place. O(n) time, O(1) extra space, uniform over all n!
 * permutations given a uniform source.
 * @template T
 * @param {T[]} arr
 * @param {Rng} rng
 * @returns {T[]} the same array
 */
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** A short, human-typeable seed. */
export function randomSeed() {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Weighted choice. weights need not be normalised; negative weights are
 * clamped to 0. O(n).
 * @template T
 * @param {Rng} rng
 * @param {T[]} items
 * @param {number[]} weights
 */
export function weightedPick(rng, items, weights) {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return pick(rng, items);
  let roll = rng() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= Math.max(0, weights[i]);
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}
