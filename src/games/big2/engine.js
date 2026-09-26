/**
 * Big Two game state machine.
 *
 * No bidding, no bottom, no roles: 52 cards, 4 seats, 13 each, and the seat
 * holding the 3 of diamonds leads the first trick with a play that must
 * contain it. Turns go counter-clockwise (seat 0 -> 1 -> 2 -> 3 -> 0), which
 * is just seat+1 mod 4 — the table's visual arrangement (you, right, top,
 * left) is a UI concern, not something the engine needs to know about.
 *
 * The functions here mutate the state they are given and return
 * { ok: true, ... } or { ok: false, error }, the same shape doudizhu/engine.js
 * uses, so a move the client thinks is legal is the same move the server
 * accepts. Nothing in this file touches the DOM or the clock.
 */

import { makeDeck52, removeCards, sortCards } from '../../core/cards.js';
import { makeRng, shuffle } from '../../core/rng.js';
import { beats, classify } from './rules.js';

export const SEATS = 4;
export const HAND_SIZE = 13;
export const Phase = { PLAYING: 'playing', FINISHED: 'finished' };

/**
 * @param {object} options
 * @param {string|number} options.seed
 * @param {{name: string, isHuman?: boolean, skill?: object}[]} options.players exactly four
 */
export function createGame({ seed, players }) {
  if (!Array.isArray(players) || players.length !== SEATS) {
    throw new Error(`Big Two needs exactly ${SEATS} players`);
  }
  const deck = shuffle(makeDeck52(), makeRng(`${seed}:deal`));
  const hands = [];
  for (let seat = 0; seat < SEATS; seat++) {
    hands.push(sortCards(deck.slice(seat * HAND_SIZE, (seat + 1) * HAND_SIZE)));
  }

  let leadSeat = -1;
  let leadCardId = null;
  for (let seat = 0; seat < SEATS; seat++) {
    const found = hands[seat].find((c) => c.rank === 3 && c.suit === 'diamond');
    if (found) {
      leadSeat = seat;
      leadCardId = found.id;
      break;
    }
  }

  return {
    game: 'big2',
    seed: String(seed),
    phase: Phase.PLAYING,
    players: players.map((p, seat) => ({ seat, name: p.name, isHuman: !!p.isHuman, skill: p.skill ?? null })),
    hands,
    turn: leadSeat,
    trick: null, // { combo, seat } — the play currently standing in this trick
    passesInRow: 0,
    // The very first play of the hand must contain the 3 of diamonds; cleared
    // to null the moment that play lands and never set again.
    leadMustInclude: leadCardId,
    history: [],
    winner: null,
  };
}

/** True while the seat on turn is opening a fresh trick and so cannot pass. */
export function mustLead(state) {
  return state.phase === Phase.PLAYING && !state.trick;
}

/** Whether `seat` may pass right now: in play, on turn, and not leading. */
export function canPass(state, seat) {
  return state.phase === Phase.PLAYING && seat === state.turn && !!state.trick;
}

function resolveCards(hand, cards) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  const byId = new Map(hand.map((card) => [card.id, card]));
  const out = [];
  const used = new Set();
  for (const entry of cards) {
    const id = typeof entry === 'number' ? entry : entry?.id;
    if (typeof id !== 'number' || used.has(id)) return null;
    const card = byId.get(id);
    if (!card) return null;
    used.add(id);
    out.push(card);
  }
  return out;
}

/**
 * Play cards. `cards` may be card objects or card ids.
 * @param {object} state
 * @param {number} seat
 * @param {object[]|number[]} cards
 */
