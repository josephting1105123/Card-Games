/**
 * Bot-vs-bot simulator, for checking that the difficulty ladder actually
 * produces harder opponents and that no table ever wedges.
 *
 * Usage:
 *   node tools/sim.mjs                      ladder report, 300 games per pairing
 *   node tools/sim.mjs 1000                 more games
 *   node tools/sim.mjs 500 grandmaster novice
 */

import { simulateGame } from '../src/games/doudizhu/match.js';
import { SKILLS } from '../src/games/doudizhu/ai.js';

const games = Number(process.argv[2] ?? 300);
const pair = process.argv.slice(3);

/**
 * `subject` sits in one seat, `field` in the other two. Chip flow is measured in
 * stake units so a landlord win counts double, exactly as the table settles.
 */
function measure(subject, field, n, seedPrefix) {
  let chips = 0;
  let wins = 0;
  let landlordGames = 0;
  let fallbacks = 0;
  for (let i = 0; i < n; i++) {
    const seat = i % 3;
    const skills = [field, field, field];
    skills[seat] = subject;
    const { state, result } = simulateGame({ seed: `${seedPrefix}:${i}`, skills });
    fallbacks += state.log.filter((e) => e.kind === 'fallback').length;
    const isLandlord = seat === result.landlordSeat;
    if (isLandlord) landlordGames += 1;
    const won = isLandlord === result.landlordWon;
    if (won) wins += 1;
    chips += (won ? 1 : -1) * (isLandlord ? 2 : 1) * result.multiplier;
  }
  return {
    subject, field, n, wins, winRate: wins / n, chips, chipsPerGame: chips / n,
    landlordShare: landlordGames / n, fallbacks,
  };
}

if (pair.length === 2) {
  const row = measure(pair[0], pair[1], games, 'pair');
  console.log(row);
} else {
  const names = Object.keys(SKILLS);
  console.log(`subject vs a table of "steady" bots, ${games} games each\n`);
  console.log('skill          win%   chips/game  landlord%  illegal');
  for (const name of names) {
    // Same seed prefix for every skill, so each one faces the identical set of
    // deals. Paired comparison: cuts the variance enough to see the ladder.
    const r = measure(name, 'steady', games, 'ladder');
    console.log(
      `${name.padEnd(13)} ${(r.winRate * 100).toFixed(1).padStart(5)}  ${r.chipsPerGame.toFixed(2).padStart(10)}  ${(r.landlordShare * 100).toFixed(1).padStart(8)}  ${String(r.fallbacks).padStart(7)}`,
    );
  }
}
