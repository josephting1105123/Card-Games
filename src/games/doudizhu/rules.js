/**
 * Dou Di Zhu (斗地主) combination rules — the default ("classic") rule set.
 *
 * Pure data in, pure data out: no DOM, no randomness. The browser and the LAN
 * server both import this file, so a move the client thinks is legal is the same
 * move the server accepts.
 *
 * Rank order: 3 < 4 < ... < 10 < J < Q < K < A < 2 < small joker < big joker.
 * Chains (straights, pair chains, trio chains) may not pass A: 2 and the jokers
 * never take part in a chain.
 *
 * Complexity: classify() is O(n log n) for the sort plus O(r) over the 15
 * distinct ranks, except for trio-chain-with-wings which scans candidate chain
 * positions, O(r * k) worst case. n <= 20, r <= 15, so all of it is trivial.
 */

import {
  RANK_CHAIN_MAX,
  RANK_JOKER_BIG,
  RANK_JOKER_SMALL,
  countByRank,
  rankLabel,
  sortCardsAsc,
} from '../../core/cards.js';

export const Combo = {
  SINGLE: 'single',
  PAIR: 'pair',
  TRIO: 'trio',
  TRIO_SINGLE: 'trio_single',
  TRIO_PAIR: 'trio_pair',
  STRAIGHT: 'straight',
  PAIR_CHAIN: 'pair_chain',
  TRIO_CHAIN: 'trio_chain',
  TRIO_CHAIN_SINGLES: 'trio_chain_singles',
  TRIO_CHAIN_PAIRS: 'trio_chain_pairs',
  FOUR_TWO: 'four_two',
  FOUR_TWO_PAIRS: 'four_two_pairs',
  BOMB: 'bomb',
  ROCKET: 'rocket',
};

const COMBO_NAMES = {
  [Combo.SINGLE]: { en: 'Single', zh: '单张' },
  [Combo.PAIR]: { en: 'Pair', zh: '对子' },
  [Combo.TRIO]: { en: 'Trio', zh: '三不带' },
  [Combo.TRIO_SINGLE]: { en: 'Trio + single', zh: '三带一' },
  [Combo.TRIO_PAIR]: { en: 'Trio + pair', zh: '三带二' },
  [Combo.STRAIGHT]: { en: 'Straight', zh: '顺子' },
  [Combo.PAIR_CHAIN]: { en: 'Pair chain', zh: '连对' },
  [Combo.TRIO_CHAIN]: { en: 'Aeroplane', zh: '飞机' },
  [Combo.TRIO_CHAIN_SINGLES]: { en: 'Aeroplane + wings', zh: '飞机带翅' },
  [Combo.TRIO_CHAIN_PAIRS]: { en: 'Aeroplane + pairs', zh: '飞机带对' },
  [Combo.FOUR_TWO]: { en: 'Four + two', zh: '四带二' },
  [Combo.FOUR_TWO_PAIRS]: { en: 'Four + two pairs', zh: '四带两对' },
  [Combo.BOMB]: { en: 'Bomb', zh: '炸弹' },
  [Combo.ROCKET]: { en: 'Rocket', zh: '王炸' },
};

/**
 * @typedef {object} ComboInfo
 * @property {string} type    one of Combo.*
 * @property {number} rank    the rank a comparison is made on (top of a chain,
 *                            the trio's rank, the four's rank)
 * @property {number} length  number of linked groups (chain length), else 1
 * @property {number} size    number of cards
 * @property {boolean} bomb   true for bombs and the rocket
 * @property {object[]} cards the cards, ascending
 */

/**
 * Identify what a set of cards is, or null when it is not a legal combination.
 * @param {object[]} input
 * @returns {ComboInfo|null}
 */
