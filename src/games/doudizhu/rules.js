/**
 * Dou Di Zhu (斗地主) combination rules — the default ("classic") rule set.
 *
 * Pure data in, pure data out: no DOM, no randomness. The browser and the LAN
 * server both import this file, so a move the client thinks is legal is the same
 * move the server accepts.
 *
 * Rank order: 3 < 4 < ... < 10 < J < Q < K < A < 2 < small joker < big joker.
 * Chains (straights, pair chains, trio chains) may not pass A: 2 and the jokers
 * never take part in a chain.
 *
 * Complexity: classify() is O(n log n) for the sort plus O(r) over the 15
 * distinct ranks, except for trio-chain-with-wings which scans candidate chain
 * positions, O(r * k) worst case. n <= 20, r <= 15, so all of it is trivial.
 */

import {
  RANK_CHAIN_MAX,
  RANK_JOKER_BIG,
  RANK_JOKER_SMALL,
  countByRank,
  rankLabel,
  sortCardsAsc,
} from '../../core/cards.js';

export const Combo = {
  SINGLE: 'single',
  PAIR: 'pair',
  TRIO: 'trio',
  TRIO_SINGLE: 'trio_single',
  TRIO_PAIR: 'trio_pair',
  STRAIGHT: 'straight',
  PAIR_CHAIN: 'pair_chain',
  TRIO_CHAIN: 'trio_chain',
  TRIO_CHAIN_SINGLES: 'trio_chain_singles',
  TRIO_CHAIN_PAIRS: 'trio_chain_pairs',
  FOUR_TWO: 'four_two',
  FOUR_TWO_PAIRS: 'four_two_pairs',
  BOMB: 'bomb',
  ROCKET: 'rocket',
};

const COMBO_NAMES = {
  [Combo.SINGLE]: { en: 'Single', zh: '单张' },
  [Combo.PAIR]: { en: 'Pair', zh: '对子' },
  [Combo.TRIO]: { en: 'Trio', zh: '三不带' },
  [Combo.TRIO_SINGLE]: { en: 'Trio + single', zh: '三带一' },
  [Combo.TRIO_PAIR]: { en: 'Trio + pair', zh: '三带二' },
  [Combo.STRAIGHT]: { en: 'Straight', zh: '顺子' },
  [Combo.PAIR_CHAIN]: { en: 'Pair chain', zh: '连对' },
  [Combo.TRIO_CHAIN]: { en: 'Aeroplane', zh: '飞机' },
  [Combo.TRIO_CHAIN_SINGLES]: { en: 'Aeroplane + wings', zh: '飞机带翅' },
  [Combo.TRIO_CHAIN_PAIRS]: { en: 'Aeroplane + pairs', zh: '飞机带对' },
  [Combo.FOUR_TWO]: { en: 'Four + two', zh: '四带二' },
  [Combo.FOUR_TWO_PAIRS]: { en: 'Four + two pairs', zh: '四带两对' },
  [Combo.BOMB]: { en: 'Bomb', zh: '炸弹' },
  [Combo.ROCKET]: { en: 'Rocket', zh: '王炸' },
};

/**
 * @typedef {object} ComboInfo
 * @property {string} type    one of Combo.*
 * @property {number} rank    the rank a comparison is made on (top of a chain,
 *                            the trio's rank, the four's rank)
 * @property {number} length  number of linked groups (chain length), else 1
 * @property {number} size    number of cards
 * @property {boolean} bomb   true for bombs and the rocket
 * @property {object[]} cards the cards, ascending
 */

/**
 * Identify what a set of cards is, or null when it is not a legal combination.
 * @param {object[]} input
 * @returns {ComboInfo|null}
 */
