/**
 * Big Two (锄大地) combination rules.
 *
 * Pure data in, pure data out: no DOM, no randomness, so the same file runs in
 * the browser and on the LAN host, same as doudizhu/rules.js.
 *
 * Rank order matches core/cards.js exactly (3..10, J=11, Q=12, K=13, A=14,
 * 2=15) — Big Two's "3 < 4 < ... < K < A < 2" is already how that file numbers
 * ranks, so nothing needs remapping here except a suit order, which
 * core/cards.js deliberately does not define (Dou Di Zhu never ranks suits).
 *
 * Straights are the one place the rank ladder is not just "5 consecutive
 * numbers": A2345 is the lowest straight (ace plays low) and JQKA2 is the
 * highest (two plays as "one past ace"), but nothing wraps twice — QKA23 and
 * KA234 are not straights. STRAIGHT_WINDOWS lists the eleven legal five-card
 * windows explicitly, because the rule is a user-confirmed enumerated list,
 * not a formula to derive and risk getting subtly wrong.
 */

import { groupByRank, rankLabel } from '../../core/cards.js';

/** Big Two's own suit order; core/cards.js has no opinion on suit ranking. */
export const SUIT_ORDER = ['diamond', 'club', 'heart', 'spade'];

/** rank*4 + suit index. Comparing two cards' values alone tells you which wins. */
export function cardValue(card) {
  return card.rank * 4 + SUIT_ORDER.indexOf(card.suit);
}

export const Combo = {
  SINGLE: 'single',
  PAIR: 'pair',
  TRIPLE: 'triple',
  STRAIGHT: 'straight',
  FLUSH: 'flush',
  FULL_HOUSE: 'full_house',
  FOUR_KIND: 'four_kind',
  STRAIGHT_FLUSH: 'straight_flush',
};

const COMBO_NAMES = {
  [Combo.SINGLE]: 'Single',
  [Combo.PAIR]: 'Pair',
  [Combo.TRIPLE]: 'Triple',
  [Combo.STRAIGHT]: 'Straight',
  [Combo.FLUSH]: 'Flush',
  [Combo.FULL_HOUSE]: 'Full house',
  [Combo.FOUR_KIND]: 'Four of a kind',
  [Combo.STRAIGHT_FLUSH]: 'Straight flush',
};

/** Five-card hands only ever compare within this ladder; see beats(). */
const FIVE_CARD_RANK = {
  [Combo.STRAIGHT]: 0,
  [Combo.FLUSH]: 1,
  [Combo.FULL_HOUSE]: 2,
  [Combo.FOUR_KIND]: 3,
  [Combo.STRAIGHT_FLUSH]: 4,
};

/** Where a five-card type sits on the straight < flush < ... < straight flush ladder. */
export function fiveCardStrength(type) {
  return FIVE_CARD_RANK[type] ?? -1;
}

/**
 * The eleven straight windows, lowest to highest, written as their actual
 * rank values (A=14, 2=15) so this table reads the same as the spec's own
 * notation. `top` is the sequence's *displayed* top card — 5 for A2345, 2
 * (rank 15) for JQKA2 — which is what a tie between two straights is broken
 * on by suit; it is not always the numerically highest rank in the window
 * (A2345 also holds the ace and two, both numerically above its own "top").
 */
export const STRAIGHT_WINDOWS = [
  { ranks: [14, 15, 3, 4, 5], top: 5 },
  { ranks: [15, 3, 4, 5, 6], top: 6 },
  { ranks: [3, 4, 5, 6, 7], top: 7 },
  { ranks: [4, 5, 6, 7, 8], top: 8 },
  { ranks: [5, 6, 7, 8, 9], top: 9 },
  { ranks: [6, 7, 8, 9, 10], top: 10 },
  { ranks: [7, 8, 9, 10, 11], top: 11 },
  { ranks: [8, 9, 10, 11, 12], top: 12 },
  { ranks: [9, 10, 11, 12, 13], top: 13 },
  { ranks: [10, 11, 12, 13, 14], top: 14 },
  { ranks: [11, 12, 13, 14, 15], top: 15 },
];

/**
 * Which straight window a hand of 5 distinct ranks matches, or null.
 * `position` is the window's index (0 = A2345, 10 = JQKA2), which is exactly
 * what "by sequence position" in the spec compares straights on.
 */
function matchStraight(ranks) {
  if (ranks.length !== 5) return null;
  const set = new Set(ranks);
  if (set.size !== 5) return null;
  for (let position = 0; position < STRAIGHT_WINDOWS.length; position++) {
    const window = STRAIGHT_WINDOWS[position];
    if (window.ranks.every((r) => set.has(r))) return { position, top: window.top };
  }
  return null;
}

