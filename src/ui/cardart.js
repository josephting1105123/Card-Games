/**
 * Card faces and backs, drawn as SVG at run time. No image files, so the whole
 * deck installs offline and stays crisp at any size.
 *
 * House style: the Chinese New Year lantern deck. Cream stock with a gold edge
 * and a gold inner rule, a gold cloud scroll in the top-right and bottom-left
 * corners, red and ink suits, and a red or ink paper lantern as the centrepiece
 * of every ace, court and joker (spot cards keep the traditional pip layouts).
 * The back is a deep-red field of gold dragon scales around a gold 龙 medallion.
 * Two index styles share that artwork: the default has a small standard corner
 * index, and the "bold" style below swaps it for an enlarged lantern seal.
 * Every colour comes from a token in tokens.css, read through `style=` rather
 * than a presentation attribute so the custom property resolves inside the
 * <use> shadow tree. Suit shapes live in one hidden <svg> of <symbol>
 * definitions that every card references with <use>, which keeps a twenty-card
 * fan cheap to build and repaint.
 */

import { JOKER_COLOUR, RANK_JOKER_BIG, RANK_TWO, SUIT_COLOUR, cardFromId, isJoker, rankIndex, rankLabel } from '../core/cards.js';

const VB_W = 100;
const VB_H = 140;
const DEFS_ID = 'cg-card-defs';

const PIPS = {
  spade: 'M50 6C30 28 11 43 11 60c0 14 11 23 23 23 7 0 13-3 16-8-3 11-8 18-17 22h34c-9-4-14-11-17-22 3 5 9 8 16 8 12 0 23-9 23-23C89 43 70 28 50 6z',
  heart: 'M50 94C19 69 7 53 7 36 7 19 19 8 32 8c9 0 15 5 18 12 3-7 9-12 18-12 13 0 25 11 25 28 0 17-12 33-43 58z',
  diamond: 'M50 4 92 50 50 96 8 50z',
  club: 'M50 6c-11 0-19 9-19 20 0 4 1 8 3 11-3-2-7-4-12-4C11 33 3 42 3 53s8 20 19 20c10 0 18-7 20-16-1 12-5 24-12 35h40c-7-11-11-23-12-35 2 9 10 16 20 16 11 0 19-9 19-20s-8-20-19-20c-5 0-9 2-12 4 2-3 3-7 3-11 0-11-8-20-19-20z',
};

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

/** Half a turn about the card's centre: the mirrored index and cloud corner. */
const FLIP = `transform="rotate(180 ${VB_W / 2} ${VB_H / 2})"`;

/** Rank and letter glyphs are set in the display face at 800. */
const RANK_FONT = 'font-family:var(--font-display);font-weight:800';

/* ==========================================================================
 * Shared symbols and the back's scale pattern. One copy, defined in the
 * default sheet (installCardDefs, below) and cross-referenced by the bold
 * sheet by plain "cg-..." id — installBoldCardDefs() guarantees the default
 * sheet exists first, so those references resolve whichever style a table
 * asks for first.
 * ========================================================================== */

function sharedCardDefs() {
  return `
    <pattern id="cg-back-scales" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M0 10a5 5 0 0 1 10 0M5 5a5 5 0 0 1 10 0M-5 5a5 5 0 0 1 10 0" fill="none" style="stroke:var(--back-line)" stroke-width="0.8"/></pattern>`;
}

/** The cream card stock. Flat: a card's drop shadow belongs to the .card box,
 * not to the artwork. */
function faceBody() {
  return '<rect x="0.75" y="0.75" width="98.5" height="138.5" rx="7" style="fill:var(--face);stroke:var(--face-edge)" stroke-width="1.5"/>';
}

/** The gold inner rule and the cloud scroll in two opposite corners — the
 * corners the index does not occupy. Every face carries it, jokers included.
 * The scroll sits tight in the corner so its curl clears the top pip column of a 9 or 10. */
function decor() {
  const cloud = '<path d="M74 11h9q7-1 7 6 0 5-5 5-4 0-4-4 0-3 3-3"fill="none" style="stroke:var(--card-gold)" stroke-width="1.3" stroke-linecap="round"/>';
  return '<rect x="5" y="5" width="90" height="130" rx="5" fill="none" style="stroke:var(--card-gold)" stroke-width="0.8"/>'
    + cloud
    + `<g ${FLIP}>${cloud}</g>`;
}

/** 'red' or 'black': jokers carry their colour on the rank, every other card on its suit. */
function cardColour(card) {
  return isJoker(card) ? JOKER_COLOUR[card.rank] : SUIT_COLOUR[card.suit];
}

/** A card's ink: the red suits (and the big joker) take --suit-red, the black
 * suits (and the small joker) --suit-black. One flat colour per card, so the
 * indices, pips and court lanterns all agree; aces are the exception and
 * always take the red lantern (see centre()). */
function inkColour(card) {
  return cardColour(card) === 'red' ? 'var(--suit-red)' : 'var(--suit-black)';
}