export function classify(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  // The server classifies whatever a client sends, so refuse a set that repeats
  // a card before reading any pattern into it.
  const seen = new Set();
  for (const card of input) {
    if (!card || typeof card.rank !== 'number' || seen.has(card.id)) return null;
    seen.add(card.id);
  }
  const cards = sortCardsAsc(input);
  const n = cards.length;
  const counts = countByRank(cards);
  const ranks = [...counts.keys()].sort((a, b) => a - b);
  /** ranks grouped by how many copies are held */
  const byCount = new Map();
  for (const [rank, c] of counts) {
    if (!byCount.has(c)) byCount.set(c, []);
    byCount.get(c).push(rank);
  }
  for (const list of byCount.values()) list.sort((a, b) => a - b);
  const only = (c) => byCount.size === 1 && byCount.has(c);
  const made = (type, rank, length) => ({ type, rank, length, size: n, bomb: type === Combo.BOMB || type === Combo.ROCKET, cards });

  if (n === 1) return made(Combo.SINGLE, ranks[0], 1);

  if (n === 2) {
    if (counts.get(RANK_JOKER_SMALL) === 1 && counts.get(RANK_JOKER_BIG) === 1) {
      return made(Combo.ROCKET, RANK_JOKER_BIG, 1);
    }
    return only(2) ? made(Combo.PAIR, ranks[0], 1) : null;
  }

  if (n === 3) return only(3) ? made(Combo.TRIO, ranks[0], 1) : null;

  if (n === 4) {
    if (only(4)) return made(Combo.BOMB, ranks[0], 1);
    if (byCount.size === 2 && byCount.get(3)?.length === 1 && byCount.get(1)?.length === 1) {
      return made(Combo.TRIO_SINGLE, byCount.get(3)[0], 1);
    }
    return null;
  }

  if (n === 5 && byCount.size === 2 && byCount.get(3)?.length === 1 && byCount.get(2)?.length === 1) {
    return made(Combo.TRIO_PAIR, byCount.get(3)[0], 1);
  }

  // Four with two loose cards (either two singles or one pair) / with two pairs.
  if (byCount.get(4)?.length === 1) {
    const four = byCount.get(4)[0];
    const restCount = n - 4;
    const restRanks = ranks.filter((r) => r !== four);
    if (restCount === 2 && restRanks.every((r) => counts.get(r) <= 2)) {
      return made(Combo.FOUR_TWO, four, 1);
    }
    if (restCount === 4 && restRanks.length === 2 && restRanks.every((r) => counts.get(r) === 2)) {
      return made(Combo.FOUR_TWO_PAIRS, four, 1);
    }
  }

  // Straight: five or more single, consecutive, 3 through A.
  if (n >= 5 && only(1) && isConsecutive(ranks) && ranks[n - 1] <= RANK_CHAIN_MAX) {
    return made(Combo.STRAIGHT, ranks[n - 1], n);
  }

  // Pair chain: three or more consecutive pairs.
  if (n >= 6 && n % 2 === 0 && only(2) && isConsecutive(ranks) && ranks[ranks.length - 1] <= RANK_CHAIN_MAX) {
    return made(Combo.PAIR_CHAIN, ranks[ranks.length - 1], ranks.length);
  }

  // Aeroplane: two or more consecutive trios, no wings.
  if (n >= 6 && n % 3 === 0 && only(3) && isConsecutive(ranks) && ranks[ranks.length - 1] <= RANK_CHAIN_MAX) {
    return made(Combo.TRIO_CHAIN, ranks[ranks.length - 1], ranks.length);
  }

  const withSingles = classifyTrioChainWings(cards, counts, 1);
  if (withSingles) return made(Combo.TRIO_CHAIN_SINGLES, withSingles.top, withSingles.length);
  const withPairs = classifyTrioChainWings(cards, counts, 2);
  if (withPairs) return made(Combo.TRIO_CHAIN_PAIRS, withPairs.top, withPairs.length);

  return null;
}

/**
 * Aeroplane with wings. `wingSize` is 1 for single wings, 2 for pair wings.
 * Tries every consecutive run of candidate trios of the required length and
 * returns the highest-topped valid reading, since a higher reading is never
 * worse for the player and both readings use the same cards.
 */
function classifyTrioChainWings(cards, counts, wingSize) {
  const n = cards.length;
  const unit = 3 + wingSize;
  if (n % unit !== 0) return null;
  const k = n / unit;
  if (k < 2) return null;

  const candidates = [...counts.keys()].filter((r) => counts.get(r) >= 3 && r <= RANK_CHAIN_MAX).sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i + k <= candidates.length; i++) {
    const run = candidates.slice(i, i + k);
    if (!isConsecutive(run)) continue;
    const leftover = new Map(counts);
    for (const r of run) {
      const remaining = leftover.get(r) - 3;
      if (remaining > 0) leftover.set(r, remaining);
      else leftover.delete(r);
    }
    let cardsLeft = 0;
    let ok = true;
    for (const c of leftover.values()) {
      cardsLeft += c;
      if (wingSize === 1 && c >= 3) ok = false;
      if (wingSize === 2 && c !== 2) ok = false;
    }
    if (!ok || cardsLeft !== k * wingSize) continue;
    if (wingSize === 2 && leftover.size !== k) continue;
    const top = run[run.length - 1];
    if (!best || top > best.top) best = { top, length: k };
  }
  return best;
}

function isConsecutive(sortedRanks) {
  for (let i = 1; i < sortedRanks.length; i++) {
    if (sortedRanks[i] !== sortedRanks[i - 1] + 1) return false;
  }
  return true;
}

/**
 * Does `candidate` legally answer `current`? A null `current` means the player
 * is leading, so anything legal goes.
 * @param {ComboInfo|null} candidate
 * @param {ComboInfo|null} current
 */
export function beats(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.type === Combo.ROCKET) return current.type !== Combo.ROCKET;
  if (current.type === Combo.ROCKET) return false;
  if (candidate.type === Combo.BOMB) {
    return current.type === Combo.BOMB ? candidate.rank > current.rank : true;
  }
  if (current.type === Combo.BOMB) return false;
  return candidate.type === current.type && candidate.length === current.length && candidate.rank > current.rank;
}

/** Bombs and the rocket double the stake. */
export function comboMultiplier(combo) {
  return combo && combo.bomb ? 2 : 1;
}

export function comboName(type, lang = 'en') {
  return COMBO_NAMES[type]?.[lang] ?? type;
}

/** Human-readable description, e.g. "Straight of 5, high card 7". */
export function describeCombo(combo, lang = 'en') {
  if (!combo) return lang === 'zh' ? '不要' : 'Pass';
  const name = comboName(combo.type, lang);
  if (combo.type === Combo.ROCKET) return name;
  const top = rankLabel(combo.rank);
  if (combo.length > 1) return `${name} ×${combo.length} (${top} high)`;
  return `${name} ${top}`;
}
