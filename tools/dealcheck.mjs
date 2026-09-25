#!/usr/bin/env node
/**
 * The deal-animation gate. Run by hand (`node tools/dealcheck.mjs`) — never
 * from `npm test`, and never imported from test/, because CI has no browser.
 *
 * Gates the spec 3 deal (see CLAUDE.md's task): a shuffle flourish; 51 cards
 * leaving the stack round-robin (left, right, you); your hand landing left to
 * right in a shuffled order; a gather-and-sort once it is full; the last 3
 * cards sliding to the landlord's three; the bid panel; a 3.0-4.5s budget;
 * skip-on-tap; and that nothing is ever destroyed while the real card it
 * stands for is still hidden.
 *
 * Like the spec it gates, this only knows the fixed points the spec itself
 * names: `.dealer`, `.seat--left/.right .seat__backs`, `.hand__inner`,
 * `.bottom-cards`, `.bid-panel`, and the shared `.card` class every card in
 * the app is built from (src/ui/cardart.js) — a face-up card carries
 * `data-card-id`, a face-down one does not, which is how a self flyer is told
 * apart from an opponent's or the landlord's-three's without knowing anything
 * about how dealIn() is implemented internally.
 */

import pw from '/opt/node22/lib/node_modules/playwright/index.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOST = process.env.DEALCHECK_HOST || 'http://127.0.0.1:8791/';
const HARD_TIMEOUT_MS = 6500; // past the 4500ms budget ceiling, so a hang still exits rather than wedging the run
const VISIBLE = 0.5; // "counts as revealed/on-screen" bar for a single card
const REVEAL = 0.9; // "clearly up" bar for the bid panel
const DIP_BELOW = 0.1;
const SUSTAIN_SAMPLES = 4; // ~4 rAF frames held, not a one-frame flicker
const BUDGET_MIN_MS = 3000;
const BUDGET_MAX_MS = 4500;
const SETTLE_TOLERANCE_PX = 3; // left-to-right landing order tolerance, in px
const ORDER_GAP_MS = 15; // minimum separation to count as "before", not sampling noise

const SHOT_DIR = process.env.DEALCHECK_SHOT_DIR || path.join(os.tmpdir(), 'dealcheck-shots');

