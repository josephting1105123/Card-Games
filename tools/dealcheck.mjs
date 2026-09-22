#!/usr/bin/env node
/**
 * The deal-animation gate. Run by hand (`node tools/dealcheck.mjs`) — never
 * from `npm test`, and never imported from test/, because CI has no browser.
 *
 * This checks the six numbered conditions in the deal spec against whatever
 * `dealIn()` and table.css currently do, by driving a real deal in Chromium
 * and sampling the DOM. It knows nothing about how the animation is built —
 * only the handful of selectors the spec itself names as fixed points
 * (`.dealer`, `.seat--left .seat__backs`, `.seat--right .seat__backs`,
 * `.hand__inner`/`.hand`, `deal-out`, `deal-shuffle`) and the shared `.card`
 * class every card in the app is built from (src/ui/cardart.js). No class
 * name or timing that the spec leaves to the implementation is assumed, so
 * this keeps working whether the fix lands as CSS custom properties, inline
 * styles, or something else entirely — as long as it produces what a player
 * can see.
 */

import pw from '/opt/node22/lib/node_modules/playwright/index.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// DEALCHECK_HOST exists only so this same script can be pointed at a throwaway
// instance for a sanity check (e.g. "does this gate actually fail on the
// pre-fix code?"); nobody running it normally needs to set it.
const HOST = process.env.DEALCHECK_HOST || 'http://127.0.0.1:8791/';
const HARD_TIMEOUT_MS = 4000; // well past the 1400ms budget; a hang should still exit, not wedge the run
const VISIBLE = 0.2; // gate 1's own visibility bar
const REVEAL = 0.5; // "clearly up", used to time each seat's reveal beat for gate 3
const LAND_OPACITY = 0.85; // gate 2's own landing bar
const LAND_DIST_PX = 20; // gate 2's own landing distance
const BUDGET_MIN_MS = 700;
const BUDGET_MAX_MS = 1400;
const ORDER_GAP_MS = 10; // minimum separation to count as "before", not sampling noise
const HANDOVER_TOLERANCE_MS = 60; // a seat may reveal at most this long after its last flyer was last seen
// A "reveal" only counts once the element has actually been seen hidden first
// (opacity <= DIP_BELOW), then crosses back up to REVEAL and stays there for
// SUSTAIN_SAMPLES in a row. Both halves matter: on the unfixed code, the hand,
// each seat's backs and the bid panel are all built visible and only hidden a
// moment later, so the very first sample or two can catch a real, same-tick
// CSS transition fading 1 -> 0 (confirmed with a synchronous in-page .click()
// and same-tick read, so it is genuine browser state, not polling noise) — a
// plain "N samples above threshold" check can still be inside that fade.
// Requiring an observed dip first means a "reveal" only ever means what it
// says: hidden, then shown — and a correct implementation, which really does
// start hidden, satisfies the dip on its very first sample or two anyway.
const DIP_BELOW = 0.1;
const SUSTAIN_SAMPLES = 4; // ~4 rAF frames, i.e. the reveal held for ~65ms, not a one-frame flicker

// Screenshots are for a human to eyeball, not for the gate to reason about, so
// they go wherever a person can find them without this script needing to know
// which session is running it. DEALCHECK_SHOT_DIR overrides the default
// (os.tmpdir()) — pass a scratchpad path to land them there instead.
const SHOT_DIR = process.env.DEALCHECK_SHOT_DIR || path.join(os.tmpdir(), 'dealcheck-shots');

