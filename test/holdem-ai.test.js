import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDeck52 } from '../src/core/cards.js';
import { makeRng, randInt } from '../src/core/rng.js';
import { Phase, act, createHand, seatView, totalChips } from '../src/games/holdem/engine.js';
import { SKILLS, chooseAction, estimateEquity, handScore, preflopStrength, skillByName } from '../src/games/holdem/ai.js';
import { botTurn, runSession, simulateHand } from '../src/games/holdem/match.js';
import { bestHand, pokerRank } from '../src/games/holdem/rules.js';

const DECK = makeDeck52();
const SUITS = [...new Set(DECK.map((c) => c.suit))];
const RANKS = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
const SUIT_OF = { s: 0, h: 1, d: 2, c: 3 };

/** 'As Kd' -> cards. */
function cards(text) {
  return text.split(' ').map((t) => {
    const suit = SUITS[SUIT_OF[t[1]]];
    return DECK.find((c) => pokerRank(c) === RANKS[t[0]] && c.suit === suit);
  });
}

test('preflop strength ranks the premium hands in order', () => {
  const aa = preflopStrength(cards('As Ad'));
  const kk = preflopStrength(cards('Ks Kd'));
  const aks = preflopStrength(cards('As Ks'));
  const ako = preflopStrength(cards('As Kd'));
  const junk = preflopStrength(cards('7s 2d'));
  assert.ok(aa > kk && kk > aks && aks > ako && ako > junk, `${aa} ${kk} ${aks} ${ako} ${junk}`);
  assert.equal(aa, 1);
  assert.ok(junk < 0.05);
  assert.ok(preflopStrength(cards('9s 8s')) > preflopStrength(cards('9s 8d')));
});

test('72 offsuit is at the very bottom of the 169 starting hands', () => {
  const ranks = Object.values(RANKS);
  const all = [];
  for (const a of ranks) {
    for (const b of ranks) {
      if (a < b) continue;
      const hole = [
        DECK.find((c) => pokerRank(c) === a && c.suit === SUITS[0]),
        DECK.find((c) => pokerRank(c) === b && c.suit === SUITS[1]),
      ];
      all.push(preflopStrength(hole));
    }
  }
  const junk = preflopStrength(cards('7s 2d'));
  assert.ok(all.filter((s) => s <= junk).length <= 8);
});

test('the fast scorer agrees with bestHand on random seven-card hands', () => {
  const rng = makeRng('scorer');
  for (let i = 0; i < 3000; i++) {
    const deck = [...DECK];
    const n = 5 + randInt(rng, 3);
    const hand = [];
    for (let k = 0; k < n; k++) hand.push(deck.splice(randInt(rng, deck.length), 1)[0]);
    assert.equal(handScore(hand), bestHand(hand).score, hand.map((c) => `${c.rank}${c.suit}`).join(' '));
  }
});

test('equity: aces are about 85% against one random hand, 72o about 35%', () => {
  const rng = makeRng('equity');
  const aa = estimateEquity(cards('As Ad'), [], 1, 2000, rng);
  const junk = estimateEquity(cards('7s 2d'), [], 1, 2000, rng);
  assert.ok(Math.abs(aa - 0.85) < 0.04, `AA ${aa}`);
  assert.ok(Math.abs(junk - 0.35) < 0.05, `72o ${junk}`);
});

test('equity: a made royal flush on the river cannot lose', () => {
  const rng = makeRng('royal');
  const eq = estimateEquity(cards('As Ks'), cards('Qs Js Ts 2h 3d'), 3, 300, rng);
  assert.equal(eq, 1);
});

test('equity: 400 samples against five opponents is quick', () => {
  const rng = makeRng('speed');
  estimateEquity(cards('As Kd'), [], 5, 50, rng); // warm up the JIT
  const start = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) estimateEquity(cards('As Kd'), cards('Qs 7d 2c'), 5, 400, rng);
  const each = Number(process.hrtime.bigint() - start) / 1e6 / 10;
  assert.ok(each < 40, `${each.toFixed(1)} ms per call`);
});

test('skillByName falls back to steady', () => {
  assert.equal(skillByName('expert'), SKILLS.expert);
  assert.equal(skillByName('nonsense'), SKILLS.steady);
});

