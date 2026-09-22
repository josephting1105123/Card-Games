/**
 * Move generation for Dou Di Zhu.
 *
 * Two entry points:
 *   enumerateLeads(hand, opts)          – everything you may open a trick with
 *   legalPlays(hand, current, opts)     – everything that answers `current`
 *
 * Kicker choice is deliberately pruned. A trio plus one loose card has as many
 * readings as there are loose cards, and an aeroplane with wings has C(m, k) of
 * them; enumerating all of that is pointless because a sane player attaches the
 * cheapest cards that do not break something better. `kickerChoices` caps how
 * many alternatives are offered per base group (default 2: the cheapest, and a
 * second-cheapest so a bot can dump a card it wants rid of).
 *
 * Complexity: O(r^2 * K) where r = 15 distinct ranks and K = kickerChoices, so a
 * few hundred candidate moves for a full 20-card hand. Answering a trick is
 * cheaper still because only one category has to be generated.
 */

import { RANK_CHAIN_MAX, RANK_JOKER_BIG, RANK_JOKER_SMALL, groupByRank, isJoker } from '../../core/cards.js';
import { Combo, beats, classify } from './rules.js';

const DEFAULTS = { kickerChoices: 2, wings: true };

/** @returns {{type: string, rank: number, length: number, size: number, bomb: boolean, cards: object[]}[]} */
export function enumerateLeads(hand, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ctx = makeContext(hand);
  const out = [];
  pushSimple(ctx, out);
  pushChains(ctx, out);
  pushTrioKickers(ctx, out, o);
  pushFourKickers(ctx, out, o);
  if (o.wings) pushChainWings(ctx, out, o);
  pushBombs(ctx, out);
  return dedupe(out);
}

/**
 * Every play in `hand` that legally answers `current`. Leading (current == null)
 * delegates to enumerateLeads.
 */
export function legalPlays(hand, current, opts = {}) {
  if (!current) return enumerateLeads(hand, opts);
  const o = { ...DEFAULTS, ...opts };
  const ctx = makeContext(hand);
  const out = [];

  if (current.type === Combo.ROCKET) return [];

  if (current.type !== Combo.BOMB) {
    switch (current.type) {
      case Combo.SINGLE: pushSingles(ctx, out); break;
      case Combo.PAIR: pushPairs(ctx, out); break;
      case Combo.TRIO: pushTrios(ctx, out); break;
      case Combo.TRIO_SINGLE:
      case Combo.TRIO_PAIR: pushTrioKickers(ctx, out, o); break;
      case Combo.STRAIGHT:
      case Combo.PAIR_CHAIN:
      case Combo.TRIO_CHAIN: pushChains(ctx, out, current.length); break;
      case Combo.TRIO_CHAIN_SINGLES:
      case Combo.TRIO_CHAIN_PAIRS: pushChainWings(ctx, out, o, current.length); break;
      case Combo.FOUR_TWO:
      case Combo.FOUR_TWO_PAIRS: pushFourKickers(ctx, out, o); break;
      default: break;
    }
  }
  pushBombs(ctx, out);
  return dedupe(out).filter((move) => beats(move, current));
}

/** The cheapest legal answer, or null. Used for the Hint button. */
export function findHint(hand, current, opts = {}) {
  const moves = legalPlays(hand, current, opts);
  if (!moves.length) return null;
  moves.sort((a, b) => moveCost(a) - moveCost(b));
  return moves[0];
}

/**
 * A rough "what does this play cost me" number, used only to order hints and to
 * pick kickers. Lower is cheaper. Bombs and jokers are expensive, low cards are
 * cheap, and long chains are cheap per card because they shed a lot of hand.
 */
export function moveCost(move) {
  let cost = move.rank * 2 + move.size;
  if (move.type === Combo.BOMB) cost += 120;
  if (move.type === Combo.ROCKET) cost += 200;
  if (move.cards.some((c) => c.rank === RANK_JOKER_SMALL)) cost += 40;
  if (move.cards.some((c) => c.rank === RANK_JOKER_BIG)) cost += 60;
  if (move.length > 1) cost -= move.length * 4;
  return cost;
}

// --- internals ---------------------------------------------------------------

function makeContext(hand) {
  const groups = groupByRank(hand);
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const count = (r) => groups.get(r)?.length ?? 0;
  const take = (r, n) => groups.get(r).slice(0, n);
  return { hand, groups, ranks, count, take };
}

function make(type, rank, length, cards) {
  return { type, rank, length, size: cards.length, bomb: type === Combo.BOMB || type === Combo.ROCKET, cards };
}

function pushSingles(ctx, out) {
  for (const r of ctx.ranks) out.push(make(Combo.SINGLE, r, 1, ctx.take(r, 1)));
}

function pushPairs(ctx, out) {
  for (const r of ctx.ranks) if (ctx.count(r) >= 2) out.push(make(Combo.PAIR, r, 1, ctx.take(r, 2)));
}

function pushTrios(ctx, out) {
  for (const r of ctx.ranks) if (ctx.count(r) >= 3) out.push(make(Combo.TRIO, r, 1, ctx.take(r, 3)));
}

function pushSimple(ctx, out) {
  pushSingles(ctx, out);
  pushPairs(ctx, out);
  pushTrios(ctx, out);
}

function pushBombs(ctx, out) {
  for (const r of ctx.ranks) if (ctx.count(r) === 4) out.push(make(Combo.BOMB, r, 1, ctx.take(r, 4)));
  if (ctx.count(RANK_JOKER_SMALL) && ctx.count(RANK_JOKER_BIG)) {
    out.push(make(Combo.ROCKET, RANK_JOKER_BIG, 1, [...ctx.take(RANK_JOKER_SMALL, 1), ...ctx.take(RANK_JOKER_BIG, 1)]));
  }
}

