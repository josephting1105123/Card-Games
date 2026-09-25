/**
 * Card faces and backs, drawn as SVG at run time. No image files, so the whole
 * deck installs offline and stays crisp at any size.
 *
 * House style: glossy black stock, a thin gold (or rose-gold, on the red
 * suits) inner frame, small serif indices top-left/bottom-right, ornate
 * flourished suit shapes centred on the spot cards and blown large on the
 * courts and ace, and an original gold art-deco back. Dou Di Zhu's "bold"
 * style below takes the same black-and-gold palette but keeps its own
 * oversized, high-contrast layout — colours only, nothing else changes.
 * Suit shapes and the ornaments live in one hidden <svg> of <symbol>
 * definitions that every card references with <use>, which keeps a
 * twenty-card fan cheap to build and repaint.
 */

import { JOKER_COLOUR, RANK_MIN, RANK_JOKER_BIG, RANK_TWO, SUIT_COLOUR, SUIT_SYMBOL, cardFromId, isJoker, rankIndex, rankLabel } from '../core/cards.js';

const VB_W = 100;
const VB_H = 140;
const DEFS_ID = 'cg-card-defs';

const PIPS = {
  spade: 'M50 6C30 28 11 43 11 60c0 14 11 23 23 23 7 0 13-3 16-8-3 11-8 18-17 22h34c-9-4-14-11-17-22 3 5 9 8 16 8 12 0 23-9 23-23C89 43 70 28 50 6z',
  heart: 'M50 94C19 69 7 53 7 36 7 19 19 8 32 8c9 0 15 5 18 12 3-7 9-12 18-12 13 0 25 11 25 28 0 17-12 33-43 58z',
  diamond: 'M50 4 92 50 50 96 8 50z',
  club: 'M50 6c-11 0-19 9-19 20 0 4 1 8 3 11-3-2-7-4-12-4C11 33 3 42 3 53s8 20 19 20c10 0 18-7 20-16-1 12-5 24-12 35h40c-7-11-11-23-12-35 2 9 10 16 20 16 11 0 19-9 19-20s-8-20-19-20c-5 0-9 2-12 4 2-3 3-7 3-11 0-11-8-20-19-20z',
};

/** A small comma/paisley curl, reused (mirrored, rotated, rescaled) as the
 * "small curled finials" the ornate suits are drawn with — one shape, many
 * instances, rather than hand-drawing a curl per suit per corner. */
const CURL = 'M10 2C15 2 18 6 17 11 16 15 11 18 7 16 4 14 4 10 7 9 9 8 11 9 11 11 11 12 10 13 9 12';

function curlUse(x, y, rot, scale, mirror) {
  const t = `translate(${x} ${y}) rotate(${rot}) scale(${(mirror ? -1 : 1) * scale} ${scale})`;
  return `<use href="#cg-curl" x="-10" y="-10" width="20" height="20" transform="${t}"/>`;
}

/** Ornate suit bodies: the plain PIPS outline plus a few curled finials at
 * the tips, in the reference's spirit ("flourished, with small curled
 * finials, not the plain pip") without redrawing the whole silhouette. */
const ORNATE_FINIALS = {
  spade: [curlUse(50, 10, -100, 0.55, false), curlUse(50, 10, 100, 0.55, true),
    curlUse(31, 83, 40, 0.5, false), curlUse(69, 83, 140, 0.5, true)],
  heart: [curlUse(21, 15, -20, 0.55, false), curlUse(79, 15, 200, 0.55, true),
    curlUse(50, 88, 90, 0.5, false)],
  diamond: [curlUse(50, 4, -90, 0.5, false), curlUse(92, 50, 0, 0.5, false),
    curlUse(50, 96, 90, 0.5, false), curlUse(8, 50, 180, 0.5, false)],
  club: [curlUse(50, 8, -100, 0.5, false), curlUse(50, 8, 100, 0.5, true),
    curlUse(9, 51, 200, 0.48, false), curlUse(91, 51, -20, 0.48, true),
    curlUse(34, 88, 60, 0.45, false), curlUse(66, 88, 120, 0.45, true)],
};

function ornatePipBody(suit) {
  return `<path d="${PIPS[suit]}"/>${ORNATE_FINIALS[suit].join('')}`;
}

/** Standard spot-card pip layouts. x, y in fractions of the face; r = rotated. */
const LAYOUTS = {
  1: [[0.5, 0.5, 1.7]],
  2: [[0.5, 0.235], [0.5, 0.765, 1, true]],
  3: [[0.5, 0.235], [0.5, 0.5], [0.5, 0.765, 1, true]],
  4: [[0.3, 0.235], [0.7, 0.235], [0.3, 0.765, 1, true], [0.7, 0.765, 1, true]],
  5: [[0.3, 0.235], [0.7, 0.235], [0.5, 0.5], [0.3, 0.765, 1, true], [0.7, 0.765, 1, true]],
  6: [[0.3, 0.235], [0.7, 0.235], [0.3, 0.5], [0.7, 0.5], [0.3, 0.765, 1, true], [0.7, 0.765, 1, true]],
  7: [[0.3, 0.235], [0.7, 0.235], [0.5, 0.3675], [0.3, 0.5], [0.7, 0.5], [0.3, 0.765, 1, true], [0.7, 0.765, 1, true]],
  8: [[0.3, 0.235], [0.7, 0.235], [0.5, 0.3675], [0.3, 0.5], [0.7, 0.5], [0.5, 0.6325, 1, true], [0.3, 0.765, 1, true], [0.7, 0.765, 1, true]],
  9: [[0.3, 0.215], [0.7, 0.215], [0.3, 0.405], [0.7, 0.405], [0.5, 0.5], [0.3, 0.595, 1, true], [0.7, 0.595, 1, true], [0.3, 0.785, 1, true], [0.7, 0.785, 1, true]],
  10: [[0.3, 0.215], [0.7, 0.215], [0.5, 0.31], [0.3, 0.405], [0.7, 0.405], [0.3, 0.595, 1, true], [0.7, 0.595, 1, true], [0.5, 0.69, 1, true], [0.3, 0.785, 1, true], [0.7, 0.785, 1, true]],
};

