/**
 * Big Two bot.
 *
 * The bot only ever reads a seat view (own hand, opponents' card counts, the
 * live trick, history). Every play in Big Two lands face up, so there is no
 * hidden information to protect a "fair" bot from — the judgement that scales
 * with skill is entirely about hand-shape and tempo, not card counting.
 *
 * How difficulty scales
 * ----------------------
 * Two dials do what they do in doudizhu/ai.js:
 *   accuracy     probability of playing the move the evaluation ranked first;
 *                otherwise a softmax sample over the rest, so a mistake reads
 *                as a plausible worse move rather than noise.
 *   temperature  how flat that softmax is.
 *
 * Two switches turn tactical discipline on as the stakes rise (both start at
 * 'casual'/'sharp' rather than every tier, so the ladder actually has a top):
 *   controlAware   holds 2s and other high cards for control (folded into
 *                   handCost via controlValue) and refuses to break a made
 *                   pair, triple or five-card hand to answer with a lone
 *                   single unless that single wins outright or denies a
 *                   one-card opponent (see protectedCardIds/scoreMove).
 *   blocksOneCard  when the very next seat holds one card and the trick to
 *                   beat is a single, spends the *highest* legal single
 *                   rather than the cheapest — the one tactic worth hard-
 *                   coding rather than leaving to the shape heuristic, since
 *                   handing that seat the lead back with room to spare is how
 *                   a hand is lost in one move.
 *
 * Evaluation is a hand-shape heuristic, not a search: handCost(hand)
 * approximates the number of plays needed to empty it via greedy
 * decomposition, cheap and monotone in the right direction rather than exact
 * (see estimatePlays). Big Two's hands are short enough (13 cards, only four
 * play shapes) that even the "exhaustive" parts of this file — protectedCardIds,
 * every candidate scored by scoreMove — stay O(hand length) or so; nothing
 * here needs doudizhu's bounded search machinery.
 */

import { countByRank, groupByRank } from '../../core/cards.js';
import { weightedPick } from '../../core/rng.js';
import { SEATS } from './engine.js';
import { Combo, STRAIGHT_WINDOWS, beats, cardValue } from './rules.js';
import { legalPlays } from './moves.js';

/**
 * @typedef {object} Skill
 * @property {string} name
 * @property {number} accuracy      0..1, chance of taking the best-ranked move
 * @property {number} temperature   softmax spread used for the remaining moves
 * @property {boolean} controlAware hold control cards, don't break a made set
 *                      for a single unless it wins or blocks a 1-card seat
 * @property {boolean} blocksOneCard spend the highest single when the next
 *                      seat has one card and the trick to beat is a single
 */

/** Ready-made profiles. economy.js maps a lobby to one of these, same as doudizhu. */
export const SKILLS = {
  novice:      { name: 'Novice',      accuracy: 0.45, temperature: 26, controlAware: false, blocksOneCard: false },
  casual:      { name: 'Casual',      accuracy: 0.58, temperature: 20, controlAware: true,  blocksOneCard: false },
  steady:      { name: 'Steady',      accuracy: 0.70, temperature: 15, controlAware: true,  blocksOneCard: false },
  sharp:       { name: 'Sharp',       accuracy: 0.80, temperature: 11, controlAware: true,  blocksOneCard: true },
  expert:      { name: 'Expert',      accuracy: 0.86, temperature: 8,  controlAware: true,  blocksOneCard: true },
  master:      { name: 'Master',      accuracy: 0.92, temperature: 6,  controlAware: true,  blocksOneCard: true },
  grandmaster: { name: 'Grandmaster', accuracy: 0.97, temperature: 4,  controlAware: true,  blocksOneCard: true },
};

export function skillByName(name) {
  return SKILLS[name] ?? SKILLS.steady;
}

const W = {
  win: 100_000,   // emptying the hand ends it
  play: 12,       // weight on the estimated number of plays still needed
  control: 3,     // weight on keeping cards that tend to win a trick outright
  shed: 1,        // mild preference for getting rid of more cards
  nearWin: 40,    // leaving exactly one play behind
  chokeOpponent: 30,
  breakSet: 10,   // cost of cannibalising a made pair/triple/five-card hand for a single
};

// --- hand shape --------------------------------------------------------------

function removeByIds(cards, subset) {
  const ids = new Set(subset.map((c) => c.id));
  return cards.filter((c) => !ids.has(c.id));
}

