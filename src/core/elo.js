/**
 * Elo ratings, one rating per game.
 *
 * Standard Elo: expected score E = 1 / (1 + 10^((Rb - Ra)/400)), and the update
 * is R' = R + K(S - E). Dou Di Zhu is three-handed, so the opponents' mean
 * rating stands in for a single opponent — crude, but it keeps one number per
 * game readable and comparable across lobbies, which is the point of showing it.
 *
 * K falls as the rating rises so a settled rating stops swinging:
 *   < 2100 -> 32,  < 2400 -> 24,  otherwise 16.
 * The first PROVISIONAL_GAMES games use a larger K so a new player converges
 * quickly instead of grinding up from 1200.
 */

export const DEFAULT_RATING = 1_200;
export const PROVISIONAL_GAMES = 10;
export const PROVISIONAL_K = 48;

export function expectedScore(rating, opponentRating) {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

export function kFactor(rating, gamesPlayed = PROVISIONAL_GAMES) {
  if (gamesPlayed < PROVISIONAL_GAMES) return PROVISIONAL_K;
  if (rating < 2_100) return 32;
  if (rating < 2_400) return 24;
  return 16;
}

/**
 * @param {object} args
 * @param {number} args.rating
 * @param {number|number[]} args.opponents one rating, or several to average
 * @param {number} args.score 1 win, 0 loss, 0.5 draw
 * @param {number} [args.gamesPlayed]
 * @returns {{rating: number, delta: number, expected: number, k: number}}
 */
export function updateRating({ rating, opponents, score, gamesPlayed = PROVISIONAL_GAMES }) {
  const list = Array.isArray(opponents) ? opponents : [opponents];
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  const expected = expectedScore(rating, mean);
  const k = kFactor(rating, gamesPlayed);
  const delta = Math.round(k * (score - expected));
  return { rating: rating + delta, delta, expected, k };
}

/** Rough label for a rating, purely cosmetic. */
export function ratingTitle(rating) {
  if (rating < 1_000) return 'Beginner';
  if (rating < 1_200) return 'Novice';
  if (rating < 1_400) return 'Club Player';
  if (rating < 1_600) return 'Strong Club';
  if (rating < 1_800) return 'Expert';
  if (rating < 2_000) return 'Candidate Master';
  if (rating < 2_200) return 'Master';
  return 'Grandmaster';
}
