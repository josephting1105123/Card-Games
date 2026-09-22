/**
 * Card faces and backs, drawn as SVG at run time. No image files, so the whole
 * deck installs offline and stays crisp at any size.
 *
 * House style: ivory stock with a double gold rule, engraved serif indices,
 * traditional pip layouts for the spot cards, mirrored court panels, and a
 * guilloche back in deep burgundy and gold. Suit shapes and the ornaments live
 * in one hidden <svg> of <symbol> definitions that every card references with
 * <use>, which keeps a twenty-card fan cheap to build and repaint.
 */

import { JOKER_COLOUR, SUIT_COLOUR, SUIT_SYMBOL, isJoker, rankIndex, rankLabel } from '../core/cards.js';

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
    <linearGradient id="cg-stock" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#fffdf6"/>
      <stop offset="0.55" stop-color="#fbf6e9"/>
      <stop offset="1" stop-color="#f1e8d2"/>
    </linearGradient>
    <linearGradient id="cg-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e8d49a"/>
      <stop offset="0.5" stop-color="#b8974f"/>
      <stop offset="1" stop-color="#8a6d2f"/>
    </linearGradient>
    <linearGradient id="cg-back-field" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#8d2334"/>
      <stop offset="0.5" stop-color="#6d1726"/>
      <stop offset="1" stop-color="#4a0f1b"/>
    </linearGradient>
    <pattern id="cg-guilloche" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <path d="M5 0 10 5 5 10 0 5z" fill="none" stroke="#d8b86a" stroke-width="0.45" opacity="0.55"/>
      <circle cx="5" cy="5" r="1.1" fill="#d8b86a" opacity="0.32"/>
    </pattern>
    <radialGradient id="cg-back-glow" cx="0.5" cy="0.42" r="0.7">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.28"/>
    </radialGradient>
    <symbol id="cg-crown" viewBox="0 0 100 60">
      <path d="M8 52 14 14 30 34 50 8 70 34 86 14 92 52z" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"/>
      <circle cx="14" cy="11" r="4" fill="currentColor"/><circle cx="50" cy="5" r="4.5" fill="currentColor"/><circle cx="86" cy="11" r="4" fill="currentColor"/>
      <path d="M8 52h84" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/>
    </symbol>
    <symbol id="cg-filigree" viewBox="0 0 100 100">
      <path d="M50 8a21 21 0 0 1 21 21 21 21 0 0 1 21 21 21 21 0 0 1-21 21 21 21 0 0 1-21 21 21 21 0 0 1-21-21 21 21 0 0 1-21-21 21 21 0 0 1 21-21 21 21 0 0 1 21-21z"
            fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.68"/>
      <ellipse cx="50" cy="50" rx="24" ry="30" fill="none" stroke="currentColor" stroke-width="0.9" opacity="0.42"/>
      <circle cx="50" cy="50" r="33" fill="none" stroke="currentColor" stroke-width="0.5" stroke-dasharray="1.6 3.2" opacity="0.5"/>
    </symbol>
  </defs>
