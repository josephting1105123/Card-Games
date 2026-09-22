/**
 * Dou Di Zhu game state machine.
 *
 * Default ("classic") rules:
 *   - 54 cards, three players, 17 each, three face-down cards for the landlord.
 *   - Bidding: in turn each player calls 1, 2 or 3 points, or passes. A call
 *     must beat the standing call. A call of 3 ends bidding at once. If all
 *     three pass the hand is redealt.
 *   - The landlord takes the three face-down cards (20 in hand) and leads.
 *   - Stake multiplier = points called x 2 per bomb or rocket x 2 for a spring.
 *   - Spring: the landlord wins without either farmer ever playing a card.
 *     Anti-spring: the farmers win and the landlord played only his opening hand.
 *
 * The functions here mutate the state they are given and return
 * { ok: true, ... } or { ok: false, error }. The LAN server keeps one state per
 * room and broadcasts a redacted view per seat; the browser keeps one state for
 * the local game. Nothing in this file touches the DOM or the clock.
 */

import { containsAll, makeDeck, removeCards, sortCards } from '../../core/cards.js';
import { makeRng, randInt, shuffle } from '../../core/rng.js';
import { beats, classify } from './rules.js';

export const Phase = { BIDDING: 'bidding', PLAYING: 'playing', FINISHED: 'finished' };
export const Role = { LANDLORD: 'landlord', FARMER: 'farmer' };
export const HAND_SIZE = 17;
export const BOTTOM_SIZE = 3;
export const SEATS = 3;

/**
 * @param {object} options
 * @param {string|number} options.seed
 * @param {{id: string, name: string, isBot?: boolean, skill?: object}[]} options.players exactly three
 */
export function createGame({ seed, players }) {
  if (!Array.isArray(players) || players.length !== SEATS) {
    throw new Error(`Dou Di Zhu needs exactly ${SEATS} players`);
  }
  const state = {
    game: 'doudizhu',
    seed: String(seed),
    deal: 0,
    phase: Phase.BIDDING,
    players: players.map((p, seat) => ({
      seat,
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      skill: p.skill ?? null,
      hand: [],
      role: Role.FARMER,
    })),
    bottom: [],
    bottomRevealed: false,
    landlord: -1,
    bidding: { turn: 0, first: 0, highest: 0, highestBy: -1, calls: [], passes: 0 },
    turn: -1,
    trick: null, // { leader, combo } while a trick is live
    // What each seat has done in the trick now in progress, in order. The table
    // lays these out one per seat, so who played what is answered by where the
    // cards are rather than by a caption.
    trickPlays: [],
    passStreak: 0,
    bidValue: 0,
    bombs: 0,
    multiplier: 1,
    plays: [],
    landlordPlays: 0,
    farmerPlays: 0,
    result: null,
    log: [],
  };
  dealCards(state, makeRng(`${seed}:0`));
  return state;
}

function dealCards(state, rng) {
  const deck = shuffle(makeDeck(), rng);
  for (let seat = 0; seat < SEATS; seat++) {
    state.players[seat].hand = sortCards(deck.slice(seat * HAND_SIZE, (seat + 1) * HAND_SIZE));
    state.players[seat].role = Role.FARMER;
  }
  state.bottom = sortCards(deck.slice(SEATS * HAND_SIZE));
  state.bottomRevealed = false;
  state.landlord = -1;
  state.phase = Phase.BIDDING;
  const first = randInt(rng, SEATS);
  state.bidding = { turn: first, first, highest: 0, highestBy: -1, calls: [], passes: 0 };
  state.turn = -1;
  state.trick = null;
  state.trickPlays = [];
  state.passStreak = 0;
  state.bidValue = 0;
  state.bombs = 0;
  state.multiplier = 1;
  state.plays = [];
  state.landlordPlays = 0;
  state.farmerPlays = 0;
  state.result = null;
}

/** Redeal after three passes. Keeps the same players, advances the deal counter. */
export function redeal(state) {
  state.deal += 1;
  dealCards(state, makeRng(`${state.seed}:${state.deal}`));
  state.log.push({ kind: 'redeal', deal: state.deal });
  return { ok: true };
}

