import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENCIES, DEFAULT_ROOM_CURRENCY, SOLO_CURRENCY,
  currencyByCode, currencyLabel, formatAmount, formatMoney, isCurrency,
} from '../src/core/currency.js';
import { formatChips } from '../src/core/economy.js';
import { DEFAULT_SETTINGS, SETTING_LIMITS, sanitiseSettings } from '../src/net/protocol.js';

test('a room does not keep score in the single-player purse', () => {
  assert.equal(SOLO_CURRENCY, 'chips');
  assert.notEqual(DEFAULT_ROOM_CURRENCY, SOLO_CURRENCY, 'a new room defaults to a different currency');
  assert.equal(DEFAULT_SETTINGS.currency, DEFAULT_ROOM_CURRENCY);
  assert.ok(isCurrency(DEFAULT_ROOM_CURRENCY));
});

test('currency codes are unique and complete', () => {
  const codes = CURRENCIES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate currency code');
  for (const currency of CURRENCIES) {
    assert.ok(currency.name, `${currency.code} has no name`);
    assert.ok(['prefix', 'suffix'].includes(currency.place));
  }
  assert.ok(codes.length >= 5, 'the host has a real choice to make');
});

test('amounts format with the symbol on the right side of the number', () => {
  assert.equal(formatMoney(1_234_567, 'chips'), '1,234,567');
  assert.equal(formatMoney(1_000, 'myr'), 'RM 1,000');
  assert.equal(formatMoney(1_000, 'usd'), '$1,000');
  assert.equal(formatMoney(1_000, 'gbp'), '£1,000');
  assert.equal(formatMoney(1_000, 'points'), '1,000 pts');
});

test('the sign sits outside a prefixed symbol', () => {
  assert.equal(formatMoney(-2_500, 'myr'), '-RM 2,500');
  assert.equal(formatMoney(-2_500, 'usd'), '-$2,500');
  assert.equal(formatMoney(-2_500, 'points'), '-2,500 pts');
  assert.equal(formatMoney(-2_500, 'chips'), '-2,500');
});

test('compact amounts keep their currency', () => {
  assert.equal(formatMoney(1_500_000, 'myr', true), 'RM 1.5M');
  assert.equal(formatMoney(50_000, 'usd', true), '$50K');
  assert.equal(formatMoney(400, 'chips', true), '400');
  assert.equal(formatAmount(-1_500_000, true), '-1.5M');
});

test('an unknown currency falls back to chips instead of throwing', () => {
  assert.equal(currencyByCode('dogecoin').code, SOLO_CURRENCY);
  assert.equal(currencyByCode(undefined).code, SOLO_CURRENCY);
  assert.equal(formatMoney(100, 'nonsense'), '100');
  assert.equal(isCurrency('nonsense'), false);
});

test('single player still reads as plain chips', () => {
  assert.equal(formatChips(10_000), '10,000');
  assert.equal(formatChips(1_500_000, true), '1.5M');
  assert.equal(currencyLabel('chips'), 'Chips');
  assert.equal(currencyLabel('myr'), 'RM');
});

test('room settings accept a currency and refuse junk', () => {
  assert.equal(sanitiseSettings({ currency: 'USD' }).currency, 'usd', 'case is forgiven');
  assert.equal(sanitiseSettings({ currency: 'bananas' }).currency, DEFAULT_ROOM_CURRENCY);
  assert.equal(sanitiseSettings({}).currency, DEFAULT_ROOM_CURRENCY);
});

test('a room can be priced for real-world stakes, not just thousands', () => {
  // Keeping score in ringgit means a pot of 5, which the old floor of 100 would
  // have silently raised.
  assert.equal(SETTING_LIMITS.pot.min, 1);
  assert.equal(sanitiseSettings({ pot: 5, startingChips: 100 }).pot, 5);
  assert.equal(sanitiseSettings({ pot: 5, startingChips: 100 }).startingChips, 100);
  assert.equal(sanitiseSettings({ pot: 0 }).pot, 1, 'still clamped above zero');
  assert.equal(sanitiseSettings({ pot: 1e12 }).pot, SETTING_LIMITS.pot.max);
});
