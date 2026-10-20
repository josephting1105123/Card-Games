import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENCIES, DEFAULT_ROOM_CURRENCY, ROOM_CURRENCIES, SOLO_CURRENCY,
  currencyByCode, currencyLabel, formatAmount, formatMoney, isCurrency, isRoomCurrency,
} from '../src/core/currency.js';
import { HAND_CAP_FACTOR, STARTING_STACK_MULTIPLE, formatChips, suggestedStakes } from '../src/core/economy.js';
import { livePotBig2, livePotDdz } from '../src/core/livepot.js';
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
  assert.equal(sanitiseSettings({ currency: 'bananas' }).currency, DEFAULT_ROOM_CURRENCY);
});

test('a room is always silver, and a Dou Di Zhu room always has the default multiplier and ceiling', () => {
  for (const currency of ['gold', 'GOLD', 'silver', 'chips', undefined]) {
    assert.equal(sanitiseSettings({ currency }).currency, DEFAULT_ROOM_CURRENCY);
  }
  const forced = sanitiseSettings({ game: 'doudizhu', currency: 'gold', baseMultiplier: 5, capFactor: 7, pot: 20, startingChips: 500 });
  assert.equal(forced.currency, 'silver');
  assert.equal(forced.baseMultiplier, 2);
  assert.equal(forced.capFactor, HAND_CAP_FACTOR);
  assert.equal(forced.pot, 20, 'the host still sets the pot');
  assert.equal(forced.startingChips, 500, 'and the starting coins');
  const big2 = sanitiseSettings({ game: 'big2', currency: 'gold', baseMultiplier: 5, capFactor: 7 });
  assert.equal('baseMultiplier' in big2, false);
  assert.equal('capFactor' in big2, false);
});

test('the live pot is two shares at the current multiplier, held to the per-hand ceiling', () => {
  assert.equal(livePotDdz(10, 2, 100), 40);
  assert.equal(livePotDdz(10, 8, 100), 160);
  assert.equal(livePotDdz(10, 300, 100), 1_000, 'the hand ceiling wins past it, and is not doubled');
  assert.equal(livePotDdz(10, 2), 40, 'the default ceiling applies when none is given');
});

test('with the stacks known, the live pot respects what each loser can actually pay', () => {
  const rich = { landlord: 1_000, farmers: [1_000, 1_000] };
  // Landlord win: both farmers pay 480 = 960. Farmers win: the landlord is held to 750.
  assert.equal(livePotDdz(40, 12, 100, rich), 960);
  const poor = { landlord: 300, farmers: [300, 300] };
  assert.equal(livePotDdz(40, 12, 100, poor), 450, 'both outcomes are held below the uncapped 960');
  const poorLandlord = { landlord: 100, farmers: [1_000, 1_000] };
  assert.equal(livePotDdz(40, 12, 100, poorLandlord), 960, 'the bigger outcome is the one shown');
  assert.equal(livePotDdz(10, 300, 100, rich), 1_000, 'the hand ceiling still bounds it');
  assert.equal(livePotDdz(10, 300, 100, { landlord: 400, farmers: [400, 400] }), 600,
    'small stacks hold it under the ceiling');
});

test('the Big Two live pot is every card the winner does not hold', () => {
  assert.equal(livePotBig2(1, [13, 13, 13, 13]), 39);
  assert.equal(livePotBig2(2, [1, 5, 7, 0]), 26, 'a hand that has gone out collects from the rest');
  assert.equal(livePotBig2(1, [4, 4]), 4);
  assert.equal(livePotBig2(1, []), 0);
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