function pip(suit, x, y, size, fillVar) {
  return `<use href="#cg-pip-${suit}" x="${x}" y="${y}" width="${size}" height="${size}" style="fill:${fillVar}"/>`;
}

/** One copy of the small corner index: rank above suit. Two-character ranks
 * ("10") are squeezed to the one-character width so they stay in the corner. */
function standardIndexGlyphs(card) {
  const label = rankIndex(card.rank);
  const ink = inkColour(card);
  const long = label.length > 1;
  const fit = long ? ' textLength="17" lengthAdjust="spacingAndGlyphs"' : '';
  return `<text x="13" y="25" text-anchor="middle" font-size="${long ? 16 : 19}"${fit} style="fill:${ink};${RANK_FONT}">${label}</text>`
    + pip(card.suit, 7.5, 29, 11, ink);
}

/** The small index in the top-left, mirrored at the bottom-right. */
function standardIndex(card) {
  return standardIndexGlyphs(card) + `<g ${FLIP}>${standardIndexGlyphs(card)}</g>`;
}

/** JOKER, one letter per line, down the left edge. */
function jokerLetters(card) {
  const ink = inkColour(card);
  return 'JOKER'.split('').map((ch, i) => `<text x="12" y="${19 + i * 11.5}" text-anchor="middle" font-size="11" style="fill:${ink};${RANK_FONT}">${ch}</text>`).join('');
}

function jokerStandardIndex(card) {
  return jokerLetters(card) + `<g ${FLIP}>${jokerLetters(card)}</g>`;
}

/** The paper lantern: gold caps, a ribbed body in `fillVar`, a tassel, and
 * whatever `inner` draws on the body. */
function lantern(fillVar, inner) {
  return '<rect x="42" y="38" width="16" height="6" rx="1" style="fill:var(--card-gold)"/>'
    + `<ellipse cx="50" cy="72" rx="26" ry="29" style="fill:${fillVar};stroke:var(--card-gold)" stroke-width="2"/>`
    + '<path d="M34 52v40M66 52v40" style="stroke:var(--card-gold)" stroke-width="0.8"/>'
    + '<rect x="42" y="100" width="16" height="6" rx="1" style="fill:var(--card-gold)"/>'
    + '<path d="M50 106v8" style="stroke:var(--card-gold)" stroke-width="2.4"/>'
    + inner;
}

const GOLD_LIGHT = 'var(--card-gold-light)';

const CROWN = '<path d="M34 80 37 62 44 70 50 58 56 70 63 62 66 80z" style="fill:var(--card-gold-light)"/><rect x="34" y="80" width="32" height="4" rx="1" style="fill:var(--card-gold-light)"/>';
const STAR = '<polygon points="50,56 54.5,67 66,67 57,74 60,86 50,79 40,86 43,74 34,67 45.5,67" style="fill:var(--card-gold-light)"/>';

/** The centrepiece: lantern for aces, courts and jokers, pips for 2-10. */
function centre(card) {
  const ink = inkColour(card);
  if (isJoker(card)) return lantern(ink, card.rank === RANK_JOKER_BIG ? CROWN : STAR);
  if (card.rank === 14) return lantern('var(--suit-red)', pip(card.suit, 35, 57, 30, GOLD_LIGHT));
  if (card.rank >= 11 && card.rank <= 13) {
    const letter = rankIndex(card.rank);
    return lantern(ink, `<text x="50" y="80" font-size="30" text-anchor="middle" style="fill:${GOLD_LIGHT};${RANK_FONT}">${letter}</text>`
      + pip(card.suit, 45, 87, 10, GOLD_LIGHT));
  }
  const layout = LAYOUTS[card.rank === RANK_TWO ? 2 : card.rank] ?? LAYOUTS[1];
  const uses = layout.map(([x, y, s = 1, flip = false]) => {
    const size = 17 * s;
    const cx = x * VB_W, cy = y * VB_H;
    const transform = flip ? ` transform="rotate(180 ${cx} ${cy})"` : '';
    return `<use href="#cg-pip-${card.suit}" x="${(cx - size / 2).toFixed(2)}" y="${(cy - size / 2).toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}" style="fill:${ink}"${transform}/>`;
  }).join('');
  return `<g>${uses}</g>`;
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
    ${sharedCardDefs()}
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
  const index = isJoker(card) ? jokerStandardIndex(card) : standardIndex(card);
  return `<g data-colour="${cardColour(card)}">${faceBody()}${decor()}${index}${centre(card)}</g>`;
}

/** A complete face as an SVG string. */
export function cardFaceSVG(card) {
  return `<svg class="cg-card-svg" viewBox="0 0 ${VB_W} ${VB_H}" role="img" aria-label="${cardAria(card)}">${cardFaceBody(card)}</svg>`;
}

/** A complete back as an SVG string. */
export function cardBackSVG() {
  return `<svg class="cg-card-svg" viewBox="0 0 ${VB_W} ${VB_H}" role="img" aria-label="Face-down card">${cardBackBody()}</svg>`;
}

