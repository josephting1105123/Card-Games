import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHand } from '../src/core/cards.js';
import { makeRng } from '../src/core/rng.js';
import { SKILLS, bestMove, chooseBid, chooseMove, skillByName } from '../src/games/doudizhu/ai.js';
import { Phase, bid, createGame, pass, play, seatView } from '../src/games/doudizhu/engine.js';
import { Combo, classify } from '../src/games/doudizhu/rules.js';

/**
 * A minimal seat view: everything ai.js actually reads (view.you.hand,
 * view.trick, view.players, view.seat, view.playedCards, view.bottomRevealed,
 * view.bottom), nothing engine.js would also produce but the bot never looks
 * at. Opponents are given a full hand of cards each unless said otherwise, so
 * "no urgency" is the default rather than something every test has to assert.
 */
function makeView({ hand, opponentCards = [17, 17], playedCards = [] }) {
  return {
    seat: 0,
    you: { seat: 0, hand, role: 'landlord' },
    players: [
      { seat: 0, id: 'me', name: 'Me', isBot: true, role: 'landlord', cards: hand.length },
      { seat: 1, id: 'a', name: 'A', isBot: true, role: 'farmer', cards: opponentCards[0] },
      { seat: 2, id: 'b', name: 'B', isBot: true, role: 'farmer', cards: opponentCards[1] },
    ],
    trick: null,
    playedCards,
    bottomRevealed: true,
    bottom: [],
  };
}

test('master, grandmaster, sharp and expert all refuse a four-with-kickers with no urgency and nothing to gain', () => {
  // Four 3s plus six loose, non-consecutive singles: playing the four with two
  // of them as kickers reads well by cost alone (it clears the least useful
  // cards), but it spends a bomb outright and forfeits the doubling, and the
  // four-card remainder it leaves is not empty and is not one unbeatable play
  // (9, J, K, A — no shared rank, no run). Neither opponent is anywhere near
  // going out (17 cards each), so nothing about this hand is urgent.
  const hand = parseHand('3333 5 7 9 J K A');
  const view = makeView({ hand });

  for (const skillName of ['sharp', 'expert', 'master', 'grandmaster']) {
    const move = bestMove(view, SKILLS[skillName]);
    assert.ok(move.cards, `${skillName} should have a legal lead, not a pass`);
    const type = classify(move.cards)?.type;
    assert.notEqual(type, Combo.FOUR_TWO);
    assert.notEqual(type, Combo.FOUR_TWO_PAIRS);
    const usedThrees = move.cards.filter((c) => c.rank === 3).length;
    assert.ok(usedThrees === 0 || usedThrees === 4,
      `${skillName} must not split the four (used ${usedThrees} of the four 3s): ${JSON.stringify(move.cards.map((c) => c.rank))}`);
    // In this hand the disciplined choice is a plain single that leaves the
    // four intact, not the bomb either (spending a real bomb here is just as
    // undisciplined as the four-with-kickers would have been).
    assert.equal(usedThrees, 0, `${skillName} should not touch the four at all here`);
  }
});

test('an opponent about to go out still does not earn the kicker four — the plain bomb is preferred', () => {
  // Same hand, but now an opponent is down to 2 cards (within every hard-
  // filtering skill's fourDisciplineThreshold). The old "urgent" exception let
  // this straight through; the fix is that a plain bomb of the very same rank
  // is always legal in this exact spot (bombs can always be led), so "no other
  // legal move stops them" is never true here and the kicker four stays
  // refused — the bot reaches for the bomb instead, which also doubles the
  // stake instead of throwing it away on kickers.
  const hand = parseHand('3333 5 7 9 J K A');
  const view = makeView({ hand, opponentCards: [2, 17] });

  for (const skillName of ['sharp', 'expert', 'master', 'grandmaster']) {
    const move = bestMove(view, SKILLS[skillName]);
    assert.ok(move.cards, `${skillName} should have a legal lead, not a pass`);
    const type = classify(move.cards)?.type;
    assert.notEqual(type, Combo.FOUR_TWO, `${skillName} must not play the four-with-kickers just because an opponent is low`);
    assert.notEqual(type, Combo.FOUR_TWO_PAIRS);
    assert.equal(type, Combo.BOMB, `${skillName} should play the plain bomb instead: got ${type}`);
  }
});

test('a low-discipline bot plays the same four-with-kickers the top of the ladder refuses', () => {
  // Same hand, same "no urgency" facts. bombDiscipline scales the penalty
  // rather than ruling the move out, and novice's is low enough (0.1) that the
  // move still reads as the best shed available.
  const hand = parseHand('3333 5 7 9 J K A');
  const view = makeView({ hand });
  const move = bestMove(view, SKILLS.novice);
  assert.ok(move.cards);
  assert.equal(move.cards.length, 6, 'novice takes the four-with-kickers, all six cards');
  assert.equal(move.cards.filter((c) => c.rank === 3).length, 4);
});

test('every skill plays the four-with-kickers when it empties the hand', () => {
  // Same shape of move, but this time it is the whole hand: four 3s and
  // exactly two more singles. There is no remainder to worry about, so even
  // the strictest discipline has nothing left to refuse.
  const hand = parseHand('3333 5 7');
  const view = makeView({ hand });
  for (const skillName of ['novice', 'sharp', 'master', 'grandmaster']) {
    const move = bestMove(view, SKILLS[skillName]);
    assert.ok(move.cards, `${skillName} must not pass with a hand it can clear outright`);
    assert.equal(move.cards.length, 6, `${skillName} should play all six cards and win`);
    assert.equal(move.cards.filter((c) => c.rank === 3).length, 4);
  }
});

