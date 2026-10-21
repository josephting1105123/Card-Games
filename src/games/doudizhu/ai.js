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
 *                first (on a search turn, the move the search picked). The rest
 *                of the time the bot samples from a softmax over the remaining
 *                moves, so a mistake is a plausible worse move rather than
 *                noise. Grandmaster's is 1: its numbers were measured with no
 *                slip, and a slip after paying for the search only costs strength.
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
 * Evaluation starts as a hand-shape heuristic: cost(hand) approximates the
 * number of tricks needed to shed it, computed by greedy decomposition in
 * O(r^2) over the 15 distinct ranks. That ranks every legal move cheaply, and
 * it is all the lower lobbies use. Two exact checks sit on top of it for
 * countsCards bots: findForcedWin() looks for an ordering of a small hand into
 * plays the unseen pool cannot beat (sound but not complete), and
 * endgameDecision() solves the last few cards exactly over sampled splits of
 * the unseen pool.
 *
 * Master and grandmaster add a Monte Carlo layer (Skill.search), still built
 * from the seat view alone:
 *
 *   inference    dealContext/drawWorlds deal the unseen cards to the two other
 *                seats in the card counts the table shows, with the revealed
 *                bottom pinned to the landlord's hand. Every pass an opponent
 *                made on a play it could have cheaply answered makes a world
 *                less likely (passTests/worldWeight), so the sample leans
 *                towards deals that explain how the opponents actually played.
 *   search       searchDecision() takes the heuristic's best few moves (and a
 *                pass) and plays each to the end in every sampled world with a
 *                fast rollout policy at all three seats (playOut), then keeps
 *                the one with the best mean stake. This is determinized
 *                (perfect-information) sampling, so it can be fooled by hands
 *                that only look good when the cards are known; the sampling
 *                and the heuristic fallback keep that in check.
 *   bidding      landlordEdge() plays the hand out as the landlord against
 *                sampled deals and bids by how far ahead that leaves it,
 *                instead of reading the call off the hand shape.
 *
 * Every budget here is a count of nodes or plies, never a time. A decision has
 * to replay identically from its seed (see core/rng.js) on a phone or a loaded
 * LAN host, and a clock cutoff would make the chosen move depend on how fast
 * the machine happened to be. The counts are sized against wall-clock cost on
 * a reference machine so the slowest decision stays well under a quarter of a
 * second. The bot still does not play perfectly, which is deliberate: a bot
 * that never erred would make the top table unplayable rather than hard.
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
 * @property {number} accuracy      0..1, chance of taking the best-ranked move (the
 *                      searched pick, on a search turn); grandmaster is 1
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
 * @property {null|{candidates: number, worlds: number, budget: number, margin: number,
 *                  bidDeals: number, bidFloor: number, bidAt: number[]}} search
 *                      null for the plain heuristic. Otherwise the Monte Carlo
 *                      layer: `candidates` heuristic-ranked moves (plus a pass)
 *                      are each played out in up to `worlds` sampled deals of
 *                      the unseen cards, sharing one `budget` of rollout plies
 *                      per decision (a count, not a time, so a decision replays
 *                      identically from its seed on any machine). A candidate
 *                      has to beat the heuristic's first choice by more than
 *                      `margin` to replace it. Bidding plays `bidDeals` whole
 *                      games as the landlord for any hand whose handStrength
 *                      reaches `bidFloor`, and calls 1, 2 or 3 as the mean
 *                      result clears bidAt[0], [1], [2].
 */

