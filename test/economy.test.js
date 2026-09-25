import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANKRUPT_THRESHOLD, ENTRY_POTS, HAND_CAP_FACTOR, LOBBIES, MAX_LOSS_FRACTION, RESCUE_EXIT,
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

test('settlement trusts the engine\'s multiplier outright, no floor applied', () => {
  // The engine bakes the lobby's base multiplier in from the start (createGame
  // takes baseMultiplier), so settleDouDiZhu must not also clamp it upward: a
  // hand that genuinely settled below the lobby's base is not something that
  // can happen once bidding always multiplies by at least 1 point called.
  const result = { landlordWon: true, landlordSeat: 0, multiplier: 1 };
  const settled = settleDouDiZhu({ lobby: starter, result, seat: 1, bankroll: 10_000 });
  assert.equal(settled.multiplier, 1, 'whatever the engine reports is what is settled on');
  assert.equal(settled.delta, -1_000);
});

test('a one-point call still settles at the lobby base, and a bomb on it visibly doubles', () => {
  // The bug the base-as-factor change fixes: under the old floor, a 1-point
  // call with one bomb settled identically to a 1-point call with no bomb at
  // all (both floored to x2). Now the base is baked into the engine's own
  // multiplier, so the bomb is never invisible.
  const noBomb = settleDouDiZhu({
    lobby: starter, result: { landlordWon: true, landlordSeat: 0, multiplier: starter.baseMultiplier * 1 }, seat: 0, bankroll: 10_000,
  });
  const oneBomb = settleDouDiZhu({
    lobby: starter, result: { landlordWon: true, landlordSeat: 0, multiplier: starter.baseMultiplier * 1 * 2 }, seat: 0, bankroll: 10_000,
  });
  assert.equal(noBomb.multiplier, 2);
  assert.equal(oneBomb.multiplier, 4, 'a bomb on a 1-point call must move the number');
  assert.ok(oneBomb.delta > noBomb.delta, 'and must actually pay more');
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
  // Landlord exposure is 2 x multiplier pots, so a 100-pot ceiling only bites
  // above a multiplier of 50. Every ordinary bomb hand pays in full.
  assert.equal(HAND_CAP_FACTOR, 100);
  assert.equal(handCap(starter), 100_000);
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
  assert.equal(absurd.delta, 100_000, 'and a runaway chain stops at the ceiling');
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

test('the rescue table cannot take you below zero', () => {
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
});

test('the rescue table releases you exactly when a normal table will have you', () => {
  assert.equal(RESCUE_EXIT, STARTER_POT * ENTRY_POTS);
  assert.equal(RESCUE_EXIT, lobbyById('starter').entry,
    'holding somebody past that point is pointless, releasing them earlier sends them back');

  const stillShort = applyToBankroll(RESCUE_EXIT - 1_000, 400, true);
  assert.equal(stillShort.rescueMode, true);
  assert.equal(stillShort.leftRescue, false);

  const released = applyToBankroll(RESCUE_EXIT - 400, 800, true);
  assert.equal(released.rescueMode, false);
  assert.equal(released.leftRescue, true);
  const open = lobbyAccess(released.bankroll, false).filter((a) => !a.locked).map((a) => a.lobby.id);
  assert.deepEqual(open, ['starter'], 'and can sit down the moment they are out');
});

test('a player leaving rescue can absorb an ordinary hand without the cap firing', () => {
  // The whole reason ENTRY_POTS is 6: a landlord at the base multiplier risks
  // 4 pots, and 75% of a 6-pot stack is 4.5, so the emergency cap stays out of
  // an ordinary loss.
  const starterLobby = lobbyById('starter');
  const settled = settleDouDiZhu({
    lobby: starterLobby,
    result: { landlordWon: false, landlordSeat: 0, multiplier: starterLobby.baseMultiplier },
    seat: 0,
    bankroll: RESCUE_EXIT,
  });
  assert.equal(settled.capped, false, 'an ordinary landlord loss is settled in full');
  assert.equal(settled.delta, -4 * STARTER_POT);
});

test('access: the rescue table is the only door when bankrupt', () => {
  const broke = lobbyAccess(500, true);
  for (const entry of broke) {
    assert.equal(entry.locked, !entry.lobby.rescue);
  }
  const flush = lobbyAccess(350_000, false);
  const open = flush.filter((e) => !e.locked).map((e) => e.lobby.id);
  assert.deepEqual(open, ['starter', 'bronze', 'silver']);
  // A fresh purse is one stack at the cheapest table and nothing more.
  const fresh = lobbyAccess(STARTING_BANKROLL, false).filter((e) => !e.locked).map((e) => e.lobby.id);
  assert.deepEqual(fresh, ['starter'], 'the ladder starts at the bottom');
  assert.equal(isBankrupt(BANKRUPT_THRESHOLD - 1), true);
  assert.equal(isBankrupt(BANKRUPT_THRESHOLD), false);
});

test('lossCap at the rescue table is simply the balance', () => {
  assert.equal(lossCap(rescue, 750, true), 750);
  // At a fresh stack the bankroll share binds long before the 50-pot ceiling.
  assert.equal(lossCap(starter, 10_000, false), 7_500);
  assert.equal(lossCap(starter, 1_000_000, false), 100_000);
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

test('every threshold is counted in pots, not set by hand', () => {
  assert.equal(BANKRUPT_THRESHOLD, STARTER_POT, 'bankrupt is one pot at the cheapest table');
  for (const lobby of LOBBIES) {
    assert.equal(lobby.entry, lobby.rescue ? 0 : lobby.pot * ENTRY_POTS, `${lobby.id} entry has drifted`);
  }
  // Entry rises with the pot, so the ladder gates rather than opening at once.
  const normal = LOBBIES.filter((l) => !l.rescue);
  for (let i = 1; i < normal.length; i++) assert.ok(normal[i].entry > normal[i - 1].entry);
});
