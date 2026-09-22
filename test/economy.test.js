import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANKRUPT_THRESHOLD, HAND_CAP_FACTOR, LOBBIES, MAX_LOSS_FRACTION, RESCUE_EXIT,
  STARTER_POT, STARTING_BANKROLL, STARTING_STACK_MULTIPLE,
  applyToBankroll, formatChips, handCap, isBankrupt, lobbyAccess, lobbyById, lossCap,
  settleDouDiZhu, stackForPot, suggestedStakes,
} from '../src/core/economy.js';
import { DEFAULT_RATING, expectedScore, kFactor, updateRating } from '../src/core/elo.js';

const starter = lobbyById('starter');
const legend = lobbyById('legend');
const rescue = lobbyById('rescue');

test('the lobby ladder is the one that was asked for', () => {
  assert.deepEqual(LOBBIES.map((l) => l.pot), [400, 1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000]);
  for (const lobby of LOBBIES) assert.equal(lobby.baseMultiplier, 2, 'every lobby starts at x2');
  assert.equal(STARTING_BANKROLL, 25_000);
  assert.equal(rescue.pot, 400);
  assert.equal(rescue.entry, 0);
});

test('bot skill and nominal rating rise with the stake', () => {
  const normal = LOBBIES.filter((l) => !l.rescue);
  for (let i = 1; i < normal.length; i++) {
    assert.ok(normal[i].botElo > normal[i - 1].botElo, 'ratings must rise with the pot');
    assert.ok(normal[i].pot > normal[i - 1].pot);
  }
});

test('a landlord settles for twice a farmer', () => {
  const result = { landlordWon: true, landlordSeat: 0, multiplier: 2 };
  const asLandlord = settleDouDiZhu({ lobby: starter, result, seat: 0, bankroll: 10_000 });
  const asFarmer = settleDouDiZhu({ lobby: starter, result, seat: 1, bankroll: 10_000 });
  assert.equal(asLandlord.delta, 4_000, '1,000 pot x2 multiplier x2 for the landlord');
  assert.equal(asFarmer.delta, -2_000);
  assert.equal(asLandlord.won, true);
  assert.equal(asFarmer.won, false);
});

test('the base multiplier acts as a floor', () => {
  const result = { landlordWon: true, landlordSeat: 0, multiplier: 1 };
  const settled = settleDouDiZhu({ lobby: starter, result, seat: 1, bankroll: 10_000 });
  assert.equal(settled.multiplier, 2, 'a one-point hand still settles at x2');
  assert.equal(settled.delta, -2_000);
});

test('a win pays in full, however much more it is than the player holds', () => {
  // A landlord at x16 collects 32 pots. Nothing about the player's balance
  // limits that: a win you could not have afforded to lose is the point.
  const result = { landlordWon: true, landlordSeat: 0, multiplier: 16 };
  const settled = settleDouDiZhu({ lobby: starter, result, seat: 0, bankroll: 1_000 });
  assert.equal(settled.delta, 32_000);
  assert.equal(settled.capped, false);
});

test('the ceiling on one hand is high enough that bombs still pay', () => {
  // Landlord exposure is 2 x multiplier pots, so a 50-pot ceiling only bites
  // above a multiplier of 32. Every ordinary bomb hand pays in full.
  assert.equal(HAND_CAP_FACTOR, 50);
  assert.equal(handCap(starter), 50_000);
  for (const multiplier of [2, 4, 8, 12, 24]) {
    const settled = settleDouDiZhu({
      lobby: starter, result: { landlordWon: true, landlordSeat: 0, multiplier }, seat: 0, bankroll: 10_000,
    });
    assert.equal(settled.capped, false, `a x${multiplier} win should pay in full`);
    assert.equal(settled.delta, 1_000 * multiplier * 2);
  }
  const absurd = settleDouDiZhu({
    lobby: starter, result: { landlordWon: true, landlordSeat: 0, multiplier: 64 }, seat: 0, bankroll: 10_000,
  });
  assert.equal(absurd.delta, 50_000, 'and a runaway chain stops at the ceiling');
  assert.equal(absurd.capped, true);
});

test('every table shares the same ceiling', () => {
  for (const lobby of LOBBIES) assert.equal(lobby.capFactor, HAND_CAP_FACTOR);
});

test('losses are capped by the table ceiling and by the bankroll', () => {
  const result = { landlordWon: false, landlordSeat: 0, multiplier: 16 };
  // 32 pots is 32,000, under the 50,000 ceiling, and 75% of 100,000 is 75,000,
  // so a rich player simply pays the lot.
  const rich = settleDouDiZhu({ lobby: starter, result, seat: 0, bankroll: 100_000 });
  assert.equal(rich.gross, -32_000);
  assert.equal(rich.delta, -32_000);
  assert.equal(rich.capped, false);
  // 75% of 5,000 is 3,750, which does bind.
  const poor = settleDouDiZhu({ lobby: starter, result, seat: 0, bankroll: 5_000 });
  assert.equal(poor.delta, -3_750);
  assert.equal(poor.capped, true);
});

test('one hand can never wipe out a bankroll, even at the 1M table', () => {
  const result = { landlordWon: false, landlordSeat: 0, multiplier: 64 };
  let bankroll = 1_500_000;
  const settled = settleDouDiZhu({ lobby: legend, result, seat: 0, bankroll });
  assert.ok(settled.delta < 0);
  bankroll += settled.delta;
  assert.ok(bankroll >= 1_500_000 * (1 - MAX_LOSS_FRACTION), 'a quarter of the stack survives any single hand');
  assert.equal(MAX_LOSS_FRACTION, 0.75);
});