/** The 5 actual cards a straight window resolves to, or null if not held. */
function takeStraight(pool, window) {
  const cards = [];
  for (const rank of window.ranks) {
    const card = pool.find((c) => c.rank === rank);
    if (!card) return null;
    cards.push(card);
  }
  return cards;
}

/**
 * Greedy decomposition into playable groups, returning the estimated number
 * of plays needed to empty the hand. Not the true minimum (that is a search
 * problem doudizhu's ai.js does not attempt either) but monotone in the right
 * direction and cheap: at most a handful of passes over a 13-card hand.
 *
 * Order of extraction: four-of-a-kind and full house first (they clear five
 * cards' worth of otherwise-stranded duplicates in one play), then whatever
 * straight or flush the remaining cards can still make, then plain triples,
 * pairs, and finally one play per leftover single.
 */
export function estimatePlays(cards) {
  let pool = [...cards];
  let plays = 0;

  for (;;) {
    const groups = groupByRank(pool);
    const quad = [...groups.entries()].find(([, list]) => list.length === 4);
    if (quad && pool.length >= 5) {
      const kicker = pool.find((c) => c.rank !== quad[0]);
      pool = removeByIds(pool, [...quad[1], kicker]);
      plays += 1;
      continue;
    }
    const triples = [...groups.entries()].filter(([, list]) => list.length >= 3);
    const houseTriple = triples
      .map(([rank, list]) => [rank, list, [...groups.entries()].find(([r, l]) => r !== rank && l.length >= 2)])
      .find(([, , pairEntry]) => pairEntry);
    if (houseTriple) {
      const [, list, pairEntry] = houseTriple;
      pool = removeByIds(pool, [...list.slice(0, 3), ...pairEntry[1].slice(0, 2)]);
      plays += 1;
      continue;
    }
    break;
  }

  for (;;) {
    const bySuit = new Map();
    for (const c of pool) {
      if (!bySuit.has(c.suit)) bySuit.set(c.suit, []);
      bySuit.get(c.suit).push(c);
    }
    const flush = [...bySuit.values()].find((list) => list.length >= 5);
    if (flush) {
      pool = removeByIds(pool, flush.slice(0, 5));
      plays += 1;
      continue;
    }
    const window = STRAIGHT_WINDOWS.map((w) => takeStraight(pool, w)).find(Boolean);
    if (window) {
      pool = removeByIds(pool, window);
      plays += 1;
      continue;
    }
    break;
  }

  const groups = groupByRank(pool);
  for (const [, list] of groups) {
    if (list.length >= 3) { pool = removeByIds(pool, list.slice(0, 3)); plays += 1; }
    else if (list.length === 2) { pool = removeByIds(pool, list); plays += 1; }
  }
  plays += pool.length; // one play per remaining loose single
  return plays;
}

/** Cards that tend to win a trick outright: twos above all, then aces, then anything doubled up. */
export function controlValue(cards) {
  const counts = countByRank(cards);
  let value = (counts.get(15) ?? 0) * 3 + (counts.get(14) ?? 0) * 1.5;
  for (const [, n] of counts) if (n >= 2) value += 0.6 * n;
  return value;
}

/** Lower is better: the number a move is judged by, before tactics. */
export function handCost(cards) {
  return estimatePlays(cards) * W.play - controlValue(cards) * W.control;
}

/**
 * Card ids worth keeping intact: half of a made pair/triple/quad, or any card
 * that takes part in a flush or straight the current hand can still make.
 * Playing one of these as a lone single spends a shape that was worth more
 * whole — see scoreMove's use of this via controlAware.
 */
function protectedCardIds(hand) {
  const ids = new Set();
  for (const list of groupByRank(hand).values()) {
    if (list.length >= 2) for (const c of list) ids.add(c.id);
  }
  const bySuit = new Map();
  for (const c of hand) {
    if (!bySuit.has(c.suit)) bySuit.set(c.suit, []);
    bySuit.get(c.suit).push(c);
  }
  for (const list of bySuit.values()) {
    if (list.length >= 5) for (const c of list) ids.add(c.id);
  }
  const ranksHeld = new Set(hand.map((c) => c.rank));
  for (const window of STRAIGHT_WINDOWS) {
    if (window.ranks.every((r) => ranksHeld.has(r))) {
      for (const c of hand) if (window.ranks.includes(c.rank)) ids.add(c.id);
    }
  }
  return ids;
}

