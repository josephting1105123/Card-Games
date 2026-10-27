/**
 * The wire protocol for local network play. Shared by the browser client and the
 * Node host so both ends agree on the spelling in one place.
 *
 * Everything is JSON text. The host is authoritative: it shuffles, it validates
 * every action against the same rules module the client uses, and it sends each
 * seat only its own hand.
 */

import { DEFAULT_ROOM_CURRENCY } from '../core/currency.js';
import { STARTING_STACK_MULTIPLE, stackForPot, suggestedStakes } from '../core/economy.js';

export const C2S = {
  HELLO: 'hello',
  CREATE: 'create',
  JOIN: 'join',
  SETTINGS: 'settings',
  SEAT_FILL: 'seat_fill',   // host adds or removes a bot in a seat
  START: 'start',
  BID: 'bid',
  PLAY: 'play',
  PASS: 'pass',
  AGAIN: 'again',
  LEAVE: 'leave',
  CHAT: 'chat',
  RESUME: 'resume',         // reclaim a held seat with the token from the ROOM frame
  SET_GAME: 'set_game',     // host switches the room's game between hands ({game})
  SIT: 'sit',               // take a free seat ({seat}); a spectator or a seated player moving
  STAND: 'stand',           // give up a seat and watch; the host may pass {id} to stand someone else
  TO_LOBBY: 'to_lobby',     // host leaves a finished hand's result and returns the room to its lobby
  // Blackjack keeps its own spellings: STAND above already means "move to the watchers".
  BJ_BET: 'bj_bet',         // a seated player's standing bet ({amount}); applies from the next deal
  BJ_RUN: 'bj_run',         // run on an opening 15
  BJ_HIT: 'bj_hit',         // a player's hit on their turn, or the banker's draw in the banker phase
  BJ_STAND: 'bj_stand',
  BJ_OPEN: 'bj_open',       // the banker opens a player's hand ({seat}: room seat 1-4)
};

export const S2C = {
  WELCOME: 'welcome',
  ROOM: 'room',
  VIEW: 'view',
  EVENT: 'event',
  RESULT: 'result',
  ERROR: 'error',
  CHAT: 'chat',
};

/** Seats at the table, per game. The host can switch a room's game between hands (SET_GAME). */
export const SEATS_BY_GAME = { doudizhu: 3, big2: 4, blackjack: 5 };

/**
 * Seated players plus spectators in one room. Spectators cost the server a socket
 * and a ROOM frame per change but no game state, so the cap only has to stop one
 * room hoarding connections, not to size a table.
 */
export const MAX_MEMBERS = 8;

/**
 * Smallest starting stack a Big Two room can have. The per-card rate is pot / 10
 * and a pot is a fraction of the stack, so anything smaller rounds the rate to nothing.
 */
export const BIG2_MIN_STACK = 100;

/**
 * The pot a room should play for after a game switch, keeping its stack worth the
 * same number of pots. Big Two stakes move in tens; Dou Di Zhu's in ones.
 */
export function potForStack(game, stack) {
  return game === 'big2'
    ? Math.max(10, Math.round(stack / (STARTING_STACK_MULTIPLE * 10)) * 10)
    : Math.max(1, Math.round(stack / STARTING_STACK_MULTIPLE));
}

/** A blackjack room's bet range: the pot is the table minimum, the ceiling ten of them. */
export function blackjackLimits(settings) {
  return { min: settings.pot, max: settings.pot * 10 };
}

const knownGame = (id) => (Object.hasOwn(SEATS_BY_GAME, id) ? id : 'doudizhu');

/** Defaults for a new room of `game`; an unknown game gets Dou Di Zhu's. */
export function defaultSettings(game = 'doudizhu') {
  const id = knownGame(game);
  const base = {
    game: id,
    // A room deals out its own temporary coins rather than touching anybody's
    // single-player purse. Always silver; see core/currency.js.
    currency: DEFAULT_ROOM_CURRENCY,
    ...suggestedStakes(DEFAULT_ROOM_CURRENCY),
  };
  if (id === 'doudizhu') {
    base.baseMultiplier = 2;
    // Matches core/economy.js's HAND_CAP_FACTOR: doubled alongside the multiplier
    // itself now that the base is a real factor rather than a floor, so an
    // ordinary bomb or two still settles in full at the default room settings.
    base.capFactor = 100;
  }
  base.botSkill = 'steady';
  base.humanSeats = 2; // the rest of the seats are filled by bots
  return base;
}

export const DEFAULT_SETTINGS = defaultSettings('doudizhu');

export const SETTING_LIMITS = {
  // Low minimums on purpose: a room keeping score in ringgit wants a pot of 5,
  // not 5,000. Amounts are whole units in every currency.
  pot: { min: 1, max: 10_000_000, step: 1 },
  startingChips: { min: 1, max: 1_000_000_000, step: 10 },
};

/** Clamp whatever a host typed into something the table can actually run. */
export function sanitiseSettings(input = {}) {
  const game = knownGame(input.game);
  const out = defaultSettings(game);
  // The host no longer picks a coin or tunes the multiplier: the create form
  // doesn't offer them, and an older client that still sends them is ignored
  // here so every room plays the same way.
  out.currency = DEFAULT_ROOM_CURRENCY;
  const clamp = (key, value) => {
    const limit = SETTING_LIMITS[key];
    return Math.min(limit.max, Math.max(limit.min, value));
  };
  // The pot is settled first, because a room that names a pot and no stack gets
  // the house multiple of it rather than the default coin's stack.
  const pot = Number(input.pot);
  out.pot = Number.isFinite(pot) ? clamp('pot', pot) : suggestedStakes(out.currency).pot;
  const stack = Number(input.startingChips);
  out.startingChips = clamp('startingChips', Number.isFinite(stack) ? stack : stackForPot(out.pot));
  // baseMultiplier and capFactor stay at the defaults set above; Big Two
  // settles by cards left and has neither.
  if (typeof input.botSkill === 'string') out.botSkill = input.botSkill;
  const humans = Number(input.humanSeats);
  if (Number.isFinite(humans)) out.humanSeats = Math.min(SEATS_BY_GAME[game], Math.max(1, Math.round(humans)));
  return out;
}

export function encode(message) {
  return JSON.stringify(message);
}

/** Never throws: a malformed frame comes back as null and is dropped. */
export function decode(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && typeof value.t === 'string' ? value : null;
  } catch {
    return null;
  }
}
