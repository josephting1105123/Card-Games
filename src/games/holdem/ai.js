/**
 * Hold'em bots: a preflop hand-strength table, a Monte Carlo equity estimate,
 * and a no-limit decision from nothing but a seatView.
 *
 * A bot only ever sees what a seat sees (its own hole cards, the board, the
 * bets), so it can't cheat. Randomness comes from the rng it is handed, never
 * Math.random, which keeps a seeded table replayable.
 *
 * Pure: no DOM, no clock.
 */

import { randInt } from '../../core/rng.js';
import { Phase } from './engine.js';
import { pokerRank } from './rules.js';

/**
 * looseness   0..1  how many preflop hands it plays, and how much it pays to see a card
 * aggression  0..1  raise rather than call, bet rather than check
 * bluff       0..1  chance of betting air when checked to
 * position    0..1  how much it widens in late seat and tightens in early seat
 * samples           Monte Carlo runs behind each postflop decision
 * mistake     0..1  chance of a random but sensible-looking deviation
 */
export const SKILLS = {
  casual: { name: 'Casual', looseness: 0.85, aggression: 0.2, bluff: 0.03, position: 0.1, samples: 120, mistake: 0.12 },
  steady: { name: 'Steady', looseness: 0.55, aggression: 0.45, bluff: 0.08, position: 0.5, samples: 200, mistake: 0.06 },
  sharp: { name: 'Sharp', looseness: 0.4, aggression: 0.65, bluff: 0.12, position: 0.8, samples: 300, mistake: 0.025 },
  expert: { name: 'Expert', looseness: 0.3, aggression: 0.8, bluff: 0.16, position: 1, samples: 400, mistake: 0.01 },
};

export function skillByName(name) {
  return SKILLS[name] ?? SKILLS.steady;
}

// ---- preflop ---------------------------------------------------------------

function chenScore(hole) {
  const a = pokerRank(hole[0]);
  const b = pokerRank(hole[1]);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  const value = (r) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let s = value(hi);
  if (hi === lo) return Math.ceil(Math.max(5, s * 2));
  if (hole[0].suit === hole[1].suit) s += 2;
  const gap = hi - lo - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) s += 1;
  return Math.ceil(s);
}

/** 0..1, AA = 1, 72o = 0 (Chen's formula rescaled from -1..20). */
export function preflopStrength(hole) {
  return Math.min(1, Math.max(0, (chenScore(hole) + 1) / 21));
}

function isPremium(hole) {
  const a = pokerRank(hole[0]);
  const b = pokerRank(hole[1]);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi === lo && hi >= 12) || (hi === 14 && lo === 13);
}

// ---- hand scoring and equity -----------------------------------------------

// Cards are packed as (rank - 2) * 4 + suit so a seven-card hand scores with
// counting arrays instead of the 21 subsets bestHand walks. The score has the
// same shape as rules.js (category * 15^5 + tie-break ranks base 15), so the two
// agree exactly; the test file checks that.
const BASE = 15;
const B4 = BASE ** 4;
const B3 = BASE ** 3;
const B2 = BASE ** 2;
const WEIGHT = BASE ** 5;

const rankCount = new Int8Array(15);
const suitCount = new Int8Array(4);
const suitMask = new Int32Array(4);

const suitIndex = {};
function suitOf(suit) {
  if (!(suit in suitIndex)) suitIndex[suit] = Object.keys(suitIndex).length;
  return suitIndex[suit];
}

function codeOf(card) {
  return (pokerRank(card) - 2) * 4 + suitOf(card.suit);
}

function straightHigh(mask) {
  const m = mask | ((mask >> 14) & 1 ? 2 : 0); // ace plays low in the wheel
  for (let h = 14; h >= 5; h--) {
    if (((m >> (h - 4)) & 31) === 31) return h;
  }
  return 0;
}

function pack(category, r0, r1, r2, r3, r4) {
  return category * WEIGHT + r0 * B4 + r1 * B3 + r2 * B2 + r3 * BASE + r4;
}

/** Highest `count` distinct ranks present, skipping two excluded ranks. Writes into `out`. */
function kickers(out, ex1, ex2, count) {
  let k = 0;
  for (let r = 14; r >= 2 && k < count; r--) {
    if (rankCount[r] > 0 && r !== ex1 && r !== ex2) out[k++] = r;
  }
  while (k < count) out[k++] = 0;
}

