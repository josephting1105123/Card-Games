/**
 * No-limit Texas Hold'em: one hand as a state machine.
 *
 * A hand is dealt, bet around, and either ends when everyone else folds or
 * runs to a showdown. Stacks carry between hands, so the caller owns the match:
 * it feeds the surviving stacks into the next createHand with nextButton().
 *
 * Chip bookkeeping: `stack` is chips behind, `bet` is chips in on this street,
 * `committed` is chips in over the whole hand and already includes `bet`. Chips
 * leave `stack` and enter `committed` in one step, so stacks + committed is
 * constant until the pot is awarded (see totalChips) and no chip is ever
 * counted twice or lost between streets.
 *
 * Deck order matters to anyone rigging a hand in a test: each street burns the
 * front card, then deals from the front. The deck is [burn, flop x3, burn, turn,
 * burn, river] after the holes are out.
 *
 * Functions that mutate state return { ok: true, ... } or { ok: false, error },
 * the shape the other engines use. Nothing here touches the DOM or the clock.
 */

import { makeDeck52 } from '../../core/cards.js';
import { makeRng, shuffle } from '../../core/rng.js';
import { bestHand } from './rules.js';

export const MIN_SEATS = 2;
export const MAX_SEATS = 9;
export const Phase = {
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  FINISHED: 'finished',
};

const fail = (error) => ({ ok: false, error });
const canAct = (p) => !p.sittingOut && !p.folded && !p.allIn;
const isLive = (p) => !p.sittingOut && !p.folded;

/**
 * @param {object} options
 * @param {string|number} options.seed
 * @param {{name: string, isHuman?: boolean, isBot?: boolean, skill?: object, stack: number}[]} options.players
 * @param {number} options.button seat with chips; use nextButton() between hands
 * @param {number} options.smallBlind
 * @param {number} options.bigBlind
 */
export function createHand({ seed, players, button, smallBlind, bigBlind }) {
  if (!Array.isArray(players) || players.length < MIN_SEATS || players.length > MAX_SEATS) {
    throw new Error(`Hold'em needs ${MIN_SEATS} to ${MAX_SEATS} seats`);
  }
  if (!(smallBlind > 0) || !(bigBlind > 0)) throw new Error('blinds must be positive');
  const n = players.length;
  const seats = players.map((p, seat) => {
    const stack = p.stack > 0 ? p.stack : 0;
    return {
      seat,
      name: p.name,
      isHuman: !!p.isHuman,
      isBot: !!p.isBot,
      skill: p.skill ?? null,
      startStack: stack,
      stack,
      bet: 0,
      committed: 0,
      folded: false,
      allIn: false,
      sittingOut: stack <= 0,
      hole: [],
      actedAt: -1,
    };
  });
  if (seats.filter((p) => !p.sittingOut).length < 2) throw new Error('at least two seats need chips');
  if (!Number.isInteger(button) || button < 0 || button >= n || seats[button].sittingOut) {
    throw new Error('the button must be a seat with chips');
  }

  // Seats with chips in dealing order: first left of the button, button last.
  const order = [];
  for (let i = 1; i <= n; i++) {
    const s = (button + i) % n;
    if (!seats[s].sittingOut) order.push(s);
  }

  const deck = shuffle(makeDeck52(), makeRng(`${seed}:deal`));
  for (let round = 0; round < 2; round++) {
    for (const s of order) seats[s].hole.push(deck.shift());
  }

  const headsUp = order.length === 2;
  const sbSeat = headsUp ? button : order[0];
  const bbSeat = headsUp ? order[0] : order[1];

  const state = {
    game: 'holdem',
    seed: String(seed),
    phase: Phase.PREFLOP,
    smallBlind,
    bigBlind,
    button,
    sbSeat,
    bbSeat,
    players: seats,
    deck,
    board: [],
    turn: -1,
    currentBet: bigBlind,
    minRaise: bigBlind,
    log: [],
    result: null,
  };

  postBlind(state, seats[sbSeat], smallBlind, 'sb');
  postBlind(state, seats[bbSeat], bigBlind, 'bb');
  // Left of the big blind; in heads-up that wraps round to the button.
  state.turn = nextEligible(state, bbSeat);
  if (streetComplete(state)) advanceStreet(state);
  return state;
}