test('master refuses splitting a four into a smaller combo the same way', () => {
  // Four 4s plus a pair of 3s: a trio out of three of the four 4s is legal,
  // leaves a lone 4 and the pair of 3s behind — not empty, not one unbeatable
  // play — so it gets the same refusal as four-with-kickers.
  const hand = parseHand('4444 3 3 5 7 9 J');
  const view = makeView({ hand });
  const move = bestMove(view, SKILLS.grandmaster);
  assert.ok(move.cards);
  const usedFours = move.cards.filter((c) => c.rank === 4).length;
  assert.ok(usedFours === 0 || usedFours === 4, `must not split the four of 4s (used ${usedFours})`);
});

test('the ladder stays monotone: fourDisciplineThreshold only tightens as skill rises', () => {
  // Not a claim that novice/casual/steady never play it — bombDiscipline still
  // scores it down as the stakes rise — only that the move is never simply
  // unavailable to them the way it is from sharp upward. sharp/expert allow the
  // urgent last resort up to a lower-card opponent (<=3) than master/grandmaster
  // do (<=2), i.e. the threshold only ever shrinks going up the ladder.
  for (const skillName of ['novice', 'casual', 'steady']) {
    assert.equal(SKILLS[skillName].fourDisciplineThreshold, 0, `${skillName} must not hard-block the move`);
  }
  assert.equal(SKILLS.sharp.fourDisciplineThreshold, 3);
  assert.equal(SKILLS.expert.fourDisciplineThreshold, 3);
  assert.equal(SKILLS.master.fourDisciplineThreshold, 2);
  assert.equal(SKILLS.grandmaster.fourDisciplineThreshold, 2);
});

/**
 * Plays one whole game with a bot in every seat, recording every decision
 * exactly (bid values, and the exact card ids of every play — not just the
 * combo shape, since two different kickers on the same trio would otherwise
 * look identical). A minimal driver rather than match.js's botTurn/
 * simulateGame, because those exist for tuning and timing, not to pin down
 * the exact sequence of decisions bit for bit.
 */
function playSeededGame(seed, skillNames) {
  const players = skillNames.map((name, seat) => ({
    id: `s${seat}`, name, isBot: true, skill: skillByName(name),
  }));
  const state = createGame({ seed, players, baseMultiplier: 2 });
  const rng = makeRng(`${seed}:play`);
  const actions = [];
  let steps = 0;
  while (state.phase !== Phase.FINISHED) {
    if (++steps > 4000) throw new Error('playSeededGame: table did not finish');
    const isBidding = state.phase === Phase.BIDDING;
    const seat = isBidding ? state.bidding.turn : state.turn;
    const skill = players[seat].skill;
    const view = seatView(state, seat);
    if (isBidding) {
      const value = chooseBid(view, skill, rng);
      actions.push({ kind: 'bid', seat, value });
      const res = bid(state, seat, value);
      assert.ok(res.ok, `bid should always be legal: ${res.error}`);
      continue;
    }
    const move = chooseMove(view, skill, rng);
    if (!move || move.pass) {
      actions.push({ kind: 'pass', seat });
      const res = pass(state, seat);
      assert.ok(res.ok, `pass should always be legal: ${res.error}`);
      continue;
    }
    actions.push({ kind: 'play', seat, ids: [...move.cards.map((c) => c.id)].sort((a, b) => a - b) });
    const res = play(state, seat, move.cards);
    assert.ok(res.ok, `bot move should always be legal: ${res.error}`);
  }
  return actions;
}

test('a seeded game replays to the exact same moves — no fallbacks, deck conserved', () => {
  // grandmaster at every seat: the skill that actually exercises
  // findForcedWin/alphaBetaEndgame/endgameDecision (countsCards, and a
  // fourDisciplineThreshold that engages filterFourDiscipline), so this is
  // the profile most likely to expose any source of nondeterminism in them.
  const seed = 'determinism-check:1';
  const first = playSeededGame(seed, ['grandmaster', 'grandmaster', 'grandmaster']);
  const second = playSeededGame(seed, ['grandmaster', 'grandmaster', 'grandmaster']);
  assert.deepEqual(second, first, 'the same seed must produce the exact same sequence of decisions');
  assert.ok(first.length > 20, 'sanity: a real game was actually played, not an empty one');
});

test('replay does not depend on the clock: a slow machine plays the same moves', () => {
  // core/rng.js's whole point is that a bot decision replays exactly from its
  // seed — for bug reports, and so the LAN host stays authoritative without
  // clients needing to agree on timing. Every search in ai.js is bounded by a
  // node count for exactly this reason; this test is what would catch it if
  // one ever went back to a wall-clock cutoff. Stubbing both clocks to crawl
  // forward 50ms per call simulates a heavily loaded or slow machine: if any
  // search were timing itself out early, this hand (grandmaster all round,
  // the same seed the previous test already played unstubbed) would come out
  // different.
  const seed = 'determinism-check:1';
  const baseline = playSeededGame(seed, ['grandmaster', 'grandmaster', 'grandmaster']);

  const realPerfNow = globalThis.performance.now;
  const realDateNow = Date.now;
  let clock = 0;
  globalThis.performance.now = () => { clock += 50; return clock; };
  Date.now = () => { clock += 50; return clock; };
  let stubbed;
  try {
    stubbed = playSeededGame(seed, ['grandmaster', 'grandmaster', 'grandmaster']);
  } finally {
    globalThis.performance.now = realPerfNow;
    Date.now = realDateNow;
  }
  assert.deepEqual(stubbed, baseline, 'a stubbed, crawling clock must not change a single decision');
});
