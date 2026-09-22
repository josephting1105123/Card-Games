/**
 * Dou Di Zhu bot.
 *
 * The bot only ever reads a seat view (own hand, opponents' card counts, the
 * played pile, the revealed bottom three). It cannot see another player's hand,
 * so raising the difficulty means better judgement, never more information.
 *
 * How difficulty scales
 * ---------------------
 * Each lobby supplies a skill profile. Two dials do most of the work:
 *
 *   accuracy     probability of actually playing the move the evaluation ranked
 *                first. The rest of the time the bot samples from a softmax over
 *                the remaining moves, so a mistake is a plausible worse move
 *                rather than noise.
 *   temperature  how flat that softmax is. Low-stake bots wander further from
 *                the best line when they do slip.
 *
 * Three switches turn judgement on as the stakes rise:
 *
 *   partnerAware   a farmer stops beating its own partner's lead
 *   countsCards    the bot tracks the played pile and knows when a card of its
 *                  own is the highest of that rank still live
 *   bombDiscipline how strongly it refuses to break a bomb for a small gain
 *
 * Evaluation is a hand-shape heuristic, not a search: cost(hand) approximates
 * the number of tricks needed to shed it, computed by greedy decomposition in
 * O(r^2) over the 15 distinct ranks. There is no minimax, which is why the top
 * lobby plays a strong club game rather than perfectly — exact Dou Di Zhu
 * endgames are a search problem well beyond a heuristic, and a bot that never
 * erred would make the 1M table unplayable rather than hard.
 */

import {
  RANK_CHAIN_MAX,
  RANK_JOKER_BIG,
  RANK_JOKER_SMALL,
  RANK_TWO,
  cardFromId,
  countByRank,
} from '../../core/cards.js';
import { weightedPick } from '../../core/rng.js';
import { Combo, beats } from './rules.js';
import { legalPlays, moveCost } from './moves.js';

/**
 * @typedef {object} Skill
 * @property {string} name
 * @property {number} accuracy      0..1, chance of taking the best-ranked move
 * @property {number} temperature   softmax spread used for the remaining moves
 * @property {boolean} countsCards
 * @property {boolean} partnerAware
 * @property {number} bombDiscipline 0..1
 * @property {number} bidNoise       added to hand strength when calling points
 */

/** Ready-made profiles. economy.js maps a lobby to one of these. */
export const SKILLS = {
  novice:   { name: 'Novice',   accuracy: 0.45, temperature: 26, countsCards: false, partnerAware: false, bombDiscipline: 0.1, bidNoise: 0.30 },
  casual:   { name: 'Casual',   accuracy: 0.62, temperature: 18, countsCards: false, partnerAware: true,  bombDiscipline: 0.3, bidNoise: 0.22 },
  steady:   { name: 'Steady',   accuracy: 0.72, temperature: 14, countsCards: false, partnerAware: true,  bombDiscipline: 0.5, bidNoise: 0.16 },
  sharp:    { name: 'Sharp',    accuracy: 0.80, temperature: 11, countsCards: true,  partnerAware: true,  bombDiscipline: 0.65, bidNoise: 0.12 },
  expert:   { name: 'Expert',   accuracy: 0.86, temperature: 8,  countsCards: true,  partnerAware: true,  bombDiscipline: 0.78, bidNoise: 0.08 },
  master:   { name: 'Master',   accuracy: 0.92, temperature: 6,  countsCards: true,  partnerAware: true,  bombDiscipline: 0.88, bidNoise: 0.05 },
  grandmaster: { name: 'Grandmaster', accuracy: 0.97, temperature: 4, countsCards: true, partnerAware: true, bombDiscipline: 0.95, bidNoise: 0.02 },
};

export function skillByName(name) {
  return SKILLS[name] ?? SKILLS.steady;
}

