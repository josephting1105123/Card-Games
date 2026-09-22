/**
 * Stamp the service worker with a hash of everything it precaches.
 *
 * The worker serves the precache cache-first, so a returning visitor keeps
 * getting the old files until the cache name changes. The browser only installs
 * a new worker when sw.js itself differs byte for byte, which means shipping a
 * change to any other file without touching sw.js leaves every existing
 * installation frozen on the previous version — silently, and for good.
 *
 * Relying on somebody remembering to bump a version by hand is how that bug
 * ships. So the name carries a hash of the precached contents instead, this
 * regenerates it, and a test fails when it is out of date.
 *
 *   node tools/stamp-sw.mjs          rewrite the stamp
 *   node tools/stamp-sw.mjs --check  exit non-zero if it is stale
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SW = join(ROOT, 'sw.js');

/** The paths listed in the worker's PRECACHE array. */
export function precachedPaths(source) {
  const start = source.indexOf('const PRECACHE');
  const block = source.slice(start, source.indexOf('];', start));
  return [...block.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
}

/** A short hash over every precached file's bytes, in listed order. */
export function precacheHash(source) {
  const hash = createHash('sha256');
  for (const path of precachedPaths(source)) {
    hash.update(path);
    hash.update(readFileSync(join(ROOT, path)));
  }
  // The worker's own logic counts too, minus the stamp it is about to be given.
  hash.update(source.replace(/const CACHE = '[^']*';/, ''));
  return hash.digest('hex').slice(0, 12);
}

export function currentStamp(source) {
  return source.match(/const CACHE = 'card-games-([^']*)';/)?.[1] ?? null;
}

function main() {
  const source = readFileSync(SW, 'utf8');
  const want = precacheHash(source);
  const have = currentStamp(source);
  if (process.argv.includes('--check')) {
    if (have === want) {
      console.log(`sw.js stamp is current (${have})`);
      return;
    }
    console.error(`sw.js stamp is stale: ${have} -> ${want}. Run: node tools/stamp-sw.mjs`);
    process.exit(1);
  }
  if (have === want) {
    console.log(`sw.js already stamped ${have}`);
    return;
  }
  writeFileSync(SW, source.replace(/const CACHE = '[^']*';/, `const CACHE = 'card-games-${want}';`));
  console.log(`sw.js stamped ${have} -> ${want}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
