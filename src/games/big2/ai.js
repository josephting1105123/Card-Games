/**
 * Big Two bot.
 *
 * The bot only ever reads a seat view (own hand, opponents' card counts, the
 * live trick, history). Every play in Big Two lands face up, so the history is
 * a complete record of what is gone: the 52-card deck minus our own hand minus
 * every card played is exactly what the three other hands hold between them.
 * Counting that pool is fair game and it is what the upper tiers use — to know
 * a lead can no longer be topped (unanswerable), and to guess the hidden hands.
 *
 * How difficulty scales
 * ----------------------
 * Two dials do what they do in doudizhu/ai.js:
 *   accuracy     probability of playing the move the evaluation ranked first;
 *                otherwise a softmax sample over the rest, so a mistake reads
 *                as a plausible worse move rather than noise.
 *   temperature  how flat that softmax is.
 *
 * Four switches turn judgement on as the stakes rise (each starts at a
 * middle tier rather than every tier, so the ladder actually has a top):
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
 *   countsCards    credits a play nobody left in the unseen pool can top
 *                   (unanswerable): it wins the trick and the lead with it.
 *   search         master and grandmaster re-rank the heuristic's shortlist by
 *                   playing it out (see "Search" below).
 *
 * Evaluation is a hand-shape heuristic: handCost(hand) approximates the number
 * of plays needed to empty it via greedy decomposition, cheap and monotone in
 * the right direction rather than exact (see estimatePlays). It ranks every
 * legal move, which is all the lower tiers do.
 *
 * Search
 * ------
 * The heuristic cannot see what an opponent will hold, so the top two tiers
 * run determinized Monte Carlo: deal the unseen pool to the three hidden hands
 * (matching their known card counts), play each shortlisted move out to the end
 * of the hand in every sampled deal, and keep the move with the best mean chip
 * payout. The same deals are used for every candidate (common random numbers),
 * so the comparison between moves is far less noisy than the payouts
 * themselves. Grandmaster's accuracy is 1: it always plays what the search
 * picked, since a random slip after paying for the search would waste it.
 *
 * Deals are not uniform. A seat that passed on a single or pair while holding
 * a card that beat it is a poor explanation of the history, so each deal is
 * weighted down by how many such passes it implies (sampleWorld). The weight is
 * soft: bots pass to keep a pair or a two intact all the time.
 *
 * Rollouts use a fixed, greedy policy for all four seats (rollLead/
 * rollRespond), driven by one decomposition per hand that is updated as cards
 * leave, not by legalPlays, whose brute force over every five-card subset is far
 * too slow to call thousands of times. The work is capped by a counter of
 * rollout plies shared across the decision, never by the clock, so a decision
 * replays identically on any machine.
 */

import { countByRank, groupByRank, makeDeck52 } from '../../core/cards.js';
import { makeRng, shuffle, weightedPick } from '../../core/rng.js';
import { SEATS } from './engine.js';
import {
  Combo, STRAIGHT_WINDOWS, SUIT_ORDER, beats, cardValue, classify, fiveCardStrength,
} from './rules.js';
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
 * @property {boolean} countsCards  credit plays nothing in the unseen pool can beat
 * @property {{candidates: number, worlds: number, budget: number}|null} search
 *                      Monte Carlo over the heuristic's shortlist: how many
 *                      moves to try, the most deals to sample, and the cap on
 *                      rollout plies shared by the whole decision. null below
 *                      master.
 */

/** Ready-made profiles. economy.js maps a lobby to one of these, same as doudizhu. */
export const SKILLS = {
  novice:      { name: 'Novice',      accuracy: 0.45, temperature: 26, controlAware: false, blocksOneCard: false, countsCards: false, search: null },
  casual:      { name: 'Casual',      accuracy: 0.58, temperature: 20, controlAware: true,  blocksOneCard: false, countsCards: false, search: null },
  steady:      { name: 'Steady',      accuracy: 0.70, temperature: 15, controlAware: true,  blocksOneCard: false, countsCards: false, search: null },
  sharp:       { name: 'Sharp',       accuracy: 0.80, temperature: 11, controlAware: true,  blocksOneCard: true,  countsCards: false, search: null },
  expert:      { name: 'Expert',      accuracy: 0.86, temperature: 8,  controlAware: true,  blocksOneCard: true,  countsCards: true,  search: null },
  master:      { name: 'Master',      accuracy: 0.92, temperature: 6,  controlAware: true,  blocksOneCard: true,  countsCards: true,  search: { candidates: 5, worlds: 24, budget: 5000 } },
  grandmaster: { name: 'Grandmaster', accuracy: 1,    temperature: 4,  controlAware: true,  blocksOneCard: true,  countsCards: true,  search: { candidates: 12, worlds: 60, budget: 40000 } },
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
  topCard: 6,     // playing something no unseen card can answer: the lead comes straight back
};