const W = {
  play: 11,        // weight on the estimated number of tricks still needed
  shed: 0.7,       // mild preference for getting rid of more cards
  control: 2.2,    // weight on keeping cards that win tricks
  win: 10000,      // emptying the hand ends it
  nearWin: 55,     // leaving one play behind
  partnerLead: 90, // farmers do not fight their own partner
  chokeOpponent: 40,
  breakSet: 14,
};

// --- hand shape --------------------------------------------------------------

/**
 * Greedy decomposition into playable groups. Returns the estimated number of
 * tricks needed to empty the hand. Not the true minimum (that is a search
 * problem), but monotone in the right direction and cheap: O(r^2).
 */
export function estimatePlays(cards) {
  const counts = countByRank(cards);
  const take = (rank, n) => {
    const left = (counts.get(rank) ?? 0) - n;
    if (left > 0) counts.set(rank, left);
    else counts.delete(rank);
  };
  let plays = 0;

  if (counts.get(RANK_JOKER_SMALL) && counts.get(RANK_JOKER_BIG)) {
    take(RANK_JOKER_SMALL, 1);
    take(RANK_JOKER_BIG, 1);
    plays += 1;
  }
  for (const [rank, n] of [...counts]) {
    if (n === 4) {
      take(rank, 4);
      plays += 1;
    }
  }
  plays += extractChains(counts, 3, 2);
  plays += extractChains(counts, 2, 3);
  plays += extractChains(counts, 1, 5);

  // Trios soak up a kicker, so they cost one trick and clear a loose card too.
  for (const [rank, n] of [...counts]) {
    if (n !== 3) continue;
    take(rank, 3);
    plays += 1;
    const kicker = [...counts.entries()].filter(([r, c]) => c <= 2 && r !== rank).sort((a, b) => a[0] - b[0])[0];
    if (kicker) take(kicker[0], Math.min(2, kicker[1]));
  }
  for (const [rank, n] of [...counts]) {
    if (n === 2) {
      take(rank, 2);
      plays += 1;
    }
  }
  for (const [rank, n] of [...counts]) {
    plays += n;
    take(rank, n);
  }
  return plays;
}

/** Pull out chains of `copies` cards per rank, longest first. Mutates counts. */
function extractChains(counts, copies, minLength) {
  let plays = 0;
  let found = true;
  while (found) {
    found = false;
    let best = null;
    for (let start = 3; start <= RANK_CHAIN_MAX; start++) {
      let end = start - 1;
      for (let r = start; r <= RANK_CHAIN_MAX; r++) {
        if ((counts.get(r) ?? 0) < copies) break;
        end = r;
      }
      const length = end - start + 1;
      if (length >= minLength && (!best || length > best.length)) best = { start, end, length };
    }
    if (best) {
      for (let r = best.start; r <= best.end; r++) {
        const left = counts.get(r) - copies;
        if (left > 0) counts.set(r, left);
        else counts.delete(r);
      }
      plays += 1;
      found = true;
    }
  }
  return plays;
}

/** Cards that tend to win a trick outright. */
export function controlValue(cards) {
  const counts = countByRank(cards);
  let value = 0;
  if (counts.get(RANK_JOKER_BIG)) value += 4;
  if (counts.get(RANK_JOKER_SMALL)) value += 2.5;
  value += (counts.get(RANK_TWO) ?? 0) * 1.6;
  value += (counts.get(14) ?? 0) * 0.8;
  for (const [, n] of counts) if (n === 4) value += 3;
  return value;
}

/** Lower is better. The number a move is judged by, before tactics. */
export function handCost(cards) {
  return estimatePlays(cards) * W.play - controlValue(cards) * W.control;
}

/**
 * Rough 0..1 read of how good a hand is for taking the landlord's seat.
 * Used for bidding.
 */