/** Next seat after `previousButton` (wrapping) that has chips; -1 as previous starts at seat 0. */
export function nextButton(players, previousButton) {
  const n = players.length;
  for (let i = 1; i <= n; i++) {
    const s = (((previousButton + i) % n) + n) % n;
    if (players[s].stack > 0) return s;
  }
  return -1;
}

/**
 * What the seat on turn may do, or null if it is not that seat's turn.
 */
export function legalActions(state, seat) {
  if (state.phase === Phase.FINISHED || state.turn !== seat) return null;
  const p = state.players[seat];
  const toCall = Math.min(Math.max(0, state.currentBet - p.bet), p.stack);
  const maxRaiseTo = p.bet + p.stack;
  const minRaiseTo = Math.min(maxRaiseTo, state.currentBet + Math.max(state.minRaise, state.bigBlind));
  // Someone who already acted may raise again only if what he now faces is at
  // least a full raise, so a lone short all-in leaves him closed but several
  // short all-ins that add up to a full raise reopen it. Nobody may raise when
  // no other seat can still respond.
  const canRaise = p.stack > toCall
    && (p.actedAt === -1 || toCall >= state.minRaise)
    && state.players.some((o) => o.seat !== seat && canAct(o));
  return {
    toCall,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    canRaise,
    minRaiseTo,
    maxRaiseTo,
    isBet: state.currentBet === 0,
  };
}

/**
 * @param {object} state
 * @param {number} seat
 * @param {{type: 'fold'|'check'|'call'|'bet'|'raise'|'allin', amount?: number}} action
 *   amount is the street total to raise TO.
 * @returns {{ok: true, streetEnded: boolean, handEnded: boolean} | {ok: false, error: string}}
 */
export function act(state, seat, action) {
  if (state.phase === Phase.FINISHED) return fail('hand is over');
  if (seat !== state.turn) return fail('not your turn');
  const p = state.players[seat];
  const legal = legalActions(state, seat);
  const wasBet = state.currentBet === 0;

  switch (action?.type) {
    case 'fold':
      p.folded = true;
      record(state, p, 'fold', 0);
      break;
    case 'check':
      if (!legal.canCheck) return fail('cannot check facing a bet');
      record(state, p, 'check', 0);
      break;
    case 'call':
      if (!legal.canCall) return fail('nothing to call');
      putIn(p, legal.toCall);
      record(state, p, 'call', legal.toCall);
      break;
    case 'bet':
    case 'raise': {
      if (!legal.canRaise) return fail('betting is closed to you');
      const to = action.amount;
      if (!Number.isInteger(to)) return fail('invalid amount');
      if (to > legal.maxRaiseTo) return fail('not enough chips');
      if (to < legal.minRaiseTo && to !== legal.maxRaiseTo) return fail('raise below the minimum');
      raiseTo(state, p, to, wasBet);
      break;
    }
    case 'allin':
      if (legal.canRaise && legal.maxRaiseTo > state.currentBet) {
        raiseTo(state, p, legal.maxRaiseTo, wasBet);
      } else if (legal.canCall) {
        putIn(p, legal.toCall);
        record(state, p, 'call', legal.toCall);
      } else {
        return fail('nothing to call');
      }
      break;
    default:
      return fail('unknown action');
  }
  p.actedAt = state.currentBet;

  if (state.players.filter(isLive).length === 1) {
    finish(state, false);
    return { ok: true, streetEnded: false, handEnded: true };
  }
  if (streetComplete(state)) {
    advanceStreet(state);
    return { ok: true, streetEnded: true, handEnded: state.phase === Phase.FINISHED };
  }
  state.turn = nextEligible(state, seat);
  return { ok: true, streetEnded: false, handEnded: false };
}

