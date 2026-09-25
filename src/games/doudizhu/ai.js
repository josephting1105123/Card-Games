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
 *   bombDiscipline how strongly it refuses to break a bomb for a small gain —
 *                  and, the same thing in disguise, how strongly it refuses to
 *                  play a four-with-kickers or split a four into a smaller
 *                  combo, both of which spend the bomb without ever doubling
 *                  the stake. sharp and up (fourDisciplineThreshold) refuse it
 *                  outright unless it empties the hand, leaves a single
 *                  remaining play the unseen cards cannot beat, or — only as a
 *                  last resort, and only when no legal bomb/rocket would do the
 *                  same job — an opponent is down to fourDisciplineThreshold
 *                  cards or fewer and nothing else legal can deny them.
 *
 * Evaluation is mostly a hand-shape heuristic, not a search: cost(hand)
 * approximates the number of tricks needed to shed it, computed by greedy
 * decomposition in O(r^2) over the 15 distinct ranks. That is why the top
 * lobby plays a strong club game rather than perfectly — a full-hand minimax
 * is a search problem well beyond it, and a bot that never erred would make
 * the 1M table unplayable rather than hard. The one exception is the bounded
 * endgame search in findForcedWin(): once a countsCards bot is down to a
 * handful of cards it checks, exactly, whether some ordering of its remaining
 * cards can go out without ever offering a play the unseen pool could beat —
 * sound but not complete (it only proves wins built entirely from unanswerable
 * plays), and cheap enough to run on every such turn.
 */

import {
  RANK_CHAIN_MAX,
  RANK_JOKER_BIG,
  RANK_JOKER_SMALL,
  RANK_TWO,
  cardFromId,
  countByRank,
} from '../../core/cards.js';
import { makeRng, shuffle, weightedPick } from '../../core/rng.js';
import { Combo, beats, classify } from './rules.js';
import { enumerateLeads, legalPlays, moveCost } from './moves.js';

/**
 * @typedef {object} Skill
 * @property {string} name
 * @property {number} accuracy      0..1, chance of taking the best-ranked move
 * @property {number} temperature   softmax spread used for the remaining moves
 * @property {boolean} countsCards
 * @property {boolean} partnerAware
 * @property {number} bombDiscipline 0..1
 * @property {number} fourDisciplineThreshold 0 to leave a four-with-kickers (or
 *                      splitting a four into a smaller combo) to bombDiscipline's
 *                      soft scoring penalty, same as a real bomb; above 0, hard-
 *                      filter it out of the candidate list unless it wins
 *                      outright, is provably safe, or (last resort, and only
 *                      when no bomb/rocket is legal instead) an opponent holds
 *                      this many cards or fewer and nothing else legal stops
 *                      them. sharp/expert use 3, master/grandmaster use 2.
 * @property {number} bidNoise       added to hand strength when calling points
 */