</svg>`;
  doc.body.appendChild(holder);
}

function pip(suit, x, y, scale = 1, flipped = false) {
  const size = 19 * scale;
  const cx = x * VB_W;
  const cy = y * VB_H;
  const transform = flipped ? ` transform="rotate(180 ${cx} ${cy})"` : '';
  return `<use href="#cg-pip-${suit}" x="${(cx - size / 2).toFixed(2)}" y="${(cy - size / 2).toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}"${transform}/>`;
}

/**
 * The corner index. Both corners are drawn from the same top-left coordinates;
 * the second is rotated half a turn about the centre of the card, which is how a
 * real card is printed and the only way to keep the two corners identical
 * without hand-tuning offsets that clip at the edge.
 */
function cornerIndex(card, flipped) {
  const label = rankIndex(card.rank);
  const symbol = SUIT_SYMBOL[card.suit];
  const rot = flipped ? ` transform="rotate(180 ${VB_W / 2} ${VB_H / 2})"` : '';
  // Garamond sets smaller than the sans face this was first drawn for, so the
  // indices run a couple of points larger to keep their weight on the card.
  const fontSize = label.length > 1 ? 16 : 19.5;
  return `<g${rot}>
    <text class="cg-index" x="12.5" y="22" font-size="${fontSize}" text-anchor="middle">${label}</text>
    <text class="cg-index-suit" x="12.5" y="34.5" font-size="12.5" text-anchor="middle">${symbol}</text>
  </g>`;
}

function courtPanel(card) {
  const letter = rankLabel(card.rank);
  return `<g class="cg-court">
    <rect x="21" y="26" width="58" height="88" rx="4" fill="none" stroke="url(#cg-gold)" stroke-width="1.1"/>
    <rect x="24" y="29" width="52" height="82" rx="3" fill="#fdf8ec" stroke="currentColor" stroke-width="0.6" opacity="0.9"/>
    <g color="currentColor" opacity="0.85"><use href="#cg-filigree" x="27" y="32" width="46" height="46"/></g>
    <g color="currentColor" opacity="0.85"><use href="#cg-filigree" x="27" y="62" width="46" height="46" transform="rotate(180 50 85)"/></g>
    <g color="url(#cg-gold)"><use href="#cg-crown" x="33" y="34" width="34" height="20"/></g>
    <text class="cg-court-letter" x="50" y="79" font-size="34" text-anchor="middle">${letter}</text>
    <use href="#cg-pip-${card.suit}" x="41" y="84" width="18" height="18"/>
    <line x1="50" y1="29" x2="50" y2="111" stroke="currentColor" stroke-width="0.4" opacity="0.25"/>
  </g>`;
}

function acePanel(card) {
  return `<g>
    <g color="url(#cg-gold)"><use href="#cg-filigree" x="14" y="34" width="72" height="72"/></g>
    <use href="#cg-pip-${card.suit}" x="32" y="50" width="36" height="36"/>
  </g>`;
}

function jokerPanel(card) {
  const big = card.rank === 17;
  const word = big ? 'JOKER' : 'Joker';
  return `<g>
    <g color="url(#cg-gold)"><use href="#cg-filigree" x="18" y="30" width="64" height="64"/></g>
    <g color="currentColor">
      <use href="#cg-crown" x="34" y="40" width="32" height="19"/>
      <text class="cg-joker" x="50" y="88" font-size="14" text-anchor="middle"
            textLength="56" lengthAdjust="spacingAndGlyphs">${word}</text>
      <text class="cg-joker-star" x="50" y="106" font-size="14" text-anchor="middle">★</text>
    </g>
  </g>`;
}

/** The inner markup of a card face (without the <svg> wrapper). */
export function cardFaceBody(card) {
  const colour = isJoker(card) ? JOKER_COLOUR[card.rank] : SUIT_COLOUR[card.suit];
  const frame = `
    <rect x="0.75" y="0.75" width="${VB_W - 1.5}" height="${VB_H - 1.5}" rx="7" fill="url(#cg-stock)" stroke="url(#cg-gold)" stroke-width="1.5"/>
    <rect x="4.5" y="4.5" width="${VB_W - 9}" height="${VB_H - 9}" rx="5" fill="none" stroke="url(#cg-gold)" stroke-width="0.7" opacity="0.85"/>
    <rect x="6.5" y="6.5" width="${VB_W - 13}" height="${VB_H - 13}" rx="4" fill="none" stroke="#8a6d2f" stroke-width="0.25" opacity="0.5"/>`;

  let centre;
  if (isJoker(card)) centre = jokerPanel(card);
  else if (card.rank >= 11 && card.rank <= 13) centre = courtPanel(card);
  else if (card.rank === 14) centre = acePanel(card);
  else {
    const layout = LAYOUTS[card.rank === 15 ? 2 : card.rank] ?? LAYOUTS[1];
    centre = `<g>${layout.map(([x, y, s = 1, flip = false]) => pip(card.suit, x, y, s, flip)).join('')}</g>`;
  }

  const star = (flip) => `<g${flip ? ` transform="rotate(180 ${VB_W / 2} ${VB_H / 2})"` : ''}>`
    + `<text class="cg-index" x="12.5" y="23" font-size="14.5" text-anchor="middle">★</text></g>`;
  const indices = isJoker(card) ? star(false) + star(true) : cornerIndex(card, false) + cornerIndex(card, true);

  return `<g class="cg-face cg-${colour}">${frame}${indices}${centre}</g>`;
}

/** A complete face as an SVG string. */
export function cardFaceSVG(card) {
  return `<svg class="cg-card-svg" viewBox="0 0 ${VB_W} ${VB_H}" role="img" aria-label="${cardAria(card)}">${cardFaceBody(card)}</svg>`;
}

/** A complete back as an SVG string. */
export function cardBackSVG() {
  return `<svg class="cg-card-svg" viewBox="0 0 ${VB_W} ${VB_H}" role="img" aria-label="Face-down card">
    <rect x="0.75" y="0.75" width="${VB_W - 1.5}" height="${VB_H - 1.5}" rx="7" fill="url(#cg-back-field)" stroke="url(#cg-gold)" stroke-width="1.5"/>
    <rect x="5" y="5" width="${VB_W - 10}" height="${VB_H - 10}" rx="5" fill="url(#cg-guilloche)"/>
    <rect x="5" y="5" width="${VB_W - 10}" height="${VB_H - 10}" rx="5" fill="url(#cg-back-glow)"/>
    <rect x="5" y="5" width="${VB_W - 10}" height="${VB_H - 10}" rx="5" fill="none" stroke="#d8b86a" stroke-width="0.8" opacity="0.8"/>
    <ellipse cx="50" cy="70" rx="24" ry="34" fill="#5c1320" opacity="0.55" stroke="#d8b86a" stroke-width="0.8"/>
    <g color="#d8b86a"><use href="#cg-filigree" x="26" y="46" width="48" height="48"/></g>
    <g color="#e8d49a"><use href="#cg-crown" x="36" y="58" width="28" height="17"/></g>
  </svg>`;
}

export function cardAria(card) {
  if (isJoker(card)) return rankLabel(card.rank);
  return `${rankLabel(card.rank)} of ${card.suit}s`;
}

/**
 * Build a card element.
 * @param {object|null} card null renders a face-down card
 * @param {{selectable?: boolean, index?: number, faceDown?: boolean}} [opts]
 */
export function cardElement(card, opts = {}) {
  const doc = globalThis.document;
  const el = doc.createElement(opts.selectable ? 'button' : 'div');
  el.className = 'card';
  if (opts.selectable) {
    el.type = 'button';
    el.setAttribute('aria-pressed', 'false');
  }
  if (!card || opts.faceDown) {
    el.classList.add('card--down');
    el.innerHTML = cardBackSVG();
  } else {
    el.dataset.cardId = String(card.id);
    el.dataset.rank = String(card.rank);
    el.innerHTML = cardFaceSVG(card);
    if (opts.selectable) el.setAttribute('aria-label', cardAria(card));
  }
  return el;
}
