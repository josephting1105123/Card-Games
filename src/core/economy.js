/**
 * Chips, lobbies, loss caps and the bankruptcy rescue table.
 *
 * Design decisions worth stating, because they are choices and not facts:
 *
 * 1. A lobby is priced by "pot per person" — the stake each of the three seats
 *    puts up. Dou Di Zhu settles asymmetrically: each farmer pays or receives one
 *    stake, and the landlord pays or receives two.
 *
 * 2. Every game carries a multiplier. It starts at the lobby's base multiplier
 *    (2 by default) and is raised by the points called, by each bomb or rocket,
 *    and by a spring. The engine reports its own multiplier; the base acts as a
 *    floor so a timid 1-point hand still settles at x2.
 *
 * 3. Loss is capped twice: by lobby (pot x capFactor) and by bankroll (you never
 *    lose more than MAX_LOSS_FRACTION of what you hold). The second cap is the
 *    one that actually protects a player who walks into the 1M table — it means
 *    a single disastrous hand cannot wipe you out, so the high lobbies are
 *    playable without fear. Winnings are not capped.
 *
 * 4. Bankruptcy is still reachable, because a run of capped losses grinds the
 *    bankroll below the cheapest normal lobby. At that point the player is moved
 *    to the rescue table: a 400 pot against the weakest bot, where losses cannot
 *    take the balance below zero, until the balance reaches RESCUE_EXIT.
 */

import { SOLO_CURRENCY, formatMoney } from './currency.js';

export const STARTING_BANKROLL = 10_000;
/** Below this you cannot afford the cheapest normal lobby, so you are bankrupt. */
export const BANKRUPT_THRESHOLD = 1_000;
/** Leave the rescue table once you hold this much. */
export const RESCUE_EXIT = 2_000;
/** No single game may take more than this share of the bankroll. */
export const MAX_LOSS_FRACTION = 0.6;

/**
 * @typedef {object} Lobby
 * @property {string} id
 * @property {string} name
 * @property {number} pot          stake per person
 * @property {number} baseMultiplier floor on the game multiplier
 * @property {number} entry        bankroll needed to sit down
 * @property {number} capFactor    per-game loss cap, as a multiple of the pot
 * @property {string} skill        bot skill profile (see games/doudizhu/ai.js)
 * @property {number} botElo       rating the bots are treated as holding
 * @property {boolean} [rescue]    the bankruptcy table
 */

/** @type {Lobby[]} */
export const LOBBIES = [
  { id: 'rescue', name: 'Rescue Table', short: '400', pot: 400, baseMultiplier: 2, entry: 0, capFactor: Infinity, skill: 'novice', botElo: 800, rescue: true,
    blurb: 'No entry fee, no bankruptcy. Grind back to 2,000 and you are out of here.' },
  { id: 'starter', name: 'Starter Room', short: '1K', pot: 1_000, baseMultiplier: 2, entry: 1_000, capFactor: 6, skill: 'casual', botElo: 1_000,
    blurb: 'The default table. Bots play a loose social game.' },
  { id: 'bronze', name: 'Bronze Hall', short: '10K', pot: 10_000, baseMultiplier: 2, entry: 12_000, capFactor: 4, skill: 'steady', botElo: 1_200,
    blurb: 'Bots stop throwing away kickers and start defending as a pair.' },
  { id: 'silver', name: 'Silver Hall', short: '50K', pot: 50_000, baseMultiplier: 2, entry: 60_000, capFactor: 3, skill: 'sharp', botElo: 1_400,
    blurb: 'Bots count the played pile from here up.' },
  { id: 'gold', name: 'Gold Salon', short: '100K', pot: 100_000, baseMultiplier: 2, entry: 120_000, capFactor: 3, skill: 'expert', botElo: 1_600,
    blurb: 'Tight bidding, disciplined bombs, punishing endgames.' },
  { id: 'ruby', name: 'Ruby Salon', short: '500K', pot: 500_000, baseMultiplier: 2, entry: 600_000, capFactor: 2.5, skill: 'master', botElo: 1_800,
    blurb: 'Rarely misreads a hand. Expect to be squeezed.' },
  { id: 'legend', name: 'Legend Table', short: '1M', pot: 1_000_000, baseMultiplier: 2, entry: 1_200_000, capFactor: 2, skill: 'grandmaster', botElo: 2_000,
    blurb: 'Near the ceiling of the evaluation. It still errs, about one move in thirty.' },
];

