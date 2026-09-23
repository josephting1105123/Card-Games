#!/usr/bin/env node
/**
 * The felt-layout gate for section 2 of the felt spec ("the trick lands on top
 * of the seats"). Run by hand (`node tools/layoutcheck.mjs`) — never from
 * `npm test`, and never imported from test/, because CI has no browser.
 *
 * The spec's own words are the gate: at every landscape viewport from 1280x720
 * down to 667x375, a played combo of up to twelve cards must not overlap the
 * seat block it sits beside, the other seat, the landlord's three, the HUD, or
 * the hand — not "mostly", zero overlapping pixels, with a couple of pixels of
 * breathing room. This checks that directly, by driving a real table in
 * Chromium, injecting cards straight into `.play--left/right/self .play__cards`
 * (bypassing the game engine entirely — a bot match cannot be steered into
 * playing a specific twelve-card combo on demand), and reading real
 * getBoundingClientRect() rectangles back out. It knows nothing about how the
 * fix is built (percentages, a CSS custom property fed from JS, a resize
 * observer) — only the class names the spec itself names as fixed points
 * (`.play--left/right/self`, `.seat--left/right`, `.bottom-cards`, `.hud`,
 * `.hand`, `.felt`) and the shared `.card` class every card in the app is
 * built from (src/ui/cardart.js).
 */

import pw from '/opt/node22/lib/node_modules/playwright/index.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { classify, feltLabel } from '../src/games/doudizhu/rules.js';
import { parseHand } from '../src/core/cards.js';

// LAYOUTCHECK_HOST/_SHOT_DIR exist only so this script can be pointed at a
// throwaway instance, or a scratch folder, for a sanity check — nobody running
// it normally needs to set them.
const HOST = process.env.LAYOUTCHECK_HOST || 'http://127.0.0.1:8791/';
const SHOT_DIR = process.env.LAYOUTCHECK_SHOT_DIR || path.join(os.tmpdir(), 'layoutcheck-shots');

// "A couple of pixels of breathing room", not zero: two rects that merely
// touch, or sit a whisker apart, still fail. Only real clearance passes.
const CLEARANCE_PX = 2;

// The ten viewports the spec measured the bug at, 1280x720 down to 667x375.
const VIEWPORTS = [
  { label: '1280x720', width: 1280, height: 720 },
  { label: '1180x620', width: 1180, height: 620 },
  { label: '1024x640', width: 1024, height: 640 },
  { label: '1000x531', width: 1000, height: 531 }, // "the tablet in the screenshot"
  { label: '960x540', width: 960, height: 540 },
  { label: '900x500', width: 900, height: 500 },
  { label: '844x390', width: 844, height: 390 },
  { label: '800x480', width: 800, height: 480 },
  { label: '740x420', width: 740, height: 420 },
  { label: '667x375', width: 667, height: 375 }, // smallest of the ten, both dimensions
];
const SMALLEST_LABEL = '667x375';

// A modest play (a pair) and the worst case named in the spec (a twelve-card
// aeroplane with wings — three trios, three single wings). Notation is
// parseHand()'s: digits and T/J/Q/K/A, no suits needed since we are not
// validating a game move, only rendering cards.
const HAND_PAIR = '99';
const HAND_AEROPLANE_12 = '333444555678';
// The exact hand section 3 hand-checked to "Aeroplane 7-8 + 2 singles" — the
// longest English felt caption named in the spec. Computed from the real
// classify()/feltLabel(), not hardcoded, so this gate breaks (loudly, in a
// useful way) rather than silently drifting if that function's wording ever
// changes.
const HAND_LONGEST_LABEL = '77788845';

function computeLabel(hand) {
  const cards = parseHand(hand);
  return feltLabel(classify(cards), cards, 'en');
}
const AEROPLANE_12_LABEL = computeLabel(HAND_AEROPLANE_12);
const LONGEST_LABEL = computeLabel(HAND_LONGEST_LABEL);

async function reachLobby(page) {
  await page.goto(HOST, { waitUntil: 'load' });
  await page.waitForSelector('button.tile');
  await page.click('button.tile');
  await page.click('.tiles button.tile:nth-child(1)');
  await page.waitForSelector('.lobby:not([disabled])');
}

