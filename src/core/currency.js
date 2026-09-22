/**
 * What the money at a table is called.
 *
 * Single player is one closed play-money economy: a persistent purse of Chips
 * with an Elo rating attached to it.
 *
 * A local network room is a different thing entirely. Its money is temporary
 * and belongs to the room — dealt out by the host when the room opens, gone when
 * the room closes, never touching anybody's purse. So a room keeps score in
 * coins, and the host picks which: silver for a quick game, gold for a heavy
 * one. There is deliberately no real currency here and no exchange rate
 * anywhere: nothing in this app represents money, and nothing can be moved off
 * the device.
 *
 * Gold and silver are the same arithmetic. What differs is the scale a table
 * opens at — silver 10 against a stack of 100, gold 1,000 against 10,000 — and
 * both open at the same ratio of stack to pot as the single-player starter
 * table, so the game plays identically whichever coin is on the felt. The host
 * can override either number.
 *
 * Amounts are whole units. Card-game stakes are counted, not measured, and
 * integer arithmetic keeps settlement exact — no rounding drift between seats.
 */

/**
 * @typedef {object} Currency
 * @property {string} code
 * @property {string} name      as it appears in the picker
 * @property {string} label     the short word for a HUD pill or column heading
 * @property {string} unit      appended to a standalone amount ('' for chips)
 * @property {string} tint      CSS custom property holding its colour
 * @property {number} [suggestedPot]
 * @property {number} [suggestedStack]
 * @property {boolean} [room]   offered to a room host
 */

/** @type {Currency[]} */
export const CURRENCIES = [
  {
    code: 'chips',
    name: 'Chips',
    label: 'Chips',
    unit: '',
    tint: 'var(--gold)',
  },
  {
    code: 'silver',
    name: 'Silver coins',
    label: 'Silver',
    unit: 'silver',
    tint: 'var(--silver)',
    suggestedPot: 10,
    suggestedStack: 100,
    room: true,
  },
  {
    code: 'gold',
    name: 'Gold coins',
    label: 'Gold',
    unit: 'gold',
    tint: 'var(--gold-bright)',
    suggestedPot: 1_000,
    suggestedStack: 10_000,
    room: true,
  },
];

/** The coins a room host may choose between. */
export const ROOM_CURRENCIES = CURRENCIES.filter((c) => c.room);
/** Single player is always this. */
export const SOLO_CURRENCY = 'chips';
/** A new room opens on silver: small numbers, quick games. */
export const DEFAULT_ROOM_CURRENCY = 'silver';

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export function currencyByCode(code) {
  return BY_CODE.get(String(code ?? '').toLowerCase()) ?? BY_CODE.get(SOLO_CURRENCY);
}

export function isCurrency(code) {
  return BY_CODE.has(String(code ?? '').toLowerCase());
}

/** Only a coin may be a room's currency; the solo purse is not on offer. */
export function isRoomCurrency(code) {
  return ROOM_CURRENCIES.some((c) => c.code === String(code ?? '').toLowerCase());
}

/** 1234567 -> "1,234,567"; compact: 1_500_000 -> "1.5M", 50_000 -> "50K". */
export function formatAmount(value, compact = false) {
  const n = Math.round(value);
  if (!compact) return n.toLocaleString('en-GB');
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}${trim(abs / 1_000)}K`;
  return n.toLocaleString('en-GB');
}

function trim(x) {
  return (Math.round(x * 10) / 10).toString();
}

/**
 * An amount with its unit, for anywhere the coin is not already named nearby.
 * @param {number} value
 * @param {string} [code]
 * @param {boolean} [compact]
 */
export function formatMoney(value, code = SOLO_CURRENCY, compact = false) {
  const currency = currencyByCode(code);
  const amount = formatAmount(value, compact);
  return currency.unit ? `${amount} ${currency.unit}` : amount;
}

/** The short word to put on a HUD pill or a column heading. */
export function currencyLabel(code) {
  return currencyByCode(code).label;
}

/** The colour a table paints its money in. */
export function currencyTint(code) {
  return currencyByCode(code).tint;
}

/** What a room of this coin should open with, before the host edits anything. */
export function suggestedStakes(code) {
  const currency = currencyByCode(code);
  return {
    pot: currency.suggestedPot ?? 1_000,
    startingChips: currency.suggestedStack ?? 10_000,
  };
}
