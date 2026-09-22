/**
 * What the chips are called.
 *
 * Single player is always in "Chips": one closed play-money economy with its own
 * Elo, and renaming it would only confuse the purse in the corner. A local
 * network room is the opposite case — the people at the table are in the same
 * house and usually keeping score in something they already have a word for — so
 * a room picks its own currency and defaults to one that is plainly not the
 * single-player purse.
 *
 * These are labels and nothing more. The app has no payments, no transfers and
 * no way to move a balance off the device; picking "MYR" writes RM in front of a
 * number, exactly like writing it on a scorepad.
 *
 * Amounts are whole units everywhere. Card-game stakes are counted, not
 * measured, and integer arithmetic keeps settlement exact — no rounding drift
 * between the three seats.
 */

/**
 * @typedef {object} Currency
 * @property {string} code
 * @property {string} name
 * @property {string} symbol   '' when the amount stands on its own
 * @property {'prefix'|'suffix'} place
 * @property {string} [gap]    separator between symbol and amount
 */

/** @type {Currency[]} */
export const CURRENCIES = [
  { code: 'chips', name: 'Chips', symbol: '', place: 'suffix' },
  { code: 'myr', name: 'Ringgit (RM)', symbol: 'RM', place: 'prefix', gap: ' ' },
  { code: 'sgd', name: 'Singapore dollar (S$)', symbol: 'S$', place: 'prefix' },
  { code: 'usd', name: 'US dollar ($)', symbol: '$', place: 'prefix' },
  { code: 'gbp', name: 'Pound (£)', symbol: '£', place: 'prefix' },
  { code: 'eur', name: 'Euro (€)', symbol: '€', place: 'prefix' },
  { code: 'cny', name: 'Yuan (¥)', symbol: '¥', place: 'prefix' },
  { code: 'twd', name: 'Taiwan dollar (NT$)', symbol: 'NT$', place: 'prefix' },
  { code: 'points', name: 'Points', symbol: 'pts', place: 'suffix', gap: ' ' },
  { code: 'matchsticks', name: 'Matchsticks', symbol: 'sticks', place: 'suffix', gap: ' ' },
];

/** Single player always uses this. */
export const SOLO_CURRENCY = 'chips';
/** A new room starts here instead, so room money never reads as your purse. */
export const DEFAULT_ROOM_CURRENCY = 'myr';

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export function currencyByCode(code) {
  return BY_CODE.get(String(code ?? '').toLowerCase()) ?? BY_CODE.get(SOLO_CURRENCY);
}

export function isCurrency(code) {
  return BY_CODE.has(String(code ?? '').toLowerCase());
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
 * @param {number} value
 * @param {string} [code]
 * @param {boolean} [compact]
 */
export function formatMoney(value, code = SOLO_CURRENCY, compact = false) {
  const currency = currencyByCode(code);
  if (!currency.symbol) return formatAmount(value, compact);
  const gap = currency.gap ?? '';
  if (currency.place !== 'prefix') return `${formatAmount(value, compact)}${gap}${currency.symbol}`;
  // The sign belongs outside the symbol: -RM 2,500, never RM -2,500.
  const sign = Math.round(value) < 0 ? '-' : '';
  return `${sign}${currency.symbol}${gap}${formatAmount(Math.abs(value), compact)}`;
}

/** The short name to put on a column heading or a HUD pill. */
export function currencyLabel(code) {
  const currency = currencyByCode(code);
  return currency.code === 'chips' ? 'Chips' : (currency.symbol || currency.name);
}