const kick = [0, 0, 0, 0, 0];

function scoreCodes(codes, n) {
  rankCount.fill(0);
  suitCount.fill(0);
  suitMask.fill(0);
  let all = 0;
  for (let i = 0; i < n; i++) {
    const c = codes[i];
    const r = (c >> 2) + 2;
    const s = c & 3;
    rankCount[r]++;
    suitCount[s]++;
    suitMask[s] |= 1 << r;
    all |= 1 << r;
  }
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s] >= 5) flushSuit = s;
  if (flushSuit >= 0) {
    const sf = straightHigh(suitMask[flushSuit]);
    if (sf) return pack(8, sf, 0, 0, 0, 0);
  }

  let quad = 0;
  let trip = 0;
  let trip2 = 0;
  let pair1 = 0;
  let pair2 = 0;
  for (let r = 14; r >= 2; r--) {
    const c = rankCount[r];
    if (c === 4) quad = r;
    else if (c === 3) {
      if (!trip) trip = r;
      else if (!trip2) trip2 = r;
    } else if (c === 2) {
      if (!pair1) pair1 = r;
      else if (!pair2) pair2 = r;
    }
  }

  if (quad) {
    kickers(kick, quad, 0, 1);
    return pack(7, quad, kick[0], 0, 0, 0);
  }
  if (trip && (trip2 || pair1)) {
    return pack(6, trip, Math.max(trip2, pair1), 0, 0, 0);
  }
  if (flushSuit >= 0) {
    let k = 0;
    for (let r = 14; r >= 2 && k < 5; r--) if ((suitMask[flushSuit] >> r) & 1) kick[k++] = r;
    return pack(5, kick[0], kick[1], kick[2], kick[3], kick[4]);
  }
  const st = straightHigh(all);
  if (st) return pack(4, st, 0, 0, 0, 0);
  if (trip) {
    kickers(kick, trip, 0, 2);
    return pack(3, trip, kick[0], kick[1], 0, 0);
  }
  if (pair2) {
    kickers(kick, pair1, pair2, 1);
    return pack(2, pair1, pair2, kick[0], 0, 0);
  }
  if (pair1) {
    kickers(kick, pair1, 0, 3);
    return pack(1, pair1, kick[0], kick[1], kick[2], 0);
  }
  kickers(kick, 0, 0, 5);
  return pack(0, kick[0], kick[1], kick[2], kick[3], kick[4]);
}

/** Score of the best five out of five to seven cards; equals bestHand(cards).score. */
export function handScore(cards) {
  return scoreCodes(cards.map(codeOf), cards.length);
}

/**
 * Win probability against `opponents` random hands, ties counting as a share.
 * Unseen cards are sampled, so it is an estimate whose error shrinks with samples.
 */
export function estimateEquity(hole, board, opponents, samples, rng) {
  if (opponents <= 0) return 1;
  const known = new Set();
  const seven = new Array(7);
  let nHero = 0;
  for (const c of hole) {
    const code = codeOf(c);
    known.add(code);
    seven[nHero++] = code;
  }
  for (const c of board) {
    const code = codeOf(c);
    known.add(code);
    seven[nHero++] = code;
  }
  const unseen = [];
  for (let code = 0; code < 52; code++) if (!known.has(code)) unseen.push(code);

  const boardNeeded = 5 - board.length;
  const need = boardNeeded + 2 * opponents;
  if (need > unseen.length) return 0.5;

  const heroCards = new Array(7);
  const oppCards = new Array(7);
  let total = 0;
  for (let it = 0; it < samples; it++) {
    // Partial Fisher-Yates: only the cards actually dealt get shuffled.
    for (let i = 0; i < need; i++) {
      const j = i + randInt(rng, unseen.length - i);
      const t = unseen[i];
      unseen[i] = unseen[j];
      unseen[j] = t;
    }
    for (let i = 0; i < nHero; i++) heroCards[i] = seven[i];
    for (let i = 0; i < boardNeeded; i++) heroCards[nHero + i] = unseen[i];
    const heroScore = scoreCodes(heroCards, 7);

    let best = -1;
    let tied = 0;
    for (let o = 0; o < opponents; o++) {
      oppCards[0] = unseen[boardNeeded + 2 * o];
      oppCards[1] = unseen[boardNeeded + 2 * o + 1];
      for (let i = 0; i < 5; i++) {
        oppCards[2 + i] = i < board.length ? seven[2 + i] : unseen[i - board.length];
      }
      const sc = scoreCodes(oppCards, 7);
      if (sc > best) {
        best = sc;
        tied = 1;
      } else if (sc === best) tied++;
    }
    if (heroScore > best) total += 1;
    else if (heroScore === best) total += 1 / (tied + 1);
  }
  return samples > 0 ? total / samples : 0.5;
}

