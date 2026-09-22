/**
 * Chips, lobbies, loss caps and the bankruptcy rescue table.
 *
 * Design decisions worth stating, because they are choices and not facts:
 *
 * 1. A lobby is priced by "pot per person" — the stake each of the three seats
 *    puts up. Dou Di Zhu settles asymmetrically: each farmer pays or receives one
 *    stake, and the landlord pays or receives two. A stack is always
 *    STARTING_STACK_MULTIPLE pots, so the shape of the game does not change
 *    between tables, only the size of the numbers.
 *
 * 2. Every game carries a multiplier. It starts at the lobby's base multiplier
 *    (2 by default) and is raised by the points called, by each bomb or rocket,
 *    and by a spring. The engine reports its own multiplier; the base acts as a
 *    floor so a timid 1-point hand still settles at x2.
 *
 * 3. A single hand moves at most HAND_CAP_FACTOR pots, in either direction. The
 *    landlord's exposure is 2 x multiplier pots, so a 50-pot ceiling only bites
 *    above a multiplier of 32 — three bombs and a spring on a 3-point call. It
 *    is a backstop against an absurd chain, not a routine clamp.
 *
 *    This matters more than it sounds. An earlier version capped at 6 pots,
 *    which bites above a multiplier of 4: every bomb past the first paid
 *    nothing, so the whole doubling mechanic was decoration. A cap that binds on
 *    ordinary hands makes winning flat and losing riskless at the same time.
 *
 * 3b. Losses are capped a second time, by bankroll: no hand takes more than
 *    MAX_LOSS_FRACTION of what you hold. That is what makes the 1M table
 *    playable — one disastrous hand cannot wipe you out. It is deliberately not
 *    applied to winnings, because a win you could not afford to lose is exactly
 *    the win worth having.
 *
 * 4. Bankruptcy is still reachable, because a run of capped losses grinds the
 *    bankroll below the cheapest normal lobby. At that point the player is moved
 *    to the rescue table: a 400 pot against the weakest bot, where losses cannot
 *    take the balance below zero, until the balance reaches RESCUE_EXIT.
 */

import { SOLO_CURRENCY, formatMoney, suggestedPot } from './currency.js';

/**
 * A stack is this many pots, everywhere: the single-player purse you start
 * with, and the stack a network room deals out. One number so that the swing of
 * a hand means the same thing at every table — a landlord at the base x2
 * multiplier is risking 4 pots, which is a sixth of the stack whichever table
 * it is.
 */
export const STARTING_STACK_MULTIPLE = 25;

/** The cheapest normal table, and the pot the opening purse is measured in. */
export const STARTER_POT = 1_000;

export const STARTING_BANKROLL = STARTER_POT * STARTING_STACK_MULTIPLE;
/** Below this you cannot afford the cheapest normal lobby, so you are bankrupt. */
export const BANKRUPT_THRESHOLD = 1_000;
/** Leave the rescue table once you hold this much. */
export const RESCUE_EXIT = 2_000;
/**
 * No single game may take more than this share of the bankroll. Raised from
 * 0.6: at 0.75 a pair of bad landlord hands from a fresh stack really does put
 * you on the rescue table, which is the risk that makes the rest mean anything.
 */
export const MAX_LOSS_FRACTION = 0.75;

/**
 * The most one hand can move, as a multiple of the pot, win or lose. Uniform
 * across the ladder: the bankroll cap already scales the protection with what a
 * player actually holds, so a second sliding scale would only obscure it.
 */
export const HAND_CAP_FACTOR = 50;

/**
 * @typedef {object} Lobby
 * @property {string} id
 * @property {string} name
 * @property {number} pot          stake per person
 * @property {number} baseMultiplier floor on the game multiplier
 * @property {number} entry        bankroll needed to sit down
 * @property {number} capFactor    per-game ceiling, as a multiple of the pot
 * @property {string} skill        bot skill profile (see games/doudizhu/ai.js)
 * @property {number} botElo       rating the bots are treated as holding
 * @property {boolean} [rescue]    the bankruptcy table
 */

