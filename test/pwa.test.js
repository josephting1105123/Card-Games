import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentStamp, precacheHash } from '../tools/stamp-sw.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const precache = (() => {
  const source = read('sw.js');
  const block = source.slice(source.indexOf('const PRECACHE'), source.indexOf('];', source.indexOf('const PRECACHE')));
  return [...block.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]);
})();

test('every shipped source file is precached, so the app runs offline', () => {
  // Documentation that ships beside an asset (a font licence, a README) is not
  // fetched at run time, so it has no business in the offline cache.
  const isRuntimeAsset = (file) => !/\.(md|txt)$/i.test(file);
  const shipped = [...walk('src'), ...walk('styles'), ...walk('assets')].filter(isRuntimeAsset);
  const missing = shipped.filter((file) => !precache.includes(file));
  assert.deepEqual(missing, [], `these files would 404 offline: ${missing.join(', ')}`);
});

test('the font files are real woff2 and are precached', () => {
  const fonts = walk('assets/fonts').filter((file) => file.endsWith('.woff2'));
  assert.ok(fonts.length >= 2, 'the app self-hosts its font rather than linking a CDN');
  for (const file of fonts) {
    assert.ok(precache.includes(file), `${file} is not precached, so an offline install loses Garamond`);
    const buf = readFileSync(join(ROOT, file));
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'wOF2', `${file} is not a woff2`);
  }
  const css = read('styles/tokens.css');
  for (const file of fonts) {
    assert.ok(css.includes(file.replace('assets/', '../assets/')), `no @font-face references ${file}`);
  }
  assert.equal(/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(css + read('index.html') + read('styles/app.css')), false,
    'the app must not fetch its font from a CDN at run time');
  assert.doesNotThrow(() => statSync(join(ROOT, 'assets/fonts/OFL.txt')), 'the font licence must ship with the font');
});

test('nothing is set in a sans face', () => {
  for (const file of ['styles/tokens.css', 'styles/app.css', 'styles/table.css']) {
    const css = read(file);
    assert.equal(/sans-serif/.test(css), false, `${file} still falls back to a sans face`);
  }
});

test('nothing in the precache list is missing from disk', () => {
  for (const entry of precache) {
    if (entry === '') continue; // './' is the start URL, served as index.html
    assert.doesNotThrow(() => statSync(join(ROOT, entry)), `sw.js precaches ${entry}, which does not exist`);
  }
});

test('the manifest is valid and its icons exist', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'landscape', 'the table is dealt across, so it installs landscape');
  assert.ok(manifest.name && manifest.short_name);
  assert.ok(manifest.start_url.startsWith('./'), 'relative, so it works under a project page path');
  assert.ok(manifest.scope.startsWith('./'));
  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'installability needs 192 and 512');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'Android wants a maskable icon');
  for (const icon of manifest.icons) {
    assert.doesNotThrow(() => statSync(join(ROOT, icon.src)), `missing icon ${icon.src}`);
  }
});

test('index.html only points at files that exist', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 4);
  for (const ref of refs) {
    assert.doesNotThrow(() => statSync(join(ROOT, ref)), `index.html references ${ref}, which does not exist`);
  }
});

test('the generated PNG icons really are PNGs of the right size', () => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const [file, size] of [['assets/icons/icon-192.png', 192], ['assets/icons/icon-512.png', 512],
    ['assets/icons/maskable-512.png', 512], ['assets/icons/apple-touch-icon.png', 180]]) {
    const buf = readFileSync(join(ROOT, file));
    assert.ok(buf.subarray(0, 8).equals(signature), `${file} is not a PNG`);
    assert.equal(buf.readUInt32BE(16), size, `${file} is not ${size} wide`);
    assert.equal(buf.readUInt32BE(20), size, `${file} is not ${size} tall`);
  }
});