/* ==========================================================================
 * Shared black-and-gold palette. One copy of these gradients and shapes,
 * defined in the default sheet (installCardDefs, below) and cross-referenced
 * by the bold sheet exactly the way the bold style already cross-references
 * the plain PIPS symbols — installBoldCardDefs() guarantees the default
 * sheet exists first, so the id="cg-..." references below always resolve
 * regardless of which style a table asks for first.
 * ========================================================================== */

function sharedGoldDefs() {
  return `
    <linearGradient id="cg-face-black" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--face-top)"/>
      <stop offset="1" style="stop-color:var(--face-bottom)"/>
    </linearGradient>
    <clipPath id="cg-face-clip"><rect x="0.75" y="0.75" width="${VB_W - 1.5}" height="${VB_H - 1.5}" rx="7"/></clipPath>
    <!-- userSpaceOnUse, not the objectBoundingBox default: a stroked straight
         line (the frame) has a zero-width or zero-height geometric bounding
         box, and a gradient keyed to a degenerate bounding box paints
         nothing at all in every browser — the frame line was invisible for
         exactly this reason. userSpaceOnUse instead resolves against the
         *current* user-unit space, which for every caller here (the card's
         own 100x140 symbol, and every nested 100x100 pip/suit symbol it
         <use>s) starts at (0,0) — so one 0,0-to-100,100 diagonal reads
         correctly as "top-left to bottom-right" everywhere it is applied,
         never divides by a zero-area box, and needs no per-caller variant. -->
    <linearGradient id="cg-gold-index" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">
      <stop offset="0" style="stop-color:var(--gold-ink-1)"/>
      <stop offset="1" style="stop-color:var(--gold-ink-2)"/>
    </linearGradient>
    <linearGradient id="cg-rose-index" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">
      <stop offset="0" style="stop-color:var(--rose-ink-1)"/>
      <stop offset="1" style="stop-color:var(--rose-ink-2)"/>
    </linearGradient>
    <linearGradient id="cg-gold-ink" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">
      <stop offset="0" style="stop-color:var(--gold-ink-1)"/>
      <stop offset="0.55" style="stop-color:var(--gold-ink-2)"/>
      <stop offset="1" style="stop-color:var(--gold-ink-3)"/>
    </linearGradient>
    <linearGradient id="cg-rose-ink" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">
      <stop offset="0" style="stop-color:var(--rose-ink-1)"/>
      <stop offset="0.55" style="stop-color:var(--rose-ink-2)"/>
      <stop offset="1" style="stop-color:var(--rose-ink-3)"/>
    </linearGradient>
    <linearGradient id="cg-silver-ink" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">
      <stop offset="0" style="stop-color:var(--joker-silver-1)"/>
      <stop offset="1" style="stop-color:var(--joker-silver-2)"/>
    </linearGradient>
    <symbol id="cg-curl" viewBox="0 0 20 20"><path d="${CURL}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
    <symbol id="cg-crown" viewBox="0 0 100 60">
      <path d="M8 52 14 14 30 34 50 8 70 34 86 14 92 52z" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"/>
      <circle cx="14" cy="11" r="4" fill="currentColor"/><circle cx="50" cy="5" r="4.5" fill="currentColor"/><circle cx="86" cy="11" r="4" fill="currentColor"/>
      <path d="M8 52h84" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/>
    </symbol>
    <!-- Back design: a gold border, a repeating scallop/fan band (not the
         reference's lattice — the brief calls for an original pattern), and
         a centred medallion. Self-contained here so both styles' backs
         (cardBackBody, cardBackBoldBody) share one definition. -->
    <radialGradient id="cg-back-medallion" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0" style="stop-color:var(--gold-ink-1)"/>
      <stop offset="1" style="stop-color:var(--gold-ink-3)"/>
    </radialGradient>
    <symbol id="cg-scallop" viewBox="0 0 20 20">
      <path d="M0 20C0 9 9 0 20 0" fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.7"/>
      <path d="M4 20C4 12 12 4 20 4" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.5"/>
    </symbol>`;
}

/** The black face rect plus a faint diagonal sheen across the upper third —
 * one clipped, low-opacity white band, not a filter (transform/opacity only
 * on anything animated elsewhere in this app; this is static, but the same
 * discipline keeps every card cheap to paint). */
function faceBody() {
  return `<rect x="0.75" y="0.75" width="${VB_W - 1.5}" height="${VB_H - 1.5}" rx="7" fill="url(#cg-face-black)" style="stroke:var(--face-edge)" stroke-width="1"/>
    <g clip-path="url(#cg-face-clip)"><polygon points="-10,0 60,0 15,50 -10,50" fill="#ffffff" opacity="0.06"/></g>`;
}

/** Which gradient a card's ink should use. `variant` "index" is the
 * restricted light two-stop gradient (guaranteed >=4.5:1 on the near-black
 * face at any point along it — the full three-stop gradient's darkest stop
 * does not clear 4.5:1, so small text never uses it); "ink" is the full
 * decorative gradient, used only on shapes big enough that a darker patch
 * within them is not a legibility problem. */
