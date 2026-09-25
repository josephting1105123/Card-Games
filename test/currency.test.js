import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENCIES, DEFAULT_ROOM_CURRENCY, ROOM_CURRENCIES, SOLO_CURRENCY,
  currencyByCode, currencyLabel, formatAmount, formatMoney, isCurrency, isRoomCurrency,
} from '../src/core/currency.js';
import { HAND_CAP_FACTOR, STARTING_STACK_MULTIPLE, formatChips, suggestedStakes } from '../src/core/economy.js';
import { DEFAULT_SETTINGS, SETTING_LIMITS, sanitiseSettings } from '../src/net/protocol.js';

test('rooms keep score in coins, not in the single-player purse', () => {
  assert.equal(SOLO_CURRENCY, 'chips');
  assert.deepEqual(ROOM_CURRENCIES.map((c) => c.code), ['silver', 'gold']);
  assert.equal(DEFAULT_ROOM_CURRENCY, 'silver');
  assert.notEqual(DEFAULT_ROOM_CURRENCY, SOLO_CURRENCY);
  assert.equal(DEFAULT_SETTINGS.currency, DEFAULT_ROOM_CURRENCY);
});

test('nothing here stands for real money', () => {
  const words = JSON.stringify(CURRENCIES).toLowerCase();
  for (const forbidden of ['usd', 'dollar', 'myr', 'ringgit', 'gbp', 'pound', 'euro', 'yen', 'yuan', '$', '£', '€', '¥']) {
    assert.equal(words.includes(forbidden), false, `"${forbidden}" should not appear in the currency table`);
  }
});

test('currency codes are unique and carry what the interface needs', () => {
  const codes = CURRENCIES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate currency code');
  for (const currency of CURRENCIES) {
    assert.ok(currency.name && currency.label && currency.tint, `${currency.code} is missing a field`);
  }
});

test('an amount carries its coin when nothing else names it', () => {
  assert.equal(formatMoney(1_234, 'silver'), '1,234 silver');
  assert.equal(formatMoney(1_234, 'gold'), '1,234 gold');
  assert.equal(formatMoney(1_234, 'chips'), '1,234', 'the solo purse needs no unit');
  assert.equal(formatMoney(-300, 'gold'), '-300 gold');
  assert.equal(formatMoney(1_500_000, 'gold', true), '1.5M gold');
  assert.equal(formatAmount(50_000, true), '50K');
  assert.equal(formatAmount(-1_500_000, true), '-1.5M');
});

test('gold and silver are the same arithmetic, different scale', () => {
  // No exchange rate anywhere: a coin only changes what a room opens with.
  assert.equal(formatAmount(500), formatAmount(500));
  const silver = suggestedStakes('silver');
  const gold = suggestedStakes('gold');
  assert.ok(gold.pot > silver.pot && gold.startingChips > silver.startingChips);
  assert.equal(silver.startingChips / silver.pot, STARTING_STACK_MULTIPLE);
  assert.equal(gold.startingChips / gold.pot, STARTING_STACK_MULTIPLE,
    'both open at the same number of pots, so the game plays the same');
});

test('an unknown coin falls back to chips instead of throwing', () => {
  assert.equal(currencyByCode('doubloons').code, SOLO_CURRENCY);
  assert.equal(currencyByCode(undefined).code, SOLO_CURRENCY);
  assert.equal(formatMoney(100, 'nonsense'), '100');
  assert.equal(isCurrency('nonsense'), false);
});

test('the solo purse cannot be selected as a room currency', () => {
  assert.equal(isRoomCurrency('chips'), false);
  assert.equal(isRoomCurrency('gold'), true);
  assert.equal(sanitiseSettings({ currency: 'chips' }).currency, DEFAULT_ROOM_CURRENCY);
  assert.equal(sanitiseSettings({ currency: 'GOLD' }).currency, 'gold', 'case is forgiven');
  assert.equal(sanitiseSettings({ currency: 'bananas' }).currency, DEFAULT_ROOM_CURRENCY);
});

test('single player still reads as plain chips', () => {
  assert.equal(formatChips(10_000), '10,000');
  assert.equal(formatChips(1_500_000, true), '1.5M');
  assert.equal(currencyLabel('chips'), 'Chips');
  assert.equal(currencyLabel('silver'), 'Silver');
  assert.equal(currencyLabel('gold'), 'Gold');
});

test('a room can be priced small, and its ceiling is the high one', () => {
  assert.equal(SETTING_LIMITS.pot.min, 1);
  assert.equal(DEFAULT_SETTINGS.capFactor, HAND_CAP_FACTOR, 'rooms get the same high ceiling as the solo tables');
  assert.deepEqual(
    { pot: DEFAULT_SETTINGS.pot, startingChips: DEFAULT_SETTINGS.startingChips },
    suggestedStakes(DEFAULT_ROOM_CURRENCY),
  );
  assert.equal(sanitiseSettings({ pot: 5, startingChips: 100 }).pot, 5);
  assert.equal(sanitiseSettings({ pot: 0 }).pot, 1, 'still clamped above zero');
  // A host who names a pot and no stack gets the house multiple of that pot,
  // not the default coin's stack.
  assert.equal(sanitiseSettings({ currency: 'gold', pot: 50 }).startingChips, 50 * STARTING_STACK_MULTIPLE);
  assert.equal(sanitiseSettings({ pot: 4 }).startingChips, 4 * STARTING_STACK_MULTIPLE);
  assert.equal(sanitiseSettings({ pot: 1_000, startingChips: 999 }).startingChips, 999,
    'but an explicit stack is left alone');
});