export function classify(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  // The server classifies whatever a client sends, so refuse a set that repeats
  // a card before reading any pattern into it.
  const seen = new Set();
  for (const card of input) {
    if (!card || typeof card.rank !== 'number' || seen.has(card.id)) return null;
    seen.add(card.id);
  }
  const cards = sortCardsAsc(input);
  const n = cards.length;
  const counts = countByRank(cards);
  const ranks = [...counts.keys()].sort((a, b) => a - b);
  /** ranks grouped by how many copies are held */
  const byCount = new Map();
  for (const [rank, c] of counts) {
    if (!byCount.has(c)) byCount.set(c, []);
    byCount.get(c).push(rank);
  }
  for (const list of byCount.values()) list.sort((a, b) => a - b);
  const only = (c) => byCount.size === 1 && byCount.has(c);
  const made = (type, rank, length) => ({ type, rank, length, size: n, bomb: type === Combo.BOMB || type === Combo.ROCKET, cards });

  if (n === 1) return made(Combo.SINGLE, ranks[0], 1);

  if (n === 2) {
    if (counts.get(RANK_JOKER_SMALL) === 1 && counts.get(RANK_JOKER_BIG) === 1) {
      return made(Combo.ROCKET, RANK_JOKER_BIG, 1);
    }
    return only(2) ? made(Combo.PAIR, ranks[0], 1) : null;
  }

  if (n === 3) return only(3) ? made(Combo.TRIO, ranks[0], 1) : null;

  if (n === 4) {
    if (only(4)) return made(Combo.BOMB, ranks[0], 1);
    if (byCount.size === 2 && byCount.get(3)?.length === 1 && byCount.get(1)?.length === 1) {
      return made(Combo.TRIO_SINGLE, byCount.get(3)[0], 1);
    }
    return null;
  }

  if (n === 5 && byCount.size === 2 && byCount.get(3)?.length === 1 && byCount.get(2)?.length === 1) {
    return made(Combo.TRIO_PAIR, byCount.get(3)[0], 1);
  }

  // Four with two loose cards (either two singles or one pair) / with two pairs.
  if (byCount.get(4)?.length === 1) {
    const four = byCount.get(4)[0];
    const restCount = n - 4;
    const restRanks = ranks.filter((r) => r !== four);
    if (restCount === 2 && restRanks.every((r) => counts.get(r) <= 2)) {
      return made(Combo.FOUR_TWO, four, 1);
    }
    if (restCount === 4 && restRanks.length === 2 && restRanks.every((r) => counts.get(r) === 2)) {
      return made(Combo.FOUR_TWO_PAIRS, four, 1);
    }
  }

  // Straight: five or more single, consecutive, 3 through A.
  if (n >= 5 && only(1) && isConsecutive(ranks) && ranks[n - 1] <= RANK_CHAIN_MAX) {
    return made(Combo.STRAIGHT, ranks[n - 1], n);
  }

  // Pair chain: three or more consecutive pairs.
  if (n >= 6 && n % 2 === 0 && only(2) && isConsecutive(ranks) && ranks[ranks.length - 1] <= RANK_CHAIN_MAX) {
    return made(Combo.PAIR_CHAIN, ranks[ranks.length - 1], ranks.length);
  }

  // Aeroplane: two or more consecutive trios, no wings.
  if (n >= 6 && n % 3 === 0 && only(3) && isConsecutive(ranks) && ranks[ranks.length - 1] <= RANK_CHAIN_MAX) {
    return made(Combo.TRIO_CHAIN, ranks[ranks.length - 1], ranks.length);
  }

  const withSingles = classifyTrioChainWings(cards, counts, 1);
  if (withSingles) return made(Combo.TRIO_CHAIN_SINGLES, withSingles.top, withSingles.length);
  const withPairs = classifyTrioChainWings(cards, counts, 2);
  if (withPairs) return made(Combo.TRIO_CHAIN_PAIRS, withPairs.top, withPairs.length);

  return null;
}

/**
 * Aeroplane with wings. `wingSize` is 1 for single wings, 2 for pair wings.
 * Tries every consecutive run of candidate trios of the required length and
 * returns the highest-topped valid reading, since a higher reading is never
 * worse for the player and both readings use the same cards.
 */
function classifyTrioChainWings(cards, counts, wingSize) {
  const n = cards.length;
  const unit = 3 + wingSize;
  if (n % unit !== 0) return null;
  const k = n / unit;
  if (k < 2) return null;

  const candidates = [...counts.keys()].filter((r) => counts.get(r) >= 3 && r <= RANK_CHAIN_MAX).sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i + k <= candidates.length; i++) {
    const run = candidates.slice(i, i + k);
    if (!isConsecutive(run)) continue;
    const leftover = new Map(counts);
    for (const r of run) {
      const remaining = leftover.get(r) - 3;
      if (remaining > 0) leftover.set(r, remaining);
      else leftover.delete(r);
    }
    let cardsLeft = 0;
    let ok = true;
    for (const c of leftover.values()) {
      cardsLeft += c;
      if (wingSize === 1 && c >= 3) ok = false;
      if (wingSize === 2 && c !== 2) ok = false;
    }
    if (!ok || cardsLeft !== k * wingSize) continue;
    if (wingSize === 2 && leftover.size !== k) continue;
    const top = run[run.length - 1];
    if (!best || top > best.top) best = { top, length: k };
  }
  return best;
}

function isConsecutive(sortedRanks) {
  for (let i = 1; i < sortedRanks.length; i++) {
    if (sortedRanks[i] !== sortedRanks[i - 1] + 1) return false;
  }
  return true;
}

/**
 * Does `candidate` legally answer `current`? A null `current` means the player
 * is leading, so anything legal goes.
 * @param {ComboInfo|null} candidate
 * @param {ComboInfo|null} current
 */
