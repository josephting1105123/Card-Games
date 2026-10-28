import test from 'node:test';
import assert from 'node:assert/strict';

import { cardFromId, parseHand } from '../src/core/cards.js';
import { bombCardIds } from '../src/ui/cardart.js';

// cardart.js reaches for `document` only when a card is built, so importing it
// here, with no DOM at all, has to work: that is what the first assertion pins.
const ids = (cards) => cards.map((card) => card.id);

test('cardart.js imports in node without a document', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof bombCardIds, 'function');
});

test('four of a rank is a bomb: all four ids, and only those', () => {
  const quad = parseHand('7777');
  const hand = [...quad, ...parseHand('9 J')];
  assert.deepEqual([...bombCardIds(hand)].sort((a, b) => a - b), ids(quad).sort((a, b) => a - b));
});

test('three of a kind is not a bomb', () => {
  assert.equal(bombCardIds(parseHand('777 99 K')).size, 0);
});

test('two quads give eight ids', () => {
  const hand = parseHand('3333 KKKK 5');
  assert.equal(bombCardIds(hand).size, 8);
  assert.equal(bombCardIds(hand).has(ids(parseHand('5'))[0]), false);
});

test('a quad of twos counts, whatever order the hand is in', () => {
  const hand = parseHand('2 4 2 6 2 8 2').reverse();
  assert.equal(bombCardIds(hand).size, 4);
});

test('both jokers are a rocket only when rocket is asked for', () => {
  const hand = parseHand('xX 5 6');
  assert.deepEqual([...bombCardIds(hand, { rocket: true })].sort((a, b) => a - b), [52, 53]);
  assert.equal(bombCardIds(hand).size, 0);
});

test('one joker is never a rocket', () => {
  assert.equal(bombCardIds([cardFromId(52), ...parseHand('5 6')], { rocket: true }).size, 0);
  assert.equal(bombCardIds([cardFromId(53), ...parseHand('5 6')], { rocket: true }).size, 0);
});

test('a quad and a rocket together, in one hand', () => {
  const hand = parseHand('9999 xX 3');
  assert.equal(bombCardIds(hand, { rocket: true }).size, 6);
  assert.equal(bombCardIds(hand).size, 4);
});

test('an empty hand has no bombs', () => {
  assert.equal(bombCardIds([], { rocket: true }).size, 0);
});