export function handStrength(cards) {
  const counts = countByRank(cards);
  let score = 0;
  if (counts.get(RANK_JOKER_BIG)) score += 8;
  if (counts.get(RANK_JOKER_SMALL)) score += 6;
  score += (counts.get(RANK_TWO) ?? 0) * 3;
  score += (counts.get(14) ?? 0) * 1.6;
  for (const [, n] of counts) if (n === 4) score += 7;
  score -= Math.max(0, estimatePlays(cards) - 7) * 1.8;
  return clamp((score - 2) / 26, 0, 1);
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// --- card counting -----------------------------------------------------------

/**
 * Cards nobody at the table has seen yet, from this seat's point of view:
 * the full deck minus this hand, minus everything played, minus the three
 * bottom cards once they have been turned face up. O(54).
 */
export function unseenCards(view) {
  const known = new Set();
  for (const card of view.you.hand) known.add(card.id);
  for (const card of view.playedCards ?? []) known.add(card.id);
  if (view.bottomRevealed) for (const card of view.bottom ?? []) if (card) known.add(card.id);
  const out = [];
  for (let id = 0; id < 54; id++) if (!known.has(id)) out.push(cardFromId(id));
  return out;
}

/**
 * Is there any combination in the unseen pool that beats this move? The pool is
 * the union of both opponents' hands, so a "no" is conservative: the move is
 * safe even in the worst split of the unseen cards.
 *
 * Reusing legalPlays() here means the check follows exactly the same rules the
 * table does, instead of an approximation that drifts away from them.
 */
function unanswerable(move, unseen) {
  if (move.type === Combo.ROCKET) return true;
  return legalPlays(unseen, move, { kickerChoices: 1 }).length === 0;
}

// --- decisions ---------------------------------------------------------------

/**
 * Points to call during bidding: 0 (pass), 1, 2 or 3.
 * @param {object} view seat view
 * @param {Skill} skill
 * @param {() => number} rng
 */
export function chooseBid(view, skill, rng) {
  const highest = view.bidding?.highest ?? 0;
  const noise = (rng() * 2 - 1) * skill.bidNoise;
  const strength = clamp(handStrength(view.you.hand) + noise, 0, 1);
  let wanted = 0;
  if (strength > 0.70) wanted = 3;
  else if (strength > 0.50) wanted = 2;
  else if (strength > 0.31) wanted = 1;
  // Being last to speak with nobody calling is worth a cheap 1.
  const spoken = view.bidding?.calls?.length ?? 0;
  if (wanted === 0 && highest === 0 && spoken === 2 && strength > 0.22) wanted = 1;
  return wanted > highest ? wanted : 0;
}

/**
 * Pick a move. Returns { pass: true } or { cards }.
 * @param {object} view seat view from engine.seatView()
 * @param {Skill} skill
 * @param {() => number} rng
 */
export function chooseMove(view, skill, rng) {
  const hand = view.you.hand;
  const current = view.trick?.combo ?? null;
  const moves = legalPlays(hand, current, { kickerChoices: 2 });
  const canPass = !!current;
  if (!moves.length) return canPass ? { pass: true } : null;

  const unseen = skill.countsCards ? unseenCards(view) : null;
  const scored = moves.map((move) => ({ move, score: scoreMove(view, skill, move, unseen) }));
  if (canPass) scored.push({ move: null, score: scorePass(view, skill) });
  scored.sort((a, b) => b.score - a.score);

  let chosen = scored[0];
  if (scored.length > 1 && rng() > skill.accuracy) {
    const rest = scored.slice(1);
    const best = scored[0].score;
    const weights = rest.map((entry) => Math.exp((entry.score - best) / Math.max(1, skill.temperature)));
    chosen = weightedPick(rng, rest, weights) ?? chosen;
  }
  return chosen.move ? { cards: chosen.move.cards } : { pass: true };
}

function scoreMove(view, skill, move, unseen) {
  const seat = view.seat;
  const me = view.players[seat];
  const remaining = removeByIds(view.you.hand, move.cards);
  if (remaining.length === 0) return W.win;

  let score = -handCost(remaining) + move.size * W.shed;

  // One play left and we are about to hold the lead: very strong.
  if (estimatePlays(remaining) === 1) score += W.nearWin;

  const opponents = view.players.filter((p) => p.seat !== seat && !sameSide(me, p));
  const partner = view.players.find((p) => p.seat !== seat && sameSide(me, p));
  const opponentLow = Math.min(...opponents.map((p) => p.cards));

  // Spending a bomb: only worth it to stop someone who is about to go out, or to
  // win outright. bombDiscipline decides how strict the bot is about that.
  if (move.bomb) {
    const urgent = opponentLow <= 2 || remaining.length <= 3;
    if (!urgent) score -= W.play * 3.5 * skill.bombDiscipline;
    else score += W.chokeOpponent * skill.bombDiscipline;
  }

  // Breaking a set to feed a kicker costs shape.
  score -= brokenSets(view.you.hand, move.cards) * W.breakSet;

  // Counting pays off on a lead, and only on a lead. An unbeatable card is worth
  // spending when it closes the hand out or when an opponent is one play from
  // going out; spending it in the opening is just giving away control, which is
  // the mistake an earlier version of this evaluation made.
  if (!view.trick && unseen && !move.bomb) {
    const nearOut = opponentLow <= 2;
    const closing = estimatePlays(remaining) <= 2;
    if (unanswerable(move, unseen)) {
      if (nearOut) score += W.chokeOpponent * 1.2;
      else if (closing) score += W.chokeOpponent * 0.8;
    } else if (nearOut) {
      score -= W.chokeOpponent * 0.5; // handing over the lead at the worst moment
    }
  }

  // Do not open with a low single while an opponent is nearly out.
  if (!view.trick && opponentLow <= 3 && move.type === Combo.SINGLE && move.rank < 11) {
    score -= W.chokeOpponent * 0.8;
  }

  // As a farmer, beating your own partner hands the trick back to the landlord.
  if (view.trick && skill.partnerAware && partner && view.trick.leader === partner.seat) {
    const landlordCards = opponents[0]?.cards ?? 17;
    const partnerNearlyOut = partner.cards <= 2;
    if (partnerNearlyOut || partner.cards <= landlordCards) score -= W.partnerLead;
  }

  return score;
}

function scorePass(view, skill) {
  const seat = view.seat;
  const me = view.players[seat];
  const partner = view.players.find((p) => p.seat !== seat && sameSide(me, p));
  let score = -handCost(view.you.hand) - 4; // passing keeps the hand but wastes a turn
  if (skill.partnerAware && partner && view.trick?.leader === partner.seat) score += W.partnerLead * 0.8;
  const opponents = view.players.filter((p) => p.seat !== seat && !sameSide(me, p));
  if (opponents.some((p) => p.cards <= 2)) score -= W.chokeOpponent; // cannot afford to let them through
  return score;
}

function sameSide(a, b) {
  return a.role === b.role;
}

function removeByIds(hand, cards) {
  const ids = new Set(cards.map((c) => c.id));
  return hand.filter((c) => !ids.has(c.id));
}

/**
 * How many pairs/trios/bombs the move tears apart by using only some of a rank.
 * Cheap shape penalty: O(n).
 */
function brokenSets(hand, cards) {
  const handCounts = countByRank(hand);
  const moveCounts = countByRank(cards);
  let broken = 0;
  for (const [rank, used] of moveCounts) {
    const held = handCounts.get(rank) ?? 0;
    if (used < held && held >= 2) broken += 1;
    if (used < held && held === 4) broken += 2; // splitting a bomb is worse
  }
  return broken;
}

/** Exposed for the simulator: rank moves without the randomness. */
export function bestMove(view, skill) {
  const current = view.trick?.combo ?? null;
  const moves = legalPlays(view.you.hand, current, { kickerChoices: 2 });
  if (!moves.length) return current ? { pass: true } : null;
  const unseen = skill.countsCards ? unseenCards(view) : null;
  let best = null;
  for (const move of moves) {
    const score = scoreMove(view, skill, move, unseen);
    if (!best || score > best.score) best = { move, score };
  }
  const passScore = current ? scorePass(view, skill) : -Infinity;
  if (passScore > best.score) return { pass: true };
  return { cards: best.move.cards };
}

export { moveCost, beats };