function inkUrl(card, variant) {
  if (isJoker(card)) {
    const big = card.rank === RANK_JOKER_BIG;
    // The big joker reads as the deck's red suits (JOKER_COLOUR marks it
    // 'red'), not gold — same rose-gold gradients hearts/diamonds use. The
    // small joker stays the neutral silver/grey it always was.
    return big ? `url(#cg-rose-${variant})` : 'url(#cg-silver-ink)';
  }
  const family = SUIT_COLOUR[card.suit] === 'black' ? 'gold' : 'rose';
  return `url(#cg-${family}-${variant})`;
}

/** The thin inner frame, inset ~7%, broken at the top-left and bottom-right
 * corners where the indices sit — drawn as three open sides plus two short
 * stubs rather than a closed rounded rect, so there is no seam to hide. */
function brokenFrame(ink, gapTLx, gapTLy, gapBRx, gapBRy) {
  const x0 = 7, y0 = 9.8, x1 = VB_W - 7, y1 = VB_H - 9.8;
  return `<g fill="none" stroke="${ink}" stroke-width="0.8" opacity="0.9" stroke-linecap="round">
    <path d="M ${(x0 + gapTLx).toFixed(1)} ${y0} L ${x1} ${y0}"/>
    <path d="M ${x1} ${y0} L ${x1} ${(y1 - gapBRy).toFixed(1)}"/>
    <path d="M ${(x1 - gapBRx).toFixed(1)} ${y1} L ${x0} ${y1}"/>
    <path d="M ${x0} ${y1} L ${x0} ${(y0 + gapTLy).toFixed(1)}"/>
  </g>`;
}

/** Small serif corner index: rank above suit, ~15% of card height, mirrored
 * at the opposite corner by rotating the same markup 180deg about the card's
 * centre — the letters and figures both stay in the deck's own EB Garamond
 * (only the bold style's 2-10 get custom digit paths; see below). */
function cornerIndexDefault(card, flipped) {
  const label = rankIndex(card.rank);
  const symbol = SUIT_SYMBOL[card.suit];
  const rot = flipped ? ` transform="rotate(180 ${VB_W / 2} ${VB_H / 2})"` : '';
  const fontSize = label.length > 1 ? 15.5 : 19;
  return `<g${rot} fill="${inkUrl(card, 'index')}">
    <text x="12" y="23" font-size="${fontSize}" text-anchor="middle">${label}</text>
    <text x="12" y="34.5" font-size="12" text-anchor="middle">${symbol}</text>
  </g>`;
}

function jokerIndexDefault(card, flipped) {
  const rot = flipped ? ` transform="rotate(180 ${VB_W / 2} ${VB_H / 2})"` : '';
  const letters = 'JOKER'.split('');
  const lines = letters.map((ch, i) => `<text x="9" y="${16 + i * 14.5}" font-size="12.5" text-anchor="middle" font-weight="700">${ch}</text>`).join('');
  return `<g${rot} fill="${inkUrl(card, 'index')}">${lines}</g>`;
}

/** A/J/Q/K: one large ornate suit symbol, ~45% of card width, centred. */
function bigOrnateSuit(card) {
  const size = 45;
  const x = (VB_W - size) / 2;
  const y = (VB_H - size) / 2 + 4;
  return `<use href="#cg-pip-ornate-${card.suit}" x="${x}" y="${y}" width="${size}" height="${size}" fill="${inkUrl(card, 'ink')}"/>`;
}

/** 2-10: the traditional pip positions, drawn in the ornate suit shape. */
function ornatePipLayout(card) {
  const layout = LAYOUTS[card.rank === RANK_TWO ? 2 : card.rank] ?? LAYOUTS[1];
  const ink = inkUrl(card, 'ink');
  const uses = layout.map(([x, y, s = 1, flip = false]) => {
    const size = 17 * s;
    const cx = x * VB_W, cy = y * VB_H;
    const transform = flip ? ` transform="rotate(180 ${cx} ${cy})"` : '';
    return `<use href="#cg-pip-ornate-${card.suit}" x="${(cx - size / 2).toFixed(2)}" y="${(cy - size / 2).toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}"${transform}/>`;
  }).join('');
  return `<g fill="${ink}">${uses}</g>`;
}

/** Jokers: an ornate crown (big) or star (small) centrepiece, flat-coloured
 * via currentColor — a decorative accent, not a legibility-critical glyph,
 * so it does not need the gradient machinery the indices and suits use. */
function jokerCentreDefault(card) {
  const big = card.rank === RANK_JOKER_BIG;
  const tone = big ? 'var(--rose-ink-2)' : 'var(--joker-silver-2)';
  if (big) return `<g style="color:${tone}"><use href="#cg-crown" x="26" y="52" width="48" height="29"/></g>`;
  return `<text x="50" y="82" font-size="50" text-anchor="middle" style="color:${tone}" fill="currentColor">★</text>`;
}

/**
 * Add the shared symbol sheet to the document once. Safe to call repeatedly.
 * @param {Document} [doc]
 */
