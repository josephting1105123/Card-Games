/**
 * Move generation for Big Two.
 *
 * Unlike Dou Di Zhu, Big Two has exactly four play shapes (single, pair,
 * triple, five-card hand) and a hand never exceeds 13 cards, so there is no
 * need for doudizhu/moves.js's per-shape combinatorial builders: every
 * candidate play is some k-card subset of the hand for k in {1, 2, 3, 5}, and
 * classify() alone decides whether that subset is legal. C(13, 5) is 1287, so
 * brute-forcing every subset of the largest possible hand and letting
 * classify() sort the legal ones from the rest is both simpler and cheap
 * enough to run on every bot decision.
 *
 * Complexity: O(C(n,1) + C(n,2) + C(n,3) + C(n,5)) subsets classified, each in
 * O(1) (5 cards at most) — a few thousand classify() calls worst case (n=13
 * leading), far fewer once responding to a fixed size or once the hand has
 * shrunk.
 */

import { beats, classify, fiveCardStrength } from './rules.js';

/** Every k-card subset of `arr`, as arrays in hand order. O(C(n,k)). */
function* combinations(arr, k) {
  const n = arr.length;
  if (k > n || k < 0) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i -= 1;
    if (i < 0) return;
    idx[i] += 1;
    for (let j = i + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
  }
}

const LEAD_SIZES = [1, 2, 3, 5];

/**
 * Every play in `hand` that legally answers `current`. A null `current` means
 * leading, so every shape is considered rather than just one size.
 * @param {object[]} hand
 * @param {{type: string, size: number, key: number}|null} [current]
 * @param {{mustInclude?: number|null}} [opts] mustInclude restricts the result
 *   to plays that contain a specific card id — the 3♦ opening rule.
 * @returns {object[]} combos, as returned by classify()
 */
export function legalPlays(hand, current = null, opts = {}) {
  const mustInclude = opts.mustInclude ?? null;
  const sizes = current ? [current.size] : LEAD_SIZES;
  const out = [];
  for (const size of sizes) {
    if (hand.length < size) continue;
    for (const subset of combinations(hand, size)) {
      if (mustInclude != null && !subset.some((card) => card.id === mustInclude)) continue;
      const combo = classify(subset);
      if (!combo) continue;
      if (current && !beats(combo, current)) continue;
      out.push(combo);
    }
  }
  return out;
}

/** 0 for single/pair/triple, the five-card ladder position for a 5-card hand. */
function shapeStrength(combo) {
  return combo.size === 5 ? fiveCardStrength(combo.type) : 0;
}

/**
 * Every legal play, weakest first — for cycling the Hint button. Ordered by
 * size (a single commits less than a five-card hand), then, within a size, by
 * where the five-card type sits on its ladder, then by key. This is a display
 * ordering for the player, not a legality rule, so ties are broken only well
 * enough to be stable.
 * @param {object[]} hand
 * @param {object|null} [current]
 * @param {object} [opts]
 * @returns {object[]}
 */
export function findHints(hand, current = null, opts = {}) {
  const moves = legalPlays(hand, current, opts);
  return moves.sort((a, b) => (a.size - b.size) || (shapeStrength(a) - shapeStrength(b)) || (a.key - b.key));
}

/**
 * Sanity check used by the tests: every generated move must survive
 * classify() as the type and size the generator claims.
 */
export function verifyMove(move) {
  const info = classify(move.cards);
  return !!info && info.type === move.type && info.size === move.size && info.key === move.key;
}