const VIEWPORTS = [
  { label: '844x390 (mobile)', width: 844, height: 390, isMobile: true, hasTouch: true },
  { label: '1280x720 (desktop)', width: 1280, height: 720, isMobile: false, hasTouch: false },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs inside the page. Kept as one self-contained function (no closure over
 * outer variables) because page.evaluate ships it into an isolated realm.
 *
 * Flyers are found by tagging whatever is under `.dealer` the first time it
 * is seen, then looking the tags up document-wide on every later sample —
 * so a flyer that gets removed (individually, or by `.dealer` itself going
 * away) is detected simply by no longer showing up, regardless of how the
 * implementation drops it.
 */
function sampleFrame() {
  const table = document.querySelector('.table');
  const out = {
    flyers: [],
    real: { hand: null, left: null, right: null, bottom: null },
    destinations: null,
    bidPanelOpacity: 0,
  };
  if (!table) return out;

  function effectiveOpacity(node) {
    // The product of the element's own opacity and every ancestor's, up to
    // .table — a card inside a container at opacity 0 is not visible even if
    // its own opacity is 1, which is exactly how today's bug hides things.
    let opacity = 1;
    let el = node;
    while (el) {
      const o = parseFloat(getComputedStyle(el).opacity);
      if (!Number.isNaN(o)) opacity *= o;
      if (el === table) break;
      el = el.parentElement;
    }
    return opacity;
  }

  function center(rect) {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function groupStats(selector) {
    const nodes = [...document.querySelectorAll(selector)];
    let max = 0;
    let visible = 0;
    for (const node of nodes) {
      const o = effectiveOpacity(node);
      if (o > max) max = o;
      if (o >= 0.2) visible++;
    }
    return { max, visible, total: nodes.length };
  }

  // Destinations are laid out even while hidden (the spec says so explicitly),
  // so they can be re-measured on every sample; the last measurement is used,
  // but any of them would do since the containers never move during a deal.
  const leftBacks = document.querySelector('.seat--left .seat__backs');
  const rightBacks = document.querySelector('.seat--right .seat__backs');
  const handInner = document.querySelector('.hand__inner');
  if (leftBacks && rightBacks && handInner) {
    out.destinations = {
      left: center(leftBacks.getBoundingClientRect()),
      right: center(rightBacks.getBoundingClientRect()),
      self: center(handInner.getBoundingClientRect()),
    };
  }

  const dealer = document.querySelector('.dealer');
  if (dealer) {
    const cards = [...dealer.querySelectorAll('.card')];
    if (cards.some((c) => !c.dataset.di)) {
      cards.forEach((c, i) => { if (!c.dataset.di) c.dataset.di = String(i); });
    }
  }
  for (const node of document.querySelectorAll('.card[data-di]')) {
    const c = center(node.getBoundingClientRect());
    out.flyers.push({ i: Number(node.dataset.di), opacity: effectiveOpacity(node), x: c.x, y: c.y });
  }

  out.real.hand = groupStats('.hand__inner .card');
  out.real.left = groupStats('.seat--left .seat__backs .card');
  out.real.right = groupStats('.seat--right .seat__backs .card');
  out.real.bottom = groupStats('.bottom-cards .card');

  const panel = document.querySelector('.bid-panel');
  if (panel && !panel.hidden && getComputedStyle(panel).display !== 'none') {
    out.bidPanelOpacity = effectiveOpacity(panel);
  }

  return out;
}

/** Also runs inside the page. Reads the raw CSSOM so gate 5 needs no DOM at all. */
function keyframesReport() {
  function collect(rules, name, found) {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) collect(rule.cssRules, name, found);
      else if (typeof CSSKeyframesRule !== 'undefined' && rule instanceof CSSKeyframesRule && rule.name === name) found.push(rule);
    }
  }
  function inspect(name) {
    const found = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet; none here, but stay defensive
      collect(rules, name, found);
    }
    if (!found.length) return { exists: false, badProps: [], steps: 0 };
    const badProps = new Set();
    let steps = 0;
    for (const kf of found) {
      for (const step of kf.cssRules) {
        steps++;
        for (let i = 0; i < step.style.length; i++) {
          const prop = step.style.item(i);
          if (prop !== 'transform' && prop !== 'opacity') badProps.add(prop);
        }
      }
    }
    return { exists: true, badProps: [...badProps], steps };
  }
  return { 'deal-out': inspect('deal-out'), 'deal-shuffle': inspect('deal-shuffle') };
}

async function reachLobby(page) {
  await page.goto(HOST, { waitUntil: 'load' });
  await page.waitForSelector('button.tile');
  await page.click('button.tile');
  await page.click('.tiles button.tile:nth-child(1)');
  await page.waitForSelector('.lobby:not([disabled])');
}