export function installCardDefs(doc = globalThis.document) {
  if (!doc || doc.getElementById(DEFS_ID)) return;
  const holder = doc.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  holder.innerHTML = `<svg id="${DEFS_ID}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${Object.entries(PIPS).map(([suit, path]) => `<symbol id="cg-pip-${suit}" viewBox="0 0 100 100"><path d="${path}"/></symbol>`).join('\n    ')}
    ${Object.keys(PIPS).map((suit) => `<symbol id="cg-pip-ornate-${suit}" viewBox="0 0 100 100">${ornatePipBody(suit)}</symbol>`).join('\n    ')}
    ${sharedGoldDefs()}
  </defs>
</svg>`;
  // Every card in the deck, and the back, defined once. A card element is then
  // a <use> of one of these: the browser builds the artwork once and instances
  // it, instead of parsing a fresh SVG document per card. Before this, one table
  // update parsed forty-four of them and cost 136ms on a phone.
  const sheet = holder.querySelector('svg');
  const symbols = [];
  for (let id = 0; id < 54; id++) {
    symbols.push(`<symbol id="cg-card-${id}" viewBox="0 0 ${VB_W} ${VB_H}">${cardFaceBody(cardFromId(id))}</symbol>`);
  }
  symbols.push(`<symbol id="cg-card-back" viewBox="0 0 ${VB_W} ${VB_H}">${cardBackBody()}</symbol>`);
  sheet.insertAdjacentHTML('beforeend', symbols.join(''));
  doc.body.appendChild(holder);
}

/** Prototype nodes, cloned per card. Built lazily, once each. */
const protos = new Map();

function cardProto(key, symbolId, extraClass) {
  let proto = protos.get(key);
  if (!proto) {
    proto = globalThis.document.createElement('div');
    proto.className = `card${extraClass ? ` ${extraClass}` : ''}`;
    proto.innerHTML = `<svg class="cg-card-svg" viewBox="0 0 ${VB_W} ${VB_H}" aria-hidden="true">`
      + `<use href="#${symbolId}" width="${VB_W}" height="${VB_H}"/></svg>`;
    protos.set(key, proto);
  }
  return proto;
}

/** The inner markup of a card face (without the <svg> wrapper). */
export function cardFaceBody(card) {
  const colour = isJoker(card) ? JOKER_COLOUR[card.rank] : SUIT_COLOUR[card.suit];
  const jk = isJoker(card);
  const bigCentre = !jk && card.rank >= 11; // J, Q, K, A
  // The index runs roughly x:[3,21] y:[8,42] card units (rank ~15% of card
  // height plus the suit glyph beneath it) — the frame's gap is sized to
  // clear that box, not the other way around.
  const gap = jk ? [18, 44] : [21, 38];
  const frameLine = brokenFrame(inkUrl(card, 'index'), gap[0], gap[1], gap[0], gap[1]);
  const corner = jk ? jokerIndexDefault(card, false) : cornerIndexDefault(card, false);
  const cornerFlip = jk ? jokerIndexDefault(card, true) : cornerIndexDefault(card, true);
  let centre;
  if (jk) centre = jokerCentreDefault(card);
  else if (bigCentre) centre = bigOrnateSuit(card);
  else centre = ornatePipLayout(card);
  return `<g data-colour="${colour}">${faceBody()}${frameLine}${corner}${cornerFlip}${centre}</g>`;
}

/** A complete face as an SVG string. */
export function cardFaceSVG(card) {
  return `<svg class="cg-card-svg" viewBox="0 0 ${VB_W} ${VB_H}" role="img" aria-label="${cardAria(card)}">${cardFaceBody(card)}</svg>`;
}

/** A complete back as an SVG string. */
export function cardBackSVG() {
  return `<svg class="cg-card-svg" viewBox="0 0 ${VB_W} ${VB_H}" role="img" aria-label="Face-down card">${cardBackBody()}</svg>`;
}

/** The back's contents, without the <svg> wrapper: a black field, a gold
 * border inset ~6%, a repeating scallop/fan band around it (original —
 * nothing like the reference's interlocking lattice) and a centred gold
 * medallion. Shared by both styles: cardBackBoldBody() below calls this
 * same function, so opponents' backs, the deck and the landlord's three
 * all read as one deck no matter which table drew them. */
export function cardBackBody() {
  const inset = VB_W * 0.06;
  const insetY = VB_H * 0.06;
  const bx = inset, by = insetY, bw = VB_W - inset * 2, bh = VB_H - insetY * 2;
  const step = bw / 7;
  const scallops = [];
  for (let i = 0; i < 7; i++) {
    const x = bx + i * step;
    scallops.push(`<use href="#cg-scallop" x="${x.toFixed(1)}" y="${by.toFixed(1)}" width="${step.toFixed(1)}" height="${step.toFixed(1)}"/>`);
    scallops.push(`<use href="#cg-scallop" x="${(x + step).toFixed(1)}" y="${(by + bh - step).toFixed(1)}" width="${step.toFixed(1)}" height="${step.toFixed(1)}" transform="rotate(180 ${(x + step / 2).toFixed(1)} ${(by + bh - step / 2).toFixed(1)})"/>`);
  }
  return `
    <rect x="0.75" y="0.75" width="${VB_W - 1.5}" height="${VB_H - 1.5}" rx="7" fill="url(#cg-face-black)" style="stroke:var(--face-edge)" stroke-width="1"/>
    <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="4" fill="none" style="stroke:var(--gold-ink-2)" stroke-width="1.4"/>
    <g style="color:var(--gold-ink-2)" opacity="0.8">${scallops.join('')}</g>
    <circle cx="${VB_W / 2}" cy="${VB_H / 2}" r="17" fill="url(#cg-back-medallion)" opacity="0.92"/>
    <circle cx="${VB_W / 2}" cy="${VB_H / 2}" r="17" fill="none" style="stroke:var(--gold-ink-3)" stroke-width="0.8"/>
    <use href="#cg-pip-ornate-diamond" x="${VB_W / 2 - 10}" y="${VB_H / 2 - 10}" width="20" height="20" style="color:var(--face-bottom)" fill="currentColor" opacity="0.85"/>`;
}

export function cardAria(card) {
  if (isJoker(card)) return rankLabel(card.rank);
  return `${rankLabel(card.rank)} of ${card.suit}s`;
}