/**
 * Split committed chips into the main pot and side pots. Pure.
 * @param {number[]} committed chips each seat put in over the hand
 * @param {boolean[]} folded
 * @returns {{amount: number, eligible: number[]}[]} main pot first
 */
export function buildPots(committed, folded) {
  const levels = [...new Set(committed.filter((c, s) => !folded[s] && c > 0))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of committed) amount += Math.max(0, Math.min(c, level) - Math.min(c, prev));
    const eligible = [];
    committed.forEach((c, s) => {
      if (!folded[s] && c >= level) eligible.push(s);
    });
    pots.push({ amount, eligible });
    prev = level;
  }
  if (!pots.length) return [];
  // Chips a folded player put in above the highest live level belong to the last pot.
  const total = committed.reduce((a, b) => a + b, 0);
  const poured = pots.reduce((a, pot) => a + pot.amount, 0);
  pots[pots.length - 1].amount += total - poured;

  const merged = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    if (last && last.eligible.join() === pot.eligible.join()) last.amount += pot.amount;
    else merged.push(pot);
  }
  return merged.filter((pot) => pot.amount > 0);
}

/** What `seat` is allowed to see. Never includes the deck or other seats' hidden cards. */
export function seatView(state, seat) {
  const shown = state.result?.shown ?? [];
  const revealAll = state.phase === Phase.FINISHED;
  const me = state.players[seat];
  return {
    game: state.game,
    phase: state.phase,
    seat,
    button: state.button,
    sbSeat: state.sbSeat,
    bbSeat: state.bbSeat,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    board: state.board.map((c) => ({ ...c })),
    turn: state.turn,
    currentBet: state.currentBet,
    pot: state.players.reduce((sum, p) => sum + p.committed, 0),
    log: structuredClone(state.log),
    result: structuredClone(state.result),
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      isHuman: p.isHuman,
      isBot: p.isBot,
      stack: p.stack,
      bet: p.bet,
      committed: p.committed,
      folded: p.folded,
      allIn: p.allIn,
      sittingOut: p.sittingOut,
      hole: p.seat === seat || (revealAll && shown.includes(p.seat)) ? p.hole.map((c) => ({ ...c })) : null,
      cardCount: p.hole.length,
    })),
    you: { seat, hole: me ? me.hole.map((c) => ({ ...c })) : [] },
    legal: legalActions(state, seat),
  };
}

/** Stacks plus chips still in the middle; constant through a hand. */
export function totalChips(state) {
  let total = 0;
  for (const p of state.players) {
    total += p.stack;
    if (state.phase !== Phase.FINISHED) total += p.committed;
  }
  return total;
}

function putIn(p, chips) {
  p.stack -= chips;
  p.bet += chips;
  p.committed += chips;
  if (p.stack === 0) p.allIn = true;
}

function postBlind(state, p, amount, label) {
  const chips = Math.min(amount, p.stack);
  putIn(p, chips);
  record(state, p, label, chips);
}

function raiseTo(state, p, to, wasBet) {
  const chips = to - p.bet;
  const size = to - state.currentBet;
  putIn(p, chips);
  // Only a full raise changes the increment.
  if (size >= state.minRaise) state.minRaise = size;
  state.currentBet = Math.max(state.currentBet, to);
  record(state, p, wasBet ? 'bet' : 'raise', chips);
}

function record(state, p, action, amount) {
  state.log.push({ seat: p.seat, street: state.phase, action, amount, to: p.bet, allIn: p.allIn });
}

/** First seat after `from` (wrapping, `from` itself last) that can still act, or -1. */
function nextEligible(state, from) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const s = (from + i) % n;
    if (canAct(state.players[s])) return s;
  }
  return -1;
}