function make(type, rank, size, cards, key) {
  return { type, rank, size, cards, key };
}

function highestCard(cards) {
  return cards.reduce((best, c) => (cardValue(c) > cardValue(best) ? c : best), cards[0]);
}

/**
 * Identify what a set of cards is, or null when it is not a legal Big Two
 * play. Duplicated cards, four-card sets (there is no such play) and any
 * 5-card shape that is not a straight/flush/full house/four-of-a-kind/
 * straight flush all return null.
 * @param {object[]} input
 * @returns {{type: string, rank: number, size: number, cards: object[], key: number}|null}
 */
export function classify(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  // A client can send whatever it likes; refuse a repeated card before reading
  // any pattern into it, exactly like doudizhu/rules.js does.
  const seen = new Set();
  for (const card of input) {
    if (!card || typeof card.rank !== 'number' || typeof card.suit !== 'string' || seen.has(card.id)) return null;
    seen.add(card.id);
  }
  const cards = [...input];
  const n = cards.length;

  if (n === 1) return make(Combo.SINGLE, cards[0].rank, 1, cards, cardValue(cards[0]));

  const groups = groupByRank(cards);
  const ranks = [...groups.keys()];

  if (n === 2) return ranks.length === 1 ? make(Combo.PAIR, ranks[0], 2, cards, cardValue(highestCard(cards))) : null;

  if (n === 3) return ranks.length === 1 ? make(Combo.TRIPLE, ranks[0], 3, cards, cardValue(highestCard(cards))) : null;

  if (n === 4) return null; // Big Two has no four-card play; a quad only exists inside a 5-card four-of-a-kind.

  if (n === 5) {
    const counts = ranks.map((r) => groups.get(r).length).sort((a, b) => b - a);

    if (counts[0] === 4) {
      const quad = ranks.find((r) => groups.get(r).length === 4);
      return make(Combo.FOUR_KIND, quad, 5, cards, quad);
    }
    if (counts[0] === 3 && counts[1] === 2) {
      const triple = ranks.find((r) => groups.get(r).length === 3);
      return make(Combo.FULL_HOUSE, triple, 5, cards, triple);
    }
    // Anything else that is a legal 5-card hand needs 5 distinct ranks (two
    // pair, or a trio with two unrelated singles, are neither a full house
    // nor anything else Big Two recognises).
    if (ranks.length !== 5) return null;

    const suits = new Set(cards.map((c) => c.suit));
    const isFlush = suits.size === 1;
    const straight = matchStraight(ranks);

    if (straight) {
      const topCard = cards.find((c) => c.rank === straight.top);
      const key = straight.position * 4 + SUIT_ORDER.indexOf(topCard.suit);
      return make(isFlush ? Combo.STRAIGHT_FLUSH : Combo.STRAIGHT, straight.top, 5, cards, key);
    }
    if (isFlush) {
      const topCard = highestCard(cards);
      return make(Combo.FLUSH, topCard.rank, 5, cards, cardValue(topCard));
    }
    return null;
  }

  return null; // Big Two never plays more than five cards at once.
}

/**
 * Does `candidate` legally answer `current`? A null `current` means the
 * player is leading, so anything legal goes. Sizes must match — a five-card
 * hand beats only a five-card hand, a pair only a pair, and so on — and for
 * two five-card hands of different shapes, the fixed ladder
 * (straight < flush < full house < four of a kind < straight flush) decides
 * before the `key` ever gets compared.
 * @param {object|null} candidate
 * @param {object|null} current
 */
export function beats(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.size !== current.size) return false;
  if (candidate.size === 5 && candidate.type !== current.type) {
    return fiveCardStrength(candidate.type) > fiveCardStrength(current.type);
  }
  return candidate.type === current.type && candidate.key > current.key;
}

export function comboName(type) {
  return COMBO_NAMES[type] ?? type;
}

/** Human-readable description, e.g. "Full house, 9s". */
export function describeCombo(combo) {
  if (!combo) return 'Pass';
  const name = comboName(combo.type);
  const label = rankLabel(combo.rank);
  switch (combo.type) {
    case Combo.PAIR:
    case Combo.TRIPLE:
    case Combo.FULL_HOUSE:
    case Combo.FOUR_KIND:
      return `${name}, ${label}s`;
    case Combo.STRAIGHT:
    case Combo.FLUSH:
    case Combo.STRAIGHT_FLUSH:
      return `${name}, ${label} high`;
    default:
      return `${name}, ${label}`;
  }
}