/* ==========================================================================
 * The "bold" style — opt-in, Dou Di Zhu table only.
 *
 * Same black-and-gold palette as the default style, but its own layout:
 * one oversized rank+suit index pinned to the top-left 34% of the card so it
 * still reads when the fan shows only a sliver, and one big suit glyph
 * bottom-right. No centre pips, no court art — the complaint this answers is
 * "hard to see", so everything here optimises for legibility at a glance.
 *
 * Built in its own <symbol> sheet, installed lazily on first use, so a table
 * that never asks for `style: 'bold'` (Blackjack, on the default style) never
 * pays for it and the default deck's own symbols are untouched.
 * ========================================================================== */

const BOLD_DEFS_ID = 'cg-card-bold-defs';

/** Numeral ranks (2-10) are drawn as filled, condensed, heavy paths with
 * real curves — not a font (EB Garamond's oldstyle figures wobbled next to
 * each other), and not the seven-segment rects this replaced (those read as
 * hollow wireframe boxes: an "8" with every segment lit IS a hollow
 * rectangle with a bar through it). Every digit is built from a small set of
 * primitives — straight, round-capped "bars" and hand-placed curved
 * "strokes", both offset to a filled outline at a constant stem width — so
 * the whole set shares one weight and one construction technique. J/Q/K/A
 * and the jokers are unaffected: they stay in the deck's own type. */

/** A filled, constant-width, round-capped stroke along a skeleton polyline —
 * the same technique for a straight bar (a 2-point polyline) or a hand-drawn
 * curve (as many points as the curve needs), so every digit's strokes are
 * built the same way. */
function offsetSides(points, stem) {
  const r = stem / 2;
  const left = [], right = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(i - 1, 0)];
    const next = points[Math.min(i + 1, points.length - 1)];
    const dx = next[0] - prev[0], dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;
    left.push([points[i][0] + px * r, points[i][1] + py * r]);
    right.push([points[i][0] - px * r, points[i][1] - py * r]);
  }
  return { left, right };
}

function fnum(n) { return Number(n.toFixed(2)); }

function strokePath(points, stem) {
  const { left, right } = offsetSides(points, stem);
  const r = stem / 2;
  let d = `M ${fnum(right[0][0])} ${fnum(right[0][1])} `;
  d += `A ${fnum(r)} ${fnum(r)} 0 0 0 ${fnum(left[0][0])} ${fnum(left[0][1])} `;
  for (let i = 1; i < left.length; i++) d += `L ${fnum(left[i][0])} ${fnum(left[i][1])} `;
  d += `A ${fnum(r)} ${fnum(r)} 0 0 0 ${fnum(right[right.length - 1][0])} ${fnum(right[right.length - 1][1])} `;
  for (let i = right.length - 2; i >= 0; i--) d += `L ${fnum(right[i][0])} ${fnum(right[i][1])} `;
  return d + 'Z';
}

function ellipsePath(cx, cy, rx, ry, sweep) {
  const x0 = cx + rx, y0 = cy;
  return `M ${fnum(x0)} ${fnum(y0)} A ${fnum(rx)} ${fnum(ry)} 0 1 ${sweep} ${fnum(cx - rx)} ${fnum(cy)} A ${fnum(rx)} ${fnum(ry)} 0 1 ${sweep} ${fnum(x0)} ${fnum(y0)} Z`;
}
/** A full ring (outer minus inner, opposite winding) — "0", and the loops
 * inside "6", "8", "9". Two contours in one path is safe here (unlike
 * concatenating whole *different* strokes together, below): they are always
 * each other's hole, never overlapping a third shape's fill. */
function ringPath(cx, cy, rx, ry, stemX, stemY) {
  return ellipsePath(cx, cy, rx, ry, 1) + ' ' + ellipsePath(cx, cy, rx - stemX, ry - stemY, 0);
}

// Design grid: authored at W0 x H (aspect wider than the final on-card box),
// then every coordinate is condensed by CONDENSE so the *authoring* aspect
// ratio already matches the final embed (20 x 62 card units) — scaling x and
// y by different factors only at <use> time would make horizontal strokes a
// different weight than vertical ones, so the condensing happens once, here,
// to both the coordinates and the stem width together.
// DSTEM0 calibrated against the letters' own stem (measured empirically off
// the rendered "K": ~5.5 card units at the index size) rather than picked by
// eye — the first cut (16) rendered noticeably heavier than the letters, ~27%
// over the spec's 15% tolerance.
// DIGIT_Y/DIGIT_H are pinned to the *letters'* own measured cap line, not
// picked by eye: J/Q/K/A (boldCornerIndex, font-size 50, baseline y=46) put
// their cap-top at y=~12.7 and their baseline at y=~46.2 on the rendered
// card (measured off K and A, the two courts with no descender to skew the
// baseline reading) — a numeral corner built to its own unrelated box
// (the previous 4..66 span) sat almost twice as tall and started 9 units
// higher, so a fanned 9-10-J run visibly jumped size and baseline. Digits
// now occupy the identical band.
const DW0 = 46, DH = 100, DSTEM0 = 13.3;
const DIGIT_W = 20; // card units — matches the original rect-digit box width
const DIGIT_Y = 12.7; // top, card units — the letters' own cap-top
const DIGIT_H = 33.5; // card units — the letters' own cap height (46.2 - 12.7)
const CONDENSE = (DIGIT_W / DIGIT_H * DH) / DW0;
const DW = DW0 * CONDENSE, DSTEM = DSTEM0 * CONDENSE;
const dcx = (x) => x * CONDENSE;
const DIGIT_ONE_W_LOCAL = 14.5; // '1' gets its own narrower box, so "10" stays tight
const DIGIT_ONE_W = DIGIT_ONE_W_LOCAL * (DIGIT_H / DH); // same H-based uniform scale as the other digits
const DIGIT_GAP = 1; // between "1" and "0" when the rank is "10"

