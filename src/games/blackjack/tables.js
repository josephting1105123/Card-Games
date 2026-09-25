/**
 * Blackjack's own stake ladder.
 *
 * Dou Di Zhu prices a table by its pot (economy.js); Blackjack bets are a
 * single number per hand instead, so it gets its own min/max ladder rather
 * than reusing economy.js's pot lobbies. A table is locked until the
 * bankroll can survive ten minimum bets — the same "an ordinary loss should
 * not knock you off the table" idea economy.js uses for Dou Di Zhu's entry
 * fee, applied to Blackjack's own numbers.
 */

import { formatChips } from '../../core/economy.js';

export const ENTRY_MULTIPLE = 10;

export const TABLES = [
  { id: 'low', name: 'Low Roller', min: 100, max: 1_000 },
  { id: 'club', name: 'Club Table', min: 1_000, max: 10_000 },
  { id: 'high', name: 'High Roller', min: 10_000, max: 100_000 },
  { id: 'vip', name: 'VIP Room', min: 100_000, max: 1_000_000 },
  { id: 'whale', name: 'Whale Room', min: 1_000_000, max: 10_000_000 },
];

export function tableById(id) {
  return TABLES.find((t) => t.id === id) ?? null;
}

export function tableEntry(table) {
  return table.min * ENTRY_MULTIPLE;
}

export function tableAccess(bankroll) {
  return TABLES.map((table) => {
    const entry = tableEntry(table);
    const locked = bankroll < entry;
    return { table, locked, reason: locked ? `Needs ${formatChips(entry)} to sit down` : '' };
  });
}

/**
 * Chip denominations for the bet selector: the table's minimum and a few
 * round multiples of it, capped at the table's maximum.
 */
export function chipDenominations(table) {
  const steps = [1, 5, 10, 25, 100];
  const chips = steps.map((s) => table.min * s).filter((v) => v <= table.max);
  if (chips[chips.length - 1] !== table.max) chips.push(table.max);
  return [...new Set(chips)];
}
