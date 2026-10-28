/**
 * Texas Hold'em hand evaluation.
 *
 * Cards come from core/cards.js, where the deuce is 15 because of Dou Di Zhu's
 * order. Poker wants the deuce at the bottom, so pokerRank()
 * maps 15 -> 2 and leaves everything else alone; the ace is 14, and plays low
 * only inside the wheel A-2-3-4-5.
 *
 * Every five-card hand reduces to a single integer score (category first, then
 * the tie-break ranks packed base 15), so "better hand" and "exact tie" are one
 * integer compare. That keeps pot awarding free of comparison logic and makes
 * split pots a plain equality check.
 *
 * Pure: no DOM, no clock, no randomness.
 */

import { cardFromId, cardId } from '../../core/cards.js';

export const Category = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

const CATEGORY_NAMES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush',
];

const RANK_SINGULAR = {
  2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight',
  9: 'nine', 10: 'ten', 11: 'jack', 12: 'queen', 13: 'king', 14: 'ace',
};
const RANK_PLURAL = {
  2: 'twos', 3: 'threes', 4: 'fours', 5: 'fives', 6: 'sixes', 7: 'sevens', 8: 'eights',
  9: 'nines', 10: 'tens', 11: 'jacks', 12: 'queens', 13: 'kings', 14: 'aces',
};

const BASE = 15;
const CATEGORY_WEIGHT = BASE ** 5;

/** Poker rank 2..14 of a card (the deck stores the deuce as 15). */
export function pokerRank(card) {
  return card.rank === 15 ? 2 : card.rank;
}

export function categoryName(category) {
  return CATEGORY_NAMES[category];
}

/**
 * Evaluate exactly five cards.
 * @returns {{category: number, ranks: number[], cards: object[], score: number}}
 */
export function evaluate5(cards) {
  if (cards.length !== 5) throw new Error('evaluate5 needs exactly five cards');
  const sorted = [...cards].sort((a, b) => pokerRank(b) - pokerRank(a));
  const flush = sorted.every((c) => c.suit === sorted[0].suit);

  const byRank = new Map();
  for (const card of sorted) {
    const r = pokerRank(card);
    if (byRank.has(r)) byRank.get(r).push(card);
    else byRank.set(r, [card]);
  }
  // Biggest group first, then highest rank: the order tie-breaks are read in.
  const groups = [...byRank.entries()]
    .map(([rank, group]) => ({ rank, cards: group }))
    .sort((a, b) => b.cards.length - a.cards.length || b.rank - a.rank);
  const counts = groups.map((g) => g.cards.length);

  let straightHigh = 0;
  if (groups.length === 5) {
    const hi = groups[0].rank;
    const lo = groups[4].rank;
    if (hi - lo === 4) straightHigh = hi;
    else if (hi === 14 && groups[1].rank === 5 && lo === 2) straightHigh = 5;
  }

  let category;
  if (straightHigh && flush) category = Category.STRAIGHT_FLUSH;
  else if (counts[0] === 4) category = Category.QUADS;
  else if (counts[0] === 3 && counts[1] === 2) category = Category.FULL_HOUSE;
  else if (flush) category = Category.FLUSH;
  else if (straightHigh) category = Category.STRAIGHT;
  else if (counts[0] === 3) category = Category.TRIPS;
  else if (counts[0] === 2 && counts[1] === 2) category = Category.TWO_PAIR;
  else if (counts[0] === 2) category = Category.PAIR;
  else category = Category.HIGH_CARD;

  let ranks;
  let ordered;
  if (straightHigh) {
    ranks = [straightHigh];
    // The wheel reads 5-4-3-2-A, so the ace goes to the end.
    ordered = straightHigh === 5 ? [...sorted.slice(1), sorted[0]] : sorted;
  } else {
    ranks = groups.map((g) => g.rank);
    ordered = groups.flatMap((g) => g.cards);
  }

  let score = category * CATEGORY_WEIGHT;
  for (let i = 0; i < 5; i++) score += (ranks[i] ?? 0) * BASE ** (4 - i);
  return { category, ranks, cards: ordered, score };
}

/**
 * Best five-card hand out of five to seven cards. C(7,5) = 21 subsets.
 * @returns {{category: number, ranks: number[], cards: object[], score: number, name: string}}
 */
export function bestHand(cards) {
  if (cards.length < 5 || cards.length > 7) throw new Error('bestHand needs five to seven cards');
  let best = null;
  const pick = [];
  const walk = (start) => {
    if (pick.length === 5) {
      const hand = evaluate5(pick);
      if (!best || hand.score > best.score) best = hand;
      return;
    }
    for (let i = start; i < cards.length; i++) {
      pick.push(cards[i]);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return { ...best, name: describeHand(best) };
}

/** Sign of a.score - b.score: 1, 0 or -1. */
export function compareHands(a, b) {
  return Math.sign(a.score - b.score);
}

export function describeHand(hand) {
  const [r0, r1] = hand.ranks;
  switch (hand.category) {
    case Category.STRAIGHT_FLUSH:
      return r0 === 14 ? 'Royal flush' : `Straight flush, ${RANK_SINGULAR[r0]} high`;
    case Category.QUADS:
      return `Four of a kind, ${RANK_PLURAL[r0]}`;
    case Category.FULL_HOUSE:
      return `Full house, ${RANK_PLURAL[r0]} over ${RANK_PLURAL[r1]}`;
    case Category.FLUSH:
      return `Flush, ${RANK_SINGULAR[r0]} high`;
    case Category.STRAIGHT:
      return `Straight, ${RANK_SINGULAR[r0]} high`;
    case Category.TRIPS:
      return `Three of a kind, ${RANK_PLURAL[r0]}`;
    case Category.TWO_PAIR:
      return `Two pair, ${RANK_PLURAL[r0]} and ${RANK_PLURAL[r1]}`;
    case Category.PAIR:
      return `Pair of ${RANK_PLURAL[r0]}`;
    default:
      return `High card, ${RANK_SINGULAR[r0]}`;
  }
}

const PARSE_RANK = {
  2: 15, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14,
};
const PARSE_SUIT = { s: 'spade', h: 'heart', c: 'club', d: 'diamond' };

/** Test helper: 'As Kd Th 9c 2s' -> card objects. Throws on a bad token. */
export function parseCards(text) {
  return text.trim().split(/\s+/).filter(Boolean).map((token) => {
    const rank = token.length === 2 ? PARSE_RANK[token[0]] : undefined;
    const suit = token.length === 2 ? PARSE_SUIT[token[1]] : undefined;
    if (rank === undefined || suit === undefined) throw new Error(`parseCards: bad card '${token}'`);
    return cardFromId(cardId(rank, suit));
  });
}