export const NORMAL_LOBBIES = LOBBIES.filter((l) => !l.rescue);
export const RESCUE_LOBBY = LOBBIES.find((l) => l.rescue);

export function lobbyById(id) {
  return LOBBIES.find((l) => l.id === id) ?? null;
}

export function isBankrupt(bankroll) {
  return bankroll < BANKRUPT_THRESHOLD;
}

/**
 * Which lobby the player is actually allowed into, and why not otherwise.
 * @param {number} bankroll
 * @param {boolean} rescueMode
 */
export function lobbyAccess(bankroll, rescueMode) {
  if (rescueMode) {
    return LOBBIES.map((lobby) => ({
      lobby,
      locked: !lobby.rescue,
      reason: lobby.rescue ? '' : `Reach ${formatChips(RESCUE_EXIT)} to leave the rescue table`,
    }));
  }
  return LOBBIES.map((lobby) => ({
    lobby,
    locked: lobby.rescue ? bankroll >= BANKRUPT_THRESHOLD : bankroll < lobby.entry,
    reason: lobby.rescue
      ? 'Only open when you are bankrupt'
      : bankroll < lobby.entry
        ? `Needs ${formatChips(lobby.entry)} to sit down`
        : '',
  }));
}

/**
 * Work out the chips changing hands for one finished Dou Di Zhu game.
 *
 * @param {object} args
 * @param {Lobby} args.lobby
 * @param {{landlordWon: boolean, landlordSeat: number, multiplier: number}} args.result engine result
 * @param {number} args.seat        the human seat
 * @param {number} args.bankroll    before settling
 * @param {boolean} [args.rescueMode]
 * @returns {{delta: number, gross: number, capped: boolean, multiplier: number, stake: number, won: boolean, cap: number}}
 */
export function settleDouDiZhu({ lobby, result, seat, bankroll, rescueMode = false }) {
  const multiplier = Math.max(result.multiplier, lobby.baseMultiplier);
  const stake = lobby.pot * multiplier;
  const isLandlord = seat === result.landlordSeat;
  const magnitude = isLandlord ? stake * 2 : stake;
  const won = isLandlord === result.landlordWon;
  const gross = won ? magnitude : -magnitude;

  if (won) {
    return { delta: gross, gross, capped: false, multiplier, stake, won, cap: Infinity };
  }

  const cap = lossCap(lobby, bankroll, rescueMode);
  const delta = -Math.min(magnitude, cap);
  return { delta, gross, capped: delta !== gross, multiplier, stake, won, cap };
}

/**
 * The most a player can lose in one game. At the rescue table the only limit is
 * the balance itself, which is what "unlimited money" means there: you can keep
 * sitting down, you just cannot go negative.
 */
export function lossCap(lobby, bankroll, rescueMode) {
  if (rescueMode || lobby.rescue) return Math.max(0, bankroll);
  const byLobby = lobby.pot * lobby.capFactor;
  const byBankroll = Math.floor(Math.max(0, bankroll) * MAX_LOSS_FRACTION);
  return Math.max(0, Math.min(byLobby, byBankroll));
}

/**
 * Apply a settlement to a bankroll and report the resulting rescue state.
 * @returns {{bankroll: number, rescueMode: boolean, wentBankrupt: boolean, leftRescue: boolean}}
 */
export function applyToBankroll(bankroll, delta, rescueMode) {
  let next = bankroll + delta;
  if (rescueMode && next < 0) next = 0;
  let nextRescue = rescueMode;
  let wentBankrupt = false;
  let leftRescue = false;
  if (rescueMode) {
    if (next >= RESCUE_EXIT) {
      nextRescue = false;
      leftRescue = true;
    }
  } else if (isBankrupt(next)) {
    nextRescue = true;
    wentBankrupt = true;
    if (next < 0) next = 0;
  }
  return { bankroll: next, rescueMode: nextRescue, wentBankrupt, leftRescue };
}

/**
 * Single-player amounts, which are always plain chips. A local network room has
 * its own currency and formats with formatMoney() from core/currency.js.
 */
export function formatChips(value, compact = false) {
  return formatMoney(value, SOLO_CURRENCY, compact);
}
