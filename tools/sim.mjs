/**
 * Bot-vs-bot simulator, for checking that the difficulty ladder actually
 * produces harder opponents and that no table ever wedges.
 *
 * Usage:
 *   node tools/sim.mjs                      ladder report, 300 games per pairing
 *   node tools/sim.mjs 1000                 more games
 *   node tools/sim.mjs 500 grandmaster novice
 *
 * The ladder report also tracks two things worth watching after the ai.js
 * discipline/search changes: how often the subject's own decisions take a
 * while (the endgame search is the one thing in ai.js that is not O(small)),
 * and how often it plays a four-with-kickers or four-with-pairs, since that
 * used to be a bomb spent for nothing.
 */

import { simulateGame } from '../src/games/doudizhu/match.js';
import { SKILLS } from '../src/games/doudizhu/ai.js';
import { classify } from '../src/games/doudizhu/rules.js';

const games = Number(process.argv[2] ?? 300);
const pair = process.argv.slice(3);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/**
 * `subject` sits in one seat, `field` in the other two. Chip flow is measured in
 * stake units so a landlord win counts double, exactly as the table settles.
 * Timing and four-with-kickers stats are only collected for the subject's own
 * decisions — the field bots are not what is being characterised.
 */
function measure(subject, field, n, seedPrefix) {
  let chips = 0;
  let wins = 0;
  let landlordGames = 0;
  let fallbacks = 0;
  let fourPlays = 0;
  let fourEmptied = 0;
  const decisionMs = [];
  for (let i = 0; i < n; i++) {
    const seat = i % 3;
    const skills = [field, field, field];
    skills[seat] = subject;
    const { state, result } = simulateGame({
      seed: `${seedPrefix}:${i}`,
      skills,
      onDecision: (info) => {
        if (info.seat !== seat) return;
        decisionMs.push(info.ms);
        if (info.kind !== 'play') return;
        const combo = classify(info.cards);
        if (combo?.type === 'four_two' || combo?.type === 'four_two_pairs') {
          fourPlays += 1;
          if (info.emptied) fourEmptied += 1;
        }
      },
    });
    fallbacks += state.log.filter((e) => e.kind === 'fallback').length;
    const isLandlord = seat === result.landlordSeat;
    if (isLandlord) landlordGames += 1;
    const won = isLandlord === result.landlordWon;
    if (won) wins += 1;
    chips += (won ? 1 : -1) * (isLandlord ? 2 : 1) * result.multiplier;
  }
  const sorted = [...decisionMs].sort((a, b) => a - b);
  const fourFinished = fourEmptied;
  const fourUnfinished = fourPlays - fourEmptied;
  return {
    subject, field, n, wins, winRate: wins / n, chips, chipsPerGame: chips / n,
    landlordShare: landlordGames / n, fallbacks, fourPlays, fourEmptied, fourPer100: (fourPlays / n) * 100,
    fourFinishedPer100: (fourFinished / n) * 100, fourUnfinishedPer100: (fourUnfinished / n) * 100,
    p50: percentile(sorted, 0.50), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] ?? 0,
  };
}

if (pair.length === 2) {
  const row = measure(pair[0], pair[1], games, 'pair');
  console.log(row);
} else {
  const names = Object.keys(SKILLS);
  console.log(`subject vs a table of "steady" bots, ${games} games each\n`);
  console.log('skill          win%   chips/game  landlord%  illegal  4+kick finish/100  4+kick nonfinish/100  p50ms   p95ms   maxms');
  for (const name of names) {
    // Same seed prefix for every skill, so each one faces the identical set of
    // deals. Paired comparison: cuts the variance enough to see the ladder.
    const r = measure(name, 'steady', games, 'ladder');
    console.log(
      `${name.padEnd(13)} ${(r.winRate * 100).toFixed(1).padStart(5)}  ${r.chipsPerGame.toFixed(2).padStart(10)}  `
      + `${(r.landlordShare * 100).toFixed(1).padStart(8)}  ${String(r.fallbacks).padStart(7)}  ${r.fourFinishedPer100.toFixed(2).padStart(16)}  `
      + `${r.fourUnfinishedPer100.toFixed(2).padStart(20)}  ${r.p50.toFixed(3).padStart(6)}  ${r.p95.toFixed(3).padStart(6)}  ${r.max.toFixed(3).padStart(6)}`,
    );
  }
}