// Search tuning.
const MIN_WORLDS = 4;        // always sample this many deals, however small the budget
const WORLD_COST = 60;       // plies of budget charged for dealing and decomposing one world
const DEAL_TRIES = 6;        // candidate deals per world; one is drawn by pass-consistency weight
const PASS_CHEAP = 0.3;      // weight when a seat passed holding a non-ace/two that beat the trick
const PASS_HIGH = 0.6;       // ... only an ace or two beat it: sitting on those is ordinary control
const PASS_PAIR = 0.35;      // ... a pair beat a pair
const ROLLOUT_CAP = 400;     // plies; every real hand ends long before this

const DECK = makeDeck52();
/** Big Two card value by card id, so rollouts never re-derive a suit index. */
const VALUE = DECK.map(cardValue);
const byValue = (a, b) => VALUE[a.id] - VALUE[b.id];

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
 * The greedy decomposition behind estimatePlays. Returns the number of plays
 * and, when `out` is given, the groups themselves (arrays of cards, in the
 * order they were carved off).
 */
function decomposeInto(cards, out) {
  let pool = [...cards];
  let plays = 0;
  const take = (group) => {
    pool = removeByIds(pool, group);
    plays += 1;
    if (out) out.push(group);
  };

  for (;;) {
    const groups = groupByRank(pool);
    const quad = [...groups.entries()].find(([, list]) => list.length === 4);
    if (quad && pool.length >= 5) {
      const kicker = pool.find((c) => c.rank !== quad[0]);
      take([...quad[1], kicker]);
      continue;
    }
    const triples = [...groups.entries()].filter(([, list]) => list.length >= 3);
    const houseTriple = triples
      .map(([rank, list]) => [rank, list, [...groups.entries()].find(([r, l]) => r !== rank && l.length >= 2)])
      .find(([, , pairEntry]) => pairEntry);
    if (houseTriple) {
      const [, list, pairEntry] = houseTriple;
      take([...list.slice(0, 3), ...pairEntry[1].slice(0, 2)]);
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
      take(flush.slice(0, 5));
      continue;
    }
    const window = STRAIGHT_WINDOWS.map((w) => takeStraight(pool, w)).find(Boolean);
    if (window) {
      take(window);
      continue;
    }
    break;
  }

  const groups = groupByRank(pool);
  for (const [, list] of groups) {
    if (list.length >= 3) take(list.slice(0, 3));
    else if (list.length === 2) take(list);
  }
  if (out) for (const c of pool) out.push([c]); // one play per remaining loose single
  return plays + pool.length;
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
  return decomposeInto(cards, null);
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

// --- card counting -----------------------------------------------------------

/** Every card that is neither in our hand nor already played: the three hidden hands, pooled. */
export function unseenCards(view) {
  const gone = new Set();
  for (const c of view.you.hand) gone.add(c.id);
  for (const h of view.history ?? []) {
    if (h.action === 'play') for (const c of h.combo.cards) gone.add(c.id);
  }
  return DECK.filter((c) => !gone.has(c.id));
}

/** Can some five-card hand made only of `unseen` cards beat `combo`? */
function fiveCardBeatable(unseen, combo) {
  const strength = fiveCardStrength(combo.type);
  const suits = [[], [], [], []];
  const ranks = new Map();
  for (const c of unseen) {
    suits[SUIT_ORDER.indexOf(c.suit)].push(c);
    const list = ranks.get(c.rank);
    if (list) list.push(c);
    else ranks.set(c.rank, [c]);
  }

  for (let s = 0; s < SUIT_ORDER.length; s++) {
    const list = suits[s];
    if (list.length < 5) continue;
    const held = new Set(list.map((c) => c.rank));
    for (let p = 0; p < STRAIGHT_WINDOWS.length; p++) {
      if (!STRAIGHT_WINDOWS[p].ranks.every((r) => held.has(r))) continue;
      if (strength < 4 || p * 4 + s > combo.key) return true;
    }
    // Any flush beats a straight; against another flush the suit decides first,
    // then the number of the highest card (same key as rules.js classify()).
    // (A suit that makes a straight flush is stronger still, so the answer holds.)
    if (strength < 1) return true;
    if (strength === 1 && s * 16 + Math.max(...list.map((c) => c.rank)) > combo.key) return true;
  }

  let bestTriple = -1;
  let bestQuad = -1;
  for (const [rank, list] of ranks) {
    if (list.length === 4) bestQuad = Math.max(bestQuad, rank);
    if (list.length >= 3) {
      for (const [other, l] of ranks) {
        if (other !== rank && l.length >= 2) { bestTriple = Math.max(bestTriple, rank); break; }
      }
    }
  }
  if (bestQuad >= 0 && unseen.length >= 5 && (strength < 3 || (strength === 3 && bestQuad > combo.key))) return true;
  if (bestTriple >= 0 && (strength < 2 || (strength === 2 && bestTriple > combo.key))) return true;

  if (strength === 0) {
    for (let p = 0; p < STRAIGHT_WINDOWS.length; p++) {
      const window = STRAIGHT_WINDOWS[p];
      if (!window.ranks.every((r) => ranks.has(r))) continue;
      let suit = 0;
      for (const c of ranks.get(window.top)) suit = Math.max(suit, SUIT_ORDER.indexOf(c.suit));
      if (p * 4 + suit > combo.key) return true;
    }
  }
  return false;
}

/**
 * True when nothing the other seats can hold beats `combo`, so playing it wins
 * the trick and the lead. The pool is the three hidden hands pooled, so a pair
 * that only two *different* opponents could jointly answer still reads as
 * answerable: the check errs towards "someone might".
 * @param {{size: number, key: number, type: string}} combo
 * @param {object[]} unseen cards held by the other seats, combined
 * @param {number} [maxOpponentCards] most cards any single opponent holds
 */
export function unanswerable(combo, unseen, maxOpponentCards = 13) {
  if (combo.size > maxOpponentCards) return true; // nobody holds enough cards to answer in kind
  if (combo.size === 1) return !unseen.some((c) => VALUE[c.id] > combo.key);
  if (combo.size === 5) return !fiveCardBeatable(unseen, combo);
  for (const list of groupByRank(unseen).values()) {
    if (list.length < combo.size) continue;
    let top = 0;
    for (const c of list) top = Math.max(top, VALUE[c.id]);
    if (top > combo.key) return false;
  }
  return true;
}

// --- decisions ---------------------------------------------------------------

function scoreMove(view, skill, move, protectedIds, unseen) {
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

  if (unseen && !blocking) {
    let maxOpp = 0;
    for (const p of view.players) if (p.seat !== seat) maxOpp = Math.max(maxOpp, p.cards);
    if (unanswerable(move, unseen, maxOpp)) score += W.topCard;
  }

  return score;
}

function scorePass(view) {
  const seat = view.seat;
  let score = -handCost(view.you.hand) - 4; // passing keeps the hand but wastes a turn
  if (view.players.some((p) => p.seat !== seat && p.cards <= 1)) score -= W.chokeOpponent;
  return score;
}

// --- world sampling ----------------------------------------------------------

/**
 * Every pass by another seat against a single or pair, with the cards that
 * seat played afterwards (so its hand at the moment of the pass can be rebuilt
 * from any sampled hand), in history order.
 */
export function passEvents(view) {
  const history = view.history ?? [];
  const events = [];
  let current = null;
  let passes = 0;
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.action === 'play') {
      current = h.combo;
      passes = 0;
      continue;
    }
    if (current && current.size <= 2 && h.seat !== view.seat) {
      events.push({ seat: h.seat, idx: i, size: current.size, key: current.key, later: null });
    }
    if (++passes >= SEATS - 1) { current = null; passes = 0; }
  }
  const later = [[], [], [], []];
  let e = events.length - 1;
  for (let i = history.length - 1; i >= 0 && e >= 0; i--) {
    const h = history[i];
    if (h.action === 'play') {
      for (const c of h.combo.cards) later[h.seat].push(c);
    } else if (events[e].idx === i) {
      events[e].later = later[h.seat].slice();
      e--;
    }
  }
  return events;
}

