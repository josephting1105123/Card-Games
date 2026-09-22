import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHand, sortCards } from '../src/core/cards.js';
import {
  BOTTOM_SIZE, HAND_SIZE, Phase, Role, availableActions, bid, createGame, pass, play, seatView,
} from '../src/games/doudizhu/engine.js';
import { simulateGame } from '../src/games/doudizhu/match.js';

const players = [
  { id: 'p0', name: 'You' },
  { id: 'p1', name: 'Bot A', isBot: true },
  { id: 'p2', name: 'Bot B', isBot: true },
];

function game(seed = 'test') {
  return createGame({ seed, players });
}

test('a deal gives three hands of 17 and keeps three cards back', () => {
  const state = game();
  assert.equal(state.phase, Phase.BIDDING);
  for (const p of state.players) assert.equal(p.hand.length, HAND_SIZE);
  assert.equal(state.bottom.length, BOTTOM_SIZE);
  const ids = new Set([...state.players.flatMap((p) => p.hand), ...state.bottom].map((c) => c.id));
  assert.equal(ids.size, 54, 'all 54 cards dealt exactly once');
  assert.equal(state.bottomRevealed, false, 'the bottom three stay face down during bidding');
});

test('the same seed deals the same cards', () => {
  assert.deepEqual(game('abc').players[0].hand, game('abc').players[0].hand);
  assert.notDeepEqual(game('abc').players[0].hand, game('xyz').players[0].hand);
});

test('bidding: three passes redeal', () => {
  const state = game('bidding-redeal');
  const first = state.bidding.first;
  const before = state.players[0].hand.map((c) => c.id);
  bid(state, first, 0);
  bid(state, (first + 1) % 3, 0);
  const res = bid(state, (first + 2) % 3, 0);
  assert.equal(res.ok, true);
  assert.equal(state.deal, 1);
  assert.equal(state.phase, Phase.BIDDING);
  assert.notDeepEqual(state.players[0].hand.map((c) => c.id), before, 'a redeal deals fresh cards');
});

test('bidding: a call of three settles it immediately', () => {
  const state = game('bid3');
  const first = state.bidding.first;
  const res = bid(state, first, 3);
  assert.equal(res.ok, true);
  assert.equal(state.phase, Phase.PLAYING);
  assert.equal(state.landlord, first);
  assert.equal(state.players[first].hand.length, HAND_SIZE + BOTTOM_SIZE);
  assert.equal(state.players[first].role, Role.LANDLORD);
  assert.equal(state.bidValue, 3);
  assert.equal(state.multiplier, 3);
  assert.equal(state.turn, first, 'the landlord leads');
  assert.equal(state.bottomRevealed, true);
});

test('bidding: calls must rise, and two passes after a call end it', () => {
  const state = game('bid-rise');
  const a = state.bidding.first;
  const b = (a + 1) % 3;
  const c = (a + 2) % 3;
  assert.equal(bid(state, a, 1).ok, true);
  assert.equal(bid(state, b, 1).ok, false, 'a call must beat the standing call');
  assert.equal(bid(state, b, 2).ok, true);
  assert.equal(bid(state, c, 0).ok, true);
  assert.equal(bid(state, a, 0).ok, true);
  assert.equal(state.phase, Phase.PLAYING);
  assert.equal(state.landlord, b);
  assert.equal(state.bidValue, 2);
});

test('bidding: out-of-turn and out-of-range calls are refused', () => {
  const state = game('bid-refuse');
  const wrong = (state.bidding.first + 1) % 3;
  assert.match(bid(state, wrong, 1).error, /turn/);
  assert.match(bid(state, state.bidding.first, 4).error, /0, 1, 2 or 3/);
});

/** Force a known layout so play rules can be checked exactly. */
function riggedGame(hands, { landlord = 0, bidValue = 2 } = {}) {
  const state = game('rigged');
  state.phase = Phase.PLAYING;
  state.landlord = landlord;
  state.bidValue = bidValue;
  state.multiplier = bidValue;
  state.bottomRevealed = true;
  state.bottom = [];
  state.turn = landlord;
  state.trick = null;
  state.players.forEach((p, seat) => {
    p.hand = sortCards(parseHand(hands[seat]));
    p.role = seat === landlord ? Role.LANDLORD : Role.FARMER;
  });
  return state;
}

test('play: turn order, hand ownership and legality are all enforced', () => {
  const state = riggedGame(['345', '456', '567']);
  assert.match(play(state, 1, parseHand('4')).error, /turn/);
  assert.match(play(state, 0, parseHand('9')).error, /not in your hand/);
  const twoDifferentRanks = [findCard(state, 0, 3), findCard(state, 0, 4)];
  assert.match(play(state, 0, twoDifferentRanks).error, /legal combination/);
  assert.equal(play(state, 0, [findCard(state, 0, 3)]).ok, true);
  assert.equal(state.turn, 1);
});

function findCard(state, seat, rank) {
  return state.players[seat].hand.find((c) => c.rank === rank);
}

test('play: a weaker card is refused, a stronger one accepted', () => {
  const state = riggedGame(['345', '456', '567']);
  play(state, 0, [findCard(state, 0, 5)]);
  assert.match(play(state, 1, [findCard(state, 1, 4)]).error, /does not beat/);
  assert.equal(play(state, 1, [findCard(state, 1, 6)]).ok, true);
});