/**
 * Straights, pair chains and aeroplanes. `onlyLength` restricts output to chains
 * of exactly that many groups, which is what answering a trick needs.
 */
function pushChains(ctx, out, onlyLength = 0) {
  const specs = [
    { copies: 1, min: 5, type: Combo.STRAIGHT },
    { copies: 2, min: 3, type: Combo.PAIR_CHAIN },
    { copies: 3, min: 2, type: Combo.TRIO_CHAIN },
  ];
  for (const spec of specs) {
    for (let start = 3; start <= RANK_CHAIN_MAX; start++) {
      const cards = [];
      for (let r = start; r <= RANK_CHAIN_MAX; r++) {
        if (ctx.count(r) < spec.copies) break;
        cards.push(...ctx.take(r, spec.copies));
        const length = r - start + 1;
        if (length < spec.min) continue;
        if (onlyLength && length !== onlyLength) continue;
        out.push(make(spec.type, r, length, [...cards]));
      }
    }
  }
}

/** Candidate kicker cards, cheapest first, skipping cards used by `usedRanks`. */
function kickerSingles(ctx, usedRanks, limit) {
  const options = [];
  for (const r of ctx.ranks) {
    if (usedRanks.has(r)) continue;
    // Prefer shedding a lone card; breaking a pair or a bomb for a kicker is a
    // last resort, so those sort later. Jokers are legal kickers and are kept in
    // the list — otherwise a hand like 444 + joker could not answer a trio with
    // a kicker at all — but they sort behind everything else.
    const penalty = ctx.count(r) === 1 ? 0 : ctx.count(r) === 2 ? 30 : ctx.count(r) === 4 ? 200 : 60;
    const jokerPenalty = isJoker({ rank: r }) ? 90 : 0;
    options.push({ rank: r, cost: r + penalty + jokerPenalty, cards: ctx.take(r, 1) });
  }
  options.sort((a, b) => a.cost - b.cost);
  return options.slice(0, limit);
}

function kickerPairs(ctx, usedRanks, limit) {
  const options = [];
  for (const r of ctx.ranks) {
    if (usedRanks.has(r) || ctx.count(r) < 2) continue;
    const penalty = ctx.count(r) === 2 ? 0 : ctx.count(r) === 4 ? 200 : 40;
    options.push({ rank: r, cost: r + penalty, cards: ctx.take(r, 2) });
  }
  options.sort((a, b) => a.cost - b.cost);
  return options.slice(0, limit);
}

function pushTrioKickers(ctx, out, o) {
  for (const r of ctx.ranks) {
    if (ctx.count(r) < 3) continue;
    const trio = ctx.take(r, 3);
    const used = new Set([r]);
    for (const k of kickerSingles(ctx, used, o.kickerChoices)) {
      out.push(make(Combo.TRIO_SINGLE, r, 1, [...trio, ...k.cards]));
    }
    for (const k of kickerPairs(ctx, used, o.kickerChoices)) {
      out.push(make(Combo.TRIO_PAIR, r, 1, [...trio, ...k.cards]));
    }
  }
}

function pushFourKickers(ctx, out, o) {
  for (const r of ctx.ranks) {
    if (ctx.count(r) !== 4) continue;
    const four = ctx.take(r, 4);
    const used = new Set([r]);
    const singles = kickerSingles(ctx, used, o.kickerChoices + 1);
    for (let i = 0; i < singles.length; i++) {
      for (let j = i + 1; j < singles.length; j++) {
        out.push(make(Combo.FOUR_TWO, r, 1, [...four, ...singles[i].cards, ...singles[j].cards]));
      }
    }
    const pairs = kickerPairs(ctx, used, o.kickerChoices + 1);
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        out.push(make(Combo.FOUR_TWO_PAIRS, r, 1, [...four, ...pairs[i].cards, ...pairs[j].cards]));
      }
    }
  }
}

function pushChainWings(ctx, out, o, onlyLength = 0) {
  for (let start = 3; start <= RANK_CHAIN_MAX; start++) {
    const chain = [];
    const used = new Set();
    for (let r = start; r <= RANK_CHAIN_MAX; r++) {
      if (ctx.count(r) < 3) break;
      chain.push(...ctx.take(r, 3));
      used.add(r);
      const k = r - start + 1;
      if (k < 2) continue;
      if (onlyLength && k !== onlyLength) continue;
      const singles = kickerSingles(ctx, used, k + o.kickerChoices);
      if (singles.length >= k) {
        for (let offset = 0; offset <= Math.min(o.kickerChoices - 1, singles.length - k); offset++) {
          const wings = singles.slice(offset, offset + k).flatMap((s) => s.cards);
          out.push(make(Combo.TRIO_CHAIN_SINGLES, r, k, [...chain, ...wings]));
        }
      }
      const pairs = kickerPairs(ctx, used, k + o.kickerChoices);
      if (pairs.length >= k) {
        for (let offset = 0; offset <= Math.min(o.kickerChoices - 1, pairs.length - k); offset++) {
          const wings = pairs.slice(offset, offset + k).flatMap((s) => s.cards);
          out.push(make(Combo.TRIO_CHAIN_PAIRS, r, k, [...chain, ...wings]));
        }
      }
    }
  }
}

function dedupe(moves) {
  const seen = new Set();
  const out = [];
  for (const move of moves) {
    const key = move.cards.map((c) => c.id).sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(move);
  }
  return out;
}

/**
 * Sanity check used by the tests and by the LAN server: every generated move
 * must survive classify() as the type the generator claimed.
 */
export function verifyMove(move) {
  const info = classify(move.cards);
  return !!info && info.type === move.type && info.rank === move.rank && info.length === move.length;
}