/** How much a dealt hand is discounted for having passed `ev` while holding a beater. */
function passFactor(hand, ev) {
  const later = ev.later;
  if (ev.size === 1) {
    let cheap = false;
    let high = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const c of pass ? later : hand) {
        if (VALUE[c.id] <= ev.key) continue;
        if (c.rank >= 14) high = true;
        else cheap = true;
      }
    }
    return cheap ? PASS_CHEAP : high ? PASS_HIGH : 1;
  }
  const count = new Array(16).fill(0);
  const top = new Array(16).fill(0);
  for (let pass = 0; pass < 2; pass++) {
    for (const c of pass ? later : hand) {
      count[c.rank] += 1;
      if (VALUE[c.id] > top[c.rank]) top[c.rank] = VALUE[c.id];
    }
  }
  for (let r = 3; r <= 15; r++) if (count[r] >= 2 && top[r] > ev.key) return PASS_PAIR;
  return 1;
}

/**
 * One deal of the unseen pool to the three hidden hands, sized by their known
 * card counts. Several uniform deals are drawn and one is kept in proportion to
 * how well it explains the passes in the history; a bounded number of draws,
 * so the cost is fixed whatever the history looks like.
 * @returns {{hands: object[][], groups: (object[]|null)[]}} hands ascending by card value; ours is null
 */