// ---- decisions -------------------------------------------------------------

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function buildContext(view) {
  const me = view.players[view.seat];
  const legal = view.legal;
  const live = view.players.filter((p) => !p.folded && !p.sittingOut);
  const street = view.log.filter((e) => e.street === view.phase);
  const raises = street.filter((e) => e.action === 'raise' || e.action === 'bet').length;
  const limpers = street.filter((e) => e.action === 'call').length;

  // Seats in the order they act postflop: first left of the button, button last.
  const order = [];
  const n = view.players.length;
  for (let i = 1; i <= n; i++) {
    const s = (view.button + i) % n;
    if (!view.players[s].sittingOut) order.push(s);
  }
  const idx = order.indexOf(view.seat);
  const relPos = order.length > 1 && idx >= 0 ? idx / (order.length - 1) : 1;

  return { view, me, legal, opp: Math.max(1, live.length - 1), raises, limpers, relPos };
}

/** A bet or raise to roughly `frac` of the pot after calling; sanitize() clamps it. */
function sized(c, frac) {
  const { view, legal } = c;
  return { type: view.currentBet === 0 ? 'bet' : 'raise', amount: view.currentBet + frac * (view.pot + legal.toCall) };
}

function preflop(c, skill, rng) {
  const { view, me, legal } = c;
  const hole = view.you.hole;
  const bb = view.bigBlind;
  const s = preflopStrength(hole);
  const premium = isPremium(hole);
  const shortStack = me.stack + me.bet <= 12 * bb;
  const canRaise = legal.canRaise;
  const late = c.relPos >= 0.66;

  let threshold = 0.4 - 0.2 * skill.looseness;
  threshold -= skill.position * (c.relPos - 0.5) * 0.12;
  threshold -= 0.03 * Math.max(0, 5 - c.opp);
  threshold += 0.07 * c.raises;
  const odds = legal.toCall / (view.pot + legal.toCall || 1);
  threshold += 0.35 * Math.max(0, odds - 0.3);

  const openTo = { type: 'raise', amount: c.raises === 0 ? bb * (3 + c.limpers) : view.currentBet * 3 };
  const flat = legal.canCheck ? { type: 'check' } : { type: 'call' };

  if (premium) {
    if (!canRaise) return flat;
    if (c.raises >= 2 || shortStack) return { type: 'allin' };
    return openTo;
  }

  const margin = 0.16 - 0.1 * skill.aggression;
  if (canRaise && s >= threshold + margin && c.raises < 2) {
    if (shortStack) return { type: 'allin' };
    if (c.raises === 0 || rng() < 0.25 + 0.5 * skill.aggression) return openTo;
    return flat;
  }
  // Stealing the blinds from late seats with hands a little below the line.
  if (canRaise && c.raises === 0 && late && legal.toCall <= bb && s >= threshold - 0.1 && rng() < skill.bluff) {
    return openTo;
  }
  if (s >= threshold) return flat;
  if (legal.canCheck) return flat;
  const cheap = legal.toCall <= bb && legal.toCall < me.stack * 0.1;
  if (cheap && rng() < skill.looseness * 0.45) return flat;
  return { type: 'fold' };
}