/**
 * Call points, or pass with value 0.
 * @param {number} seat
 * @param {0|1|2|3} value
 */
export function bid(state, seat, value) {
  if (state.phase !== Phase.BIDDING) return { ok: false, error: 'not bidding' };
  if (seat !== state.bidding.turn) return { ok: false, error: 'not your turn to call' };
  if (![0, 1, 2, 3].includes(value)) return { ok: false, error: 'a call must be 0, 1, 2 or 3' };
  if (value !== 0 && value <= state.bidding.highest) {
    return { ok: false, error: `a call must beat ${state.bidding.highest}` };
  }

  const b = state.bidding;
  b.calls.push({ seat, value });
  state.log.push({ kind: 'bid', seat, value });

  if (value === 0) {
    b.passes += 1;
    if (b.highestBy === -1 && b.passes === SEATS) {
      // Nobody wanted it: redeal.
      return { ok: true, redeal: true, ...redeal(state) };
    }
    if (b.highestBy !== -1 && b.passes >= SEATS - 1) return { ok: true, ...settleBidding(state) };
  } else {
    b.highest = value;
    b.highestBy = seat;
    b.passes = 0;
    if (value === 3) return { ok: true, ...settleBidding(state) };
  }

  b.turn = (b.turn + 1) % SEATS;
  return { ok: true };
}

function settleBidding(state) {
  const landlord = state.bidding.highestBy;
  state.landlord = landlord;
  state.bidValue = state.bidding.highest;
  state.players[landlord].role = Role.LANDLORD;
  state.players[landlord].hand = sortCards([...state.players[landlord].hand, ...state.bottom]);
  state.bottomRevealed = true;
  state.phase = Phase.PLAYING;
  state.turn = landlord;
  state.trick = null;
  state.trickPlays = [];
  state.passStreak = 0;
  state.multiplier = state.bidValue;
  state.log.push({ kind: 'landlord', seat: landlord, points: state.bidValue });
  return { landlordChosen: landlord };
}

/** What the seat on turn is allowed to do right now. */
export function availableActions(state, seat) {
  if (state.phase === Phase.BIDDING) {
    if (seat !== state.bidding.turn) return [];
    const options = [0];
    for (const v of [1, 2, 3]) if (v > state.bidding.highest) options.push(v);
    return [{ kind: 'bid', values: options }];
  }
  if (state.phase === Phase.PLAYING && seat === state.turn) {
    const actions = [{ kind: 'play' }];
    if (state.trick) actions.push({ kind: 'pass' });
    return actions;
  }
  return [];
}

/** True when the seat on turn is opening a fresh trick and so cannot pass. */
export function mustLead(state) {
  return state.phase === Phase.PLAYING && !state.trick;
}

/**
 * Play cards. `cards` may be card objects or card ids.
 */
export function play(state, seat, cards) {
  if (state.phase !== Phase.PLAYING) return { ok: false, error: 'not in play' };
  if (seat !== state.turn) return { ok: false, error: 'not your turn' };
  const player = state.players[seat];
  const resolved = resolveCards(player.hand, cards);
  if (!resolved) return { ok: false, error: 'those cards are not in your hand' };
  if (!containsAll(player.hand, resolved)) return { ok: false, error: 'those cards are not in your hand' };

  const combo = classify(resolved);
  if (!combo) return { ok: false, error: 'that is not a legal combination' };
  if (state.trick && !beats(combo, state.trick.combo)) {
    return { ok: false, error: 'that does not beat the current play' };
  }

  if (!state.trick) state.trickPlays = []; // leading: the last trick clears away
  player.hand = removeCards(player.hand, resolved);
  state.plays.push({ seat, cards: resolved, combo: summarise(combo) });
  state.log.push({ kind: 'play', seat, combo: summarise(combo) });
  if (combo.bomb) {
    state.bombs += 1;
    state.multiplier *= 2;
  }
  if (player.role === Role.LANDLORD) state.landlordPlays += 1;
  else state.farmerPlays += 1;

  state.trick = { leader: seat, combo };
  state.trickPlays.push({ seat, cards: resolved, combo: summarise(combo) });
  state.passStreak = 0;

  if (player.hand.length === 0) {
    finish(state, seat);
    return { ok: true, finished: true };
  }
  state.turn = (seat + 1) % SEATS;
  return { ok: true };
}

