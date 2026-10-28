/**
 * Texas Hold'em's stake ladder.
 *
 * Dou Di Zhu and Big Two price a table by its pot: everyone antes the same
 * entry and the hand's swing is a multiple of it. Hold'em has no such number.
 * What a player can lose in one hand is whatever they sit down with, so a
 * table here is defined by its blinds and you pick a buy-in on sitting down.
 * The buy-in is capped at 100 big blinds, the usual cash-game ceiling, so a
 * deep bankroll cannot walk into a low table and bully it with a stack far
 * bigger than anyone else's, and it is never more than the bankroll itself.
 * A table is locked until the bankroll covers the 20 big blind minimum.
 */

import { formatChips } from '../../core/economy.js';

export const MAX_BUYIN_BB = 100;
export const MIN_BUYIN_BB = 20;

export const TABLES = [
  { id: 'micro', name: 'Micro Stakes', sb: 10, bb: 20, skill: 'casual', blurb: 'Small blinds and loose, friendly bots. A good place to learn the betting.' },
  { id: 'low', name: 'Low Stakes', sb: 50, bb: 100, skill: 'steady', blurb: 'Bots that fold their weak hands and call when they have something.' },
  { id: 'club', name: 'Club Game', sb: 250, bb: 500, skill: 'sharp', blurb: 'Sharper bots that notice when you only bet big with a strong hand.' },
  { id: 'high', name: 'High Stakes', sb: 1_000, bb: 2_000, skill: 'expert', blurb: 'Expert bots and blinds that cost real chips every orbit.' },
  { id: 'vip', name: 'VIP Room', sb: 5_000, bb: 10_000, skill: 'expert', blurb: 'The biggest blinds in the house, against the toughest bots.' },
];

export function tableById(id) {
  return TABLES.find((t) => t.id === id) ?? null;
}

export function minBuyIn(table) {
  return table.bb * MIN_BUYIN_BB;
}

/** What you sit down with: a full 100 big blinds, or the whole bankroll if that is less. */
export function buyIn(table, bankroll) {
  return Math.min(bankroll, table.bb * MAX_BUYIN_BB);
}

export function tableAccess(bankroll) {
  return TABLES.map((table) => {
    const locked = bankroll < minBuyIn(table);
    return { table, locked, reason: locked ? `Needs ${formatChips(minBuyIn(table))} to sit down` : '' };
  });
}
