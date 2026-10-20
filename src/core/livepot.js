/**
 * The "what could change hands right now" figure shown on the tables. Pure
 * arithmetic, so a test can pin it.
 */

import { HAND_CAP_FACTOR, lossCap } from './economy.js';

/**
 * Dou Di Zhu: the most one hand can move at the current multiplier. The landlord
 * stakes twice what a farmer does, and the hand ceiling is per hand rather than
 * per seat, so it is not doubled.
 *
 * Given the seats' stacks (a room knows them) the figure also respects the
 * loss cap each loser is held to, and reports the bigger of the two outcomes,
 * since nobody knows yet who will win.
 * @param {number} pot
 * @param {number} multiplier
 * @param {number} [capFactor]
 * @param {{landlord: number, farmers: number[]}|null} [stacks]
 */
export function livePotDdz(pot, multiplier, capFactor = HAND_CAP_FACTOR, stacks = null) {
  const stake = pot * multiplier;
  const ceiling = pot * capFactor;
  if (!stacks) return Math.min(2 * stake, ceiling);
  const lobby = { pot, capFactor };
  const landlordWin = Math.min(
    stacks.farmers.reduce((sum, stack) => sum + Math.min(stake, lossCap(lobby, stack, false)), 0),
    2 * stake,
    ceiling,
  );
  const farmersWin = Math.min(2 * stake, lossCap(lobby, stacks.landlord, false), ceiling);
  return Math.max(landlordWin, farmersWin);
}

/**
 * Big Two: every loser pays `rate` per card left, and the winner has none, so
 * the winner collects the cards held by everyone but the player with the
 * fewest.
 * @param {number} rate
 * @param {number[]} counts cards left per seat
 */
export function livePotBig2(rate, counts) {
  if (!counts.length) return 0;
  const total = counts.reduce((sum, n) => sum + n, 0);
  return rate * (total - Math.min(...counts));
}