export function beats(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.type === Combo.ROCKET) return current.type !== Combo.ROCKET;
  if (current.type === Combo.ROCKET) return false;
  if (candidate.type === Combo.BOMB) {
    return current.type === Combo.BOMB ? candidate.rank > current.rank : true;
  }
  if (current.type === Combo.BOMB) return false;
  return candidate.type === current.type && candidate.length === current.length && candidate.rank > current.rank;
}

/** Bombs and the rocket double the stake. */
export function comboMultiplier(combo) {
  return combo && combo.bomb ? 2 : 1;
}

export function comboName(type, lang = 'en') {
  return COMBO_NAMES[type]?.[lang] ?? type;
}

/** Human-readable description, e.g. "Straight of 5, high card 7". */
export function describeCombo(combo, lang = 'en') {
  if (!combo) return lang === 'zh' ? '不要' : 'Pass';
  const name = comboName(combo.type, lang);
  if (combo.type === Combo.ROCKET) return name;
  const top = rankLabel(combo.rank);
  if (combo.length > 1) return `${name} ×${combo.length} (${top} high)`;
  return `${name} ${top}`;
}

// --- felt caption -----------------------------------------------------
//
// describeCombo() above answers "what kind of thing is this" for a screen
// reader or a tooltip, and a chain's length is enough for that ("Aeroplane
// ×2"). The felt caption answers a different question — "who played what" —
// and a count does not answer it: "Trio + pair x5" does not say the trio was
// jacks and the pair was fours, so a player reads it as naming one rank when
// it names neither. feltLabel() below names every rank a player would want
// named, using the cards themselves (COMBO_NAMES/ComboInfo carry only the
// combo's own top rank, never a kicker's).

const EN_DASH = '–';

/** The bare shape word this function builds each label from. Deliberately its
 * own vocabulary rather than COMBO_NAMES: COMBO_NAMES's compound entries read
 * as whole phrases ("Trio + pair"), but a kicker's rank has to land *inside*
 * that phrase ("Trio J + pair 4"), so the shape word alone is what's needed.
 * The zh side reuses COMBO_NAMES's own characters wherever that reads
 * cleanly (single/pair/trio/straight/pair chain/aeroplane/bomb/rocket keep
 * their existing zh name outright); trio-with-a-kicker and four-with-a-kicker
 * fall back to the shared leading character of their COMBO_NAMES family
 * (三/四) because the full compound name (e.g. 三不带, "trio carrying
 * nothing") would contradict a kicker actually being named right after it. */
const FELT_BASE = {
  [Combo.SINGLE]: { en: 'Single', zh: COMBO_NAMES[Combo.SINGLE].zh },
  [Combo.PAIR]: { en: 'Pair', zh: COMBO_NAMES[Combo.PAIR].zh },
  [Combo.TRIO]: { en: 'Trio', zh: COMBO_NAMES[Combo.TRIO].zh },
  [Combo.TRIO_SINGLE]: { en: 'Trio', zh: '三' },
  [Combo.TRIO_PAIR]: { en: 'Trio', zh: '三' },
  [Combo.STRAIGHT]: { en: 'Straight', zh: COMBO_NAMES[Combo.STRAIGHT].zh },
  [Combo.PAIR_CHAIN]: { en: 'Pairs', zh: COMBO_NAMES[Combo.PAIR_CHAIN].zh },
  [Combo.TRIO_CHAIN]: { en: 'Aeroplane', zh: COMBO_NAMES[Combo.TRIO_CHAIN].zh },
  [Combo.TRIO_CHAIN_SINGLES]: { en: 'Aeroplane', zh: COMBO_NAMES[Combo.TRIO_CHAIN].zh },
  [Combo.TRIO_CHAIN_PAIRS]: { en: 'Aeroplane', zh: COMBO_NAMES[Combo.TRIO_CHAIN].zh },
  [Combo.FOUR_TWO]: { en: 'Four', zh: '四' },
  [Combo.FOUR_TWO_PAIRS]: { en: 'Four', zh: '四' },
  [Combo.BOMB]: { en: 'Bomb', zh: COMBO_NAMES[Combo.BOMB].zh },
  [Combo.ROCKET]: { en: 'Rocket', zh: COMBO_NAMES[Combo.ROCKET].zh },
};

const KICKER_WORD = {
  single: { en: 'single', zh: '单' },
  pair: { en: 'pair', zh: '对' },
  singles: { en: 'singles', zh: '单' },
  pairs: { en: 'pairs', zh: '对' },
};

/** "3-7" / "5-8", low to high, from a chain's top rank and its length in
 * links (pairs or trios — not cards; see ComboInfo). An en dash, not a
 * hyphen, so it never reads as a minus sign next to a rank number. */
