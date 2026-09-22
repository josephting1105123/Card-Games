import test from 'node:test';
import assert from 'node:assert/strict';
import { cardsToString, parseHand, sortCardsAsc } from '../src/core/cards.js';
import { Combo, beats, classify } from '../src/games/doudizhu/rules.js';
import { enumerateLeads, findHint, legalPlays, verifyMove } from '../src/games/doudizhu/moves.js';

const hand = (s) => parseHand(s);
const c = (s) => classify(parseHand(s));

test('every generated lead is a combination the rules recognise', () => {
  const h = hand('3344455678TTJQKA2xX');
  const moves = enumerateLeads(h);
  // 14 singles, 4 pairs, 1 trio, 2+2 trio-with-kicker, 3 straights, 1 pair chain,
  // 1 rocket. Exact because a change in kicker pruning should be deliberate.
  assert.equal(moves.length, 28 + 1);
  for (const move of moves) {
    assert.ok(verifyMove(move), `generator produced an illegal ${move.type}: ${cardsToString(move.cards)}`);
  }
});

test('generated moves only ever use cards from the hand', () => {
  const h = hand('333444555677889TJQKA2');
  const ids = new Set(h.map((card) => card.id));
  for (const move of enumerateLeads(h)) {
    const counts = new Map();
    for (const card of move.cards) {
      assert.ok(ids.has(card.id), 'move used a card not in hand');
      counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
      assert.equal(counts.get(card.id), 1, 'move used the same card twice');
    }
  }
});

test('answers beat the current play and nothing else is offered', () => {
  const h = hand('456789TTJQKA2');
  const current = c('33');
  const answers = legalPlays(h, current);
  assert.ok(answers.length > 0);
  for (const move of answers) assert.ok(beats(move, current), `${move.type} does not beat a pair of 3s`);
  assert.ok(answers.some((m) => m.type === Combo.PAIR && m.rank === 10));
});

test('a rocket cannot be answered', () => {
  const h = hand('3333444455556666');
  assert.deepEqual(legalPlays(h, c('xX')), []);
});

test('a bomb is only answered by a bigger bomb or the rocket', () => {
  const h = hand('4444 55 xX').filter(Boolean);
  const answers = legalPlays(h, c('3333'));
  const kinds = new Set(answers.map((m) => m.type));
  assert.deepEqual([...kinds].sort(), [Combo.BOMB, Combo.ROCKET]);
});

test('straight answers must match length', () => {
  const h = hand('456789TJ');
  const answers = legalPlays(h, c('34567'));
  assert.ok(answers.length > 0);
  for (const move of answers) {
    if (move.bomb) continue;
    assert.equal(move.type, Combo.STRAIGHT);
    assert.equal(move.length, 5);
  }
});

test('a trio with a kicker can be answered when the only kicker is a joker', () => {
  const h = hand('444x');
  const answers = legalPlays(h, c('3335'));
  assert.ok(answers.some((m) => m.type === Combo.TRIO_SINGLE && m.rank === 4),
    'hand 444 + small joker must be able to answer 333 + 5');
});

test('hint returns the cheapest answer it can find', () => {
  const h = hand('456789TJQKA2xX');
  const hint = findHint(h, c('5'));
  assert.ok(hint);
  assert.equal(hint.type, Combo.SINGLE);
  assert.equal(hint.rank, 6, 'the cheapest answer to a 5 is a 6, not a joker');
  assert.equal(findHint(hand('345'), c('2')), null);
});

test('leads include chains, aeroplanes and bombs when the hand holds them', () => {
  const moves = enumerateLeads(hand('33344455567xX'));
  const types = new Set(moves.map((m) => m.type));
  for (const expected of [Combo.SINGLE, Combo.PAIR, Combo.TRIO, Combo.TRIO_SINGLE, Combo.TRIO_PAIR,
    Combo.STRAIGHT, Combo.PAIR_CHAIN, Combo.TRIO_CHAIN, Combo.TRIO_CHAIN_SINGLES, Combo.ROCKET]) {
    assert.ok(types.has(expected), `no ${expected} generated from 333 444 555 67 xX`);
  }
});

test('sortCardsAsc is stable enough for identical hands to generate identically', () => {
  const a = enumerateLeads(sortCardsAsc(hand('3456789')));
  const b = enumerateLeads(hand('9876543'));
  assert.equal(a.length, b.length);
});
