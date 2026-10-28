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
 * @returns {{stats: object, bankrollChange: object, applied: number}} applied is
 *   what actually moved the bankroll, which differs from delta when the rescue
 *   table floors a loss at zero.
 */
export function recordBlackjackResult(profile, gameId, delta) {
  const before = profile.bankroll;
  const bankrollChange = applyToBankroll(before, delta, profile.rescueMode);
  const applied = bankrollChange.bankroll - before;

  // Win/loss and streaks follow the round; the money figures follow the chips
  // that really moved, so a loss the rescue table absorbed is not booked.
  const stats = gameStats(profile, gameId);
  stats.played += 1;
  stats.net = (stats.net ?? 0) + applied;
  if (delta > 0) {
    stats.won += 1;
    stats.streak = stats.streak > 0 ? stats.streak + 1 : 1;
    stats.biggestWin = Math.max(stats.biggestWin, applied);
  } else if (delta < 0) {
    stats.lost += 1;
    stats.streak = stats.streak < 0 ? stats.streak - 1 : -1;
    stats.biggestLoss = Math.min(stats.biggestLoss, applied);
  }
  stats.bestStreak = Math.max(stats.bestStreak, Math.abs(stats.streak));

  profile.bankroll = bankrollChange.bankroll;
  profile.rescueMode = bankrollChange.rescueMode;
  saveProfile(profile);
  return { stats, bankrollChange, applied };
}