/** Run a hand through chooseAction directly and check every decision as it goes. */
function playChecked(seed, skillNames, stacks, button) {
  const players = stacks.map((stack, i) => ({ name: `P${i}`, isBot: true, skill: SKILLS[skillNames[i]], stack }));
  const state = createHand({ seed, players, button, smallBlind: 10, bigBlind: 20 });
  const rng = makeRng(`${seed}:bots`);
  const before = totalChips(state);
  let guard = 0;
  while (state.phase !== Phase.FINISHED) {
    assert.ok(guard++ < 400, 'hand ran away');
    const seat = state.turn;
    const view = seatView(state, seat);
    const { legal } = view;
    const action = chooseAction(view, state.players[seat].skill, rng);
    if (legal.canCheck) assert.notEqual(action.type, 'fold', 'folded with a free check');
    if (!legal.canRaise) assert.ok(!['bet', 'raise'].includes(action.type), 'raised with betting closed');
    if (action.type === 'bet' || action.type === 'raise') {
      assert.ok(Number.isInteger(action.amount));
      assert.ok(action.amount >= legal.minRaiseTo && action.amount <= legal.maxRaiseTo, `${action.amount} outside range`);
    }
    const res = act(state, seat, action);
    assert.ok(res.ok, `${action.type} ${action.amount}: ${res.error}`);
    assert.equal(totalChips(state), before);
  }
  return state;
}

test('chooseAction is always legal, never folds a free check, never raises when closed', () => {
  const rng = makeRng('legal');
  const names = Object.keys(SKILLS);
  for (let h = 0; h < 150; h++) {
    const n = 2 + randInt(rng, 8);
    const skillNames = Array.from({ length: n }, () => names[randInt(rng, 4)]);
    const stacks = Array.from({ length: n }, () => 15 + randInt(rng, 3000));
    playChecked(`checked-${h}`, skillNames, stacks, randInt(rng, n));
  }
});

test('simulateHand: 500 mixed-skill hands finish cleanly and conserve chips', () => {
  const rng = makeRng('mixed');
  const names = Object.keys(SKILLS);
  for (let h = 0; h < 500; h++) {
    const n = 2 + randInt(rng, 8);
    const skills = Array.from({ length: n }, () => names[randInt(rng, 4)]);
    const stacks = Array.from({ length: n }, () => 20 + randInt(rng, 4000));
    const total = stacks.reduce((a, b) => a + b, 0);
    const { state, fallbacks } = simulateHand({ seed: `mixed-${h}`, stacks, skills, button: randInt(rng, n) });
    assert.equal(state.phase, Phase.FINISHED);
    assert.equal(fallbacks, 0);
    assert.equal(totalChips(state), total);
    assert.equal(state.result.net.reduce((a, b) => a + b, 0), 0);
  }
});

test('botTurn leaves a human seat to the UI and stops when the hand is over', () => {
  const players = [
    { name: 'You', isHuman: true, stack: 1000 },
    { name: 'Bot', isBot: true, skill: SKILLS.steady, stack: 1000 },
  ];
  const state = createHand({ seed: 'human', players, button: 0, smallBlind: 10, bigBlind: 20 });
  const rng = makeRng('human');
  assert.equal(state.turn, 0);
  assert.equal(botTurn(state, rng), null);
  act(state, 0, { type: 'fold' });
  assert.equal(botTurn(state, rng), null);
});

test('an expert folds seven-deuce offsuit to a huge preflop shove', () => {
  for (let i = 0; i < 40; i++) {
    const players = ['a', 'b', 'c'].map((name) => ({ name, isBot: true, skill: SKILLS.expert, stack: 2000 }));
    const state = createHand({ seed: `shove-${i}`, players, button: 0, smallBlind: 10, bigBlind: 20 });
    assert.equal(state.turn, 0);
    assert.ok(act(state, 0, { type: 'allin' }).ok);
    assert.equal(state.turn, 1);
    state.players[1].hole = cards('7s 2d');
    const action = chooseAction(seatView(state, 1), SKILLS.expert, makeRng(`shove-rng-${i}`));
    assert.equal(action.type, 'fold');
  }
});

test('an expert plays aces against the same shove', () => {
  for (let i = 0; i < 40; i++) {
    const players = ['a', 'b', 'c'].map((name) => ({ name, isBot: true, skill: SKILLS.expert, stack: 2000 }));
    const state = createHand({ seed: `shove-${i}`, players, button: 0, smallBlind: 10, bigBlind: 20 });
    act(state, 0, { type: 'allin' });
    state.players[1].hole = cards('As Ad');
    const action = chooseAction(seatView(state, 1), SKILLS.expert, makeRng(`aces-rng-${i}`));
    assert.notEqual(action.type, 'fold');
  }
});

test('three experts beat three casual players over 300-hand sessions', () => {
  // One 300-hand session swings by tens of thousands of chips (the expert edge
  // is real but small next to that), so three seeded sessions are summed.
  const skills = ['expert', 'casual', 'expert', 'casual', 'expert', 'casual'];
  let expert = 0;
  for (let session = 0; session < 3; session++) {
    const { net, hands } = runSession({ hands: 300, seedPrefix: `edge-${session}`, skills, startStack: 2000, smallBlind: 10, bigBlind: 20 });
    assert.equal(hands, 300);
    assert.equal(net.reduce((a, b) => a + b, 0), 0);
    expert += net.filter((_, i) => skills[i] === 'expert').reduce((a, b) => a + b, 0);
  }
  assert.ok(expert > 0, `experts ${expert}`);
});
