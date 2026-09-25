/**
 * Card values, hand totals and the shoe, for both Blackjack rule sets.
 *
 * Card ranks come from core/cards.js, which numbers them for Dou Di Zhu's own
 * order (3..10, J=11, Q=12, K=13, A=14, 2=15 — the 2 sits above the ace there).
 * Blackjack has no use for that ordering, so this module maps the same numbers
 * to blackjack pip values instead of asking cards.js to mean two things.
 */

import { makeDeck52 } from '../../core/cards.js';
import { shuffle } from '../../core/rng.js';

export const ACE_RANK = 14;
export const TWO_RANK = 15;

export function isAce(card) {
  return card.rank === ACE_RANK;
}

/** 10, J, Q or K — any card worth ten, the group a peek or an insurance offer cares about. */
export function isTenValue(card) {
  return card.rank === 10 || (card.rank >= 11 && card.rank <= 13);
}

export function isSeven(card) {
  return card.rank === 7;
}

/** A card's pip value with an ace counted high (11); callers adjust for low aces. */
export function baseValue(card) {
  if (card.rank === ACE_RANK) return 11;
  if (card.rank === TWO_RANK) return 2;
  if (isTenValue(card)) return 10;
  return card.rank; // 3..10 already are their own value
}

/**
 * American total: every ace counts 11 until that busts the hand, then aces
 * are demoted to 1 one at a time. `soft` is true while an ace is still being
 * counted as 11 — the label a table shows as "Soft 17".
 */
export function americanTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (isAce(card)) aces += 1;
    total += baseValue(card);
  }
  let softAces = aces;
  while (total > 21 && softAces > 0) {
    total -= 10;
    softAces -= 1;
  }
  return { total, soft: softAces > 0, bust: total > 21 };
}

/** A two-card 21 that was dealt, not built by hitting or splitting into it. */
export function isNaturalBlackjack(cards) {
  return cards.length === 2 && americanTotal(cards).total === 21;
}

/**
 * Malaysian (Ban Luck) total: an ace's high/low pair depends on how many
 * cards the hand holds — 11-or-10 with two cards, 10-or-1 with three, 1-or-1
 * (fixed) with four or five. Each ace starts at the high value and is
 * demoted to the low one, one at a time, only as far as needed to avoid a
 * bust — the same shape as American's soft-hand demotion, just with the
 * house's own pair of values per hand length instead of a fixed 11-or-1.
 */
export function malaysianTotal(cards) {
  const aceCount = cards.filter(isAce).length;
  const rest = cards.filter((c) => !isAce(c)).reduce((sum, c) => sum + baseValue(c), 0);
  if (aceCount === 0) return { total: rest, soft: false, bust: rest > 21 };
  const [high, low] = cards.length <= 2 ? [11, 10] : cards.length === 3 ? [10, 1] : [1, 1];
  let total = rest + high * aceCount;
  let softAces = aceCount;
  while (total > 21 && softAces > 0 && high !== low) {
    total -= high - low;
    softAces -= 1;
  }
  return { total, soft: softAces > 0 && high !== low, bust: total > 21 };
}

/** A full 52-card deck, unshuffled — this game's own deal order. */
export function freshDeck() {
  return makeDeck52();
}

/**
 * Shuffle `decks` copies of a 52-card deck together. A multi-deck shoe deals
 * the same card id more than once, so every card gets a `key` unique within
 * the shoe (its position after the shuffle) for the UI to key DOM nodes on.
 */
export function buildShoe(decks, rng) {
  const cards = [];
  for (let d = 0; d < decks; d++) cards.push(...freshDeck());
  shuffle(cards, rng);
  return cards.map((card, i) => ({ ...card, key: `${card.id}-${i}` }));
}

/**
 * @param {number} decks
 * @param {import('../../core/rng.js').Rng} rng
 */
export function createShoe(decks, rng) {
  const cards = buildShoe(decks, rng);
  return { decks, cards, size: cards.length, dealt: 0 };
}

export function drawCard(shoe) {
  if (shoe.dealt >= shoe.cards.length) throw new Error('the shoe is empty');
  const card = shoe.cards[shoe.dealt];
  shoe.dealt += 1;
  return card;
}

/** Past the cut point (75% dealt by default): reshuffle before the next round. */
export function needsReshuffle(shoe, threshold = 0.75) {
  return shoe.dealt / shoe.size >= threshold;
}

export function reshuffleShoe(shoe, rng) {
  shoe.cards = buildShoe(shoe.decks, rng);
  shoe.size = shoe.cards.length;
  shoe.dealt = 0;
  return shoe;
}
