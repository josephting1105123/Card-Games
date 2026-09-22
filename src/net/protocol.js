/**
 * The wire protocol for local network play. Shared by the browser client and the
 * Node host so both ends agree on the spelling in one place.
 *
 * Everything is JSON text. The host is authoritative: it shuffles, it validates
 * every action against the same rules module the client uses, and it sends each
 * seat only its own hand.
 */

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
  pot: 1_000,
  startingChips: 10_000,
  baseMultiplier: 2,
  capFactor: 6,
  botSkill: 'steady',
  humanSeats: 2, // the rest of the three seats are filled by bots
};

export const SETTING_LIMITS = {
  pot: { min: 100, max: 1_000_000, step: 100 },
  startingChips: { min: 1_000, max: 100_000_000, step: 1_000 },
  baseMultiplier: { min: 1, max: 8, step: 1 },
  capFactor: { min: 1, max: 20, step: 0.5 },
};

/** Clamp whatever a host typed into something the table can actually run. */
export function sanitiseSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [key, limit] of Object.entries(SETTING_LIMITS)) {
    const value = Number(input[key]);
    if (Number.isFinite(value)) out[key] = Math.min(limit.max, Math.max(limit.min, value));
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
