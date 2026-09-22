/**
 * Room codes.
 *
 * Five characters from a 32-letter alphabet with the ambiguous glyphs left out
 * (no I, no O, no 0, no 1), which is 32^5 = 33.5 million combinations — far more
 * than a house needs, and short enough to read out loud.
 *
 * Mistyped characters are not silently "corrected": a 0 could be a misread D, O
 * or Q, and guessing would drop someone into the wrong room. A bad code fails
 * with "no such room" instead.
 *
 * A code may carry the host's address after an "@" so a client that already has
 * the app open from somewhere else can still find the host:
 *
 *   KRM7Q                 join the server this page came from
 *   KRM7Q@192.168.1.24    join that host on the default port
 *   KRM7Q@192.168.1.24:8790
 */

export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;
export const DEFAULT_PORT = 8787;

/** @param {() => number} [rng] */
export function generateCode(rng = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return out;
}

/** Upper-case, and strip the spaces and dashes people add when reading aloud. */
export function normaliseCode(input) {
  return String(input ?? '').trim().toUpperCase().replace(/[\s-]+/g, '');
}

/**
 * Split a typed code into the room part and, if present, the host address.
 * @returns {{code: string, host: string|null, port: number|null, valid: boolean}}
 */
export function parseCode(input) {
  const normalised = normaliseCode(input);
  const [code, address] = normalised.split('@');
  const valid = code.length === CODE_LENGTH && [...code].every((ch) => ALPHABET.includes(ch));
  if (!address) return { code, host: null, port: null, valid };
  const [host, port] = address.split(':');
  return { code, host: host || null, port: port ? Number(port) : DEFAULT_PORT, valid: valid && !!host };
}

/** Build the code you hand to other players. */
export function formatCode(code, host, port = DEFAULT_PORT) {
  if (!host) return code;
  return port === DEFAULT_PORT ? `${code}@${host}` : `${code}@${host}:${port}`;
}

/** The WebSocket URL a parsed code points at, given where this page came from. */
export function socketUrlFor(parsed, location) {
  if (parsed.host) return `ws://${parsed.host}:${parsed.port ?? DEFAULT_PORT}/lan`;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/lan`;
}