test('repeated capped losses still reach bankruptcy', () => {
  let bankroll = STARTING_BANKROLL;
  let rescueMode = false;
  const result = { landlordWon: false, landlordSeat: 0, multiplier: 8 };
  let hands = 0;
  while (!rescueMode && hands < 200) {
    const settled = settleDouDiZhu({ lobby: starter, result, seat: 0, bankroll, rescueMode });
    const next = applyToBankroll(bankroll, settled.delta, rescueMode);
    bankroll = next.bankroll;
    rescueMode = next.rescueMode;
    hands += 1;
  }
  assert.equal(rescueMode, true, 'a losing run does eventually bankrupt you');
  assert.ok(hands >= 2, 'but never in a single hand');
  assert.ok(hands < 40, `took ${hands} hands, which should be a run and not a grind`);
});

test('the rescue table cannot take you below zero and releases you at 2,000', () => {
  const loss = settleDouDiZhu({
    lobby: rescue,
    result: { landlordWon: false, landlordSeat: 0, multiplier: 8 },
    seat: 0,
    bankroll: 300,
    rescueMode: true,
  });
  const afterLoss = applyToBankroll(300, loss.delta, true);
  assert.ok(afterLoss.bankroll >= 0);
  assert.equal(afterLoss.rescueMode, true);

  const afterWin = applyToBankroll(1_900, 400, true);
  assert.equal(afterWin.bankroll, 2_300);
  assert.equal(afterWin.rescueMode, false);
  assert.equal(afterWin.leftRescue, true);
  assert.equal(RESCUE_EXIT, 2_000);
});

test('access: the rescue table is the only door when bankrupt', () => {
  const broke = lobbyAccess(500, true);
  for (const entry of broke) {
    assert.equal(entry.locked, !entry.lobby.rescue);
  }
  const flush = lobbyAccess(150_000, false);
  const open = flush.filter((e) => !e.locked).map((e) => e.lobby.id);
  assert.deepEqual(open, ['starter', 'bronze', 'silver', 'gold']);
  assert.equal(isBankrupt(BANKRUPT_THRESHOLD - 1), true);
  assert.equal(isBankrupt(BANKRUPT_THRESHOLD), false);
});

test('lossCap at the rescue table is simply the balance', () => {
  assert.equal(lossCap(rescue, 750, true), 750);
  // At a fresh stack the bankroll share binds long before the 50-pot ceiling.
  assert.equal(lossCap(starter, 10_000, false), 7_500);
  assert.equal(lossCap(starter, 1_000_000, false), 50_000);
});

test('formatChips', () => {
  assert.equal(formatChips(1_234_567), '1,234,567');
  assert.equal(formatChips(1_500_000, true), '1.5M');
  assert.equal(formatChips(50_000, true), '50K');
  assert.equal(formatChips(400, true), '400');
});

test('Elo: expected score is symmetric and monotone', () => {
  assert.equal(expectedScore(1_200, 1_200), 0.5);
  assert.ok(expectedScore(1_600, 1_200) > 0.9);
  const a = expectedScore(1_500, 1_300);
  const b = expectedScore(1_300, 1_500);
  assert.ok(Math.abs(a + b - 1) < 1e-12, 'the two expectations must sum to one');
});

test('Elo: a win against stronger opposition gains more than against weaker', () => {
  const vsStrong = updateRating({ rating: 1_200, opponents: 1_800, score: 1, gamesPlayed: 50 });
  const vsWeak = updateRating({ rating: 1_200, opponents: 800, score: 1, gamesPlayed: 50 });
  assert.ok(vsStrong.delta > vsWeak.delta);
  assert.ok(vsWeak.delta >= 0);
});

test('Elo: K falls as the rating rises, and starts high while provisional', () => {
  assert.equal(kFactor(DEFAULT_RATING, 0), 48);
  assert.equal(kFactor(1_500, 50), 32);
  assert.equal(kFactor(2_200, 50), 24);
  assert.equal(kFactor(2_500, 50), 16);
});

test('Elo: rating is conserved in a head-to-head pair', () => {
  const winner = updateRating({ rating: 1_400, opponents: 1_400, score: 1, gamesPlayed: 99 });
  const loser = updateRating({ rating: 1_400, opponents: 1_400, score: 0, gamesPlayed: 99 });
  assert.equal(winner.delta + loser.delta, 0);
});

test('a stack is the same number of pots wherever you sit', () => {
  assert.equal(STARTING_STACK_MULTIPLE, 25);
  assert.equal(STARTING_BANKROLL, STARTER_POT * STARTING_STACK_MULTIPLE);
  assert.equal(stackForPot(1_000), 25_000);
  assert.equal(stackForPot(10), 250);
  assert.equal(stackForPot(0), 1, 'never a stack of nothing');
  for (const code of ['silver', 'gold']) {
    const { pot, startingChips } = suggestedStakes(code);
    assert.equal(startingChips, pot * STARTING_STACK_MULTIPLE, `${code} opens off the house multiple`);
  }
});

test('the swing of a hand is the same fraction of the stack at every table', () => {
  // A landlord at the base x2 multiplier risks 4 pots. With a stack of 25 pots
  // that is the same share of it whatever the table is priced at, which is the
  // point of deriving the stack from the pot rather than fixing it.
  const shares = LOBBIES.filter((l) => !l.rescue).map((lobby) => {
    const stack = stackForPot(lobby.pot);
    const settled = settleDouDiZhu({
      lobby, result: { landlordWon: false, landlordSeat: 0, multiplier: 2 }, seat: 0, bankroll: stack,
    });
    return Math.abs(settled.delta) / stack;
  });
  for (const share of shares) assert.equal(share, shares[0]);
  assert.ok(shares[0] > 0.1 && shares[0] < 0.2, `a base landlord hand is ${(shares[0] * 100).toFixed(0)}% of a stack`);
});