/** @type {Lobby[]} */
export const LOBBIES = [
  { id: 'rescue', name: 'Rescue Table', short: '400', pot: 400, baseMultiplier: 2, entry: 0, capFactor: HAND_CAP_FACTOR, skill: 'novice', botElo: 800, rescue: true,
    blurb: 'No entry fee, no bankruptcy. Grind back to 2,000 and you are out of here.' },
  { id: 'starter', name: 'Starter Room', short: '1K', pot: STARTER_POT, baseMultiplier: 2, entry: STARTER_POT, capFactor: HAND_CAP_FACTOR, skill: 'casual', botElo: 1_000,
    blurb: 'The default table. Bots play a loose social game.' },
  { id: 'bronze', name: 'Bronze Hall', short: '10K', pot: 10_000, baseMultiplier: 2, entry: 12_000, capFactor: HAND_CAP_FACTOR, skill: 'steady', botElo: 1_200,
    blurb: 'Bots stop throwing away kickers and start defending as a pair.' },
  { id: 'silver', name: 'Silver Hall', short: '50K', pot: 50_000, baseMultiplier: 2, entry: 60_000, capFactor: HAND_CAP_FACTOR, skill: 'sharp', botElo: 1_400,
    blurb: 'Bots count the played pile from here up.' },
  { id: 'gold', name: 'Gold Salon', short: '100K', pot: 100_000, baseMultiplier: 2, entry: 120_000, capFactor: HAND_CAP_FACTOR, skill: 'expert', botElo: 1_600,
    blurb: 'Tight bidding, disciplined bombs, punishing endgames.' },
  { id: 'ruby', name: 'Ruby Salon', short: '500K', pot: 500_000, baseMultiplier: 2, entry: 600_000, capFactor: HAND_CAP_FACTOR, skill: 'master', botElo: 1_800,
    blurb: 'Rarely misreads a hand. Expect to be squeezed.' },
  { id: 'legend', name: 'Legend Table', short: '1M', pot: 1_000_000, baseMultiplier: 2, entry: 1_200_000, capFactor: HAND_CAP_FACTOR, skill: 'grandmaster', botElo: 2_000,
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
    const cap = handCap(lobby);
    const delta = Math.min(magnitude, cap);
    return { delta, gross, capped: delta !== gross, multiplier, stake, won, cap };
  }

  const cap = lossCap(lobby, bankroll, rescueMode);
  const delta = -Math.min(magnitude, cap);
  return { delta, gross, capped: delta !== gross, multiplier, stake, won, cap };
}

/**
 * What a room of this coin opens with: the coin's pot, and a stack of
 * STARTING_STACK_MULTIPLE of them.
 * @param {string} currencyCode
 */
export function suggestedStakes(currencyCode) {
  const pot = suggestedPot(currencyCode);
  return { pot, startingChips: pot * STARTING_STACK_MULTIPLE };
}

/** The stack that goes with any pot, by the same rule. */
export function stackForPot(pot) {
  return Math.max(1, Math.round(pot * STARTING_STACK_MULTIPLE));
}

/** The ceiling on one hand at this table, before any bankroll limit. */
export function handCap(lobby) {
  return lobby.pot * (lobby.capFactor ?? HAND_CAP_FACTOR);
}

/**
 * The most a player can lose in one game. At the rescue table the only limit is
 * the balance itself, which is what "unlimited money" means there: you can keep
 * sitting down, you just cannot go negative.
 */
export function lossCap(lobby, bankroll, rescueMode) {
  if (rescueMode || lobby.rescue) return Math.max(0, bankroll);
  const byBankroll = Math.floor(Math.max(0, bankroll) * MAX_LOSS_FRACTION);
  return Math.max(0, Math.min(handCap(lobby), byBankroll));
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