function postflop(c, skill, rng) {
  const { view, me, legal } = c;
  const equity = estimateEquity(view.you.hole, view.board, c.opp, skill.samples, rng);
  const pot = view.pot;
  const toCall = legal.toCall;
  const respect = 0.4 + 0.6 * (1 - skill.looseness);

  // Players who bet or raise hold more than a random hand; the harder the
  // pressure, the less a random-hand equity is worth.
  let eff = equity;
  if (toCall > 0) {
    const betFrac = toCall / Math.max(1, pot - toCall);
    eff -= respect * (Math.min(0.15, 0.12 * betFrac) + 0.03 * Math.min(c.raises, 3));
  }
  const valueLine = clamp(0.64 - 0.1 * skill.aggression - 0.035 * (c.opp - 1), 0.4, 0.7);
  const canRaise = legal.canRaise && c.raises < 3;

  if (toCall > 0) {
    const potOdds = toCall / (pot + toCall);
    const slack = 0.15 * skill.looseness - 0.02;
    if (eff < potOdds - slack) {
      const draw = equity > 0.25 && equity < 0.5 && view.phase !== Phase.RIVER;
      if (canRaise && draw && c.raises < 2 && rng() < skill.bluff * 0.6) return sized(c, 0.75);
      return { type: 'fold' };
    }
    if (canRaise && eff >= valueLine && rng() < 0.5 + 0.45 * skill.aggression) {
      return sized(c, 0.5 + 0.5 * rng());
    }
    return { type: 'call' };
  }

  if (!canRaise) return { type: 'check' };
  if (eff >= valueLine) {
    // Slow-playing a monster now and then keeps the weaker bots from folding.
    if (rng() < 0.8 + 0.2 * skill.aggression) return sized(c, 0.5 + 0.5 * rng());
    return { type: 'check' };
  }
  if (eff >= valueLine - 0.12 && rng() < 0.5 * skill.aggression) return sized(c, 0.33 + 0.17 * rng());
  const field = c.opp <= 1 ? 1.4 : c.opp === 2 ? 0.8 : 0.35;
  const bluffChance = skill.bluff * field * (1 + skill.position * (c.relPos - 0.5));
  if (eff < 0.45 && rng() < bluffChance) return sized(c, 0.5 + 0.25 * rng());
  return { type: 'check' };
}

/** A random but plausible slip: a flat call, a min-raise, or a fold to a big bet. */
function deviate(c, rng) {
  const { legal, view } = c;
  const roll = rng();
  if (legal.canCheck) {
    return roll < 0.5 || !legal.canRaise ? { type: 'check' } : { type: view.currentBet === 0 ? 'bet' : 'raise', amount: 0 };
  }
  const cheap = legal.toCall <= 0.35 * view.pot;
  if (!cheap) return { type: 'fold' };
  if (roll < 0.7 || !legal.canRaise) return { type: 'call' };
  return { type: 'raise', amount: 0 };
}

/** Force whatever was chosen into something the engine will accept. */
function sanitize(action, c) {
  const { legal, view } = c;
  const flat = legal.canCheck ? { type: 'check' } : { type: 'call' };
  switch (action.type) {
    case 'fold':
      return legal.canCheck ? { type: 'check' } : action;
    case 'check':
      return legal.canCheck ? action : { type: 'fold' };
    case 'call':
      return legal.canCall ? action : { type: 'check' };
    case 'allin':
      return legal.canRaise ? action : flat;
    case 'bet':
    case 'raise': {
      if (!legal.canRaise) return flat;
      const to = Math.round(Number.isFinite(action.amount) ? action.amount : 0);
      const amount = clamp(to, legal.minRaiseTo, legal.maxRaiseTo);
      const remainder = legal.maxRaiseTo - amount;
      if (amount >= legal.maxRaiseTo || remainder < 0.25 * view.pot) return { type: 'allin' };
      return { type: legal.isBet ? 'bet' : 'raise', amount };
    }
    default:
      return flat;
  }
}

/**
 * Pick a legal action from one seat's view.
 * @returns {{type: 'fold'|'check'|'call'|'bet'|'raise'|'allin', amount?: number}}
 */
export function chooseAction(view, skill, rng) {
  if (!view.legal) return { type: 'check' };
  const c = buildContext(view);
  let raw;
  if (skill.mistake > 0 && rng() < skill.mistake) raw = deviate(c, rng);
  else raw = view.phase === Phase.PREFLOP ? preflop(c, skill, rng) : postflop(c, skill, rng);
  return sanitize(raw, c);
}