// --- decisions ---------------------------------------------------------------

function scoreMove(view, skill, move, protectedIds) {
  const remaining = removeByIds(view.you.hand, move.cards);
  if (remaining.length === 0) return W.win;

  let score = -handCost(remaining) + move.size * W.shed;
  if (estimatePlays(remaining) === 1) score += W.nearWin;

  const seat = view.seat;
  const next = view.players[(seat + 1) % SEATS];
  // The one tactic worth hard-coding rather than trusting the shape heuristic
  // to find on its own: with the very next seat down to their last card and a
  // single to beat, spending the strongest single denies them the chance to
  // top it and go out. A weak single here is a wasted turn at best.
  const blocking = !!(skill.blocksOneCard && view.trick && view.trick.combo.type === Combo.SINGLE
    && next && next.cards === 1);

  if (move.type === Combo.SINGLE) {
    const card = move.cards[0];
    if (blocking) {
      score += cardValue(card) * 6;
    } else {
      score -= card.rank * 0.6; // dump low singles first when nothing is urgent
      if (skill.controlAware && protectedIds.has(card.id)) score -= W.breakSet;
    }
  }

  // Leading with size presses an opponent who is down to very few cards
  // harder than doling out one card at a time.
  if (!view.trick) {
    const lowest = Math.min(...view.players.filter((p) => p.seat !== seat).map((p) => p.cards));
    if (lowest <= 2 && move.size >= 2) score += W.chokeOpponent * 0.4;
  }

  return score;
}

function scorePass(view) {
  const seat = view.seat;
  let score = -handCost(view.you.hand) - 4; // passing keeps the hand but wastes a turn
  if (view.players.some((p) => p.seat !== seat && p.cards <= 1)) score -= W.chokeOpponent;
  return score;
}

/**
 * Pick a move. Returns {action:'play', cards} or {action:'pass'}.
 * @param {object} view seat view from engine.seatView()
 * @param {Skill} skill
 * @param {() => number} rng
 */
export function chooseMove(view, skill, rng) {
  const hand = view.you.hand;
  const current = view.trick?.combo ?? null;
  const moves = legalPlays(hand, current, { mustInclude: view.leadMustInclude ?? null });
  const canPass = !!current;
  if (!moves.length) {
    // Cannot happen with a non-empty hand on a lead (every single card is a
    // legal lead), but never hand back an illegal action either way.
    return canPass ? { action: 'pass' } : { action: 'play', cards: [hand[0]] };
  }

  const protectedIds = skill.controlAware ? protectedCardIds(hand) : new Set();
  const scored = moves.map((move) => ({ move, score: scoreMove(view, skill, move, protectedIds) }));
  if (canPass) scored.push({ move: null, score: scorePass(view) });
  scored.sort((a, b) => b.score - a.score);

  let chosen = scored[0];
  if (scored.length > 1 && rng() > skill.accuracy) {
    const rest = scored.slice(1);
    const best = scored[0].score;
    const weights = rest.map((entry) => Math.exp((entry.score - best) / Math.max(1, skill.temperature)));
    chosen = weightedPick(rng, rest, weights) ?? chosen;
  }
  return chosen.move ? { action: 'play', cards: chosen.move.cards } : { action: 'pass' };
}

/**
 * The evaluation's own top choice, with none of chooseMove's accuracy/
 * temperature randomness. Exposed for the simulator and for tests that need
 * to pin down exactly what the heuristic ranks best.
 */
export function bestMove(view, skill) {
  const hand = view.you.hand;
  const current = view.trick?.combo ?? null;
  const moves = legalPlays(hand, current, { mustInclude: view.leadMustInclude ?? null });
  const canPass = !!current;
  if (!moves.length) return canPass ? { action: 'pass' } : { action: 'play', cards: [hand[0]] };

  const protectedIds = skill.controlAware ? protectedCardIds(hand) : new Set();
  let best = null;
  for (const move of moves) {
    const score = scoreMove(view, skill, move, protectedIds);
    if (!best || score > best.score) best = { move, score };
  }
  const passScore = canPass ? scorePass(view) : -Infinity;
  if (passScore > best.score) return { action: 'pass' };
  return { action: 'play', cards: best.move.cards };
}

export { beats };