export function sampleWorld(view, unseen, events, rng) {
  const tries = events.length ? DEAL_TRIES : 1;
  const deals = [];
  const weights = [];
  for (let t = 0; t < tries; t++) {
    const pool = shuffle(unseen.slice(), rng);
    const hands = [null, null, null, null];
    let at = 0;
    for (let s = 0; s < SEATS; s++) {
      if (s === view.seat) continue;
      const n = view.players[s].cards;
      hands[s] = pool.slice(at, at + n);
      at += n;
    }
    let weight = 1;
    for (const ev of events) weight *= passFactor(hands[ev.seat], ev);
    deals.push(hands);
    weights.push(weight);
  }
  const hands = tries === 1 ? deals[0] : weightedPick(rng, deals, weights);
  for (const hand of hands) if (hand) hand.sort(byValue);
  return { hands, groups: [null, null, null, null] };
}

// --- rollouts ----------------------------------------------------------------

function comboOf(cards) {
  const n = cards.length;
  if (n === 1) return { type: Combo.SINGLE, rank: cards[0].rank, size: 1, cards, key: VALUE[cards[0].id] };
  if (n === 2 || n === 3) {
    let key = 0;
    for (const c of cards) key = Math.max(key, VALUE[c.id]);
    return { type: n === 2 ? Combo.PAIR : Combo.TRIPLE, rank: cards[0].rank, size: n, cards, key };
  }
  return classify(cards);
}

/** Lead order: weakest first. Five-card hands sit by their displayed top rank. */
const leadOrder = (g) => (g.size === 5 ? g.rank * 4 + 2 : g.key);

/** A hand's decomposition as combos, weakest lead first. */
function comboGroups(cards) {
  const raw = [];
  decomposeInto(cards, raw);
  const out = [];
  for (const g of raw) {
    const combo = comboOf(g);
    if (combo) out.push(combo);
    else for (const c of g) out.push(comboOf([c]));
  }
  return out.sort((a, b) => leadOrder(a) - leadOrder(b));
}

function cheaper(a, b) {
  if (a.size === 5 && a.type !== b.type) return fiveCardStrength(a.type) < fiveCardStrength(b.type);
  return a.key < b.key;
}

function seatGroups(st, s) {
  const seat = st.seats[s];
  if (!seat.groups) {
    if (seat.pristine && st.world.groups[s]) {
      seat.groups = st.world.groups[s].slice();
    } else {
      seat.groups = comboGroups(seat.cards);
      if (seat.pristine) st.world.groups[s] = seat.groups.slice();
    }
  }
  return seat.groups;
}

/** Play `combo` out of seat s. `gi` is its index in the seat's groups, or -1 when it broke one up. */
function rollPlay(st, s, combo, gi) {
  const seat = st.seats[s];
  const gone = combo.cards;
  seat.cards = seat.cards.filter((c) => {
    for (const x of gone) if (x.id === c.id) return false;
    return true;
  });
  seat.pristine = false;
  if (gi >= 0) seat.groups.splice(gi, 1);
  else seat.groups = null;
  st.trick = { combo, seat: s };
  st.passes = 0;
  if (seat.cards.length === 0) st.winner = s;
  else st.turn = (s + 1) % SEATS;
}

function rollPass(st, s) {
  if (++st.passes >= SEATS - 1) {
    st.turn = st.trick.seat;
    st.trick = null;
    st.passes = 0;
  } else {
    st.turn = (s + 1) % SEATS;
  }
}

