/**
 * Card model shared by every game and by the LAN server.
 *
 * A card is a plain object: { id, rank, suit }. Ranks are stored as the numbers
 * used for comparison rather than as labels, which keeps every rule check to an
 * integer compare:
 *
 *   3..10 -> 3..10,  J=11, Q=12, K=13, A=14, 2=15,
 *   small joker = 16, big joker = 17
 *
 * That ordering is Dou Di Zhu's. Games with a different order (Big Two ranks by
 * suit as well; poker treats A as high or low) map from these numbers instead of
 * redefining the deck, so one renderer can draw every game's cards.
 */

export const SUITS = ['spade', 'heart', 'club', 'diamond', 'joker'];
export const SUIT_SYMBOL = { spade: '♠', heart: '♥', club: '♣', diamond: '♦', joker: '★' };
export const SUIT_COLOUR = { spade: 'black', club: 'black', heart: 'red', diamond: 'red', joker: 'red' };
/** The two jokers are told apart by colour, as on a printed deck. */
export const JOKER_COLOUR = { 16: 'black', 17: 'red' };

export const RANK_MIN = 3;
export const RANK_TWO = 15;
export const RANK_JOKER_SMALL = 16;
export const RANK_JOKER_BIG = 17;
/** Highest rank that may appear inside a straight / pair-chain / trio-chain. */
export const RANK_CHAIN_MAX = 14;

const RANK_LABELS = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: 'x', 17: 'X',
};
/** Compact notation used by parseHand() and in tests. */
const CHAR_TO_RANK = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, '0': 10,
  J: 11, Q: 12, K: 13, A: 14, '2': 15, x: 16, X: 17,
};

export function rankLabel(rank) {
  if (rank === RANK_JOKER_SMALL) return 'Joker';
  if (rank === RANK_JOKER_BIG) return 'JOKER';
  return RANK_LABELS[rank] ?? String(rank);
}

/** Short label for the corner index of a rendered card. */
export function rankIndex(rank) {
  if (rank === RANK_JOKER_SMALL || rank === RANK_JOKER_BIG) return 'J★';
  return RANK_LABELS[rank];
}

export function isJoker(card) {
  return card.rank >= RANK_JOKER_SMALL;
}

export function cardId(rank, suit) {
  if (rank === RANK_JOKER_SMALL) return 52;
  if (rank === RANK_JOKER_BIG) return 53;
  return (rank - RANK_MIN) * 4 + SUITS.indexOf(suit);
}

export function cardFromId(id) {
  if (id === 52) return { id: 52, rank: RANK_JOKER_SMALL, suit: 'joker' };
  if (id === 53) return { id: 53, rank: RANK_JOKER_BIG, suit: 'joker' };
  const rank = Math.floor(id / 4) + RANK_MIN;
  const suit = SUITS[id % 4];
  return { id, rank, suit };
}

/** A full 54-card Dou Di Zhu deck (52 + two jokers), unshuffled. O(1). */
export function makeDeck() {
  const deck = [];
  for (let id = 0; id < 54; id++) deck.push(cardFromId(id));
  return deck;
}

/** A 52-card deck without jokers, for the games that want one. */
export function makeDeck52() {
  const deck = [];
  for (let id = 0; id < 52; id++) deck.push(cardFromId(id));
  return deck;
}

/**
 * Descending by rank, then by suit, which is the order players expect to see a
 * hand fanned in. O(n log n).
 */
export function sortCards(cards) {
  return [...cards].sort((a, b) => b.rank - a.rank || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit));
}

export function sortCardsAsc(cards) {
  return [...cards].sort((a, b) => a.rank - b.rank || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit));
}

/**
 * Map of rank -> how many cards of that rank are present. O(n).
 * @returns {Map<number, number>}
 */
export function countByRank(cards) {
  const counts = new Map();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return counts;
}

/** Group cards by rank, preserving each group's cards. O(n). */
export function groupByRank(cards) {
  /** @type {Map<number, object[]>} */
  const groups = new Map();
  for (const card of cards) {
    const list = groups.get(card.rank);
    if (list) list.push(card);
    else groups.set(card.rank, [card]);
  }
  return groups;
}

/** Remove `subset` from `cards` by card id. O(n + m). */
export function removeCards(cards, subset) {
  const ids = new Set(subset.map((c) => c.id));
  return cards.filter((c) => !ids.has(c.id));
}

/** True when every card of `subset` is present in `cards`. O(n + m). */
export function containsAll(cards, subset) {
  const ids = new Set(cards.map((c) => c.id));
  return subset.every((c) => ids.has(c.id));
}

export function cardToString(card) {
  return isJoker(card) ? rankLabel(card.rank) : `${RANK_LABELS[card.rank]}${SUIT_SYMBOL[card.suit]}`;
}

export function cardsToString(cards) {
  return sortCards(cards).map(cardToString).join(' ');
}

/**
 * Build cards from compact notation, e.g. parseHand('333 444 55 xX').
 * Suits are assigned in deck order so repeated ranks get distinct cards.
 * Throws on an unknown character or on asking for a fifth card of one rank.
 * O(n).
 */
export function parseHand(text) {
  const used = new Map();
  const cards = [];
  for (const ch of text) {
    if (ch === ' ' || ch === ',' || ch === '-') continue;
    const rank = CHAR_TO_RANK[ch];
    if (rank === undefined) throw new Error(`parseHand: unknown card character '${ch}'`);
    if (rank >= RANK_JOKER_SMALL) {
      const n = used.get(rank) ?? 0;
      if (n >= 1) throw new Error(`parseHand: the deck holds only one ${rankLabel(rank)}`);
      used.set(rank, 1);
      cards.push(cardFromId(rank === RANK_JOKER_SMALL ? 52 : 53));
      continue;
    }
    const n = used.get(rank) ?? 0;
    if (n >= 4) throw new Error(`parseHand: more than four cards of rank ${rankLabel(rank)}`);
    used.set(rank, n + 1);
    cards.push(cardFromId(cardId(rank, SUITS[n])));
  }
  return cards;
}