/** The back's contents, without the <svg> wrapper: a cream outline, a thick
 * red frame, a deep-red field of gold dragon scales and a gold 龙 medallion.
 * Shared by both styles: cardBackBoldBody() below calls this same function, so
 * opponents' backs, the deck and the landlord's three all read as one deck no
 * matter which table drew them. */
export function cardBackBody() {
  return `
    <rect x="0.75" y="0.75" width="98.5" height="138.5" rx="7" style="fill:var(--face);stroke:var(--back-frame)" stroke-width="1.5"/>
    <rect x="3.5" y="3.5" width="93" height="133" rx="6" fill="none" style="stroke:var(--back-frame)" stroke-width="4"/>
    <rect x="7" y="7" width="86" height="126" rx="4" style="fill:var(--back);stroke:var(--back-line)" stroke-width="1.2"/>
    <rect x="7" y="7" width="86" height="126" rx="4" fill="url(#cg-back-scales)" opacity="0.7"/>
    <circle cx="50" cy="70" r="18" style="fill:var(--back);stroke:var(--back-line)" stroke-width="2"/>
    <text x="50" y="79" font-size="24" text-anchor="middle" style="fill:var(--card-gold-light);font-family:var(--font-display);font-weight:700">龙</text>`;
}

export function cardAria(card) {
  if (isJoker(card)) return rankLabel(card.rank);
  return `${rankLabel(card.rank)} of ${card.suit}s`;
}

/* ==========================================================================
 * The "bold" style — opt-in: the Dou Di Zhu and Big Two tables.
 *
 * The same lantern artwork as the default style, but the corner index becomes
 * an enlarged lantern seal. Shedding-game hands fan their cards so only the
 * left third of each one shows, and the default's small index is too little to
 * read there; the seal puts the rank large in that strip. Blackjack lays its
 * cards side by side with the whole face visible, so it keeps the standard
 * index. The centrepiece is drawn at 0.6 scale in the open space to the right
 * of the seal.
 *
 * Built in its own <symbol> sheet, installed lazily on first use, so a table
 * that never asks for `style: 'bold'` never pays for it and the default deck's
 * own symbols are untouched.
 * ========================================================================== */

const BOLD_DEFS_ID = 'cg-card-bold-defs';

/** The index lantern: rank reversed out of an ink seal, suit pip beneath. */
function lanternSeal(ink, card) {
  const label = rankIndex(card.rank);
  const fit = label.length > 1 ? ' textLength="21" lengthAdjust="spacingAndGlyphs"' : '';
  return '<rect x="14" y="5" width="13" height="5" rx="1" style="fill:var(--card-gold)"/>'
    + `<rect x="5" y="9" width="31" height="38" rx="15.5" style="fill:${ink}"/>`
    + '<path d="M11 20v16M30 20v16" style="stroke:var(--card-gold)" stroke-width="0.7"/>'
    + '<rect x="14" y="46" width="13" height="5" rx="1" style="fill:var(--card-gold)"/>'
    + '<path d="M20.5 51v9" style="stroke:var(--card-gold)" stroke-width="2"/>'
    + `<text x="20.5" y="37" font-size="25" text-anchor="middle"${fit} style="fill:var(--seal-text);${RANK_FONT}">${label}</text>`
    + pip(card.suit, 11.5, 63, 18, ink);
}

function boldJokerIndex(ink) {
  const letters = 'JOKER'.split('').map((ch, i) => `<text x="21" y="${27 + i * 12}" text-anchor="middle" font-size="10" style="fill:var(--seal-text);${RANK_FONT}">${ch}</text>`).join('');
  return `<rect x="10" y="11" width="22" height="72" rx="4" style="fill:${ink}"/>${letters}`;
}

/** The bold face's inner markup (without the <svg> wrapper). */
export function cardFaceBoldBody(card) {
  const ink = inkColour(card);
  // Scaled to 0.55 and set at x 34 so the right pip column of a 4-10 ends at
  // x ~77, clear of the mirrored corner suit that starts at x 81.5.
  const small = `<g transform="translate(34 42) scale(0.55)">${centre(card)}</g>`;
  const index = isJoker(card)
    ? boldJokerIndex(ink)
    : lanternSeal(ink, card) + `<g ${FLIP}>${standardIndexGlyphs(card)}</g>`;
  return `<g data-colour="${cardColour(card)}">${faceBody()}${decor()}${index}${small}</g>`;
}

/** The bold back: identical to the default style's back (see cardBackBody)
 * — one deck, drawn once, read by both tables. */
export function cardBackBoldBody() {
  return cardBackBody();
}

function installBoldCardDefs(doc = globalThis.document) {
  // The bold sheet cross-references the default sheet's plain pips and the
  // back's scale pattern by plain "cg-..." id (see sharedCardDefs) rather than
  // duplicating them — this guarantees that cross-reference resolves
  // regardless of which style a caller reaches for first.
  installCardDefs(doc);
  if (!doc || doc.getElementById(BOLD_DEFS_ID)) return;
  const holder = doc.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  holder.innerHTML = `<svg id="${BOLD_DEFS_ID}" xmlns="http://www.w3.org/2000/svg"><defs></defs></svg>`;
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
  const colour = down ? '' : cardColour(card);
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