/**
 * One deal, sampled from inside the page.
 *
 * The loop runs in the page on requestAnimationFrame and the clock is the
 * page's own, so nothing this script costs lands in the numbers the gates
 * read. It used to poll across the process boundary every 30ms and take
 * screenshots in the same loop; both showed up as time. Measured against an
 * in-page rAF trace, that put the bid panel 260ms later than it really
 * arrives, which is enough on its own to fail the budget gate on a correct
 * implementation. An instrument that reports its own cost as the thing being
 * measured is worse than no instrument.
 */
async function driveDeal(page) {
  const result = await page.evaluate(async ({ src, cfg }) => {
    const sampleFrame = new Function(`return (${src})`)();
    const samples = [];
    let bidPanelAt = null;
    let streak = 0;
    let streakStart = null;
    let sawDip = false;

    const t0 = performance.now();
    document.querySelector('.lobby:not([disabled])').click();

    await new Promise((done) => {
      const tick = () => {
        const t = Math.round(performance.now() - t0);
        const snap = sampleFrame();
        samples.push({ t, ...snap });

        if (snap.bidPanelOpacity <= cfg.dipBelow) sawDip = true;
        if (sawDip && snap.bidPanelOpacity >= cfg.reveal) {
          if (streak === 0) streakStart = t;
          streak++;
        } else {
          streak = 0;
          streakStart = null;
        }
        if (streak >= cfg.sustain) { bidPanelAt = streakStart; return done(); }
        if (t > cfg.timeout) return done();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    return { samples, bidPanelAt };
  }, {
    src: sampleFrame.toString(),
    cfg: { dipBelow: DIP_BELOW, reveal: REVEAL, sustain: SUSTAIN_SAMPLES, timeout: HARD_TIMEOUT_MS },
  });

  return result;
}

/**
 * A second deal, for the human. These frames are eyeballed, never measured, so
 * the screenshot cost sits outside every timing the gates read.
 */
async function captureShots(page, label) {
  const shotTimes = [150, 400, 700, 1000];
  const screenshots = [];
  await reachLobby(page);
  const t0 = Date.now();
  await page.click('.lobby:not([disabled])');
  for (const st of shotTimes) {
    const wait = st - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    const file = path.join(SHOT_DIR, `${safe(label)}-t${st}.png`);
    await page.screenshot({ path: file }).catch(() => {});
    screenshots.push(file);
  }
  await sleep(600);
  const finalFile = path.join(SHOT_DIR, `${safe(label)}-final.png`);
  await page.screenshot({ path: finalFile }).catch(() => {});
  screenshots.push(finalFile);
  return screenshots;
}

function safe(label) {
  return label.replace(/[^a-z0-9]+/gi, '-');
}

function printTrace(samples) {
  console.log('  t(ms)  flyers  real  phase');
  for (const s of samples) {
    const visibleFlyers = s.flyers.filter((f) => f.opacity >= VISIBLE).length;
    const realGroups = ['hand', 'left', 'right', 'bottom'];
    const visibleReal = realGroups.reduce((sum, k) => sum + (s.real[k]?.visible ?? 0), 0);
    let phase;
    if (s.bidPanelOpacity >= REVEAL) phase = 'bid-panel up';
    else if (visibleFlyers === 0 && visibleReal === 0) phase = 'BLANK';
    else if (visibleFlyers > 0 && visibleReal === 0) phase = 'flying';
    else if (visibleFlyers > 0 && visibleReal > 0) phase = 'handover';
    else phase = 'revealed';
    console.log(`  ${String(s.t).padStart(5)}  ${String(visibleFlyers).padStart(6)}  ${String(visibleReal).padStart(4)}  ${phase}`);
  }
}

// --- the six gates -----------------------------------------------------

function gate1_noDeadFrame(samples) {
  const dead = [];
  for (const s of samples) {
    const maxFlyer = s.flyers.reduce((m, f) => Math.max(m, f.opacity), 0);
    const maxReal = Math.max(s.real.hand?.max ?? 0, s.real.left?.max ?? 0, s.real.right?.max ?? 0, s.real.bottom?.max ?? 0);
    if (maxFlyer < VISIBLE && maxReal < VISIBLE) dead.push({ t: s.t, maxFlyer, maxReal });
  }
  return { pass: dead.length === 0, dead };
}

function landingByFlyer(samples) {
  const lastSeen = new Map();
  let destinations = null;
  for (const s of samples) {
    if (s.destinations) destinations = s.destinations;
    for (const f of s.flyers) lastSeen.set(f.i, { opacity: f.opacity, x: f.x, y: f.y, t: s.t });
  }
  return { lastSeen, destinations };
}

const SEAT_OF = ['left', 'right', 'self']; // dealing order per spec item 4: left -> right -> you, three times round

/**
 * First genuine reveal of a value read off each sample by `getValue`: it must
 * actually dip to <= DIP_BELOW at some point, then cross back up to >= REVEAL
 * and hold for SUSTAIN_SAMPLES in a row. Mirrors the live bid-panel loop in
 * driveDeal — same dip-then-sustain reasoning is in the comment on DIP_BELOW.
 * A run still open at the last sample counts too, since nothing later
 * contradicted it.
 */
function firstGenuineReveal(samples, getValue) {
  let sawDip = false;
  let streak = 0;
  let streakStart = null;
  for (const s of samples) {
    const v = getValue(s);
    if (v <= DIP_BELOW) sawDip = true;
    if (sawDip && v >= REVEAL) {
      if (streak === 0) streakStart = s.t;
      streak++;
      if (streak >= SUSTAIN_SAMPLES) return streakStart;
    } else {
      streak = 0;
      streakStart = null;
    }
  }
  return streak > 0 ? streakStart : null;
}

function gate2_cardsLand(samples, landing) {
  const { lastSeen, destinations } = landing;
  const results = [...lastSeen.entries()].sort((a, b) => a[0] - b[0]).map(([i, rec]) => {
    const seat = SEAT_OF[i % 3];
    const dest = destinations?.[seat];
    const dist = dest ? Math.hypot(rec.x - dest.x, rec.y - dest.y) : Infinity;
    return { i, seat, opacity: rec.opacity, dist, ok: rec.opacity >= LAND_OPACITY && dist <= LAND_DIST_PX, t: rec.t };
  });
  return { pass: results.length > 0 && results.every((r) => r.ok), results };
}

function gate3_order(samples, landing) {
  const firstReveal = (key) => firstGenuineReveal(samples, (s) => s.real[key]?.max ?? 0);
  const reveal = { left: firstReveal('left'), right: firstReveal('right'), self: firstReveal('hand') };
  const lastFlyerIdx = { left: 6, right: 7, self: 8 }; // each seat's third and final card, in round-robin order
  const notes = [];
  let pass = true;

  if (reveal.left == null || reveal.right == null || reveal.self == null) {
    pass = false;
    notes.push(`a seat never revealed (left=${reveal.left}, right=${reveal.right}, self=${reveal.self})`);
  } else {
    if (!(reveal.right - reveal.left >= ORDER_GAP_MS && reveal.self - reveal.right >= ORDER_GAP_MS)) {
      pass = false;
      notes.push(`seats did not reveal strictly in deal order: left=${reveal.left}ms, right=${reveal.right}ms, self=${reveal.self}ms`);
    }
    for (const [seat, idx] of Object.entries(lastFlyerIdx)) {
      const rec = landing.lastSeen.get(idx);
      if (!rec) { pass = false; notes.push(`flyer #${idx} (${seat}'s last card) was never observed`); continue; }
      if (reveal[seat] > rec.t + HANDOVER_TOLERANCE_MS) {
        pass = false;
        notes.push(`${seat} revealed at ${reveal[seat]}ms, more than ${HANDOVER_TOLERANCE_MS}ms after its last flyer (#${idx}) was last seen at ${rec.t}ms — a gap`);
      }
    }
  }
  return { pass, reveal, notes };
}

function gate4_budget(bidPanelAt) {
  const pass = bidPanelAt != null && bidPanelAt >= BUDGET_MIN_MS && bidPanelAt <= BUDGET_MAX_MS;
  return { pass, bidPanelAt };
}

function gate5_compositorOnly(kfReport) {
  const notes = [];
  let pass = true;
  for (const [name, data] of Object.entries(kfReport)) {
    if (!data.exists) { pass = false; notes.push(`@keyframes ${name} not found`); continue; }
    if (data.badProps.length) { pass = false; notes.push(`@keyframes ${name} animates ${data.badProps.join(', ')}, not just transform/opacity`); }
  }
  return { pass, notes };
}

// --- run + report --------------------------------------------------------

async function runViewport(browser, vp) {
  console.log(`\n=== ${vp.label} ===`);
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
  });
  const page = await context.newPage();
  try {
    await reachLobby(page);
    const kfReport = await page.evaluate(keyframesReport);
    const { samples, bidPanelAt } = await driveDeal(page);
    const screenshots = await captureShots(page, vp.label);

    printTrace(samples);

    const landing = landingByFlyer(samples);
    const g1 = gate1_noDeadFrame(samples);
    const g2 = gate2_cardsLand(samples, landing);
    const g3 = gate3_order(samples, landing);
    const g4 = gate4_budget(bidPanelAt);
    const g5 = gate5_compositorOnly(kfReport);

    console.log(`\n  gate 1 (no dead frame): ${g1.pass ? 'PASS' : 'FAIL'}`);
    if (!g1.pass) for (const d of g1.dead) console.log(`    t=${d.t}ms: max flyer opacity=${d.maxFlyer.toFixed(3)}, max real-card opacity=${d.maxReal.toFixed(3)} — nothing visible`);
    else console.log(`    every one of ${samples.length} samples had a card at effective opacity >= ${VISIBLE}`);

    console.log(`  gate 2 (cards land): ${g2.pass ? 'PASS' : 'FAIL'}`);
    for (const r of g2.results) {
      const mark = r.ok ? 'ok' : 'BAD';
      console.log(`    flyer #${r.i} -> ${r.seat}: last opacity=${r.opacity.toFixed(3)} (need >=${LAND_OPACITY}), landing dist=${r.dist.toFixed(1)}px (need <=${LAND_DIST_PX}px) [${mark}]`);
    }
    if (!g2.results.length) console.log('    no flyers were ever observed');

    console.log(`  gate 3 (order): ${g3.pass ? 'PASS' : 'FAIL'}`);
    console.log(`    reveal times: left=${g3.reveal.left}ms, right=${g3.reveal.right}ms, self=${g3.reveal.self}ms`);
    for (const n of g3.notes) console.log(`    - ${n}`);

    console.log(`  gate 4 (budget 700-1400ms): ${g4.pass ? 'PASS' : 'FAIL'}`);
    console.log(`    click to bid panel: ${g4.bidPanelAt == null ? 'never appeared within ' + HARD_TIMEOUT_MS + 'ms' : g4.bidPanelAt + 'ms'}`);

    console.log(`  gate 5 (compositor only): ${g5.pass ? 'PASS' : 'FAIL'}`);
    for (const [name, data] of Object.entries(kfReport)) {
      console.log(`    @keyframes ${name}: ${data.exists ? `${data.steps} step(s), properties = ${data.badProps.length ? '[BAD] ' + data.badProps.join(', ') + ' (+transform/opacity)' : 'transform, opacity only'}` : 'MISSING'}`);
    }

    console.log('\n  screenshots:');
    for (const f of screenshots) console.log(`    ${f}`);

    const pass = g1.pass && g2.pass && g3.pass && g4.pass && g5.pass;
    return { pass, label: vp.label };
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`Screenshots -> ${SHOT_DIR}`);

  const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  try {
    for (const vp of VIEWPORTS) results.push(await runViewport(browser, vp));
  } finally {
    await browser.close();
  }

  const allPass = results.every((r) => r.pass); // gate 6: both viewports have to pass everything
  console.log('\n=== summary ===');
  for (const r of results) console.log(`  ${r.label}: ${r.pass ? 'PASS' : 'FAIL'}`);
  console.log(allPass ? '\nALL GATES PASS at both viewports.' : '\nGATE FAILURES — see above.');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