test('play: you may not pass when leading', () => {
  const state = riggedGame(['345', '456', '567']);
  assert.match(pass(state, 0).error, /must lead/);
  assert.deepEqual(availableActions(state, 0).map((a) => a.kind), ['play']);
});

test('play: two passes hand the lead back to the trick winner', () => {
  const state = riggedGame(['345', '456', '567']);
  play(state, 0, [findCard(state, 0, 5)]);
  assert.deepEqual(availableActions(state, 1).map((a) => a.kind), ['play', 'pass']);
  pass(state, 1);
  pass(state, 2);
  assert.equal(state.turn, 0, 'the trick winner opens the next trick');
  assert.equal(state.trick, null);
});

test('bombs double the stake', () => {
  const state = riggedGame(['3333 4', '567 8', '9TJ Q'], { bidValue: 2 });
  assert.equal(state.multiplier, 2);
  assert.equal(play(state, 0, parseHand('3333').map((c) => c.id)).ok, true);
  assert.equal(state.bombs, 1);
  assert.equal(state.multiplier, 4);
});

test('a spring doubles again when the farmers never played', () => {
  const state = riggedGame(['3456789TJQKA2', '4', '5'], { bidValue: 1 });
  // The landlord holds one unbeatable straight-free run; force it out in one go
  // by simply emptying the hand a card at a time while both farmers pass.
  let guard = 0;
  while (state.phase === Phase.PLAYING) {
    if (++guard > 60) throw new Error('did not finish');
    const seat = state.turn;
    if (seat === 0) {
      play(state, 0, [state.players[0].hand[0]]);
    } else {
      pass(state, seat);
    }
  }
  assert.equal(state.result.landlordWon, true);
  assert.equal(state.result.spring, true);
  assert.equal(state.result.multiplier, 2, 'one point called, doubled by the spring');
});

test('the anti-spring fires when the landlord only ever played once', () => {
  const state = riggedGame(['34', '5', '6'], { bidValue: 1 });
  assert.equal(play(state, 0, [findCard(state, 0, 3)]).ok, true);
  assert.equal(play(state, 1, [findCard(state, 1, 5)]).ok, true, 'a farmer goes out');
  assert.equal(state.phase, Phase.FINISHED);
  assert.equal(state.result.landlordWon, false);
  assert.equal(state.result.antiSpring, true);
  assert.equal(state.result.multiplier, 2);
});

test('seatView hides other hands but shows their counts', () => {
  const state = game('view');
  bid(state, state.bidding.first, 3);
  const view = seatView(state, 1);
  assert.equal(view.you.hand.length, state.players[1].hand.length);
  assert.equal(view.players.length, 3);
  for (const p of view.players) assert.equal(typeof p.cards, 'number');
  assert.equal(JSON.stringify(view).includes('"hand"'), true);
  // The only hand in the payload is the viewer's own.
  const handOccurrences = JSON.stringify(view).match(/"hand"/g).length;
  assert.equal(handOccurrences, 1);
});

test('a hundred bot games all finish and conserve the deck', () => {
  for (let i = 0; i < 100; i++) {
    const { state, result } = simulateGame({ seed: `conserve:${i}`, skills: ['casual', 'steady', 'expert'] });
    assert.equal(state.phase, Phase.FINISHED);
    assert.ok(result.multiplier >= 1);
    const dealt = state.players.reduce((n, p) => n + p.hand.length, 0)
      + state.plays.reduce((n, p) => n + (p.cards?.length ?? 0), 0);
    assert.equal(dealt, 54, `deck not conserved on seed ${i}`);
    assert.equal(state.log.some((e) => e.kind === 'fallback'), false, 'a bot produced an illegal move');
  }
});

test('trickPlays says who did what in the trick now in progress', () => {
  const state = riggedGame(['345', '456', '567']);
  assert.deepEqual(state.trickPlays, []);

  play(state, 0, [findCard(state, 0, 5)]);
  assert.equal(state.trickPlays.length, 1);
  assert.equal(state.trickPlays[0].seat, 0);
  assert.equal(state.trickPlays[0].cards.length, 1);

  play(state, 1, [findCard(state, 1, 6)]);
  pass(state, 2);
  assert.deepEqual(state.trickPlays.map((p) => p.seat), [0, 1, 2]);
  assert.equal(state.trickPlays[2].pass, true);

  // Two passes end the trick, but the finished trick stays on the table so it
  // can be shown greyed rather than blinking out of existence.
  pass(state, 0);
  assert.equal(state.trick, null);
  assert.equal(state.trickPlays.length, 4, 'the finished trick is still readable');

  // Leading again clears it.
  play(state, 1, [findCard(state, 1, 4)]);
  assert.deepEqual(state.trickPlays.map((p) => p.seat), [1]);
});

test('a seat view carries the current trick per seat', () => {
  const state = riggedGame(['345', '456', '567']);
  play(state, 0, [findCard(state, 0, 3)]);
  const view = seatView(state, 1);
  assert.equal(view.trickPlays.length, 1);
  assert.equal(view.trickPlays[0].seat, 0);
  // Still only the viewer's own hand in the payload.
  assert.equal(JSON.stringify(view).match(/"hand"/g).length, 1);
});
