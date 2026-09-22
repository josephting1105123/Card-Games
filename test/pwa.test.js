import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const shipped = [...walk('src'), ...walk('styles'), ...walk('assets')];
  const missing = shipped.filter((file) => !precache.includes(file));
  assert.deepEqual(missing, [], `these files would 404 offline: ${missing.join(', ')}`);
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