function minOpponentCards(st, s) {
  let low = 99;
  for (let o = 0; o < SEATS; o++) if (o !== s) low = Math.min(low, st.seats[o].cards.length);
  return low;
}

/** Lead the weakest group; with a seat on one card, shed multi-card groups it cannot answer, else the top single. */
function rollLead(st, s) {
  const groups = seatGroups(st, s);
  let gi = 0;
  if (minOpponentCards(st, s) === 1) {
    gi = groups.findIndex((g) => g.size > 1);
    if (gi < 0) gi = groups.length - 1;
  }
  rollPlay(st, s, groups[gi], gi);
}

/**
 * Answer the trick with the cheapest whole group that beats it. A pair or triple
 * is only broken up for a smaller play when the hand is nearly out or an
 * opponent is; a lone two is held back in the middlegame.
 */
function rollRespond(st, s) {
  const seat = st.seats[s];
  const groups = seatGroups(st, s);
  const cur = st.trick.combo;

  if (cur.size === 1) {
    // A one-card seat still to act can only be stopped by the top single.
    let oneCardToAct = false;
    for (let o = (s + 1) % SEATS; o !== st.trick.seat; o = (o + 1) % SEATS) {
      if (st.seats[o].cards.length === 1) oneCardToAct = true;
    }
    if (oneCardToAct) {
      const top = seat.cards[seat.cards.length - 1];
      if (VALUE[top.id] > cur.key) {
        const gi = groups.findIndex((g) => g.size === 1 && g.cards[0].id === top.id);
        rollPlay(st, s, comboOf([top]), gi);
      } else {
        rollPass(st, s);
      }
      return;
    }
  }

  let gi = -1;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.size !== cur.size || !beats(g, cur)) continue;
    if (gi < 0 || cheaper(g, groups[gi])) gi = i;
  }
  const low = minOpponentCards(st, s);
  if (gi >= 0) {
    const g = groups[gi];
    const holdTwo = cur.size === 1 && g.cards[0].rank === 15 && low > 3 && groups.length > 2;
    if (holdTwo) rollPass(st, s);
    else rollPlay(st, s, g, gi);
    return;
  }

  if (cur.size <= 2 && (low <= 2 || seat.cards.length <= 3)) {
    if (cur.size === 1) {
      for (const c of seat.cards) {
        if (VALUE[c.id] > cur.key) { rollPlay(st, s, comboOf([c]), -1); return; }
      }
    } else {
      for (const g of groups) {
        if (g.size !== 3) continue;
        const t = g.cards.slice().sort(byValue);
        const pair = VALUE[t[1].id] > cur.key ? [t[0], t[1]] : VALUE[t[2].id] > cur.key ? [t[0], t[2]] : null;
        if (pair) { rollPlay(st, s, comboOf(pair), -1); return; }
      }
    }
  }
  rollPass(st, s);
}

/**
 * Play the hand out after `cand` and return this seat's chip payout (settle
 * with rate 1: a win collects every loser's cards left, a loss pays our own).
 * Adds the plies played to ctx.used.
 */
function rollout(view, world, cand, ctx) {
  const me = view.seat;
  const seats = [];
  for (let s = 0; s < SEATS; s++) {
    seats.push(s === me
      ? { cards: cand.rest.slice(), groups: cand.groups(), pristine: false }
      : { cards: world.hands[s].slice(), groups: null, pristine: true });
  }
  const st = { seats, world, trick: view.trick, passes: view.passesInRow ?? 0, turn: me, winner: -1 };

  if (cand.move) {
    st.trick = { combo: cand.move, seat: me };
    st.passes = 0;
    if (seats[me].cards.length === 0) st.winner = me;
    else st.turn = (me + 1) % SEATS;
  } else {
    rollPass(st, me);
  }

  let plies = 1;
  while (st.winner < 0 && plies < ROLLOUT_CAP) {
    plies += 1;
    if (st.trick) rollRespond(st, st.turn);
    else rollLead(st, st.turn);
  }
  ctx.used += plies;
  if (st.winner < 0) return 0;
  if (st.winner === me) {
    let pot = 0;
    for (let s = 0; s < SEATS; s++) pot += seats[s].cards.length;
    return pot;
  }
  return -seats[me].cards.length;
}

/**
 * Re-rank the shortlist by playing it out. Returns the entry to play, or null
 * when the view cannot support a search (the history does not account for the
 * hidden cards) and the heuristic's order should stand.
 * @param {object[]} ranked heuristic entries {move|null, score}, best first
 */