function rangeLabel(topRank, length) {
  const low = topRank - length + 1;
  return low === topRank ? rankLabel(topRank) : `${rankLabel(low)}${EN_DASH}${rankLabel(topRank)}`;
}

/**
 * What is left of `cards`, by rank, once `usedFor(rank)` copies of each rank
 * are removed — i.e. the kicker(s) once the combo's own trio/four/chain is
 * subtracted out. A kicker rank that coincides with a chain rank (splitting a
 * bomb into an aeroplane's wings, legal if unwise) still shows up here with
 * whatever the chain did not consume.
 */
function leftoverAfter(cards, usedFor) {
  const leftover = new Map();
  for (const [rank, n] of countByRank(cards)) {
    const remain = n - usedFor(rank);
    if (remain > 0) leftover.set(rank, remain);
  }
  return leftover;
}

/**
 * The kicker half of a label: a single rank named outright when there is
 * only one of it ("single 4", "pair 4" — the count is read straight off how
 * many cards of that one rank are left, not off `family`), or a plain count
 * when the kickers are several different ranks ("2 singles", "2 pairs"),
 * since a count can never name the wrong rank. `family` says whether this
 * combo's kicker slots are naturally single cards or pairs, and only matters
 * for that count phrasing.
 */
function kickerPhrase(leftover, family, lang) {
  const entries = [...leftover.entries()];
  if (entries.length === 1) {
    const [rank, count] = entries[0];
    const word = count >= 2 ? KICKER_WORD.pair : KICKER_WORD.single;
    return lang === 'zh' ? `${word.zh}${rankLabel(rank)}` : `${word.en} ${rankLabel(rank)}`;
  }
  const group = family === 'pair' ? KICKER_WORD.pairs : KICKER_WORD.singles;
  const count = family === 'pair' ? entries.length : entries.reduce((sum, [, c]) => sum + c, 0);
  return lang === 'zh' ? `${count}${group.zh}` : `${count} ${group.en}`;
}

/**
 * The felt caption for a played combo, e.g. "Trio J + pair 4",
 * "Aeroplane 7-8 + 2 singles", "Straight 3-7". Unlike describeCombo(), this
 * names every rank a player would want named rather than a chain's length,
 * so it needs the actual cards the combo was built from — a kicker's rank
 * never made it into ComboInfo.
 * @param {ComboInfo|null} combo
 * @param {object[]} cards   the cards the combo was classified from (e.g.
 *                           the play's entry.cards at the call site)
 * @param {'en'|'zh'} [lang]
 */
export function feltLabel(combo, cards, lang = 'en') {
  if (!combo) return lang === 'zh' ? '不要' : 'Pass';
  const base = FELT_BASE[combo.type];
  if (!base) return comboName(combo.type, lang);
  const name = lang === 'zh' ? base.zh : base.en;
  const sep = lang === 'zh' ? '' : ' ';
  const plus = lang === 'zh' ? '+' : ' + ';

  switch (combo.type) {
    case Combo.ROCKET:
      return name;

    case Combo.SINGLE:
    case Combo.PAIR:
    case Combo.TRIO:
    case Combo.BOMB:
      return `${name}${sep}${rankLabel(combo.rank)}`;

    case Combo.STRAIGHT:
    case Combo.PAIR_CHAIN:
    case Combo.TRIO_CHAIN:
      return `${name}${sep}${rangeLabel(combo.rank, combo.length)}`;

    case Combo.TRIO_SINGLE:
    case Combo.TRIO_PAIR: {
      const family = combo.type === Combo.TRIO_PAIR ? 'pair' : 'single';
      const leftover = leftoverAfter(cards, (r) => (r === combo.rank ? 3 : 0));
      return `${name}${sep}${rankLabel(combo.rank)}${plus}${kickerPhrase(leftover, family, lang)}`;
    }

    case Combo.FOUR_TWO:
    case Combo.FOUR_TWO_PAIRS: {
      const family = combo.type === Combo.FOUR_TWO_PAIRS ? 'pair' : 'single';
      const leftover = leftoverAfter(cards, (r) => (r === combo.rank ? 4 : 0));
      return `${name}${sep}${rankLabel(combo.rank)}${plus}${kickerPhrase(leftover, family, lang)}`;
    }

    case Combo.TRIO_CHAIN_SINGLES:
    case Combo.TRIO_CHAIN_PAIRS: {
      const family = combo.type === Combo.TRIO_CHAIN_PAIRS ? 'pair' : 'single';
      const low = combo.rank - combo.length + 1;
      const leftover = leftoverAfter(cards, (r) => (r >= low && r <= combo.rank ? 3 : 0));
      return `${name}${sep}${rangeLabel(combo.rank, combo.length)}${plus}${kickerPhrase(leftover, family, lang)}`;
    }

    default:
      return comboName(combo.type, lang);
  }
}