function dbar(x0, y0, x1, y1, stem = DSTEM) { return strokePath([[dcx(x0), y0], [dcx(x1), y1]], stem); }
function dcurve(pts, stem = DSTEM) { return strokePath(pts.map(([x, y]) => [dcx(x), y]), stem); }
function dring(cx, cy, rx, ry, stemX, stemY) { return ringPath(dcx(cx), cy, dcx(rx), ry, dcx(stemX), stemY); }

const dxL = DSTEM / 2, dxR = DW - DSTEM / 2, dyT = DSTEM / 2, dyB = DH - DSTEM / 2;

/** Each digit is an array of independent path fragments (own <path>
 * elements at build time) rather than one concatenated multi-subpath "d":
 * concatenating overlapping shapes and trusting nonzero-fill-rule winding to
 * union them silently cancels out wherever two fragments' winding
 * directions disagree — found by hand when a hook overlapping its ring
 * punched a stray hole exactly at the seam. Waypoints are written in the
 * original W0=46 grid; dbar()/dcurve()/dring() condense them. */
const DIGIT_PATHS = {
  0: () => [dring(23, 50, 21, 50, DSTEM0 * 0.875, DSTEM0)],
  2: () => [
    dcurve([[14, 20], [16, 8], [30, 8], [38, 16], [38, 28], [28, 40], [10, 52]]),
    dcurve([[10, 52], [11, 70], [12, 90]], DSTEM * 0.9),
    dbar(4, 92, 42, 92),
  ],
  3: () => [dcurve([
    [12, 14], [26, 8], [38, 18], [38, 34], [28, 46], [16, 50],
    [30, 54], [38, 66], [38, 82], [26, 92], [11, 86],
  ], DSTEM * 0.92)],
  4: () => [
    dbar(38, dyT, 38, dyB),
    dcurve([[30, 8], [8, 62]], DSTEM * 0.95),
    dbar(8, 62, 38, 62),
  ],
  5: () => [
    dcurve([[38, 8], [10, 8], [10, 45]]),
    dcurve([[10, 45], [18, 42], [32, 46], [38, 60], [38, 80], [26, 92], [9, 85]], DSTEM * 0.92),
  ],
  6: () => [
    dcurve([[34, 10], [18, 10], [9, 22], [7, 38], [10, 54]], DSTEM * 0.92),
    dring(23, 70, 19, 30, DSTEM0 * 0.8125, DSTEM0 * 0.9375),
  ],
  7: () => [
    dbar(4, dyT, 42, dyT),
    dcurve([[34, 8], [13, 92]]),
  ],
  8: () => [
    dring(23, 27, 19, 27, DSTEM0 * 0.8125, DSTEM0 * 0.875),
    dring(23, 73, 19, 27, DSTEM0 * 0.8125, DSTEM0 * 0.875),
  ],
  // "9" is "6" rotated 180deg about the digit's own centre (23, 50 in the
  // W0=46/H=100 authoring grid) — literally the same hook-plus-ring joint
  // that already reads correctly for "6", just turned over, rather than a
  // second hand-fitted curve that drifted into an unrecognisable spiral.
  9: () => [
    dring(23, 30, 19, 30, DSTEM0 * 0.8125, DSTEM0 * 0.9375),
    dcurve([[12, 90], [28, 90], [37, 78], [39, 62], [36, 46]], DSTEM * 0.92),
  ],
};

/** Measured bbox (card-local y-units, 0-100 before condensing) of each raw
 * digit above — a handful of the curved digits land a few units short of
 * the exact 0/100 extremes their straight-stroke siblings hit exactly.
 * Every symbol below is wrapped in a translate+scaleY built from this table,
 * so every digit's ink spans exactly the same top and bottom by
 * normalisation rather than by hand-nudging waypoints until they agree. */
const DIGIT_RAW_BBOX = {
  0: [-0.96, 100.96], 2: [-0.31, 100.63], 3: [0.11, 99.89], 4: [0, 100], 5: [-0.63, 99.87],
  6: [2.06, 100], 7: [-0.63, 100.63], 8: [0, 100], 9: [0, 97.94],
};

function digitNormalizeTransform(n) {
  const [top, bottom] = DIGIT_RAW_BBOX[n];
  const scale = 100 / (bottom - top);
  const translate = -top * scale;
  if (Math.abs(scale - 1) < 0.001 && Math.abs(translate) < 0.01) return '';
  return ` transform="translate(0 ${fnum(translate)}) scale(1 ${fnum(scale)})"`;
}

/** The digit <symbol>s (0, 2-9; "1" is a plain bar with its own narrower
 * box), installed once into the bold defs sheet. fill is left unset: each
 * renders inside whichever `<g fill="...">` its <use> sits in — the same
 * handoff the pip symbols already rely on, now carrying a gradient url
 * instead of currentColor. */
function digitDefsMarkup() {
  const digits = Object.entries(DIGIT_PATHS).map(([n, fn]) => {
    const body = fn().map((d) => `<path d="${d}"/>`).join('');
    return `<symbol id="cg-digit-${n}" viewBox="0 0 ${DW} ${DH}"><g${digitNormalizeTransform(n)}>${body}</g></symbol>`;
  }).join('');
  const oneStem = DSTEM;
  const oneX = DIGIT_ONE_W_LOCAL / 2;
  const oneBody = strokePath([[oneX, oneStem / 2], [oneX, DH - oneStem / 2]], oneStem);
  const one = `<symbol id="cg-digit-1" viewBox="0 0 ${DIGIT_ONE_W_LOCAL} ${DH}"><path d="${oneBody}"/></symbol>`;
  return digits + one;
}