export function play(state, seat, cards) {
  if (state.phase !== Phase.PLAYING) return { ok: false, error: 'not in play' };
  if (seat !== state.turn) return { ok: false, error: 'not your turn' };
  const hand = state.hands[seat];
  const resolved = resolveCards(hand, cards);
  if (!resolved) return { ok: false, error: 'those cards are not in your hand' };

  if (state.leadMustInclude != null && !resolved.some((c) => c.id === state.leadMustInclude)) {
    return { ok: false, error: 'the opening play must include the 3 of diamonds' };
  }
  const combo = classify(resolved);
  if (!combo) return { ok: false, error: 'that is not a legal combination' };
  if (state.trick && !beats(combo, state.trick.combo)) {
    return { ok: false, error: 'that does not beat the current play' };
  }

  state.hands[seat] = removeCards(hand, resolved);
  state.trick = { combo, seat };
  state.passesInRow = 0;
  state.leadMustInclude = null;
  state.history.push({ seat, action: 'play', combo });

  if (state.hands[seat].length === 0) {
    state.phase = Phase.FINISHED;
    state.winner = seat;
    state.turn = -1;
  } else {
    state.turn = (seat + 1) % SEATS;
  }
  return { ok: true };
}

export function pass(state, seat) {
  if (state.phase !== Phase.PLAYING) return { ok: false, error: 'not in play' };
  if (seat !== state.turn) return { ok: false, error: 'not your turn' };
  if (!state.trick) return { ok: false, error: 'you must lead' };

  state.history.push({ seat, action: 'pass' });
  state.passesInRow += 1;
  if (state.passesInRow >= SEATS - 1) {
    // Every other seat passed: the trick is won, and its winner leads next,
    // free to play anything. trick is cleared here rather than left standing,
    // since the engine has no clock of its own to hold it on screen for —
    // that timing is the table's job, not the state machine's.
    state.turn = state.trick.seat;
    state.trick = null;
    state.passesInRow = 0;
  } else {
    state.turn = (seat + 1) % SEATS;
  }
  return { ok: true };
}

/**
 * The state as one seat is allowed to see it: own hand in full, everyone
 * else as a card count. Big Two has no hidden information once a card is
 * played (every play lands face up), so history and the trick are not
 * redacted at all — only the other three hands are.
 */
export function seatView(state, seat) {
  return {
    game: state.game,
    phase: state.phase,
    seat,
    you: { seat, hand: state.hands[seat] },
    players: state.players.map((p, s) => ({
      seat: s, name: p.name, isHuman: p.isHuman, cards: state.hands[s].length,
    })),
    trick: state.trick ? { combo: state.trick.combo, seat: state.trick.seat } : null,
    turn: state.turn,
    leadMustInclude: state.leadMustInclude,
    passesInRow: state.passesInRow,
    history: state.history,
    winner: state.winner,
  };
}

/**
 * Chip settlement: each loser pays cardsLeft x rate to the winner, so the sum
 * of payouts is always zero. Only meaningful once the hand has finished; on a
 * game still in progress there is no winner to pay anyone, so every payout is
 * zero (still zero-sum, just trivially).
 * @param {object} state
 * @param {number} rate chips per card left in a loser's hand
 * @returns {{payouts: number[], cardsLeft: number[]}}
 */
export function settle(state, rate) {
  const cardsLeft = state.hands.map((h) => h.length);
  if (state.winner == null) return { payouts: cardsLeft.map(() => 0), cardsLeft };
  const payouts = cardsLeft.map((n, seat) => (seat === state.winner ? 0 : -n * rate));
  payouts[state.winner] = cardsLeft.reduce((sum, n, seat) => sum + (seat === state.winner ? 0 : n * rate), 0);
  return { payouts, cardsLeft };
}

/** Deep copy, for anything that wants to look ahead without disturbing the real game. */
export function cloneGame(state) {
  return structuredClone(state);
}

/**
 * Cards still in hand plus everything anyone has ever played — must always be
 * 52. Played cards leave the hands array with nothing else tracking them, so
 * this has to add history's play entries back in rather than just summing
 * hand lengths, or it would only ever equal 52 before the first play.
 */
export function cardsInPlay(state) {
  const played = state.history.reduce((sum, h) => sum + (h.action === 'play' ? h.combo.cards.length : 0), 0);
  return state.hands.reduce((sum, h) => sum + h.length, 0) + played;
}
