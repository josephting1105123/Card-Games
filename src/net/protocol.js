/**
 * The wire protocol for local network play. Shared by the browser client and the
 * Node host so both ends agree on the spelling in one place.
 *
 * Everything is JSON text. The host is authoritative: it shuffles, it validates
 * every action against the same rules module the client uses, and it sends each
 * seat only its own hand.
 */

import { DEFAULT_ROOM_CURRENCY, isRoomCurrency } from '../core/currency.js';
import { stackForPot, suggestedStakes } from '../core/economy.js';

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

export const DEFAULT_SETTINGS = {
  game: 'doudizhu',
  // A room deals out its own temporary coins rather than touching anybody's
  // single-player purse. The host picks silver or gold; see core/currency.js.
  currency: DEFAULT_ROOM_CURRENCY,
  ...suggestedStakes(DEFAULT_ROOM_CURRENCY),
  baseMultiplier: 2,
  // Matches core/economy.js's HAND_CAP_FACTOR: doubled alongside the multiplier
  // itself now that the base is a real factor rather than a floor, so an
  // ordinary bomb or two still settles in full at the default room settings.
  capFactor: 100,
  botSkill: 'steady',
  humanSeats: 2, // the rest of the three seats are filled by bots
};

export const SETTING_LIMITS = {
  // Low minimums on purpose: a room keeping score in ringgit wants a pot of 5,
  // not 5,000. Amounts are whole units in every currency.
  pot: { min: 1, max: 10_000_000, step: 1 },
  startingChips: { min: 1, max: 1_000_000_000, step: 10 },
  baseMultiplier: { min: 1, max: 8, step: 1 },
  // A loss cap high enough to be a backstop rather than a routine clamp: see
  // the note on caps in core/economy.js.
  capFactor: { min: 1, max: 200, step: 1 },
};

/** Clamp whatever a host typed into something the table can actually run. */
export function sanitiseSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS };
  if (isRoomCurrency(input.currency)) out.currency = String(input.currency).toLowerCase();
  else if (input.currency === undefined && input.pot === undefined) {
    Object.assign(out, suggestedStakes(out.currency));
  }
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
  for (const key of ['baseMultiplier', 'capFactor']) {
    const value = Number(input[key]);
    if (Number.isFinite(value)) out[key] = clamp(key, value);
  }
  if (typeof input.botSkill === 'string') out.botSkill = input.botSkill;
  const humans = Number(input.humanSeats);
  if (Number.isFinite(humans)) out.humanSeats = Math.min(3, Math.max(1, Math.round(humans)));
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
