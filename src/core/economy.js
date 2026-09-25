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
 *    (2 by default) — a real factor, not a floor applied after the fact — and is
 *    then multiplied by the points called, by each bomb or rocket, and by a
 *    spring. The engine reports the finished number; settleDouDiZhu trusts it
 *    outright. Because the base is baked in from the start, a bomb on even a
 *    timid 1-point call visibly doubles what is on the table, instead of
 *    vanishing behind a floor that was already higher than the raw number.
 *
 * 3. A single hand moves at most HAND_CAP_FACTOR pots, in either direction. The
 *    landlord's exposure is 2 x multiplier pots, so a 100-pot ceiling only bites
 *    above a multiplier of 50 — four bombs on a 3-point call, or three bombs and
 *    a spring. It is a backstop against an absurd chain, not a routine clamp.
 *    (HAND_CAP_FACTOR was doubled from 50 alongside the multiplier itself: since
 *    the base is now a real factor rather than a floor, an ordinary game with a
 *    bomb or two settles at roughly twice the multiplier it used to, and the
 *    ceiling had to move with it or it would start biting on ordinary hands.)
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
 *
 * 5. Every threshold is counted in pots rather than set by hand, so the ladder
 *    stays in step with itself: a stack is STARTING_STACK_MULTIPLE pots, sitting
 *    down needs ENTRY_POTS of them, and the rescue table releases you at exactly
 *    the point the cheapest normal table will have you.
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

/**
 * No single game may take more than this share of the bankroll. Raised from
 * 0.6: at 0.75 a pair of bad landlord hands from a fresh stack really does put
 * you on the rescue table, which is the risk that makes the rest mean anything.
 *
 * Left alone when the multiplier stopped treating the base as a floor: it is a
 * fraction of the bankroll, not of a pot count, so it does not move just
 * because the multiplier's arithmetic changed underneath it.
 */
export const MAX_LOSS_FRACTION = 0.75;

/**
 * Pots you must hold to sit down at a table.
 *
 * Six is not a taste: it is the smallest number at which an ordinary hand is
 * settled in full. A landlord at the base x2 multiplier risks 4 pots — the
 * pre-bidding base times the landlord's double, unchanged by the multiplier
 * rework — and the bankroll cap allows MAX_LOSS_FRACTION of the stack, so at
 * five pots or fewer (0.75 x 5 = 3.75 pots) the emergency cap fires on a
 * perfectly normal loss.
 * A table you cannot lose an ordinary hand at is a table you should not be
 * sitting at, and the cap should be for disasters, not for Tuesdays.
 */
export const ENTRY_POTS = 6;

/** Below one pot at the cheapest table you cannot play at all: bankrupt. */
export const BANKRUPT_THRESHOLD = STARTER_POT;

/**
 * Leave the rescue table at exactly the point you can sit at the cheapest
 * normal one. Holding anybody in rescue past that is pointless, and releasing
 * them before it only sends them straight back: the old threshold of two pots
 * handed a player a stack that one ordinary landlord hand took most of.
 * About a dozen net hands at the 400 pot, which is a stint rather than a
 * sentence.
 */
export const RESCUE_EXIT = STARTER_POT * ENTRY_POTS;

/**
 * The most one hand can move, as a multiple of the pot, win or lose. Uniform
 * across the ladder: the bankroll cap already scales the protection with what a
 * player actually holds, so a second sliding scale would only obscure it.
 *
 * Doubled from 50 when the multiplier stopped treating the base as a floor and
 * started treating it as a real factor: the
 * same game now reports roughly twice the multiplier it used to, so the ceiling
 * has to rise with it to keep landing on the same hands (freak chains of bombs)
 * rather than starting to bite on an ordinary bomb or two.
 */
export const HAND_CAP_FACTOR = 100;

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

/** @type {Omit<Lobby, 'entry'>[]} */
const LOBBY_DEFS = [
  { id: 'rescue', name: 'Rescue Table', short: '400', pot: 400, baseMultiplier: 2, capFactor: HAND_CAP_FACTOR, skill: 'novice', botElo: 800, rescue: true,
    blurb: 'No entry fee, no bankruptcy. Grind back to 2,000 and you are out of here.' },
  { id: 'starter', name: 'Starter Room', short: '1K', pot: STARTER_POT, baseMultiplier: 2, capFactor: HAND_CAP_FACTOR, skill: 'casual', botElo: 1_000,
    blurb: 'The default table. Bots play a loose social game.' },
  { id: 'bronze', name: 'Bronze Hall', short: '10K', pot: 10_000, baseMultiplier: 2, capFactor: HAND_CAP_FACTOR, skill: 'steady', botElo: 1_200,
    blurb: 'Bots stop throwing away kickers and start defending as a pair.' },
  { id: 'silver', name: 'Silver Hall', short: '50K', pot: 50_000, baseMultiplier: 2, capFactor: HAND_CAP_FACTOR, skill: 'sharp', botElo: 1_400,
    blurb: 'Bots count the played pile from here up.' },
  { id: 'gold', name: 'Gold Salon', short: '100K', pot: 100_000, baseMultiplier: 2, capFactor: HAND_CAP_FACTOR, skill: 'expert', botElo: 1_600,
    blurb: 'Tight bidding, disciplined bombs, punishing endgames.' },
  { id: 'ruby', name: 'Ruby Salon', short: '500K', pot: 500_000, baseMultiplier: 2, capFactor: HAND_CAP_FACTOR, skill: 'master', botElo: 1_800,
    blurb: 'Rarely misreads a hand. Expect to be squeezed.' },
  { id: 'legend', name: 'Legend Table', short: '1M', pot: 1_000_000, baseMultiplier: 2, capFactor: HAND_CAP_FACTOR, skill: 'grandmaster', botElo: 2_000,
    blurb: 'Near the ceiling of the evaluation. It still errs, about one move in thirty.' },
];

/**
 * Entry is derived, so the ladder cannot drift out of step with ENTRY_POTS the
 * way a hand-written column did. The rescue table has no entry at all: it is
 * where you go when you can afford nothing.
 */
export const LOBBIES = LOBBY_DEFS.map((lobby) => ({
  ...lobby,
  entry: lobby.rescue ? 0 : lobby.pot * ENTRY_POTS,
}));

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
  // The engine already factors in the lobby's base multiplier (it is passed
  // in as baseMultiplier when the game is created), so result.multiplier is
  // the real number, not a value that still needs a floor applied to it.
  const multiplier = result.multiplier;
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
