/**
 * The local player profile: chips, per-game Elo, settings.
 *
 * Kept in localStorage, which can throw or come back empty (private windows,
 * blocked site data), so every read and write is guarded and the app works with
 * an in-memory profile if storage is unavailable.
 */

import { DEFAULT_RATING, updateRating } from './elo.js';
import { STARTING_BANKROLL, applyToBankroll, isBankrupt } from './economy.js';

const KEY = 'card-games.profile.v2';
/**
 * Bumped to 2 when a stack became 25 pots and the hand ceilings changed. A
 * profile saved under the old economy starts from the old 10,000 and would
 * quietly be playing a different game, so a profile from an earlier schema is
 * dropped and dealt again rather than migrated.
 */
const SCHEMA = 2;

let memoryFallback = null;

export function defaultProfile() {
  return {
    schema: SCHEMA,
    name: 'Player',
    bankroll: STARTING_BANKROLL,
    rescueMode: false,
    lastLobby: 'starter',
    games: {},
    settings: { lang: 'en', animations: true, sound: false, hints: true },
    created: Date.now(),
  };
}

export function defaultGameStats() {
  return {
    rating: DEFAULT_RATING,
    peak: DEFAULT_RATING,
    played: 0,
    won: 0,
    lost: 0,
    streak: 0,
    bestStreak: 0,
    biggestWin: 0,
    biggestLoss: 0,
    bombs: 0,
    springs: 0,
    asLandlord: 0,
    landlordWins: 0,
  };
}

export function loadProfile() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schema === SCHEMA) return migrate(parsed);
    }
  } catch {
    /* storage unavailable: fall through to a fresh profile */
  }
  return memoryFallback ?? defaultProfile();
}

export function saveProfile(profile) {
  memoryFallback = profile;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(profile));
  } catch {
    /* nothing to do: the in-memory copy above keeps the session going */
  }
  return profile;
}

export function resetProfile() {
  return saveProfile(defaultProfile());
}

function migrate(profile) {
  const base = defaultProfile();
  return {
    ...base,
    ...profile,
    settings: { ...base.settings, ...(profile.settings ?? {}) },
    games: profile.games ?? {},
  };
}

export function gameStats(profile, gameId) {
  if (!profile.games[gameId]) profile.games[gameId] = defaultGameStats();
  else profile.games[gameId] = { ...defaultGameStats(), ...profile.games[gameId] };
  return profile.games[gameId];
}

/**
 * Fold one finished game into the profile: chips, rescue state, Elo, counters.
 *
 * @param {object} profile
 * @param {object} args
 * @param {string} args.gameId
 * @param {number} args.delta        chips won or lost, already capped
 * @param {boolean} args.won
 * @param {number} args.botElo
 * @param {object} [args.extra]      { asLandlord, bombs, spring }
 * @returns {{profile: object, elo: object, bankrollChange: object}}
 */
export function recordResult(profile, { gameId, delta, won, botElo, extra = {} }) {
  const stats = gameStats(profile, gameId);
  const elo = updateRating({
    rating: stats.rating,
    opponents: [botElo, botElo],
    score: won ? 1 : 0,
    gamesPlayed: stats.played,
  });
  stats.rating = elo.rating;
  stats.peak = Math.max(stats.peak, elo.rating);
  stats.played += 1;
  if (won) {
    stats.won += 1;
    stats.streak = stats.streak > 0 ? stats.streak + 1 : 1;
    stats.biggestWin = Math.max(stats.biggestWin, delta);
  } else {
    stats.lost += 1;
    stats.streak = stats.streak < 0 ? stats.streak - 1 : -1;
    stats.biggestLoss = Math.min(stats.biggestLoss, delta);
  }
  stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
  stats.bombs += extra.bombs ?? 0;
  stats.springs += extra.spring ? 1 : 0;
  if (extra.asLandlord) {
    stats.asLandlord += 1;
    if (won) stats.landlordWins += 1;
  }

  const bankrollChange = applyToBankroll(profile.bankroll, delta, profile.rescueMode);
  profile.bankroll = bankrollChange.bankroll;
  profile.rescueMode = bankrollChange.rescueMode;
  saveProfile(profile);
  return { profile, elo, bankrollChange };
}

/** Called on start-up: a profile loaded below the threshold belongs in rescue. */
export function reconcileRescue(profile) {
  if (!profile.rescueMode && isBankrupt(profile.bankroll)) profile.rescueMode = true;
  return profile;
}
