/**
 * Generate the app icons.
 *
 * Everything is drawn by hand into an RGBA buffer and written out as PNG with
 * node:zlib, so regenerating the icons needs no image library, no headless
 * browser and no network. Shapes are signed-distance tests sampled 4x4 per pixel
 * for antialiasing — slow in principle, irrelevant at 512 square.
 *
 *   node tools/make-icons.mjs
 */

import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../assets/icons/', import.meta.url));

// --- PNG ---------------------------------------------------------------------

const crc32 = typeof zlibCrc32 === 'function'
  ? (buf) => zlibCrc32(buf)
  : (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return (buf) => {
      let c = 0xffffffff;
      for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
  })();

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** @param {Uint8Array} rgba row-major, 4 bytes per pixel */
export function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing -----------------------------------------------------------------

const SAMPLES = 4; // per axis

function hex(value) {
  const n = parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Rounded rectangle, optionally rotated about its own centre. The usual signed
 * distance formula: push the test point into the first quadrant of the inner
 * rectangle, then measure against the corner radius.
 */
function inRoundedRect(px, py, cx, cy, w, h, r, angle = 0) {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const dx = px - cx;
  const dy = py - cy;
  const qx = Math.abs(dx * cos - dy * sin) - (w / 2 - r);
  const qy = Math.abs(dx * sin + dy * cos) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return inside + outside - r <= 0;
}

/** Rotate a point into a shape's own frame, normalised by `size`. */
function localPoint(px, py, cx, cy, size, angle) {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  return [
    ((px - cx) * cos - (py - cy) * sin) / size,
    ((px - cx) * sin + (py - cy) * cos) / size,
  ];
}

/** Two lobes over a wedge. Point down, centred on (0, 0) in the shape's frame. */
function heartAt(x, y) {
  const lobeR = 0.29;
  const lobeY = -0.17;
  if (Math.hypot(x + 0.25, y - lobeY) <= lobeR) return true;
  if (Math.hypot(x - 0.25, y - lobeY) <= lobeR) return true;
  if (y >= lobeY && y <= 0.56) {
    const t = (y - lobeY) / (0.56 - lobeY);
    return Math.abs(x) <= 0.54 * (1 - t) ** 0.85;
  }
  return false;
}

function inHeart(px, py, cx, cy, size, angle = 0) {
  const [x, y] = localPoint(px, py, cx, cy, size, angle);
  return heartAt(x, y);
}

/** A spade is a heart turned point-up, with a stem under it. */
function inSpade(px, py, cx, cy, size, angle = 0) {
  const [x, y] = localPoint(px, py, cx, cy, size, angle);
  // Flip the heart so its point is uppermost, and lift it to leave room below.
  if (heartAt(x, -y - 0.14)) return true;
  if (y > 0.26 && y < 0.56) {
    const t = (y - 0.26) / 0.3;
    return Math.abs(x) <= 0.05 + t * t * 0.3;
  }
  return false;
}

/**
 * @param {number} size
 * @param {{padding?: number}} [options] padding is the maskable safe-zone inset
 */
function drawIcon(size, { padding = 0 } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  const felt0 = hex('#14503c');
  const felt1 = hex('#06180f');
  const gold = hex('#d8b86a');
  const ivory = hex('#f7f1e2');
  const ivoryDim = hex('#ddd3bc');
  const claret = hex('#b4232c');
  const ink = hex('#16140f');

  const scale = 1 - padding;
  const mid = size / 2;
  const cardW = size * 0.34 * scale;
  const cardH = size * 0.47 * scale;
  const radius = size * 0.035 * scale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          const sample = shade(px, py);
          r += sample[0];
          g += sample[1];
          b += sample[2];
          a += sample[3];
        }
      }
      const n = SAMPLES * SAMPLES;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return rgba;

  function shade(px, py) {
    // Background: felt with a soft highlight above centre.
    if (!inRoundedRect(px, py, mid, mid, size, size, size * 0.22)) return [0, 0, 0, 0];
    const glow = Math.max(0, 1 - Math.hypot(px - mid, py - size * 0.34) / (size * 0.75));
    let colour = mix(felt1, felt0, 0.35 + glow * 0.75);

    // Gold hairline just inside the edge.
    const inset = size * 0.055;
    const onRing = inRoundedRect(px, py, mid, mid, size - inset * 2, size - inset * 2, size * 0.17)
      && !inRoundedRect(px, py, mid, mid, size - inset * 2 - size * 0.012, size - inset * 2 - size * 0.012, size * 0.16);
    if (onRing) colour = gold;

    // The front card is tested first, so it paints over the one behind it.
    const frontAngle = 0.18;
    const frontCx = mid + size * 0.10 * scale;
    const frontCy = mid + size * 0.02;
    if (inRoundedRect(px, py, frontCx, frontCy, cardW, cardH, radius, frontAngle)) {
      colour = inRoundedRect(px, py, frontCx, frontCy, cardW - size * 0.014, cardH - size * 0.014, radius, frontAngle)
        ? ivory : gold;
      if (inHeart(px, py, frontCx + size * 0.022, frontCy, size * 0.19 * scale, frontAngle)) colour = claret;
      return [...colour, 255];
    }

    // Back card, tilted the other way, its pip clear of the overlap.
    const backAngle = -0.20;
    const backCx = mid - size * 0.10 * scale;
    const backCy = mid;
    if (inRoundedRect(px, py, backCx, backCy, cardW, cardH, radius, backAngle)) {
      colour = inRoundedRect(px, py, backCx, backCy, cardW - size * 0.014, cardH - size * 0.014, radius, backAngle)
        ? ivoryDim : gold;
      if (inSpade(px, py, backCx - size * 0.022, backCy, size * 0.19 * scale, backAngle)) colour = ink;
      return [...colour, 255];
    }

    return [...colour, 255];
  }
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0b2a22"/>
  <rect x="3.5" y="3.5" width="57" height="57" rx="11" fill="none" stroke="#d8b86a" stroke-width="1.2"/>
  <g transform="rotate(-12 26 34)">
    <rect x="13" y="17" width="22" height="31" rx="3" fill="#ded4bd" stroke="#d8b86a" stroke-width="1.2"/>
    <path d="M24 25c-4 5-7 8-7 11 0 2.4 1.9 4 4.2 4 1.3 0 2.2-.5 2.8-1.3-.5 2-1.4 3.3-3 4h6c-1.6-.7-2.5-2-3-4 .6.8 1.5 1.3 2.8 1.3 2.3 0 4.2-1.6 4.2-4 0-3-3-6-7-11z" fill="#16140f"/>
  </g>
  <g transform="rotate(9 40 34)">
    <rect x="30" y="17" width="22" height="31" rx="3" fill="#f7f1e2" stroke="#d8b86a" stroke-width="1.2"/>
    <path d="M41 44c-5-4-8-7-8-10.5 0-2.6 2-4.5 4.3-4.5 1.6 0 2.8.9 3.7 2.2.9-1.3 2.1-2.2 3.7-2.2 2.4 0 4.3 1.9 4.3 4.5C49 37 46 40 41 44z" fill="#b4232c"/>
  </g>
</svg>`;

function main() {
  mkdirSync(OUT, { recursive: true });
  const jobs = [
    ['icon-192.png', 192, {}],
    ['icon-512.png', 512, {}],
    ['maskable-512.png', 512, { padding: 0.22 }],
    ['apple-touch-icon.png', 180, {}],
  ];
  for (const [name, size, options] of jobs) {
    const png = encodePng(drawIcon(size, options), size, size);
    writeFileSync(OUT + name, png);
    console.log(`${name.padEnd(22)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KiB`);
  }
  writeFileSync(OUT + 'favicon.svg', `${FAVICON}\n`);
  console.log('favicon.svg');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