export function pass(state, seat) {
  if (state.phase !== Phase.PLAYING) return { ok: false, error: 'not in play' };
  if (seat !== state.turn) return { ok: false, error: 'not your turn' };
  if (!state.trick) return { ok: false, error: 'you must lead' };
  state.plays.push({ seat, pass: true });
  state.trickPlays.push({ seat, pass: true });
  state.log.push({ kind: 'pass', seat });
  state.passStreak += 1;
  if (state.passStreak >= SEATS - 1) {
    // Both opponents passed: the trick is won, its winner opens the next one.
    // trickPlays is left standing so the table can keep the finished trick on
    // screen, greyed, until somebody leads again.
    state.turn = state.trick.leader;
    state.trick = null;
    state.passStreak = 0;
  } else {
    state.turn = (seat + 1) % SEATS;
  }
  return { ok: true };
}

function finish(state, winnerSeat) {
  const winnerRole = state.players[winnerSeat].role;
  const landlordWon = winnerRole === Role.LANDLORD;
  const spring = landlordWon && state.farmerPlays === 0;
  const antiSpring = !landlordWon && state.landlordPlays <= 1;
  if (spring || antiSpring) state.multiplier *= 2;
  state.phase = Phase.FINISHED;
  state.trick = null;
  state.turn = -1;
  state.result = {
    winnerSeat,
    winnerRole,
    landlordSeat: state.landlord,
    landlordWon,
    bidValue: state.bidValue,
    bombs: state.bombs,
    spring,
    antiSpring,
    multiplier: state.multiplier,
    handsLeft: state.players.map((p) => p.hand.length),
  };
  state.log.push({ kind: 'finished', ...state.result });
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

function summarise(combo) {
  return { type: combo.type, rank: combo.rank, length: combo.length, size: combo.size, bomb: combo.bomb };
}

/**
 * The state as one seat is allowed to see it: own hand in full, everyone else as
 * a card count. Sent over the wire in LAN games so a client cannot read another
 * player's hand out of the network traffic.
 */
export function seatView(state, seat) {
  return {
    game: state.game,
    phase: state.phase,
    seat,
    deal: state.deal,
    you: {
      seat,
      hand: state.players[seat].hand,
      role: state.players[seat].role,
    },
    players: state.players.map((p) => ({
      seat: p.seat,
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      role: p.role,
      cards: p.hand.length,
    })),
    bottom: state.bottomRevealed ? state.bottom : state.bottom.map(() => null),
    bottomRevealed: state.bottomRevealed,
    landlord: state.landlord,
    bidding: state.bidding,
    turn: state.turn,
    trick: state.trick ? { leader: state.trick.leader, combo: summarise(state.trick.combo), cards: state.trick.combo.cards } : null,
    lastPlays: state.plays.slice(-6),
    trickPlays: state.trickPlays,
    // Every card anyone has played. Public information at the table, so passing
    // it to a bot is card counting, not cheating.
    playedCards: state.plays.flatMap((p) => p.cards ?? []),
    bidValue: state.bidValue,
    bombs: state.bombs,
    multiplier: state.multiplier,
    result: state.result,
  };
}

/** Deep copy, for bots that want to look ahead without disturbing the real game. */
export function cloneGame(state) {
  return structuredClone(state);
}

/** Seats of the two farmers. */
export function farmerSeats(state) {
  return state.players.filter((p) => p.role === Role.FARMER).map((p) => p.seat);
}

/** Total card count check, used by the tests as an invariant. */
export function cardsInPlay(state) {
  return state.players.reduce((sum, p) => sum + p.hand.length, 0) + (state.bottomRevealed ? 0 : state.bottom.length);
}