/** Ready-made profiles. economy.js maps a lobby to one of these. */
export const SKILLS = {
  novice:      { name: 'Novice',      accuracy: 0.45, temperature: 26, countsCards: false, partnerAware: false, bombDiscipline: 0.1,  fourDisciplineThreshold: 0, bidNoise: 0.30, search: null },
  casual:      { name: 'Casual',      accuracy: 0.62, temperature: 18, countsCards: false, partnerAware: true,  bombDiscipline: 0.3,  fourDisciplineThreshold: 0, bidNoise: 0.22, search: null },
  steady:      { name: 'Steady',      accuracy: 0.72, temperature: 14, countsCards: false, partnerAware: true,  bombDiscipline: 0.5,  fourDisciplineThreshold: 0, bidNoise: 0.16, search: null },
  sharp:       { name: 'Sharp',       accuracy: 0.80, temperature: 11, countsCards: true,  partnerAware: true,  bombDiscipline: 0.65, fourDisciplineThreshold: 3, bidNoise: 0.12, search: null },
  expert:      { name: 'Expert',      accuracy: 0.86, temperature: 8,  countsCards: true,  partnerAware: true,  bombDiscipline: 0.78, fourDisciplineThreshold: 3, bidNoise: 0.08, search: null },
  master:      { name: 'Master',      accuracy: 0.92, temperature: 6,  countsCards: true,  partnerAware: true,  bombDiscipline: 0.88, fourDisciplineThreshold: 2, bidNoise: 0.05, search: { candidates: 5, worlds: 16, budget: 15000, margin: 0, bidDeals: 100, bidFloor: 0.1, bidAt: [0.1, 0.4, 0.8] } },
  // accuracy 1: the grandmaster numbers were measured with no slip, and a slip only costs it strength.
  grandmaster: { name: 'Grandmaster', accuracy: 1,    temperature: 4,  countsCards: true,  partnerAware: true,  bombDiscipline: 0.95, fourDisciplineThreshold: 2, bidNoise: 0.02, search: { candidates: 7, worlds: 32, budget: 40000, margin: 0, bidDeals: 240, bidFloor: 0.1, bidAt: [0.1, 0.4, 0.8] } },
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

  const ctx = dealContext(view, unseen);
  if (!ctx) return null;

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
  // candidates that happened to draw different pools. The worlds are weighted
  // by how well they explain the passes so far (see drawWorlds).
  const worlds = drawWorlds(ctx, rng, ENDGAME_DETERMINIZATIONS);

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
    for (const world of worlds) {
      const hands = world.hands.map((h, s) => (s === seat ? hand : h));
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

// --- fast play-out ------------------------------------------------------------

/*
 * Search needs thousands of whole-game play-outs per decision, which the card-
 * object move generator in moves.js is too slow to feed. So everything from here
 * to the end of the sampler works on rank-count arrays: a hand is an Int8Array
 * indexed by rank (3..17), a play is a few (rank, count) pairs, and nothing in
 * the play-out loop allocates. The policy is deliberately plain — lead the shed
 * that leaves the fewest plays, answer with the cheapest card that wins, leave a
 * partner's trick alone — because a search is only as good as the rollouts under
 * it, and a rollout that costs a millisecond buys no rollouts at all.
 */

const T_SINGLE = 1;
const T_PAIR = 2;
const T_TRIO = 3;
const T_TRIO1 = 4;
const T_TRIO2 = 5;
const T_STRAIGHT = 6;
const T_PAIRS = 7;
const T_PLANE = 8;
const T_PLANE1 = 9;
const T_PLANE2 = 10;
const T_FOUR = 11; // four with kickers: the rollout never leads one, and only ever answers it with a bomb
const T_BOMB = 13;
const T_ROCKET = 14;

const TYPE_CODE = {
  [Combo.SINGLE]: T_SINGLE,
  [Combo.PAIR]: T_PAIR,
  [Combo.TRIO]: T_TRIO,
  [Combo.TRIO_SINGLE]: T_TRIO1,
  [Combo.TRIO_PAIR]: T_TRIO2,
  [Combo.STRAIGHT]: T_STRAIGHT,
  [Combo.PAIR_CHAIN]: T_PAIRS,
  [Combo.TRIO_CHAIN]: T_PLANE,
  [Combo.TRIO_CHAIN_SINGLES]: T_PLANE1,
  [Combo.TRIO_CHAIN_PAIRS]: T_PLANE2,
  [Combo.FOUR_TWO]: T_FOUR,
  [Combo.FOUR_TWO_PAIRS]: T_FOUR,
  [Combo.BOMB]: T_BOMB,
  [Combo.ROCKET]: T_ROCKET,
};

/** Rollout policy knobs, in one place so they can be tuned against the bench. */
const ROLL = {
  saveHighUnlessOppLeft: 4, // an opponent this low (or my hand this small) is worth a 2 or a joker to answer
  saveHighUnlessHand: 6,
  bombOppLeft: 2,           // bomb an opponent's play once an opponent is down to this many cards
};

function newMove() {
  return { type: 0, rank: 0, len: 0, n: 0, k: 0, rk: new Int8Array(24), cn: new Int8Array(24) };
}
const mv = newMove();     // the play under construction
const bestMv = newMove(); // best lead found so far
const planScratch = new Int8Array(18);
const wingBuf = new Int8Array(16);

function mvStart(m, type, rank, len) {
  m.type = type;
  m.rank = rank;
  m.len = len;
  m.n = 0;
  m.k = 0;
}
function mvAdd(m, rank, count) {
  m.rk[m.k] = rank;
  m.cn[m.k] = count;
  m.k += 1;
  m.n += count;
}
function mvCopy(dst, src) {
  dst.type = src.type;
  dst.rank = src.rank;
  dst.len = src.len;
  dst.n = src.n;
  dst.k = src.k;
  for (let i = 0; i < src.k; i++) {
    dst.rk[i] = src.rk[i];
    dst.cn[i] = src.cn[i];
  }
}
function mvTake(h, m) {
  for (let i = 0; i < m.k; i++) h[m.rk[i]] -= m.cn[i];
}
function mvGive(h, m) {
  for (let i = 0; i < m.k; i++) h[m.rk[i]] += m.cn[i];
}
function buildChain(type, copies, from, to) {
  mvStart(mv, type, to, to - from + 1);
  for (let r = from; r <= to; r++) mvAdd(mv, r, copies);
}

function cardsToCounts(cards, out) {
  out.fill(0);
  for (const card of cards) out[card.rank] += 1;
  return out;
}

/** estimatePlays() over a count array. Same greedy order, no Map. */
function playsOf(h) {
  const c = planScratch;
  c.set(h);
  let plays = 0;
  if (c[16] && c[17]) {
    c[16] = 0;
    c[17] = 0;
    plays += 1;
  }
  for (let r = 3; r <= 15; r++) {
    if (c[r] === 4) {
      c[r] = 0;
      plays += 1;
    }
  }
  plays += chainPlays(c, 3, 2);
  plays += chainPlays(c, 2, 3);
  plays += chainPlays(c, 1, 5);
  for (let r = 3; r <= 17; r++) {
    if (c[r] !== 3) continue;
    c[r] = 0;
    plays += 1;
    for (let k = 3; k <= 17; k++) {
      if (c[k] > 0 && c[k] <= 2) {
        c[k] = 0;
        break;
      }
    }
  }
  for (let r = 3; r <= 17; r++) {
    if (c[r] === 2) {
      c[r] = 0;
      plays += 1;
    }
  }
  for (let r = 3; r <= 17; r++) plays += c[r];
  return plays;
}

function chainPlays(c, copies, minLen) {
  let plays = 0;
  for (;;) {
    let bestStart = 0;
    let bestLen = 0;
    let s = 3;
    while (s <= RANK_CHAIN_MAX) {
      if (c[s] < copies) {
        s += 1;
        continue;
      }
      let e = s;
      while (e < RANK_CHAIN_MAX && c[e + 1] >= copies) e += 1;
      if (e - s + 1 >= minLen && e - s + 1 > bestLen) {
        bestLen = e - s + 1;
        bestStart = s;
      }
      s = e + 1;
    }
    if (!bestLen) return plays;
    for (let r = bestStart; r < bestStart + bestLen; r++) c[r] -= copies;
    plays += 1;
  }
}

/**
 * Pick `count` distinct ranks outside [lo, hi] to ride along as kickers, `size`
 * cards each, into wingBuf. Exact holdings first (a lone card for a single, a
 * pair for a pair), then ranks that have to be broken, and the 2s and jokers
 * only after every lower rank: the same order moves.js prefers. A joker pair is
 * the rocket, so it is never split up for a kicker.
 */
function collectWings(h, lo, hi, count, size) {
  const jokers = h[16] > 0 && h[17] > 0;
  let found = 0;
  for (let phase = 0; phase < 4 && found < count; phase++) {
    const high = phase >= 2;
    const exact = (phase & 1) === 0;
    for (let r = 3; r <= 17 && found < count; r++) {
      if ((r >= RANK_TWO) !== high || (r >= lo && r <= hi)) continue;
      const c = h[r];
      if (c < size || c === 4 || (exact ? c !== size : c === size)) continue;
      if (jokers && r >= RANK_JOKER_SMALL) continue;
      wingBuf[found++] = r;
    }
  }
  return found === count;
}

let runStart = 0;
let runEnd = 0;
/** Lowest maximal run of ranks 3..A holding lo..hi cards each, at least minLen long. */
function lowestRun(h, lo, hi, minLen) {
  let s = 3;
  while (s <= RANK_CHAIN_MAX) {
    if (h[s] < lo || h[s] > hi) {
      s += 1;
      continue;
    }
    let e = s;
    while (e < RANK_CHAIN_MAX && h[e + 1] >= lo && h[e + 1] <= hi) e += 1;
    if (e - s + 1 >= minLen) {
      runStart = s;
      runEnd = e;
      return true;
    }
    s = e + 1;
  }
  return false;
}

let leadKey = 0;
function considerLead(h, handLeft, startRank, penalty) {
  let key;
  if (mv.n === handLeft) {
    key = -1e9; // goes out
  } else {
    mvTake(h, mv);
    key = playsOf(h) * 1000 + startRank * 10 - mv.n + penalty;
    mvGive(h, mv);
  }
  if (key < leadKey) {
    leadKey = key;
    mvCopy(bestMv, mv);
  }
}

/**
 * The rollout's lead: of a short list (the lowest single, pair, trio, and the
 * lowest run of each chain kind), the one that leaves the fewest plays, lowest
 * card first on a tie. Bombs and the rocket wait until nothing else is left.
 * With an opponent down to two cards or fewer it stops dribbling out singles.
 */
function pickLead(h, handLeft, oppMin) {
  leadKey = Infinity;
  const jokers = h[16] > 0 && h[17] > 0;
  let s1 = 0;
  let s2 = 0;
  let hiSingle = 0;
  let p1 = 0;
  let t1 = 0;
  for (let r = 3; r <= 17; r++) {
    const c = h[r];
    if (c === 0 || c === 4 || (jokers && r >= RANK_JOKER_SMALL)) continue;
    hiSingle = r;
    if (c === 1) {
      if (!s1) s1 = r;
    } else {
      if (!s2) s2 = r;
      if (c === 2) {
        if (!p1) p1 = r;
      } else if (!t1) {
        t1 = r;
      }
    }
  }

  if (hiSingle) {
    const low = oppMin <= 2;
    const r = low ? hiSingle : (s1 || s2);
    mvStart(mv, T_SINGLE, r, 1);
    mvAdd(mv, r, 1);
    considerLead(h, handLeft, r, low ? 4000 : 0);
  }
  const pr = p1 || t1;
  if (pr) {
    mvStart(mv, T_PAIR, pr, 1);
    mvAdd(mv, pr, 2);
    considerLead(h, handLeft, pr, 0);
  }
  if (t1) {
    let any = false;
    if (collectWings(h, t1, t1, 1, 1)) {
      mvStart(mv, T_TRIO1, t1, 1);
      mvAdd(mv, t1, 3);
      mvAdd(mv, wingBuf[0], 1);
      considerLead(h, handLeft, t1, 0);
      any = true;
    }
    if (collectWings(h, t1, t1, 1, 2)) {
      mvStart(mv, T_TRIO2, t1, 1);
      mvAdd(mv, t1, 3);
      mvAdd(mv, wingBuf[0], 2);
      considerLead(h, handLeft, t1, 0);
      any = true;
    }
    if (!any) {
      mvStart(mv, T_TRIO, t1, 1);
      mvAdd(mv, t1, 3);
      considerLead(h, handLeft, t1, 0);
    }
  }
  if (lowestRun(h, 1, 3, 5)) {
    buildChain(T_STRAIGHT, 1, runStart, runEnd);
    considerLead(h, handLeft, runStart, 0);
    if (runEnd - runStart > 4) {
      buildChain(T_STRAIGHT, 1, runStart, runStart + 4);
      considerLead(h, handLeft, runStart, 0);
    }
  }
  if (lowestRun(h, 2, 3, 3)) {
    buildChain(T_PAIRS, 2, runStart, runEnd);
    considerLead(h, handLeft, runStart, 0);
    if (runEnd - runStart > 2) {
      buildChain(T_PAIRS, 2, runStart, runStart + 2);
      considerLead(h, handLeft, runStart, 0);
    }
  }
  if (lowestRun(h, 3, 3, 2)) {
    const s = runStart;
    const e = runEnd;
    const len = e - s + 1;
    let any = false;
    if (collectWings(h, s, e, len, 1)) {
      buildChain(T_PLANE1, 3, s, e);
      for (let i = 0; i < len; i++) mvAdd(mv, wingBuf[i], 1);
      considerLead(h, handLeft, s, 0);
      any = true;
    }
    if (collectWings(h, s, e, len, 2)) {
      buildChain(T_PLANE2, 3, s, e);
      for (let i = 0; i < len; i++) mvAdd(mv, wingBuf[i], 2);
      considerLead(h, handLeft, s, 0);
      any = true;
    }
    if (!any) {
      buildChain(T_PLANE, 3, s, e);
      considerLead(h, handLeft, s, 0);
    }
  }

  if (leadKey === Infinity) {
    let bomb = 0;
    for (let r = 3; r <= RANK_TWO; r++) {
      if (h[r] === 4) {
        bomb = r;
        break;
      }
    }
    if (bomb) {
      mvStart(mv, T_BOMB, bomb, 1);
      mvAdd(mv, bomb, 4);
    } else if (h[RANK_JOKER_SMALL] && h[RANK_JOKER_BIG]) {
      mvStart(mv, T_ROCKET, RANK_JOKER_BIG, 1);
      mvAdd(mv, RANK_JOKER_SMALL, 1);
      mvAdd(mv, RANK_JOKER_BIG, 1);
    } else {
      let r = 3;
      while (!h[r]) r += 1;
      mvStart(mv, T_SINGLE, r, 1);
      mvAdd(mv, r, 1);
    }
    mvCopy(bestMv, mv);
  }
  return bestMv;
}

/**
 * Cheapest non-bomb answer to a play of `type`/`rank`/`len`, built into mv.
 * `maxRank` caps how high the answer may reach (inference only counts an answer
 * a seat would plausibly have spent). Singles prefer lone cards, weighted
 * against rank (a card taken from a pair costs r+6, so it can tie a lone card),
 * never come from a four, and the 2s and jokers are the dearest ranks simply
 * by being the highest.
 */
function findBeat(h, type, rank, len, maxRank) {
  const jokers = h[16] > 0 && h[17] > 0;
  switch (type) {
    case T_SINGLE: {
      let best = 0;
      let bestCost = 1e9;
      const top = jokers ? RANK_TWO : RANK_JOKER_BIG;
      for (let r = rank + 1; r <= top && r <= maxRank; r++) {
        const c = h[r];
        if (c === 0 || c === 4) continue;
        const cost = r + (c === 1 ? 0 : c === 2 ? 6 : 9);
        if (cost < bestCost) {
          bestCost = cost;
          best = r;
        }
      }
      if (!best) return false;
      mvStart(mv, T_SINGLE, best, 1);
      mvAdd(mv, best, 1);
      return true;
    }
    case T_PAIR: {
      let best = 0;
      let bestCost = 1e9;
      for (let r = rank + 1; r <= RANK_TWO && r <= maxRank; r++) {
        const c = h[r];
        if (c < 2 || c === 4) continue;
        const cost = r + (c === 2 ? 0 : 9);
        if (cost < bestCost) {
          bestCost = cost;
          best = r;
        }
      }
      if (!best) return false;
      mvStart(mv, T_PAIR, best, 1);
      mvAdd(mv, best, 2);
      return true;
    }
    case T_TRIO:
    case T_TRIO1:
    case T_TRIO2: {
      for (let r = rank + 1; r <= RANK_TWO && r <= maxRank; r++) {
        if (h[r] !== 3) continue;
        if (type === T_TRIO) {
          mvStart(mv, T_TRIO, r, 1);
          mvAdd(mv, r, 3);
          return true;
        }
        const size = type === T_TRIO1 ? 1 : 2;
        if (!collectWings(h, r, r, 1, size)) continue;
        mvStart(mv, type, r, 1);
        mvAdd(mv, r, 3);
        mvAdd(mv, wingBuf[0], size);
        return true;
      }
      return false;
    }
    case T_STRAIGHT:
    case T_PAIRS:
    case T_PLANE:
    case T_PLANE1:
    case T_PLANE2: {
      const lo = type === T_STRAIGHT ? 1 : type === T_PAIRS ? 2 : 3;
      for (let s = Math.max(3, rank - len + 2); s + len - 1 <= RANK_CHAIN_MAX && s + len - 1 <= maxRank; s++) {
        const to = s + len - 1;
        let ok = true;
        for (let r = s; r <= to; r++) {
          if (h[r] < lo || h[r] > 3) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (type === T_STRAIGHT) {
          buildChain(T_STRAIGHT, 1, s, to);
        } else if (type === T_PAIRS) {
          buildChain(T_PAIRS, 2, s, to);
        } else if (type === T_PLANE) {
          buildChain(T_PLANE, 3, s, to);
        } else {
          const size = type === T_PLANE1 ? 1 : 2;
          if (!collectWings(h, s, to, len, size)) continue;
          buildChain(type, 3, s, to);
          for (let i = 0; i < len; i++) mvAdd(mv, wingBuf[i], size);
        }
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** Lowest bomb that beats the play (or the rocket), built into mv. */
function findBomb(h, type, rank) {
  if (type === T_ROCKET) return false;
  for (let r = type === T_BOMB ? rank + 1 : 3; r <= RANK_TWO; r++) {
    if (h[r] === 4) {
      mvStart(mv, T_BOMB, r, 1);
      mvAdd(mv, r, 4);
      return true;
    }
  }
  if (h[RANK_JOKER_SMALL] && h[RANK_JOKER_BIG]) {
    mvStart(mv, T_ROCKET, RANK_JOKER_BIG, 1);
    mvAdd(mv, RANK_JOKER_SMALL, 1);
    mvAdd(mv, RANK_JOKER_BIG, 1);
    return true;
  }
  return false;
}

/**
 * The rollout's answer to a live trick: the cheapest card that wins, nothing at
 * all on a partner's trick (unless it goes out), a 2 or joker only when it
 * matters, and a bomb only to stop an opponent who is nearly out or to leave a
 * hand one play from going out. Returns mv, or null for a pass.
 */
function pickReply(h, handLeft, partnerLead, oppLeft, cType, cRank, cLen) {
  if (cType < T_FOUR && findBeat(h, cType, cRank, cLen, RANK_JOKER_BIG)) {
    if (partnerLead) return mv.n === handLeft ? mv : null;
    if (mv.rank >= RANK_TWO && mv.n < handLeft && oppLeft > ROLL.saveHighUnlessOppLeft && handLeft > ROLL.saveHighUnlessHand) return null;
    return mv;
  }
  if (partnerLead || !findBomb(h, cType, cRank)) return null;
  if (mv.n === handLeft || oppLeft <= ROLL.bombOppLeft) return mv;
  mvTake(h, mv);
  const rest = playsOf(h);
  mvGive(h, mv);
  return rest <= 1 ? mv : null;
}

/**
 * Play a fully dealt hand to the end with the rollout policy at all three
 * seats. Returns the landlord's result per point of the call: +m if the
 * landlord went out first, -m otherwise, where m doubles for every bomb or
 * rocket, and once more for a spring or anti-spring, exactly as engine.js
 * settles it. `budget.n` is decremented once per ply so a decision's total
 * work is a count, never a clock.
 */
function playOut(H, left, L, turn, cType, cRank, cLen, leader, streak, bombs, lpl, fpl, budget) {
  for (let guard = 0; guard < 500; guard++) {
    budget.n -= 1;
    const h = H[turn];
    const isLandlord = turn === L;
    const oppLeft = isLandlord ? Math.min(left[(turn + 1) % 3], left[(turn + 2) % 3]) : left[L];
    const move = cType === 0
      ? pickLead(h, left[turn], oppLeft)
      : pickReply(h, left[turn], !isLandlord && leader !== L, oppLeft, cType, cRank, cLen);
    if (!move) {
      streak += 1;
      if (streak >= 2) {
        turn = leader;
        cType = 0;
        streak = 0;
      } else {
        turn = (turn + 1) % 3;
      }
      continue;
    }
    mvTake(h, move);
    left[turn] -= move.n;
    if (move.type >= T_BOMB) bombs += 1;
    if (isLandlord) lpl += 1;
    else fpl += 1;
    if (left[turn] === 0) {
      let m = 1 << bombs;
      if (isLandlord ? fpl === 0 : lpl <= 1) m *= 2;
      return isLandlord ? m : -m;
    }
    cType = move.type;
    cRank = move.rank;
    cLen = move.len;
    leader = turn;
    streak = 0;
    turn = (turn + 1) % 3;
  }
  return 0;
}

const rollHands = [new Int8Array(18), new Int8Array(18), new Int8Array(18)];
const rollLeft = new Int8Array(3);

// --- dealing the unseen cards ---------------------------------------------------

/** How hard a pass counts against a sampled world; see worldWeight(). */
const INFER = {
  passFactor: 0.3, // weight kept by a world where a seat passed while holding a cheap answer
  cheapMax: 14,    // an answer topping out above an ace is not one a bot is expected to spend
  oversample: 3,   // proposals drawn per world kept
};

/**
 * Everything needed to deal the unseen pool to the two other seats, or null
 * when the view does not add up (some caller built a partial view): every
 * search deals from the pool, so a pool that does not match the card counts on
 * the table has nothing reliable to deal.
 *
 * The bottom three are public — everyone saw them go down — and they always
 * started in the landlord's hand. unseenCards() takes them out of the pool
 * unconditionally for that reason, whether or not the landlord has since played
 * one. So when the landlord is one of the two seats being dealt for (true
 * exactly when I am a farmer), the pool is short by however many of the three
 * he is still holding: those are pinned to his hand instead of drawn at random.
 */
export function dealContext(view, unseen) {
  const seat = view.seat;
  const opponents = view.players.filter((p) => p.seat !== seat);
  const opponentTotal = opponents.reduce((sum, p) => sum + p.cards, 0);
  const landlordOpponent = opponents.find((p) => p.role === 'landlord');
  const playedIds = new Set((view.playedCards ?? []).map((c) => c.id));
  const knownBottom = view.bottomRevealed ? (view.bottom ?? []).filter(Boolean) : [];
  const bottomOwed = landlordOpponent ? knownBottom.filter((c) => !playedIds.has(c.id)) : [];
  if (unseen.length + bottomOwed.length !== opponentTotal) return null;
  if (bottomOwed.length > (landlordOpponent?.cards ?? 0)) return null; // never pin more than the hand holds
  const pins = opponents.map((p) => (p === landlordOpponent ? bottomOwed : []));
  const need = opponents.map((p, i) => p.cards - pins[i].length);
  return { opponents, pins, need, pool: unseen, tests: passTests(view) };
}

/**
 * What the table's passes say about the hands. Each pass by an opponent against
 * a play from the other side is a test: rebuild what that seat held at that
 * moment (its hand now, plus everything it played since) and see whether a
 * non-bomb answer was sitting in it. A pass against a seat's own partner says
 * nothing, and neither does one against a bomb.
 */
function passTests(view) {
  const history = view.history;
  if (!history?.length) return [];
  const me = view.seat;
  const roleOf = view.players.map((p) => p.role);
  const marked = new Map(); // history index -> the play that was passed on
  let top = null;
  let streak = 0;
  history.forEach((ev, i) => {
    if (!ev.pass) {
      top = ev;
      streak = 0;
      return;
    }
    if (top && ev.seat !== me && roleOf[ev.seat] !== roleOf[top.seat] && !top.combo.bomb && TYPE_CODE[top.combo.type] < T_FOUR) {
      marked.set(i, top.combo);
    }
    streak += 1;
    if (streak >= 2) {
      top = null;
      streak = 0;
    }
  });
  if (!marked.size) return [];
  const after = [new Int8Array(18), new Int8Array(18), new Int8Array(18)];
  const tests = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const ev = history[i];
    if (!ev.pass) {
      for (const card of ev.cards) after[ev.seat][card.rank] += 1;
    } else if (marked.has(i)) {
      const combo = marked.get(i);
      tests.push({ seat: ev.seat, type: TYPE_CODE[combo.type], rank: combo.rank, len: combo.length, after: Int8Array.from(after[ev.seat]) });
    }
  }
  return tests;
}

const inferScratch = new Int8Array(18);

/**
 * How well a sampled split explains the passes: 1 for a world that explains all
 * of them, passFactor for each pass it cannot — a seat that held a cheap answer
 * and let the trick go. Not a hard exclusion: a bot does pass with an answer in
 * hand (to keep a 2, to let a partner have it), so a world that needs that is
 * unlikelier, not impossible.
 */
export function worldWeight(ctx, counts) {
  let w = 1;
  for (const t of ctx.tests) {
    inferScratch.set(counts[t.seat]);
    for (let r = 3; r <= 17; r++) inferScratch[r] += t.after[r];
    if (findBeat(inferScratch, t.type, t.rank, t.len, INFER.cheapMax)) w *= INFER.passFactor;
  }
  return w;
}

/**
 * `count` sampled splits of the unseen pool between the two other seats, as
 * { hands, counts } indexed by seat (null at my own). With no passes to learn
 * from every split is as good as any other; otherwise INFER.oversample times as
 * many are drawn and resampled in proportion to worldWeight, systematically, so
 * the result is still `count` equally weighted worlds and the same number of
 * rng draws whatever the weights come to. Bounded: a fixed number of proposals,
 * never a retry loop.
 */
export function drawWorlds(ctx, rng, count) {
  const weighted = ctx.tests.length > 0;
  const proposals = weighted ? count * INFER.oversample : count;
  const worlds = [];
  const weights = [];
  for (let p = 0; p < proposals; p++) {
    const deck = shuffle(ctx.pool.slice(), rng);
    const hands = [null, null, null];
    const counts = [null, null, null];
    let cursor = 0;
    for (let i = 0; i < ctx.opponents.length; i++) {
      const seat = ctx.opponents[i].seat;
      const drawn = deck.slice(cursor, cursor + ctx.need[i]);
      cursor += ctx.need[i];
      const hand = ctx.pins[i].length ? ctx.pins[i].concat(drawn) : drawn;
      hands[seat] = hand;
      counts[seat] = cardsToCounts(hand, new Int8Array(18));
    }
    worlds.push({ hands, counts });
    if (weighted) weights.push(worldWeight(ctx, counts));
  }
  if (!weighted) return worlds;
  let total = 0;
  for (const w of weights) total += w;
  const step = total / count;
  const start = rng() * step;
  const out = [];
  let acc = 0;
  let i = 0;
  for (let j = 0; j < count; j++) {
    const target = start + j * step;
    while (i < worlds.length - 1 && acc + weights[i] < target) {
      acc += weights[i];
      i += 1;
    }
    out.push(worlds[i]);
  }
  return out;
}

// --- determinized Monte Carlo search ------------------------------------------

function moveToMv(move) {
  const m = newMove();
  mvStart(m, TYPE_CODE[move.type], move.rank, move.length);
  const counts = cardsToCounts(move.cards, new Int8Array(18));
  for (let r = 3; r <= 17; r++) if (counts[r]) mvAdd(m, r, counts[r]);
  return m;
}

/**
 * Choose among the heuristic's best few moves (and a pass, when passing is
 * legal) by playing each one out. For every sampled split of the unseen cards,
 * the candidate is made and the deal played to the end with the rollout policy
 * at all three seats; the score is what the seat would win or lose in stake
 * units (call x 2 per bomb x 2 for a spring, doubled again if this seat is the
 * landlord). Worlds are the outer loop and shared by every candidate, so a
 * candidate is never ahead because it drew the easier deal. The whole decision
 * shares one play counter (skill.search.budget); when it runs out between
 * worlds, the worlds already played stand. Ties, and any lead smaller than
 * skill.search.margin, go to the heuristic's own first choice.
 *
 * `scored` is the heuristic's ranking, best first, with { move: null } for pass.
 * Returns the chosen entry of `scored`, or null when there is nothing to decide
 * or the view cannot be dealt from.
 */
function searchDecision(view, skill, unseen, rng, scored) {
  const cfg = skill.search;
  const me = view.seat;
  const landlord = view.players.find((p) => p.role === 'landlord');
  if (!landlord) return null;
  const ctx = dealContext(view, unseen);
  if (!ctx) return null;

  const picked = scored.slice(0, cfg.candidates);
  if (!picked.some((e) => e.move === null)) {
    const passEntry = scored.find((e) => e.move === null);
    if (passEntry) picked.push(passEntry);
  }
  if (picked.length < 2) return null;
  const cands = picked.map((e) => ({ entry: e, mv: e.move ? moveToMv(e.move) : null, sum: 0 }));

  const L = landlord.seat;
  const iAmLandlord = L === me;
  const trick = view.trick;
  const cType = trick ? TYPE_CODE[trick.combo.type] : 0;
  const cRank = trick ? trick.combo.rank : 0;
  const cLen = trick ? trick.combo.length : 0;
  const leader = trick ? trick.leader : me;
  const streak = trick ? currentPassStreak(view) : 0;
  const bid = view.bidValue || 1;
  const bombs0 = view.bombs || 0;
  let lpl = 1; // without a history, assume the spring is already off
  let fpl = 1;
  if (view.history) {
    lpl = 0;
    fpl = 0;
    for (const ev of view.history) {
      if (ev.pass) continue;
      if (view.players[ev.seat].role === 'landlord') lpl += 1;
      else fpl += 1;
    }
  }

  const mine = cardsToCounts(view.you.hand, new Int8Array(18));
  const worlds = drawWorlds(ctx, rng, cfg.worlds);
  const budget = { n: cfg.budget };
  const next = (me + 1) % 3;
  let played = 0;
  for (const world of worlds) {
    if (budget.n <= 0) break;
    for (const cand of cands) {
      for (let s = 0; s < 3; s++) {
        if (s === me) rollHands[s].set(mine);
        else rollHands[s].set(world.counts[s]);
        rollLeft[s] = s === me ? view.you.hand.length : view.players[s].cards;
      }
      let res;
      if (cand.mv === null) {
        const passed = streak + 1;
        res = passed >= 2
          ? playOut(rollHands, rollLeft, L, leader, 0, 0, 0, leader, 0, bombs0, lpl, fpl, budget)
          : playOut(rollHands, rollLeft, L, next, cType, cRank, cLen, leader, passed, bombs0, lpl, fpl, budget);
      } else {
        const m = cand.mv;
        mvTake(rollHands[me], m);
        rollLeft[me] -= m.n;
        const bombs = bombs0 + (m.type >= T_BOMB ? 1 : 0);
        const l = iAmLandlord ? lpl + 1 : lpl;
        const f = iAmLandlord ? fpl : fpl + 1;
        if (rollLeft[me] === 0) {
          let k = 1 << bombs;
          if (iAmLandlord ? f === 0 : l <= 1) k *= 2;
          res = iAmLandlord ? k : -k;
        } else {
          res = playOut(rollHands, rollLeft, L, next, m.type, m.rank, m.len, me, 0, bombs, l, f, budget);
        }
      }
      cand.sum += (iAmLandlord ? 2 * res : -res) * bid;
    }
    played += 1;
  }
  if (played < 2) return null;

  let best = 0;
  for (let i = 1; i < cands.length; i++) if (cands[i].sum > cands[best].sum) best = i;
  if (best !== 0 && (cands[best].sum - cands[0].sum) / played <= cfg.margin) best = 0;
  return cands[best].entry;
}

/**
 * Mean result, per point of the call, of taking the landlord seat with this
 * hand: the unseen cards are dealt as the bottom three and the two opponents'
 * hands, and each deal is played out with this seat as the landlord. Positive
 * means the seat is a favourite; the number also carries the bombs, so a hand
 * that wins big when it wins reads higher than one that scrapes through.
 */
function landlordEdge(view, deals, rng) {
  const unseen = unseenCards(view);
  if (unseen.length !== 37 || view.you.hand.length !== 17) return null;
  const ranks = Int8Array.from(unseen, (c) => c.rank);
  const mine = cardsToCounts(view.you.hand, new Int8Array(18));
  const me = view.seat;
  const a = (me + 1) % 3;
  const b = (me + 2) % 3;
  const budget = { n: 0 };
  let sum = 0;
  for (let d = 0; d < deals; d++) {
    shuffle(ranks, rng);
    rollHands[me].set(mine);
    rollHands[a].fill(0);
    rollHands[b].fill(0);
    for (let i = 0; i < 3; i++) rollHands[me][ranks[i]] += 1;
    for (let i = 3; i < 20; i++) rollHands[a][ranks[i]] += 1;
    for (let i = 20; i < 37; i++) rollHands[b][ranks[i]] += 1;
    rollLeft[me] = 20;
    rollLeft[a] = 17;
    rollLeft[b] = 17;
    sum += playOut(rollHands, rollLeft, me, me, 0, 0, 0, me, 0, 0, 0, 0, budget);
  }
  return sum / deals;
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
  const cfg = skill.search;
  if (cfg?.bidDeals && handStrength(view.you.hand) >= cfg.bidFloor) {
    // Play the seat out as the landlord against sampled deals instead of
    // reading it off the hand shape: the edge already carries the bombs, the
    // 20-card hand and the two farmers working together.
    const edge = landlordEdge(view, cfg.bidDeals, rng);
    if (edge !== null) {
      const wanted = edge >= cfg.bidAt[2] ? 3 : edge >= cfg.bidAt[1] ? 2 : edge >= cfg.bidAt[0] ? 1 : 0;
      return wanted > highest ? wanted : 0;
    }
  }
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

  const scored = rankMoves(view, skill, moves, unseen);
  if (unseen && skill.search) {
    // The searched pick goes to the front and takes the same accuracy slip as
    // any other first choice; it is always one of `scored`'s own entries.
    const found = searchDecision(view, skill, unseen, rng, scored);
    if (found && found !== scored[0]) {
      scored.splice(scored.indexOf(found), 1);
      scored.unshift(found);
    }
  }

  let chosen = scored[0];
  if (scored.length > 1 && rng() > skill.accuracy) {
    const rest = scored.slice(1);
    const best = Math.max(...scored.map((entry) => entry.score));
    const weights = rest.map((entry) => Math.exp((entry.score - best) / Math.max(1, skill.temperature)));
    chosen = weightedPick(rng, rest, weights) ?? chosen;
  }
  return chosen.move ? { cards: chosen.move.cards } : { pass: true };
}

/** The heuristic's ranking of every legal move (and a pass, when legal), best first. */
function rankMoves(view, skill, moves, unseen) {
  const candidates = filterFourDiscipline(view, skill, moves, unseen);
  const scored = candidates.map((move) => ({ move, score: scoreMove(view, skill, move, unseen) }));
  if (view.trick) scored.push({ move: null, score: scorePass(view, skill) });
  scored.sort((a, b) => b.score - a.score);
  return scored;
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
  const rng = unseen ? makeRng(hand.map((c) => c.id).sort((a, b) => a - b).join(',')) : null;
  if (unseen) {
    if (!current && hand.length > 1) {
      const forced = findForcedWin(hand, unseen);
      if (forced) return { cards: forced.cards };
    }
    const deep = endgameDecision(view, skill, unseen, rng);
    if (deep) return deep.pass ? { pass: true } : { cards: deep.cards };
  }
  const scored = rankMoves(view, skill, moves, unseen);
  if (unseen && skill.search) {
    const found = searchDecision(view, skill, unseen, rng, scored);
    if (found) return found.move ? { cards: found.move.cards } : { pass: true };
  }
  return scored[0].move ? { cards: scored[0].move.cards } : { pass: true };
}

export { moveCost, beats };