function searchPick(view, skill, ranked) {
  const cfg = skill.search;
  const unseen = unseenCards(view);
  let hidden = 0;
  for (const p of view.players) if (p.seat !== view.seat) hidden += p.cards;
  if (hidden !== unseen.length) return null;

  const picks = [];
  let plays = 0;
  for (const entry of ranked) {
    if (entry.move && plays++ >= cfg.candidates) continue;
    picks.push(entry);
  }
  if (picks.length < 2) return null;

  const hand = view.you.hand;
  const cands = picks.map((entry) => {
    const rest = entry.move ? removeByIds(hand, entry.move.cards).sort(byValue) : hand.slice().sort(byValue);
    let groups = null;
    return {
      entry,
      move: entry.move,
      rest,
      groups: () => (groups ??= comboGroups(rest)).slice(),
    };
  });

  const events = passEvents(view);
  const rng = makeRng(`big2-search:${view.seat}:${(view.history ?? []).length}:${hand.map((c) => c.id).sort((a, b) => a - b).join(',')}`);
  const totals = new Array(cands.length).fill(0);
  const ctx = { used: 0 };
  for (let w = 0; w < cfg.worlds; w++) {
    if (ctx.used >= cfg.budget && w >= MIN_WORLDS) break;
    const world = sampleWorld(view, unseen, events, rng);
    ctx.used += WORLD_COST;
    for (let i = 0; i < cands.length; i++) totals[i] += rollout(view, world, cands[i], ctx);
  }

  let best = 0;
  for (let i = 1; i < cands.length; i++) if (totals[i] > totals[best] + 1e-9) best = i;
  return cands[best].entry;
}

/** Heuristic ranking of every legal move (and the pass), best first; null when there is nothing to rank. */
function rankMoves(view, skill) {
  const hand = view.you.hand;
  const current = view.trick?.combo ?? null;
  const moves = legalPlays(hand, current, { mustInclude: view.leadMustInclude ?? null });
  if (!moves.length) return null;

  const protectedIds = skill.controlAware ? protectedCardIds(hand) : new Set();
  const unseen = skill.countsCards ? unseenCards(view) : null;
  const scored = moves.map((move) => ({ move, score: scoreMove(view, skill, move, protectedIds, unseen) }));
  if (current) scored.push({ move: null, score: scorePass(view) });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** The ranking with the search's pick moved to the front, when this skill searches and the choice is open. */
function rankWithSearch(view, skill) {
  const scored = rankMoves(view, skill);
  if (scored && skill.search && scored.length > 1 && scored[0].score < W.win) {
    const picked = searchPick(view, skill, scored);
    if (picked && picked !== scored[0]) {
      scored.splice(scored.indexOf(picked), 1);
      scored.unshift(picked);
    }
  }
  return scored;
}

/** Hand back a legal action even when no move was generated; cannot happen with a non-empty hand on a lead. */
function noMoves(view) {
  return view.trick ? { action: 'pass' } : { action: 'play', cards: [view.you.hand[0]] };
}

/**
 * Pick a move. Returns {action:'play', cards} or {action:'pass'}.
 * @param {object} view seat view from engine.seatView()
 * @param {Skill} skill
 * @param {() => number} rng
 */
export function chooseMove(view, skill, rng) {
  const scored = rankWithSearch(view, skill);
  if (!scored) return noMoves(view);

  let chosen = scored[0];
  if (scored.length > 1 && rng() > skill.accuracy) {
    const rest = scored.slice(1);
    const best = Math.max(...scored.map((entry) => entry.score));
    const weights = rest.map((entry) => Math.exp((entry.score - best) / Math.max(1, skill.temperature)));
    chosen = weightedPick(rng, rest, weights) ?? chosen;
  }
  return chosen.move ? { action: 'play', cards: chosen.move.cards } : { action: 'pass' };
}

/**
 * The evaluation's own top choice, with none of chooseMove's accuracy/
 * temperature randomness. Exposed for the simulator and for tests that need
 * to pin down exactly what the heuristic ranks best. A searching skill seeds
 * its deals from the view, so this is deterministic too.
 */
export function bestMove(view, skill) {
  const scored = rankWithSearch(view, skill);
  if (!scored) return noMoves(view);
  const top = scored[0];
  return top.move ? { action: 'play', cards: top.move.cards } : { action: 'pass' };
}

export { beats };