/** True for the numeral ranks: 2-10 (this engine's Dou Di Zhu ordering
 * stores "2" as rank 15, above ace, so it isn't caught by a plain range). */
function isNumeralRank(rank) {
  return (rank >= RANK_MIN && rank <= 10) || rank === RANK_TWO;
}

/** "2".."9" is one digit symbol; "10" is the "1" and "0" symbols set tight
 * together — both scaled to the identical DIGIT_H, so top and baseline match
 * every other numeral on the deck. The suit glyph sits a fixed gap under
 * whichever digits were drawn, never overlapping them. */
function boldDigitCorner(card) {
  const label = rankIndex(card.rank); // "2".."9", or "10"
  const glyphs = label === '10' ? ['1', '0'] : [label];
  let x = 2;
  const uses = glyphs.map((d) => {
    const w = d === '1' ? DIGIT_ONE_W : DIGIT_W;
    const markup = `<use href="#cg-digit-${d}" x="${x.toFixed(2)}" y="${DIGIT_Y}" width="${w.toFixed(2)}" height="${DIGIT_H}"/>`;
    x += w + DIGIT_GAP;
    return markup;
  }).join('');
  // Fixed at the same x/PIP_Y/size the letters' suit glyph uses
  // (boldCornerIndex, below) rather than derived from DIGIT_Y/DIGIT_H — the
  // two corners must land the suit glyph in the same spot however tall the
  // rank glyph is.
  return `<g fill="${inkUrl(card, 'index')}">${uses}<use href="#cg-pip-${card.suit}" x="2" y="${PIP_Y}" width="28" height="28"/></g>`;
}

// Letter ranks (J, Q, K, A — "10" is a numeral rank, see isNumeralRank, and
// never reaches this branch) are set in the site's own EB Garamond at 800.
// SVG getBBox() does not return true per-glyph ink extents in every browser
// (it fell back to the font's flat ascent/descent box here, identical for
// every letter), so cap height and descent below come from rendering the
// real glyph and reading back ink pixels instead. K and J's flat serif top
// (no overshoot) is the unambiguous cap-height reference — A's pointed apex
// and Q's round shoulder both overshoot it slightly, by design, same as most
// type. Q's tail is the deepest natural descender of the four (12.68 units
// below the baseline at LETTER_FONT_SIZE), J's next (10.17); A and K barely
// dip past the baseline — see PIP_Y below, which is sized to clear Q's.
const LETTER_CAP_RATIO = 0.655; // K/J's cap-top, in em, above the baseline
// One font-size for every letter rank, chosen so that shared cap height
// equals the digits' own (DIGIT_H) — the same cap line and baseline as
// 2-10, derived from a measurement rather than picked by eye.
const LETTER_FONT_SIZE = DIGIT_H / LETTER_CAP_RATIO; // ~51.15 card units
const LETTER_BASELINE = 46;
// All four letters take this one shared horizontal scale (never stretched,
// only narrowed) so their rendered width matches the condensed digits'
// instead of each letter's own, much wider, natural width — chosen by eye
// off a side-by-side sheet of candidate factors, the same anchored-transform
// mechanism as below. A per-glyph textLength/lengthAdjust compromise was
// tried first and rejected: it rendered Q's overshooting swash tail WIDER
// under a mild requested compression (52.6) than with no compression at all
// (47.2 natural) — a genuine rendering bug for that glyph in this engine.
const LETTER_CONDENSE_SX = 0.72;
// The suit glyph below the rank sits low enough to clear a letter's full,
// unclipped natural descender — moved down (from the digits' original 52)
// by the same amount for every rank alike, digits included, so the pip row
// still lines up across the fan. Q's tail is the deepest natural descender
// among the ranks (12.68 units below the baseline at LETTER_FONT_SIZE, J's
// is 10.21): baseline 46 + 12.68 + a measured 1.5-unit clearance = 60.18
// required ink-top; the pip's own ink starts 1.68 units below its y
// attribute (measured off the rendered symbol), so y = 60.18 - 1.68 rounds
// up to 59 for a touch more margin (~2.0 units clear at render). At y=59 the
// pip's ink still ends around y=86, well inside both the visible strip of a
// hand card at the tightest fan (only the top ~114.8 of 140 units survive
// the 844x330 viewport) and clear of the bottom-right big suit (top at 94).
const PIP_Y = 59;

/** Left-edge index strip: rank glyph, then suit glyph beneath it. The rank
 * glyph is never taller than the digits' own cap height, and the suit glyph
 * (fixed at PIP_Y) sits far enough below the baseline to clear even Q's full,
 * unclipped tail — so both stay legible however tall a fanned card's own
 * corner strip runs. */
function boldCornerIndex(card) {
  if (isNumeralRank(card.rank)) return boldDigitCorner(card);
  const label = rankIndex(card.rank);
  // Anchored at x=2, the glyph's own left edge, so scaling narrows it toward
  // where it already starts — the cap-line top and baseline are untouched,
  // only the width changes.
  const transformAttr = ` transform="translate(2 0) scale(${LETTER_CONDENSE_SX} 1) translate(-2 0)"`;
  return `<g fill="${inkUrl(card, 'index')}">
    <text class="cg-bold-index" x="2" y="${LETTER_BASELINE}" font-size="${LETTER_FONT_SIZE.toFixed(2)}"${transformAttr} font-weight="800" text-anchor="start">${label}</text>
    <use href="#cg-pip-${card.suit}" x="2" y="${PIP_Y}" width="28" height="28"/>
  </g>`;
}

