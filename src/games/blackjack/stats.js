/**
 * Fold one finished Blackjack round into the profile.
 *
 * Dou Di Zhu's recordResult() (core/profile.js) always updates an Elo rating,
 * and Blackjack carries none — a solo player against fixed house rules has no
 * opponent rating to converge on. This is the same bankroll bookkeeping
 * (applyToBankroll, saveProfile) with played/won/net counted instead.
 */

import { applyToBankroll } from '../../core/economy.js';
import { gameStats, saveProfile } from '../../core/profile.js';

/**
 * @param {object} profile
 * @param {string} gameId
 * @param {number} delta  net chips this round, already signed
 */
export function recordBlackjackResult(profile, gameId, delta) {
  const stats = gameStats(profile, gameId);
  stats.played += 1;
  stats.net = (stats.net ?? 0) + delta;
  if (delta > 0) {
    stats.won += 1;
    stats.streak = stats.streak > 0 ? stats.streak + 1 : 1;
    stats.biggestWin = Math.max(stats.biggestWin, delta);
  } else if (delta < 0) {
    stats.lost += 1;
    stats.streak = stats.streak < 0 ? stats.streak - 1 : -1;
    stats.biggestLoss = Math.min(stats.biggestLoss, delta);
  }
  stats.bestStreak = Math.max(stats.bestStreak, Math.abs(stats.streak));

  const bankrollChange = applyToBankroll(profile.bankroll, delta, profile.rescueMode);
  profile.bankroll = bankrollChange.bankroll;
  profile.rescueMode = bankrollChange.rescueMode;
  saveProfile(profile);
  return { stats, bankrollChange };
}
