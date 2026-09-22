import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANKRUPT_THRESHOLD, LOBBIES, MAX_LOSS_FRACTION, RESCUE_EXIT, STARTING_BANKROLL,
  applyToBankroll, formatChips, isBankrupt, lobbyAccess, lobbyById, lossCap, settleDouDiZhu,
} from '../src/core/economy.js';
import { DEFAULT_RATING, expectedScore, kFactor, updateRating } from '../src/core/elo.js';

const starter = lobbyById('starter');
const legend = lobbyById('legend');
const rescue = lobbyById('rescue');

test('the lobby ladder is the one that was asked for', () => {
  assert.deepEqual(LOBBIES.map((l) => l.pot), [400, 1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000]);
  for (const lobby of LOBBIES) assert.equal(lobby.baseMultiplier, 2, 'every lobby starts at x2');
  assert.equal(STARTING_BANKROLL, 10_000);
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

test('winnings are never capped', () => {
  const result = { landlordWon: true, landlordSeat: 0, multiplier: 16 };
  const settled = settleDouDiZhu({ lobby: starter, result, seat: 0, bankroll: 1_000 });
  assert.equal(settled.delta, 32_000);
  assert.equal(settled.capped, false);
});

test('losses are capped by the lobby and by the bankroll', () => {
  const result = { landlordWon: false, landlordSeat: 0, multiplier: 16 };
  // Lobby cap: 1,000 pot x capFactor 6 = 6,000. Bankroll cap at 60% of 100,000
  // is 60,000, so the lobby cap binds.
  const rich = settleDouDiZhu({ lobby: starter, result, seat: 0, bankroll: 100_000 });
  assert.equal(rich.gross, -32_000);
  assert.equal(rich.delta, -6_000);
  assert.equal(rich.capped, true);
  // Bankroll cap: 60% of 5,000 is 3,000, which now binds instead.
  const poor = settleDouDiZhu({ lobby: starter, result, seat: 0, bankroll: 5_000 });
  assert.equal(poor.delta, -3_000);
});

test('one hand can never wipe out a bankroll, even at the 1M table', () => {
  const result = { landlordWon: false, landlordSeat: 0, multiplier: 64 };
  let bankroll = 1_500_000;
  const settled = settleDouDiZhu({ lobby: legend, result, seat: 0, bankroll });
  assert.ok(settled.delta < 0);
  bankroll += settled.delta;
  assert.ok(bankroll >= 1_500_000 * (1 - MAX_LOSS_FRACTION), 'at least 40% survives any single hand');
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
  assert.ok(hands > 2 && hands < 40, `took ${hands} hands, which should be a run and not one hand`);
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
  assert.equal(lossCap(starter, 10_000, false), Math.min(6_000, 6_000));
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