/** Ready-made profiles. economy.js maps a lobby to one of these. */
export const SKILLS = {
  novice:      { name: 'Novice',      accuracy: 0.45, temperature: 26, countsCards: false, partnerAware: false, bombDiscipline: 0.1,  fourDisciplineThreshold: 0, bidNoise: 0.30 },
  casual:      { name: 'Casual',      accuracy: 0.62, temperature: 18, countsCards: false, partnerAware: true,  bombDiscipline: 0.3,  fourDisciplineThreshold: 0, bidNoise: 0.22 },
  steady:      { name: 'Steady',      accuracy: 0.72, temperature: 14, countsCards: false, partnerAware: true,  bombDiscipline: 0.5,  fourDisciplineThreshold: 0, bidNoise: 0.16 },
  sharp:       { name: 'Sharp',       accuracy: 0.80, temperature: 11, countsCards: true,  partnerAware: true,  bombDiscipline: 0.65, fourDisciplineThreshold: 3, bidNoise: 0.12 },
  expert:      { name: 'Expert',      accuracy: 0.86, temperature: 8,  countsCards: true,  partnerAware: true,  bombDiscipline: 0.78, fourDisciplineThreshold: 3, bidNoise: 0.08 },
  master:      { name: 'Master',      accuracy: 0.92, temperature: 6,  countsCards: true,  partnerAware: true,  bombDiscipline: 0.88, fourDisciplineThreshold: 2, bidNoise: 0.05 },
  grandmaster: { name: 'Grandmaster', accuracy: 0.97, temperature: 4,  countsCards: true,  partnerAware: true,  bombDiscipline: 0.95, fourDisciplineThreshold: 2, bidNoise: 0.02 },
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

// --- spending a bomb without playing one --------------------------------------

/**
 * True when `move` uses one or more cards from a rank this hand holds all four
 * of, without the move itself being the bomb (or the rocket). Covers both
 * four-with-kickers (all four cards, plus two more) and splitting a four —
 * using only one, two or three of them in some other combo. Either way the
 * bomb is gone from the hand and the stake was never doubled for it, which is
 * the thing worth discouraging.
 */
function spendsFour(hand, move) {
  if (move.bomb) return false;
  const handCounts = countByRank(hand);
  const moveCounts = countByRank(move.cards);
  for (const [rank, used] of moveCounts) {
    if (used >= 1 && (handCounts.get(rank) ?? 0) === 4) return true;
  }
  return false;
}

/**
 * Spending a four early is provably fine, without trusting a heuristic, in two
 * cases: it empties the hand outright, or the cards left over, played as a
 * single combo, are something the unseen pool cannot beat ("leaves exactly one
 * play that cannot be beaten"). Anything short of that is for
 * filterFourDiscipline's own last-resort case to weigh, not this function —
 * an earlier version folded a broad "urgent" test in here too (opponent low on
 * cards, or few of my own left) and it let through six-card sheds that neither
 * finished the hand nor denied anyone anything, which is exactly the "weird"
 * behaviour this was meant to fix.
 */
function fourSpendJustified(remaining, unseen) {
  if (remaining.length === 0) return true;
  if (!unseen) return false;
  const combo = classify(remaining);
  return !!combo && unanswerable(combo, unseen);
}

/**
 * For sharp and up (fourDisciplineThreshold > 0): drop any move that spends or
 * splits a four unless it is justified, rather than merely scoring it down.
 *
 * Justified means one of:
 *   (a) it empties the hand outright;
 *   (b) what is left, played as one combo, nothing unseen can beat;
 *   (c) last resort — an opponent holds fourDisciplineThreshold cards or fewer,
 *       nothing else legal right now is provably safe against the unseen pool
 *       either, AND no plain bomb or rocket is legal this turn. That last part
 *       matters: whenever a move that spends a four is legal, a plain bomb of
 *       that same rank is legal too (a bomb can always be led, and always beats
 *       a non-bomb current combo), so in practice (c) only ever fires when the
 *       hand's spare four has already been spent on a bomb earlier and some
 *       *other* leftover fragment of it is what's being split — the point is
 *       the bot never breaks a four for kickers while a bomb was sitting right
 *       there doing the same job for free.
 *
 * Never returns an empty list — if every legal move happens to touch a four (a
 * hand made of nothing else) the filter backs off instead of leaving the bot
 * with nothing to play.
 */
function filterFourDiscipline(view, skill, moves, unseen) {
  const threshold = skill.fourDisciplineThreshold;
  if (!threshold) return moves;
  const hand = view.you.hand;
  const seat = view.seat;
  const me = view.players[seat];
  const opponentLow = Math.min(...view.players.filter((p) => p.seat !== seat && !sameSide(me, p)).map((p) => p.cards));
  const bombAvailable = moves.some((m) => m.bomb);
  const allowed = moves.filter((move) => {
    if (!spendsFour(hand, move)) return true;
    const remaining = removeByIds(hand, move.cards);
    if (fourSpendJustified(remaining, unseen)) return true;
    if (bombAvailable || opponentLow > threshold || !unseen) return false;
    const somethingElseStops = moves.some((m) => m !== move && unanswerable(m, unseen));
    return !somethingElseStops;
  });
  return allowed.length ? allowed : moves;
}

const FORCED_WIN_MAX_HAND = 8;
const FORCED_WIN_NODE_BUDGET = 20_000;

/**
 * Bounded exact endgame search. Looks for an ordering of `hand` into leads
 * that are each unanswerable by the unseen pool — so nobody can ever beat one,
 * meaning every one of them is passed on and the lead simply comes straight
 * back — all the way down to an empty hand. If one exists, that is a proven
 * win regardless of how the unseen cards are actually split between the two
 * opponents. Returns the first move of such a sequence, or null.
 *
 * Sound, not complete: a real forced win that requires offering an answerable
 * play (because the opponent who could beat it can be shown to never hold the
 * lead again) would be missed. Only ever tried on hands of FORCED_WIN_MAX_HAND
 * cards or fewer, where the search is cheap regardless; the node budget is a
 * backstop against a pathological hand, not something expected to bind.
 *
 * Bounded by node count alone, not wall-clock time: every bot decision has to
 * replay identically from its seed (see core/rng.js), on a phone or a loaded
 * LAN host alike, and a clock-based cutoff would make the move depend on how
 * fast the machine happened to be at the time.
 */
function findForcedWin(hand, unseen) {
  if (!hand.length || hand.length > FORCED_WIN_MAX_HAND) return null;
  let budget = FORCED_WIN_NODE_BUDGET;
  const search = (cards) => {
    if (cards.length === 0) return [];
    if (--budget < 0) return null;
    const leads = enumerateLeads(cards, { kickerChoices: 1 }).filter((m) => unanswerable(m, unseen));
    // Try the plays that shed the most cards first: not needed for correctness
    // (any successful decomposition proves the win), just finds one faster.
    leads.sort((a, b) => b.size - a.size || moveCost(a) - moveCost(b));
    for (const move of leads) {
      const rest = search(removeByIds(cards, move.cards));
      if (rest) return [move, ...rest];
    }
    return null;
  };
  const sequence = search(hand);
  return sequence && sequence.length ? sequence[0] : null;
}

// --- determinized endgame search ----------------------------------------------

/**
 * How many trailing passes the trick now in progress already carries, read
 * back out of trickPlays. Needed to resume a search mid-trick with the same
 * "how many more passes end it" state the real engine has, rather than
 * silently resetting it to zero and giving the search one pass too many.
 */
function currentPassStreak(view) {
  const plays = view.trickPlays ?? [];
  let streak = 0;
  for (let i = plays.length - 1; i >= 0; i--) {
    if (!plays[i].pass) break;
    streak += 1;
  }
  return streak;
}

const ENDGAME_TOTAL_MAX = 21;       // sum of all three hands left in play
const ENDGAME_DETERMINIZATIONS = 8; // sampled splits of the unseen pool
const ENDGAME_CANDIDATE_LIMIT = 10; // how many of my own candidate moves get the full determinized evaluation
// One search-node counter for the whole endgameDecision() call — every
// candidate, every determinization together, not a fresh budget per search.
// A per-search budget let a decision cost (candidates x determinizations)
// times as much as a single search looked like, which is what pushed worst-
// case time past the 150ms ceiling once the search window widened enough to
// matter. This is node count, not wall-clock time: every bot decision has to
// replay identically from its seed on any machine (see core/rng.js), and a
// clock-based cutoff would make the chosen move depend on how fast the
// machine that happened to compute it was. A hand here is at most
// ENDGAME_TOTAL_MAX cards, so the cost of a single node (legalPlays on a
// bounded hand) is itself bounded, and node count is calibrated below,
// empirically, against wall-clock time on the reference machine.
const ENDGAME_NODE_BUDGET_TOTAL = 9_000;

/**
 * Exact two-player alpha-beta (landlord maximising, the two farmers on one
 * side minimising — chip-wise they win and lose together, so it really is a
 * two-player zero-sum game once every hand is known) over one fully-known
 * deal. `hands` is indexed by seat and mutated then restored as the search
 * backtracks. Values are boolean-as-number: 1 means the landlord goes out
 * first, 0 means a farmer does, so a maximiser that reaches 1 or a minimiser
 * that reaches 0 can stop immediately — the cheap substitute for numeric
 * alpha-beta bounds that a two-valued game affords.
 *
 * Returns { value, choice } where choice is { cards } or { pass: true }, or
 * { value: null, choice: null } once the shared node budget runs out — every
 * caller must treat null as "unknown" and bail the whole search, not as a
 * result. `budget` is the one object shared across the whole endgameDecision()
 * call — see ENDGAME_NODE_BUDGET_TOTAL.
 */
function alphaBetaEndgame(hands, turn, current, leader, passStreak, roles, budget) {
  if (--budget.n < 0) return { value: null, choice: null };
  const hand = hands[turn];
  const maximizing = roles[turn] === 'landlord';
  const moves = legalPlays(hand, current, { kickerChoices: 2 });
  // Try the moves that end the hand outright first: they are the fastest way
  // to hit the stop-immediately case above, and legalPlays' own cost-ordering
  // is otherwise unrelated to which of these is actually best to search first.
  moves.sort((a, b) => (b.cards.length === hand.length ? 1 : 0) - (a.cards.length === hand.length ? 1 : 0));

  let bestValue = maximizing ? -Infinity : Infinity;
  let best = null;
  const better = (v) => (maximizing ? v > bestValue : v < bestValue);
  const done = () => (maximizing ? bestValue === 1 : bestValue === 0);

  for (const move of moves) {
    let value;
    if (move.cards.length === hand.length) {
      value = maximizing ? 1 : 0; // this seat empties its hand and the deal ends
    } else {
      const saved = hands[turn];
      hands[turn] = removeByIds(hand, move.cards);
      const res = alphaBetaEndgame(hands, (turn + 1) % 3, move, turn, 0, roles, budget);
      hands[turn] = saved;
      if (res.value === null) return { value: null, choice: null };
      value = res.value;
    }
    if (better(value)) { bestValue = value; best = { cards: move.cards }; }
    if (done()) break;
  }

  if (current && !done()) {
    const streak = passStreak + 1;
    const [nextTurn, nextCurrent, nextLeader, nextStreak] = streak >= 2
      ? [leader, null, leader, 0]
      : [(turn + 1) % 3, current, leader, streak];
    const res = alphaBetaEndgame(hands, nextTurn, nextCurrent, nextLeader, nextStreak, roles, budget);
    if (res.value === null) return { value: null, choice: null };
    if (better(res.value)) { bestValue = res.value; best = { pass: true }; }
  }

  if (best === null) return { value: maximizing ? 0 : 1, choice: null }; // must lead, nothing legal: cannot happen with a non-empty hand
  return { value: bestValue, choice: best };
}

/**
 * Apply one candidate (a move, or pass) to a fully-determined world and read
 * off whether the seat that owns this decision goes on to win it, with both
 * sides playing the rest out exactly (alphaBetaEndgame). Emptying the hand
 * outright is resolved without a search — there is nothing left to play.
 * Returns null when the search could not finish inside the decision's shared
 * node budget. `budget` is that shared object, passed in by endgameDecision()
 * so nodes spent on earlier candidates and worlds count against the same
 * total rather than each call getting its own fresh allowance.
 */
function evaluateChoice(hands, seat, choice, hand, current, leader, passStreak, roles, budget) {
  if (choice === null) {
    // Pass: only legal mid-trick. Work out where the turn and the trick
    // itself land next, exactly as pass() in engine.js does.
    const streak = passStreak + 1;
    const [nextTurn, nextCurrent, nextLeader, nextStreak] = streak >= 2
      ? [leader, null, leader, 0]
      : [(seat + 1) % 3, current, leader, streak];
    const res = alphaBetaEndgame(hands, nextTurn, nextCurrent, nextLeader, nextStreak, roles, budget);
    return res.value;
  }
  if (choice.cards.length === hand.length) return roles[seat] === 'landlord' ? 1 : 0; // goes out now
  const saved = hands[seat];
  hands[seat] = removeByIds(hand, choice.cards);
  const res = alphaBetaEndgame(hands, (seat + 1) % 3, choice, seat, 0, roles, budget);
  hands[seat] = saved;
  return res.value;
}

/**
 * Sample ENDGAME_DETERMINIZATIONS ways the unseen pool could actually be split
 * between the two opponents (their hand sizes are known, exactly, from the
 * seat view — only which cards is hidden). For each of my own legal moves —
 * shortlisted to ENDGAME_CANDIDATE_LIMIT by the ordinary heuristic, so the
 * search spends its budget on plausible plays rather than everything legal —
 * solve every sampled world exactly with alphaBetaEndgame() and see how often
 * that specific move wins. The same set of sampled worlds is reused for every
 * candidate (common random numbers), so the comparison between them is not
 * fighting its own sampling noise. Returns the move with the best win rate, or
 * null if none of them could be evaluated at all.
 *
 * Only tried once the total cards left across the table is small — the point
 * in the hand where "what if the split were different" has few enough answers
 * that a handful of full searches per candidate is still cheap.
 */
function endgameDecision(view, skill, unseen, rng) {
  const seat = view.seat;
  const opponents = view.players.filter((p) => p.seat !== seat);
  const opponentTotal = opponents.reduce((sum, p) => sum + p.cards, 0);
  const totalRemaining = view.you.hand.length + opponentTotal;
  if (totalRemaining > ENDGAME_TOTAL_MAX || totalRemaining <= 1) return null;

  // The bottom three are public — everyone at the table saw them go down —
  // and they always started in the landlord's hand. unseenCards() takes them
  // back out of the unseen pool unconditionally for that reason, whether or
  // not the landlord has since played one. So when the landlord is one of the
  // two seats being dealt for (true exactly when I am a farmer), the pool is
  // short by however many of the three the landlord is still holding: those
  // are pinned to the landlord's determinized hand instead of drawn at random,
  // rather than assumed to still all be there.
  const landlordOpponent = opponents.find((p) => p.role === 'landlord');
  const playedIds = new Set((view.playedCards ?? []).map((c) => c.id));
  const knownBottom = view.bottomRevealed ? (view.bottom ?? []).filter(Boolean) : [];
  const bottomOwed = landlordOpponent ? knownBottom.filter((c) => !playedIds.has(c.id)) : [];
  // Every card not in my hand, played, or the revealed bottom must be in one
  // of the two opponents' hands — if that count does not match what the seat
  // view says they are holding, something upstream is inconsistent and the
  // search has no reliable pool to deal from.
  if (unseen.length + bottomOwed.length !== opponentTotal) return null;
  if (bottomOwed.length > (landlordOpponent?.cards ?? 0)) return null; // paranoia: never pin more than the hand holds

  const hand = view.you.hand;
  const roles = view.players.map((p) => p.role);
  const current = view.trick ? view.trick.combo : null;
  const leader = view.trick ? view.trick.leader : seat;
  const passStreak = view.trick ? currentPassStreak(view) : 0;
  const iAmLandlord = roles[seat] === 'landlord';

  // filterFourDiscipline first: the exact search knows nothing about "do not
  // break a bomb for kickers" — it only sees win or lose — so without this a
  // wide-enough search window would happily rediscover the very move the
  // discipline rule exists to rule out, on the correct but beside-the-point
  // grounds that it wins this fully-determined sample.
  const legal = filterFourDiscipline(view, skill, legalPlays(hand, current, { kickerChoices: 2 }), unseen);
  const ranked = legal
    .map((move) => ({ move, score: scoreMove(view, skill, move, unseen) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, ENDGAME_CANDIDATE_LIMIT)
    .map((e) => e.move);
  /** @type {(object|null)[]} candidate choices; null stands for pass */
  const shortlist = current ? [...ranked, null] : ranked;
  if (!shortlist.length) return null;

  // Common random numbers: the same K worlds for every candidate, so "move A
  // won 5/6" versus "move B won 3/6" is a real difference and not two
  // candidates that happened to draw different pools.
  const worldSeeds = [];
  for (let k = 0; k < ENDGAME_DETERMINIZATIONS; k++) worldSeeds.push(shuffle([...unseen], rng));

  // One shared node budget for the whole decision (every candidate, every
  // determinization), not one per search — otherwise a search that looked
  // cheap in isolation still added up to an expensive decision once there
  // were (candidates x determinizations) of them. Deterministic and
  // machine-independent: see ENDGAME_NODE_BUDGET_TOTAL.
  const budget = { n: ENDGAME_NODE_BUDGET_TOTAL };

  let best = null;
  for (const choice of shortlist) {
    if (budget.n <= 0) break; // whatever is already scored stands; nothing new gets started
    let wins = 0;
    let evaluated = 0;
    for (const pool of worldSeeds) {
      const hands = [];
      let cursor = 0;
      for (const p of view.players) {
        if (p.seat === seat) { hands[p.seat] = hand; continue; }
        if (p === landlordOpponent && bottomOwed.length) {
          const need = p.cards - bottomOwed.length;
          hands[p.seat] = [...bottomOwed, ...pool.slice(cursor, cursor + need)];
          cursor += need;
          continue;
        }
        hands[p.seat] = pool.slice(cursor, cursor + p.cards);
        cursor += p.cards;
      }
      const value = evaluateChoice(hands, seat, choice, hand, current, leader, passStreak, roles, budget);
      if (value === null) continue; // this world's search ran out of the shared node budget; skip rather than guess
      evaluated += 1;
      if (iAmLandlord ? value === 1 : value === 0) wins += 1;
    }
    // A candidate the shared budget ran out on partway through is worse
    // information, not a worse move — comparing its rate against a
    // fully-sampled rival
    // would be comparing noise to signal, so it is left out of the running
    // entirely rather than letting a lucky partial sample win on paper and
    // then get discarded anyway (which used to make the whole search bail
    // even when an earlier candidate had finished clean).
    if (evaluated < ENDGAME_DETERMINIZATIONS) continue;
    const rate = wins / evaluated;
    // Ties favour whichever candidate the ordinary heuristic already ranked
    // first (shortlist is heuristic-sorted), so the search only overrides it
    // when it actually found something better.
    if (!best || rate > best.rate) best = { choice, rate };
  }
  if (!best) return null; // nothing finished cleanly inside the time/node budget; fall back to the heuristic
  return best.choice === null ? { pass: true } : { cards: best.choice.cards };
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

  // A proven win takes priority over the heuristic outright, the same way a
  // human who has counted the table out would just take it. The cheap
  // unanswerable-decomposition check first, since it is nearly free when it
  // does not apply; the determinized search second, since it also covers
  // responding to a trick, which the first check cannot.
  if (unseen) {
    if (!current && hand.length > 1) {
      const forced = findForcedWin(hand, unseen);
      if (forced) return { cards: forced.cards };
    }
    const deep = endgameDecision(view, skill, unseen, rng);
    if (deep) return deep.pass ? { pass: true } : { cards: deep.cards };
  }

  const candidates = filterFourDiscipline(view, skill, moves, unseen);
  const scored = candidates.map((move) => ({ move, score: scoreMove(view, skill, move, unseen) }));
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

  // Spending a bomb — playing it outright, playing a four-with-kickers, or
  // splitting a four into some other combo — is only worth it to stop someone
  // who is about to go out, or to win outright. bombDiscipline decides how
  // strict the bot is about that; skills with a fourDisciplineThreshold
  // (sharp and up) have already ruled the frivolous four-spends out of the
  // candidate list before this is even reached, via filterFourDiscipline.
  if (move.bomb || spendsFour(view.you.hand, move)) {
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

  // A farmer overtaking their own partner's already-winning play gains the
  // team nothing — the trick was already going their way — and costs a card
  // that might have mattered later, so this is close to an absolute rule, not
  // a judgement call that fades when the partner looks safe. (It was gated by
  // "partner nearly out or behind the landlord on cards" before; that let a
  // farmer overtake a comfortable partner for a marginal shed, which is
  // exactly the "fighting your own team" mistake partnerAware exists to rule
  // out.)
  if (view.trick && skill.partnerAware && partner && view.trick.leader === partner.seat) {
    score -= W.partnerLead;
  }

  // As a farmer, taking the trick back from the landlord (not from your own
  // partner) is worth a little extra: it denies the landlord the lead, which
  // is the one seat both farmers actually want to keep away from it. The
  // farmer who answers the landlord's own lead first — a fixed seat, turn
  // order being landlord then each farmer in turn — gets an extra push to beat
  // it comfortably rather than by the smallest margin: a bare-minimum beat
  // leaves the landlord's very next card able to retake it, while a firmer
  // answer actually costs them tempo. The second farmer, who by then is only
  // ever facing their own partner's play or a pass, is covered by the rule
  // above instead.
  if (view.trick && skill.partnerAware && me.role === 'farmer' && view.trick.leader !== partner?.seat && !move.bomb) {
    score += W.chokeOpponent * 0.35;
    const landlord = opponents.find((p) => p.role === 'landlord');
    if (landlord && view.trick.leader === landlord.seat && seat === (landlord.seat + 1) % 3) {
      score += move.rank * 0.9;
    }
  }

  // A farmer down to one or two cards is much likelier to hold a stray single
  // than a matching pair or chain. As the landlord, leading with size presses
  // that farmer harder than doling out singles one at a time.
  if (!view.trick && me.role === 'landlord' && opponentLow <= 2 && !move.bomb) {
    if (move.size >= 2) score += W.chokeOpponent * 0.5;
    else score -= W.chokeOpponent * 0.4;
  }

  // Feeding a partner who is down to their last one or two cards: lead your
  // cheapest single or pair rather than whatever sheds the most cost. A big
  // lead risks getting bombed or topped and wastes a card that could have
  // stayed in reserve; a small one is likely to go unanswered or answered
  // small, keeping the trick cheap and the initiative cycling back around to
  // the partner quickly.
  if (!view.trick && skill.partnerAware && partner && partner.cards <= 2 && !move.bomb
    && (move.type === Combo.SINGLE || move.type === Combo.PAIR)) {
    score -= move.rank * 1.4;
  }

  // Between two leads that shed the same amount and cost the same shape, take
  // the lower one: it is less likely to be the top of its rank still live, so
  // it is cheaper to lose and cheaper to have wasted if the trick is contested.
  if (!view.trick && !move.bomb) score -= move.rank * 0.15;

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

/** Exposed for the simulator: rank moves without the randomness of accuracy
 * and temperature. The endgame search still has its own internal sampling —
 * seeded from the hand itself, so the same view always resolves the same way. */
export function bestMove(view, skill) {
  const current = view.trick?.combo ?? null;
  const hand = view.you.hand;
  const moves = legalPlays(hand, current, { kickerChoices: 2 });
  if (!moves.length) return current ? { pass: true } : null;
  const unseen = skill.countsCards ? unseenCards(view) : null;
  if (unseen) {
    if (!current && hand.length > 1) {
      const forced = findForcedWin(hand, unseen);
      if (forced) return { cards: forced.cards };
    }
    const rng = makeRng(hand.map((c) => c.id).sort((a, b) => a - b).join(','));
    const deep = endgameDecision(view, skill, unseen, rng);
    if (deep) return deep.pass ? { pass: true } : { cards: deep.cards };
  }
  const candidates = filterFourDiscipline(view, skill, moves, unseen);
  let best = null;
  for (const move of candidates) {
    const score = scoreMove(view, skill, move, unseen);
    if (!best || score > best.score) best = { move, score };
  }
  const passScore = current ? scorePass(view, skill) : -Infinity;
  if (passScore > best.score) return { pass: true };
  return { cards: best.move.cards };
}

export { moveCost, beats };