test('no browser module imports a Node built-in', () => {
  // The browser bundle has no build step, so a stray node: import would only
  // fail at run time in front of a player.
  for (const file of walk('src')) {
    const source = read(file);
    const nodeImports = [...source.matchAll(/from\s+'(node:[^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(nodeImports, [], `${file} imports ${nodeImports.join(', ')}`);
  }
});

test('the shared game code is free of DOM access', () => {
  // engine, rules and moves run on the LAN host too, where there is no document.
  for (const file of ['src/games/doudizhu/rules.js', 'src/games/doudizhu/moves.js',
    'src/games/doudizhu/engine.js', 'src/games/doudizhu/ai.js', 'src/games/doudizhu/match.js',
    'src/core/cards.js', 'src/core/economy.js', 'src/core/elo.js', 'src/core/rng.js']) {
    const source = read(file);
    assert.equal(/\bdocument\.|\bwindow\./.test(source), false, `${file} touches the DOM`);
  }
});

test('the stylesheets read tokens rather than hard-coded values', () => {
  // tokens.css owns the palette, the type scale and the motion curves; a colour
  // or a duration that drifts into a component sheet is how a design system
  // stops being one.
  const tokens = read('styles/tokens.css');
  for (const name of ['--font', '--t-body', '--dur-med', '--ease', '--r-lg', '--shadow-8', '--gold']) {
    assert.ok(tokens.includes(`${name}:`), `tokens.css does not define ${name}`);
  }
  for (const file of ['styles/app.css', 'styles/table.css']) {
    const css = read(file);
    assert.equal(/^\s*:root\s*\{/m.test(css), false, `${file} redefines tokens; they belong in tokens.css`);
    assert.equal(/@font-face/.test(css), false, `${file} declares a font face; that belongs in tokens.css`);
  }
});

test('no card fan is spaced with a percentage margin', () => {
  // A percentage margin resolves against the containing block's width, not the
  // element's. On a row of overlapping cards that is self-amplifying: each extra
  // card widens the row, which widens every negative margin, which collapses the
  // fan into a pile. It shipped twice — once on the seats' card backs, once on
  // the played trick. Overlap is expressed as a fraction of --card-w instead.
  for (const file of ['styles/app.css', 'styles/table.css', 'styles/tokens.css']) {
    const offenders = [...read(file).matchAll(/margin[a-z-]*:[^;{}]*?-[\d.]+%/g)].map((m) => m[0].trim());
    assert.deepEqual(offenders, [], `${file} spaces something with a negative percentage margin: ${offenders.join(' | ')}`);
  }
});

test('the card width is declared where every element that reads it can see it', () => {
  // --card-w is a custom property, so it inherits downward and nowhere else.
  // Declared on .card it reached the card and nothing above it, which left the
  // hand's height calc invalid, collapsed its row to zero and floated the fan up
  // over the trick. The table owns the value; a landing area may override it on
  // its own cards; nothing else may declare it.
  const css = read('styles/table.css');
  const tableBlock = css.slice(css.indexOf('.table {'), css.indexOf('}', css.indexOf('.table {')));
  assert.ok(/--card-w:/.test(tableBlock), '.table does not declare --card-w, so .hand cannot inherit it');

  for (const [, selector, block] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/--card-w:/.test(block)) continue;
    const rule = selector.trim().split('\n').pop().trim();
    assert.ok(/^\.table\b/.test(rule) || /\.card\b/.test(rule),
      `${rule} declares --card-w; the table owns it and only a card may override its own`);
  }

  // The card reads the inherited value, with a fallback for a card rendered
  // outside the table, rather than setting a width of its own.
  const cardBlock = css.slice(css.indexOf('\n.card {'), css.indexOf('}', css.indexOf('\n.card {')));
  assert.ok(/width:\s*var\(--card-w,/.test(cardBlock), '.card must take its width from --card-w with a fallback');
});

test('the interface quotes the thresholds rather than hard-coding them', () => {
  // A number typed into a sentence is a number that drifts the next time the
  // economy is tuned; it happened once with the rescue threshold already.
  const sources = ['src/ui/screens.js', 'src/ui/solo.js', 'src/ui/lan.js'];
  const thresholds = [/\b25,?000\b/, /\b6,?000\b/, /\b2,?000 ?\./];
  for (const file of sources) {
    const source = read(file).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const pattern of thresholds) {
      assert.equal(pattern.test(source), false, `${file} writes a threshold out in full: ${pattern}`);
    }
  }
});

test('every stored setting is read by something', () => {
  // Settings that nothing consults are a promise the app does not keep; three
  // of them accumulated before anyone noticed.
  const profileSource = read('src/core/profile.js');
  const block = profileSource.slice(profileSource.indexOf('settings: {'), profileSource.indexOf('}', profileSource.indexOf('settings: {')));
  const keys = [...block.matchAll(/(\w+):/g)].map((m) => m[1]).filter((k) => k !== 'settings');
  assert.ok(keys.length > 0, 'could not find the default settings');
  const ui = ['src/ui/screens.js', 'src/ui/solo.js', 'src/ui/lan.js', 'src/ui/tableview.js', 'src/main.js']
    .map(read).join('\n');
  for (const key of keys) {
    assert.ok(new RegExp(`settings\\??\\.${key}\\b`).test(ui), `nothing reads profile setting "${key}"`);
  }
});

test('the table view only reads fields a seat view actually sends', () => {
  // The hint highlight silently stopped clearing because this read view.plays,
  // which seatView has never emitted.
  const engine = read('src/games/doudizhu/engine.js');
  const viewBlock = engine.slice(engine.indexOf('export function seatView'), engine.indexOf('/** Deep copy'));
  // [:,] so shorthand properties such as `seat,` are counted as sent too.
  const sent = new Set([...viewBlock.matchAll(/^\s{4}(\w+)[:,]/gm)].map((m) => m[1]));
  for (const extra of ['you', 'players', 'trick', 'bidding', 'result']) sent.add(extra);
  const tableview = read('src/ui/tableview.js');
  const readFields = [...tableview.matchAll(/\bview\.(\w+)/g)].map((m) => m[1]);
  for (const field of new Set(readFields)) {
    assert.ok(sent.has(field), `tableview reads view.${field}, which seatView does not send`);
  }
});

test('the service worker cache name tracks what it caches', () => {
  // Cache-first means a returning visitor keeps the old app until this name
  // changes, and the browser only installs a new worker when sw.js itself
  // differs. Shipping a change to any other file without touching sw.js would
  // freeze every existing installation on the previous version, silently.
  const source = read('sw.js');
  assert.equal(currentStamp(source), precacheHash(source),
    'sw.js stamp is stale \u2014 run: node tools/stamp-sw.mjs');
});

test('the stamp actually moves when a precached file moves', () => {
  const source = read('sw.js');
  const before = precacheHash(source);
  const target = join(ROOT, 'styles/app.css');
  const original = readFileSync(target);
  try {
    writeFileSync(target, Buffer.concat([original, Buffer.from('\n/* stamp probe */\n')]));
    assert.notEqual(precacheHash(source), before, 'editing a shipped file must change the stamp');
  } finally {
    writeFileSync(target, original);
  }
  assert.equal(precacheHash(read('sw.js')), before, 'and restoring it must put the stamp back');
});