const VIEWPORTS = [
  { label: '844x390 (mobile)', width: 844, height: 390, isMobile: true, hasTouch: true },
  { label: '1280x720 (desktop)', width: 1280, height: 720, isMobile: false, hasTouch: false },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs inside the page. No closures over outer variables: page.evaluate ships it into an isolated realm. */
function sampleFrame() {
  const table = document.querySelector('.table');
  if (!table) return null;

  function effectiveOpacity(node) {
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
  function visibleCount(sel, bar) {
    return [...document.querySelectorAll(sel)].filter((n) => effectiveOpacity(n) >= bar).length;
  }
  function center(rect) {
    return rect.left + rect.width / 2;
  }

  const selfFlyers = [...document.querySelectorAll('.dealer .card[data-card-id]')].map((n) => ({
    id: n.dataset.cardId,
    x: center(n.getBoundingClientRect()),
    opacity: effectiveOpacity(n),
  }));
  const downFlyers = document.querySelectorAll('.dealer .card:not([data-card-id])').length;
  const handSlots = [...document.querySelectorAll('.hand__inner .card')].map((n) => center(n.getBoundingClientRect()));

  const panel = document.querySelector('.bid-panel');
  const bidPanelOpacity = panel && !panel.hidden && getComputedStyle(panel).display !== 'none' ? effectiveOpacity(panel) : 0;

  return {
    dealerPresent: !!document.querySelector('.dealer'),
    leftVisible: visibleCount('.seat--left .seat__backs .card', 0.5),
    rightVisible: visibleCount('.seat--right .seat__backs .card', 0.5),
    bottomVisible: visibleCount('.bottom-cards .card', 0.5),
    handRealVisible: visibleCount('.hand__inner .card', 0.5),
    selfFlyers,
    downFlyers,
    handSlots,
    bidPanelOpacity,
  };
}

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
      try { rules = sheet.cssRules; } catch { continue; }
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
  return { 'cg-fly': inspect('cg-fly') };
}

async function reachLobby(page) {
  await page.goto(HOST, { waitUntil: 'load' });
  await page.waitForSelector('button.tile');
  await page.click('button.tile');
  await page.click('.tiles button.tile:nth-child(1)');
  await page.waitForSelector('.lobby:not([disabled])');
}

/** One full deal, sampled from inside the page on its own rAF clock. */
async function driveDeal(page) {
  return page.evaluate(async ({ src, cfg }) => {
    const sampleFrame = new Function(`return (${src})`)();
    const samples = [];
    let bidPanelAt = null;
    let streak = 0;
    let streakStart = null;
    let sawDip = false;

    const t0 = performance.now();

    // A hard-timer-equivalent "landed" signal for every flyer, self included:
    // the moment its first flight leg's CSS animation actually completes. A
    // self flyer otherwise only offers a *visual settle* (the ease-out tail
    // creeps within a couple of px of the target well before the animation
    // is technically done), which isn't comparable to an opponent's reveal —
    // that fires on a hard 300ms-after-launch JS timer. animationend is the
    // one signal both kinds of flyer produce on the same terms, so
    // round-robin ordering uses this instead of the settle heuristic.
    // .felt doesn't exist until the click below mounts the table, so this
    // listens on document (always present) rather than requiring it up front.
    const seenFirstLeg = new WeakSet();
    const flightEnds = [];
    document.addEventListener('animationend', (e) => {
      if (e.animationName !== 'cg-fly' || seenFirstLeg.has(e.target)) return;
      seenFirstLeg.add(e.target);
      // x read *inside* the handler, once the end keyframe (rotation back to
      // 0deg included) is the target's computed state — sampling mid-flight
      // via a rotated element's axis-aligned bounding box wobbles as the
      // rotation un-does, which is a measurement artifact, not the card
      // actually moving backwards.
      const r = e.target.getBoundingClientRect();
      flightEnds.push({ t: Math.round(performance.now() - t0), self: e.target.hasAttribute('data-card-id'), x: r.left + r.width / 2 });
    }, true);

    document.querySelector('.lobby:not([disabled])').click();

    await new Promise((done) => {
      const tick = () => {
        const t = Math.round(performance.now() - t0);
        const snap = sampleFrame();
        if (snap) samples.push({ t, ...snap });

        const op = snap?.bidPanelOpacity ?? 0;
        if (op <= cfg.dipBelow) sawDip = true;
        if (sawDip && op >= cfg.reveal) {
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

    return { samples, bidPanelAt, flightEnds };
  }, {
    src: sampleFrame.toString(),
    cfg: { dipBelow: DIP_BELOW, reveal: REVEAL, sustain: SUSTAIN_SAMPLES, timeout: HARD_TIMEOUT_MS },
  });
}

/** A tap mid-deal should collapse straight to the end state within a couple of frames. */
async function driveSkip(page) {
  await reachLobby(page);
  return page.evaluate(async ({ src, cfg }) => {
    const sampleFrame = new Function(`return (${src})`)();
    const t0 = performance.now();
    document.querySelector('.lobby:not([disabled])').click();
    await new Promise((r) => setTimeout(r, cfg.tapAt));

    const felt = document.querySelector('.felt');
    const tTap = performance.now() - t0;
    felt.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

    const samples = [];
    let resolvedAt = null;
    await new Promise((done) => {
      const tick = () => {
        const t = Math.round(performance.now() - t0);
        const snap = sampleFrame();
        samples.push({ t, ...snap });
        const table = document.querySelector('.table');
        if (snap && !table.classList.contains('is-dealing-bid') && snap.bidPanelOpacity >= cfg.reveal) {
          resolvedAt = t;
          return done();
        }
        if (t - tTap > cfg.timeout) return done();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const last = samples[samples.length - 1];
    return {
      tapAtMs: Math.round(tTap),
      resolvedAtMs: resolvedAt,
      skipLatencyMs: resolvedAt != null ? Math.round(resolvedAt - tTap) : null,
      endState: last,
    };
  }, { src: sampleFrame.toString(), cfg: { tapAt: 700, reveal: REVEAL, timeout: 1500 } });
}

async function captureShots(page, label) {
  const shotTimes = [200, 900, 1800, 2600, 3200, 3600, 4000];
  const screenshots = [];
  await reachLobby(page);
  const t0 = Date.now();
  await page.click('.lobby:not([disabled])');
  for (const st of shotTimes) {
    const w = st - (Date.now() - t0);
    if (w > 0) await sleep(w);
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

// --- gates ---------------------------------------------------------------

function gate_budget(bidPanelAt) {
  const pass = bidPanelAt != null && bidPanelAt >= BUDGET_MIN_MS && bidPanelAt <= BUDGET_MAX_MS;
  return { pass, bidPanelAt };
}

function firstAtLeast(samples, key, n) {
  const s = samples.find((s) => (s[key] ?? 0) >= n);
  return s ? s.t : null;
}

/** Earliest animationend of any self flyer's first leg — the hard-timer
 * equivalent of an opponent's reveal, so it is fair to compare against. */
function firstSelfFlightEnd(flightEnds) {
  const selfEnds = (flightEnds ?? []).filter((f) => f.self).map((f) => f.t);
  return selfEnds.length ? Math.min(...selfEnds) : null;
}

function gate_roundRobinOrder(samples, flightEnds) {
  const leftAt = firstAtLeast(samples, 'leftVisible', 1);
  const rightAt = firstAtLeast(samples, 'rightVisible', 1);
  const selfAt = firstSelfFlightEnd(flightEnds);
  const notes = [];
  let pass = true;
  if (leftAt == null || rightAt == null || selfAt == null) {
    pass = false;
    notes.push(`a seat's first landing was never observed (left=${leftAt}, right=${rightAt}, self=${selfAt})`);
  } else {
    if (!(rightAt - leftAt >= ORDER_GAP_MS)) { pass = false; notes.push(`right (${rightAt}ms) did not land strictly after left (${leftAt}ms)`); }
    if (!(selfAt - rightAt >= -ORDER_GAP_MS)) { pass = false; notes.push(`self (${selfAt}ms) landed well before right (${rightAt}ms)`); }
  }
  return { pass, leftAt, rightAt, selfAt, notes };
}

/** Opponent backs must grow one at a time across the deal, not jump from 0 to
 * capacity in one or two frames. */
function gate_opponentCountsRise(samples, key, minSteps) {
  let steps = 0;
  let max = 0;
  let prev = 0;
  let monotonic = true;
  for (const s of samples) {
    const v = s[key] ?? 0;
    if (v > prev) steps++;
    if (v < prev) monotonic = false; // a reveal must never un-reveal
    prev = v;
    if (v > max) max = v;
  }
  return { pass: steps >= minSteps && monotonic && max > 0, steps, max, monotonic };
}

/** Each self flyer's first-leg landing (its `cg-fly` animationend, in launch
 * order) should sit left-to-right across the hand row. animationend, not a
 * bounding-rect settle: the deal-out leg rotates -12deg to 0deg alongside
 * the translate, and an axis-aligned bounding box's centre wobbles as a
 * rotated rect un-rotates, which reads as false backward motion even though
 * the card's actual centre moves in a straight line. */
function gate_selfLandsLeftToRight(flightEnds) {
  const landings = (flightEnds ?? []).filter((f) => f.self).sort((a, b) => a.t - b.t);
  let pass = landings.length >= 10; // most of a 17-card hand should show a clean landing
  const violations = [];
  for (let i = 1; i < landings.length; i++) {
    if (landings[i].x < landings[i - 1].x - SETTLE_TOLERANCE_PX * 2) {
      pass = false;
      violations.push(`card landing at t=${landings[i].t}ms sat left of the one before it (x=${landings[i].x.toFixed(0)} < ${landings[i - 1].x.toFixed(0)})`);
    }
  }
  return { pass, count: landings.length, violations, landings };
}

/** After the round-robin lands, the hand should visibly gather toward a
 * single point, then re-spread — a dip in the flyers' x-spread, then a rise
 * back to roughly what it was. */
function gate_gatherAndSort(samples) {
  const spreads = samples
    .filter((s) => (s.selfFlyers?.length ?? 0) >= 10)
    .map((s) => {
      const xs = s.selfFlyers.map((f) => f.x);
      return { t: s.t, spread: Math.max(...xs) - Math.min(...xs) };
    });
  if (spreads.length < 5) return { pass: false, notes: ['too few samples with a near-full hand to judge the gather'] };
  const preMax = Math.max(...spreads.slice(0, Math.ceil(spreads.length / 2)).map((s) => s.spread));
  const minPoint = spreads.reduce((m, s) => (s.spread < m.spread ? s : m), spreads[0]);
  const afterMin = spreads.filter((s) => s.t > minPoint.t);
  const postMax = afterMin.length ? Math.max(...afterMin.map((s) => s.spread)) : 0;
  const gathered = minPoint.spread <= preMax * 0.35;
  const reSpread = postMax >= preMax * 0.75;
  return {
    pass: gathered && reSpread,
    preMax, gatherSpread: minPoint.spread, gatherAt: minPoint.t, postMax,
    notes: [
      gathered ? `gathered to ${minPoint.spread.toFixed(0)}px at t=${minPoint.t}ms (from a high of ${preMax.toFixed(0)}px)` : `never gathered: spread only fell to ${minPoint.spread.toFixed(0)}px, vs a high of ${preMax.toFixed(0)}px`,
      reSpread ? `re-spread to ${postMax.toFixed(0)}px afterward` : `never re-spread: only reached ${postMax.toFixed(0)}px afterward`,
    ],
  };
}

/** Once revealed, a destination must never go back to hidden — the black-box
 * proxy for "a flyer is never removed while its target is still hidden": if
 * that ever happened, the destination would visibly flicker off. */
function gate_neverUnreveals(samples) {
  const notes = [];
  let pass = true;
  for (const key of ['leftVisible', 'rightVisible', 'bottomVisible', 'handRealVisible']) {
    let prev = 0;
    for (const s of samples) {
      const v = s[key] ?? 0;
      if (v < prev) { pass = false; notes.push(`${key} dropped from ${prev} to ${v} at t=${s.t}ms`); }
      prev = v;
    }
  }
  return { pass, notes };
}

function gate_skip(result) {
  const notes = [];
  let pass = true;
  if (result.skipLatencyMs == null) { pass = false; notes.push('the deal never resolved after the tap'); }
  else if (result.skipLatencyMs > 120) { pass = false; notes.push(`skip took ${result.skipLatencyMs}ms — spec asks for within a frame or two`); }
  const end = result.endState;
  if (!end) { pass = false; notes.push('no end-state sample captured'); }
  else {
    if (end.handRealVisible < 17) { pass = false; notes.push(`hand shows ${end.handRealVisible}/17 real cards after skip`); }
    if (end.dealerPresent) { pass = false; notes.push('the flyer layer is still in the DOM after skip'); }
    if (end.bidPanelOpacity < REVEAL) { pass = false; notes.push(`bid panel opacity is ${end.bidPanelOpacity} after skip`); }
  }
  return { pass, notes, ...result };
}

function gate_compositorOnly(kfReport) {
  const notes = [];
  let pass = true;
  for (const [name, data] of Object.entries(kfReport)) {
    if (!data.exists) { pass = false; notes.push(`@keyframes ${name} not found`); continue; }
    if (data.badProps.length) { pass = false; notes.push(`@keyframes ${name} animates ${data.badProps.join(', ')}, not just transform/opacity`); }
  }
  return { pass, notes };
}

// --- run + report ----------------------------------------------------------

async function runViewport(browser, vp) {
  console.log(`\n=== ${vp.label} ===`);
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
  const page = await context.newPage();
  try {
    await reachLobby(page);
    const kfReport = await page.evaluate(keyframesReport);
    const { samples, bidPanelAt, flightEnds } = await driveDeal(page);

    const g1 = gate_budget(bidPanelAt);
    const g2 = gate_roundRobinOrder(samples, flightEnds);
    const g3l = gate_opponentCountsRise(samples, 'leftVisible', 6);
    const g3r = gate_opponentCountsRise(samples, 'rightVisible', 6);
    const g4 = gate_selfLandsLeftToRight(flightEnds);
    const g5 = gate_gatherAndSort(samples);
    const g6 = gate_neverUnreveals(samples);
    const g7 = gate_compositorOnly(kfReport);

    console.log(`  gate budget (${BUDGET_MIN_MS}-${BUDGET_MAX_MS}ms): ${g1.pass ? 'PASS' : 'FAIL'} — bid panel at ${g1.bidPanelAt}ms`);
    console.log(`  gate round-robin order (left, right, self): ${g2.pass ? 'PASS' : 'FAIL'} — left=${g2.leftAt}ms right=${g2.rightAt}ms self=${g2.selfAt}ms`);
    for (const n of g2.notes) console.log(`    - ${n}`);
    console.log(`  gate left backs rise incrementally: ${g3l.pass ? 'PASS' : 'FAIL'} — ${g3l.steps} distinct rises, max ${g3l.max}, monotonic=${g3l.monotonic}`);
    console.log(`  gate right backs rise incrementally: ${g3r.pass ? 'PASS' : 'FAIL'} — ${g3r.steps} distinct rises, max ${g3r.max}, monotonic=${g3r.monotonic}`);
    console.log(`  gate hand lands left-to-right: ${g4.pass ? 'PASS' : 'FAIL'} — ${g4.count} cards with a clean settle`);
    for (const v of g4.violations) console.log(`    - ${v}`);
    console.log(`  gate gather-and-sort: ${g5.pass ? 'PASS' : 'FAIL'}`);
    for (const n of g5.notes) console.log(`    - ${n}`);
    console.log(`  gate nothing un-reveals: ${g6.pass ? 'PASS' : 'FAIL'}`);
    for (const n of g6.notes) console.log(`    - ${n}`);
    console.log(`  gate compositor-only (transform/opacity): ${g7.pass ? 'PASS' : 'FAIL'}`);
    for (const [name, data] of Object.entries(kfReport)) {
      console.log(`    @keyframes ${name}: ${data.exists ? `${data.steps} step(s), ${data.badProps.length ? 'BAD: ' + data.badProps.join(', ') : 'transform/opacity only'}` : 'MISSING'}`);
    }

    const skipResult = gate_skip(await driveSkip(page));
    console.log(`  gate skip-on-tap: ${skipResult.pass ? 'PASS' : 'FAIL'} — tapped at ${skipResult.tapAtMs}ms, resolved ${skipResult.skipLatencyMs}ms later`);
    for (const n of skipResult.notes) console.log(`    - ${n}`);

    const screenshots = await captureShots(page, vp.label);
    console.log('\n  screenshots:');
    for (const f of screenshots) console.log(`    ${f}`);

    const pass = g1.pass && g2.pass && g3l.pass && g3r.pass && g4.pass && g5.pass && g6.pass && g7.pass && skipResult.pass;
    return { pass, label: vp.label };
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`Screenshots -> ${SHOT_DIR}`);
  console.log(`Host -> ${HOST}`);

  const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  try {
    for (const vp of VIEWPORTS) results.push(await runViewport(browser, vp));
  } finally {
    await browser.close();
  }

  const allPass = results.every((r) => r.pass);
  console.log('\n=== summary ===');
  for (const r of results) console.log(`  ${r.label}: ${r.pass ? 'PASS' : 'FAIL'}`);
  console.log(allPass ? '\nALL GATES PASS at both viewports.' : '\nGATE FAILURES — see above.');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