/**
 * Seat the human at a table and freeze it. `.lobby:not([disabled])` may match
 * more than one stake tile, so this clicks the first the same way the DOM
 * itself would (`querySelector`), not Playwright's own (strict-mode) `.click`.
 *
 * The bot loop (SoloGame.drive()) keeps calling view.update() on its own timer
 * even after we start injecting fake plays, and update() rebuilds exactly the
 * classes and text this gate reads (renderPlays() resets `.play__name` and
 * `is-empty` on every call, trickPlays or not). Racing it would make this gate
 * flaky for a reason that has nothing to do with the layout under test, so
 * `window.cardGames.controller` (main.js's one global, `app`) is stopped and
 * its view's update() is neutered the moment the table exists — the DOM is
 * then ours alone for the rest of this viewport.
 */
async function reachAndFreezeTable(page) {
  await reachLobby(page);
  await page.evaluate(() => document.querySelector('.lobby:not([disabled])').click());
  // 'attached', not the default 'visible': the zone is genuinely empty (no
  // cards, opacity 0 while `is-empty`) until this gate injects into it, so it
  // never satisfies Playwright's own visibility check.
  await page.waitForSelector('.play--left .play__cards', { state: 'attached' });
  await page.waitForSelector('.seat--left .seat__backs .card');
  await page.evaluate(() => {
    const app = window.cardGames;
    if (app?.controller) {
      app.controller.stopped = true;
      if (app.controller.view) app.controller.view.update = () => {};
    }
    const panel = document.querySelector('.bid-panel');
    if (panel) { panel.hidden = true; panel.style.display = 'none'; }
  });
}

/**
 * Paint a played combo straight into a landing zone, the same way
 * TableView.paintZone() would (sorted cards, cardElement(), the --i stagger
 * variable) — so the layout this gate measures is pixel-for-pixel what a real
 * trick produces, without needing a bot to actually play that exact combo.
 * Runs in the page; no closure over outer variables since page.evaluate ships
 * it into an isolated realm.
 */
async function injectPlays(page, handsBySlot, labelsBySlot = {}) {
  await page.evaluate(async ({ handsBySlot, labelsBySlot }) => {
    const cardart = await import('/src/ui/cardart.js');
    const cardsMod = await import('/src/core/cards.js');
    for (const slot of ['left', 'right', 'self']) {
      const hand = handsBySlot[slot];
      if (!hand) continue;
      const zone = document.querySelector(`.play--${slot}`);
      const holder = zone.querySelector('.play__cards');
      const nameEl = zone.querySelector('.play__name');
      holder.innerHTML = '';
      const cards = cardsMod.sortCards(cardsMod.parseHand(hand));
      cards.forEach((card, i) => {
        const node = cardart.cardElement(card);
        node.style.setProperty('--i', String(i));
        holder.append(node);
      });
      zone.classList.remove('is-empty');
      zone.classList.add('is-standing');
      zone.dataset.key = 'layoutcheck'; // belt-and-suspenders: nothing should repaint this, but if it did, this would look "unchanged"
      nameEl.textContent = labelsBySlot[slot] ?? '';
    }
  }, { handsBySlot, labelsBySlot });
}