function streetComplete(state) {
  const open = state.players.filter(canAct);
  if (open.length === 0) return true;
  if (open.length === 1) {
    // Compare with what the others actually put in, not the nominal bet: a big
    // blind that posted short leaves currentBet above every real stake.
    let covered = 0;
    for (const p of state.players) {
      if (isLive(p) && p !== open[0]) covered = Math.max(covered, p.bet);
    }
    return open[0].bet >= covered;
  }
  return open.every((p) => p.actedAt !== -1 && p.bet === state.currentBet);
}

/** Close the street, deal the next one; loops through streets nobody can bet on. */
function advanceStreet(state) {
  for (;;) {
    for (const p of state.players) {
      p.bet = 0;
      p.actedAt = -1;
    }
    state.currentBet = 0;
    state.minRaise = state.bigBlind;
    if (state.phase === Phase.RIVER) {
      finish(state, true);
      return;
    }
    dealStreet(state);
    if (!streetComplete(state)) {
      state.turn = nextEligible(state, state.button);
      return;
    }
  }
}

function dealStreet(state) {
  const next = { [Phase.PREFLOP]: Phase.FLOP, [Phase.FLOP]: Phase.TURN, [Phase.TURN]: Phase.RIVER }[state.phase];
  state.deck.shift(); // burn
  const count = next === Phase.FLOP ? 3 : 1;
  for (let i = 0; i < count; i++) state.board.push(state.deck.shift());
  state.phase = next;
}

function finish(state, showdown) {
  const { players } = state;
  const n = players.length;
  for (const p of players) p.bet = 0;

  // The part of the biggest stake nobody matched goes back to its owner.
  let top = -1;
  let topAmount = 0;
  let second = 0;
  for (const p of players) {
    if (p.committed > topAmount) {
      second = topAmount;
      topAmount = p.committed;
      top = p.seat;
    } else if (p.committed > second) {
      second = p.committed;
    }
  }
  const winnings = new Array(n).fill(0);
  let refund = null;
  if (top >= 0 && topAmount > second) {
    refund = { seat: top, amount: topAmount - second };
    players[top].stack += refund.amount;
    players[top].committed -= refund.amount;
    winnings[top] += refund.amount;
  }

  let pots;
  const hands = {};
  let shown = [];
  if (!showdown) {
    const winner = players.find(isLive).seat;
    const amount = players.reduce((sum, p) => sum + p.committed, 0);
    players[winner].stack += amount;
    winnings[winner] += amount;
    pots = [{ amount, eligible: [winner], winners: [winner], share: amount, handName: null }];
  } else {
    for (const p of players) {
      if (isLive(p)) hands[p.seat] = bestHand([...p.hole, ...state.board]);
    }
    shown = Object.keys(hands).map(Number);
    // Odd chips go one each from the seat left of the button onward.
    const fromButton = (s) => (s - state.button - 1 + n) % n;
    pots = buildPots(players.map((p) => p.committed), players.map((p) => p.folded || p.sittingOut)).map((pot) => {
      const best = Math.max(...pot.eligible.map((s) => hands[s].score));
      const winners = pot.eligible.filter((s) => hands[s].score === best);
      const share = Math.floor(pot.amount / winners.length);
      const odd = pot.amount - share * winners.length;
      const gain = new Map(winners.map((s) => [s, share]));
      [...winners].sort((a, b) => fromButton(a) - fromButton(b)).slice(0, odd).forEach((s) => {
        gain.set(s, gain.get(s) + 1);
      });
      for (const [s, chips] of gain) {
        winnings[s] += chips;
        players[s].stack += chips;
      }
      return { amount: pot.amount, eligible: pot.eligible, winners, share, handName: hands[winners[0]].name };
    });
  }

  state.result = {
    uncontested: !showdown,
    showdown,
    pots,
    hands,
    winnings,
    net: players.map((p) => p.stack - p.startStack),
    refund,
    shown,
  };
  state.phase = Phase.FINISHED;
  state.turn = -1;
}