/** Big suit glyph, bottom-right, ~42% of the card's width. */
function boldCornerSuit(card) {
  const size = 42;
  const x = VB_W - size - 4;
  const y = VB_H - size - 4;
  return `<use href="#cg-pip-${card.suit}" x="${x}" y="${y}" width="${size}" height="${size}" fill="${inkUrl(card, 'ink')}"/>`;
}

/** JOKER, one letter per line, stacked down the same top-left strip. */
function boldJokerIndex(card) {
  const letters = 'JOKER'.split('');
  const lines = letters.map((ch, i) => `<text class="cg-bold-index" x="4" y="${22 + i * 20}" font-size="19" font-weight="800" text-anchor="start">${ch}</text>`).join('');
  return `<g fill="${inkUrl(card, 'index')}">${lines}</g>`;
}

/** A big star (small joker) or crown (big joker), bottom-right. */
function boldJokerBottom(card) {
  const big = card.rank === 17;
  const size = 42;
  const x = VB_W - size - 4;
  if (big) {
    const h = size * 0.6;
    return `<g style="color:var(--rose-ink-2)"><use href="#cg-crown" x="${x}" y="${VB_H - h - 6}" width="${size}" height="${h}"/></g>`;
  }
  return `<text x="${x + size / 2}" y="${VB_H - 8}" font-size="${size * 0.85}" text-anchor="middle" style="color:var(--joker-silver-2)" fill="currentColor">★</text>`;
}

/** The bold face's inner markup (without the <svg> wrapper). Same black
 * face and gold/rose-gold ink as the default style; the layout — one
 * oversized top-left index, one big bottom-right suit glyph — is untouched. */
export function cardFaceBoldBody(card) {
  const colour = isJoker(card) ? JOKER_COLOUR[card.rank] : SUIT_COLOUR[card.suit];
  const corner = isJoker(card) ? boldJokerIndex(card) : boldCornerIndex(card);
  const bottom = isJoker(card) ? boldJokerBottom(card) : boldCornerSuit(card);
  // The index runs the top-left ~34% wide, ~72% tall strip; the suit glyph
  // is a 42%-wide box bottom-right — the frame's gaps clear both, leaving
  // only a sliver bottom-left/top-right for the line itself to occupy.
  const frameLine = brokenFrame(inkUrl(card, 'index'), 36, 102, 48, 48);
  return `<g data-colour="${colour}">${faceBody()}${frameLine}${corner}${bottom}</g>`;
}

/** The bold back: identical to the default style's back (see cardBackBody)
 * — one deck, drawn once, read by both tables. */
export function cardBackBoldBody() {
  return cardBackBody();
}

function installBoldCardDefs(doc = globalThis.document) {
  // The bold sheet cross-references the default sheet's shared gradients,
  // the plain pip symbols and the crown/curl symbols by plain "cg-..." id
  // (see sharedGoldDefs) rather than duplicating them — this guarantees
  // that cross-reference resolves regardless of which style a caller reaches
  // for first.
  installCardDefs(doc);
  if (!doc || doc.getElementById(BOLD_DEFS_ID)) return;
  const holder = doc.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  holder.innerHTML = `<svg id="${BOLD_DEFS_ID}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${digitDefsMarkup()}
  </defs>
</svg>`;
  const sheet = holder.querySelector('svg');
  const symbols = [];
  for (let id = 0; id < 54; id++) {
    symbols.push(`<symbol id="cg-card-bold-${id}" viewBox="0 0 ${VB_W} ${VB_H}">${cardFaceBoldBody(cardFromId(id))}</symbol>`);
  }
  symbols.push(`<symbol id="cg-card-bold-back" viewBox="0 0 ${VB_W} ${VB_H}">${cardBackBoldBody()}</symbol>`);
  sheet.insertAdjacentHTML('beforeend', symbols.join(''));
  doc.body.appendChild(holder);
}

/**
 * Build a card element.
 * @param {object|null} card null renders a face-down card
 * @param {{selectable?: boolean, index?: number, faceDown?: boolean, style?: 'bold'}} [opts]
 */
export function cardElement(card, opts = {}) {
  const down = !card || opts.faceDown;
  const bold = opts.style === 'bold';
  if (bold) installBoldCardDefs();
  const colour = down ? '' : isJoker(card) ? JOKER_COLOUR[card.rank] : SUIT_COLOUR[card.suit];
  const key = (down ? 'back' : `${card.id}:${colour}`) + (bold ? ':bold' : '');
  const symbolId = bold
    ? (down ? 'cg-card-bold-back' : `cg-card-bold-${card.id}`)
    : (down ? 'cg-card-back' : `cg-card-${card.id}`);
  const extraClass = bold
    ? (down ? 'card--bold card--bold-down' : `card--bold card--bold-${colour}`)
    : (down ? 'card--down' : `card--${colour}`);
  const el = cardProto(key, symbolId, extraClass).cloneNode(true);

  if (opts.selectable) {
    // A button cannot be cloned from a div prototype, so the interactive case
    // wraps the same artwork rather than reparsing it.
    const button = globalThis.document.createElement('button');
    button.className = el.className;
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.append(...el.childNodes);
    if (!down) {
      button.dataset.cardId = String(card.id);
      button.dataset.rank = String(card.rank);
      button.setAttribute('aria-label', cardAria(card));
    }
    return button;
  }
  if (!down) {
    el.dataset.cardId = String(card.id);
    el.dataset.rank = String(card.rank);
  }
  return el;
}