/** Runs in the page. Every rect this gate reasons about, read in one pass. */
function measurePage() {
  const rectOf = (sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  return {
    felt: rectOf('.felt'),
    hud: rectOf('.hud'),
    hand: rectOf('.hand'),
    seatLeft: rectOf('.seat--left'),
    seatRight: rectOf('.seat--right'),
    bottom: rectOf('.bottom-cards'),
    zones: {
      left: rectOf('.play--left .play__cards'),
      right: rectOf('.play--right .play__cards'),
      self: rectOf('.play--self .play__cards'),
    },
    names: {
      left: rectOf('.play--left .play__name'),
      right: rectOf('.play--right .play__name'),
      self: rectOf('.play--self .play__name'),
    },
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
}

// --- geometry --------------------------------------------------------------

function intersect(a, b) {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

/** How far apart two non-overlapping rects really are (0 if they overlap). */
function gapBetween(a, b) {
  const dx = Math.max(b.left - a.right, a.left - b.right, 0);
  const dy = Math.max(b.top - a.bottom, a.top - b.bottom, 0);
  return dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy);
}

/** Pass requires no overlap AND at least CLEARANCE_PX of real daylight. */
function checkClear(a, b) {
  if (!a || !b) return { pass: true, na: true, overlap: null, gap: null };
  const overlap = intersect(a, b);
  const gap = overlap ? 0 : gapBetween(a, b);
  return { pass: !overlap && gap >= CLEARANCE_PX, overlap, gap };
}

/** The five things a played combo must clear, per the spec's own list. */
function targetsFor(slot, m) {
  const common = [
    { name: "landlord's three", rect: m.bottom },
    { name: 'HUD', rect: m.hud },
    { name: 'hand', rect: m.hand },
  ];
  if (slot === 'left') return [{ name: 'seat--left (beside)', rect: m.seatLeft }, { name: 'seat--right (other seat)', rect: m.seatRight }, ...common];
  if (slot === 'right') return [{ name: 'seat--right (beside)', rect: m.seatRight }, { name: 'seat--left (other seat)', rect: m.seatLeft }, ...common];
  return [{ name: 'seat--left', rect: m.seatLeft }, { name: 'seat--right', rect: m.seatRight }, ...common];
}

function runOverlapChecks(m) {
  const rows = [];
  for (const slot of ['left', 'right', 'self']) {
    const cards = m.zones[slot];
    for (const target of targetsFor(slot, m)) {
      const result = checkClear(cards, target.rect);
      rows.push({ slot, against: target.name, ...result });
    }
  }
  return rows;
}

/** Section 2: "must survive a twelve-card play ... without overflowing the
 * felt horizontally", at 667x375. Checked two ways: the page-wide signal (a
 * horizontal scrollbar would mean *something* spilled) and the specific one
 * the spec is actually about (a zone's own cards spilling past the felt's own
 * left/right edge, which `.table`'s overflow:hidden would silently clip). */
function feltOverflowCheck(m) {
  const pageOverflow = m.scrollWidth > m.innerWidth + 1;
  const zoneOverflows = [];
  if (m.felt) {
    for (const slot of ['left', 'right', 'self']) {
      const cards = m.zones[slot];
      if (!cards) continue;
      const overLeft = m.felt.left - cards.left;
      const overRight = cards.right - m.felt.right;
      if (overLeft > 1 || overRight > 1) zoneOverflows.push({ slot, overLeft, overRight });
    }
  }
  return { pass: !pageOverflow && zoneOverflows.length === 0, pageOverflow, zoneOverflows };
}

/** Section 3: "Longest English label must still fit on the felt at 667x375
 * without wrapping or overflowing its zone." `.play__name` is `white-space:
 * nowrap` and absolutely positioned off its `.play` zone, so "overflowing its
 * zone" cashes out as spilling past the felt itself — the only concrete box
 * there is to overflow. */
function labelFitCheck(m) {
  const rows = [];
  for (const slot of ['left', 'right', 'self']) {
    const name = m.names[slot];
    if (!name || !m.felt) { rows.push({ slot, pass: true, na: true }); continue; }
    const overLeft = m.felt.left - name.left;
    const overRight = name.right - m.felt.right;
    rows.push({ slot, pass: overLeft <= 1 && overRight <= 1, overLeft, overRight });
  }
  return rows;
}

// --- reporting ---------------------------------------------------------

function fmtOverlap(o) {
  return o ? `${Math.round(o.width)}x${Math.round(o.height)}px OVERLAP` : null;
}

function printOverlapRows(rows) {
  let anyFail = false;
  for (const r of rows) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    if (!r.pass) anyFail = true;
    const detail = r.na ? 'n/a (element missing)' : fmtOverlap(r.overlap) ?? `clear, gap=${r.gap.toFixed(1)}px`;
    console.log(`    ${r.slot.padEnd(5)} vs ${r.against.padEnd(26)} [${mark}] ${detail}`);
  }
  return !anyFail;
}

function safe(label) {
  return label.replace(/[^a-z0-9]+/gi, '-');
}

// --- run + report --------------------------------------------------------

async function runViewport(browser, vp, shots) {
  console.log(`\n=== ${vp.label} ===`);
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await context.newPage();
  // dealIn()'s shuffle-and-fly flourish checks prefers-reduced-motion and, if
  // it matches, returns before ever touching the DOM (see TableView.animationsOn).
  // Without this, this gate's own waitForSelector can resolve mid-animation —
  // a card kept its real box the whole time (table.css lays out "hidden"
  // destinations on purpose), so the numbers this gate reads stay correct
  // either way, but the dealer's flying cards sit on top of everything in a
  // screenshot, which is not what a human opening one wants to see.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let pass = true;
  try {
    await reachAndFreezeTable(page);

    // Modest play: a pair, in all three zones at once (a real trick has one
    // play per seat standing together, so that is what is measured).
    await injectPlays(page, { left: HAND_PAIR, right: HAND_PAIR, self: HAND_PAIR }, {});
    const mPair = await page.evaluate(measurePage);
    console.log('  [pair] overlap checks (own cards vs. seats / landlord\'s three / HUD / hand):');
    if (!printOverlapRows(runOverlapChecks(mPair))) pass = false;
    if (shots.pair.has(vp.label)) {
      const file = path.join(SHOT_DIR, `${safe(vp.label)}-pair.png`);
      await page.screenshot({ path: file }).catch(() => {});
      console.log(`    screenshot: ${file}`);
    }

    // Worst case: a twelve-card aeroplane with wings. "An overlap that only
    // shows on long combos is still an overlap."
    await injectPlays(page,
      { left: HAND_AEROPLANE_12, right: HAND_AEROPLANE_12, self: HAND_AEROPLANE_12 },
      { left: AEROPLANE_12_LABEL, right: AEROPLANE_12_LABEL, self: AEROPLANE_12_LABEL });
    const mAero = await page.evaluate(measurePage);
    console.log('  [12-card aeroplane w/ wings] overlap checks:');
    if (!printOverlapRows(runOverlapChecks(mAero))) pass = false;
    const aeroFile = path.join(SHOT_DIR, `${safe(vp.label)}-aeroplane12.png`);
    await page.screenshot({ path: aeroFile }).catch(() => {});
    console.log(`    screenshot: ${aeroFile}`);

    if (vp.label === SMALLEST_LABEL) {
      const overflow = feltOverflowCheck(mAero);
      console.log(`  [12-card, smallest viewport] no horizontal overflow of the felt: ${overflow.pass ? 'PASS' : 'FAIL'}`);
      if (overflow.pageOverflow) console.log(`    page: scrollWidth=${mAero.scrollWidth}px > innerWidth=${mAero.innerWidth}px`);
      for (const z of overflow.zoneOverflows) console.log(`    ${z.slot}: cards spill ${Math.round(Math.max(z.overLeft, 0))}px past the felt's left edge / ${Math.round(Math.max(z.overRight, 0))}px past its right edge`);
      if (!overflow.pass) pass = false;

      // The longest English caption, in its own scenario so the check is not
      // entangled with whichever combo happens to be twelve cards.
      await injectPlays(page,
        { left: HAND_LONGEST_LABEL, right: HAND_LONGEST_LABEL, self: HAND_LONGEST_LABEL },
        { left: LONGEST_LABEL, right: LONGEST_LABEL, self: LONGEST_LABEL });
      const mLabel = await page.evaluate(measurePage);
      const labelRows = labelFitCheck(mLabel);
      console.log(`  [longest label "${LONGEST_LABEL}", smallest viewport] fits inside the felt without overflowing:`);
      for (const r of labelRows) {
        const mark = r.pass ? 'PASS' : 'FAIL';
        const detail = r.na ? 'n/a (caption missing)' : `overLeft=${r.overLeft.toFixed(1)}px overRight=${r.overRight.toFixed(1)}px`;
        console.log(`    ${r.slot.padEnd(5)} [${mark}] ${detail}`);
        if (!r.pass) pass = false;
      }
      const labelFile = path.join(SHOT_DIR, `${safe(vp.label)}-longest-label.png`);
      await page.screenshot({ path: labelFile }).catch(() => {});
      console.log(`    screenshot: ${labelFile}`);
    }

    console.log(`  ${vp.label}: ${pass ? 'PASS' : 'FAIL'}`);
    return { label: vp.label, pass };
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`Host: ${HOST}`);
  console.log(`Screenshots -> ${SHOT_DIR}`);
  console.log(`Longest label under test: "${LONGEST_LABEL}" (from feltLabel(), hand ${HAND_LONGEST_LABEL})`);
  console.log(`Twelve-card worst case: "${AEROPLANE_12_LABEL}" (hand ${HAND_AEROPLANE_12})`);

  const shots = {
    // A screenshot per viewport for every scenario would be dozens of files
    // nobody looks at; these are the ones worth a human's eyes — the spec's
    // own "clean" and "broken" reference points for the modest play, and every
    // viewport for the worst case (added unconditionally above).
    pair: new Set(['1280x720', '1000x531']),
  };

  const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  try {
    for (const vp of VIEWPORTS) results.push(await runViewport(browser, vp, shots));
  } finally {
    await browser.close();
  }

  const allPass = results.every((r) => r.pass);
  console.log('\n=== summary ===');
  for (const r of results) console.log(`  ${r.label}: ${r.pass ? 'PASS' : 'FAIL'}`);
  console.log(allPass ? '\nALL VIEWPORTS PASS.' : '\nLAYOUT FAILURES — see above.');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
