#!/usr/bin/env node
/**
 * The local network host.
 *
 * It does two jobs: serve the app's files, and run the rooms. Serving the files
 * itself is the point — everyone on the network opens the same origin, so the
 * WebSocket is same-origin too and no browser blocks it as mixed content. A page
 * loaded from GitHub Pages over HTTPS cannot open a ws:// socket to a private
 * address, which is a browser rule and not something this app can work around.
 *
 *   node server/server.js            port 8787
 *   PORT=9000 node server/server.js
 *
 * Set PUBLIC=1 to run it as the public online host (see render.yaml and the
 * README's "Online play"): no LAN addresses are advertised and private-network
 * origins are no longer trusted. Other variables: HOST, ALLOWED_ORIGINS,
 * TRUST_PROXY_HOPS, MAX_CONN_PER_IP, UPGRADES_PER_IP, MAX_CONNECTIONS,
 * MAX_ROOMS, MAX_ROOMS_PER_IP, PUBLIC_HOSTS.
 *
 * No dependencies. Node 20 or newer.
 */

import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attachWebSocket } from './ws.js';
import { RoomHub } from './rooms.js';
import { lanAddresses, primaryAddress } from './lan.js';
import { DEFAULT_PORT } from '../src/net/roomcode.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const DEFAULT_ALLOWED_ORIGINS = [
  'https://josephting1105123.github.io',
  'https://entropicsoftwarelabs.com',
  'https://www.entropicsoftwarelabs.com',
];

const DEFAULT_PUBLIC_HOSTS = ['cards.entropicsoftwarelabs.com'];

/** A limit from the environment: unset, blank or not a number keeps the default; anything else is at least 1. */
function limit(value, fallback) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(1, n) : fallback;
}

/** Settings from the environment. Anything not set keeps today's LAN behaviour. */
export function readEnv(env = process.env) {
  const list = (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  const isPublic = env.PUBLIC === '1';
  const listed = (env.PUBLIC_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  let hosts;
  if (!isPublic || listed.includes('*')) hosts = []; // "*" is the explicit way to skip the check
  else hosts = listed.length ? listed : DEFAULT_PUBLIC_HOSTS;
  return {
    port: Number(env.PORT) || DEFAULT_PORT,
    host: env.HOST || '0.0.0.0',
    public: isPublic,
    allowedOrigins: list.length ? list : DEFAULT_ALLOWED_ORIGINS,
    trustProxyHops: Math.max(0, Math.floor(Number(env.TRUST_PROXY_HOPS)) || 0),
    maxConnPerIp: limit(env.MAX_CONN_PER_IP, 20),
    upgradesPerIp: limit(env.UPGRADES_PER_IP, 10),
    maxConnections: limit(env.MAX_CONNECTIONS, 1000),
    maxRooms: limit(env.MAX_ROOMS, 300),
    maxRoomsPerIp: limit(env.MAX_ROOMS_PER_IP, 3),
    // X-Forwarded-For is only as honest as the proxy chain that wrote it, and a
    // hostname with a different hop count lets a client choose its own address,
    // so the public host pins Host to the name TRUST_PROXY_HOPS was measured on.
    // Empty means any Host is accepted: not public, or PUBLIC_HOSTS=* to test
    // on the onrender.com name before DNS exists.
    publicHosts: hosts,
  };
}

const UPGRADE_WINDOW_MS = 10_000;
const LIMIT_LOG_INTERVAL_MS = 60_000;

/** The Host header without its port, lowercased; IPv6 literals keep their brackets. */
function hostName(header) {
  return String(header ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

/**
 * The client's address. X-Forwarded-For is "client, proxy1, proxy2": each proxy
 * appends the address it saw, so only entries counted from the right can be
 * trusted. With N trusted hops the client is the Nth entry from the end; a shorter
 * list means fewer proxies than configured, so the leftmost entry is the best guess.
 */
export function clientIp(req, trustProxyHops) {
  const direct = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxyHops) return direct;
  const header = req.headers['x-forwarded-for'];
  const entries = String(header ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  if (!entries.length) return direct;
  return entries.length >= trustProxyHops ? entries[entries.length - trustProxyHops] : entries[0];
}

/** How many addresses the request's X-Forwarded-For carries. */
export function forwardedEntries(req) {
  return String(req.headers['x-forwarded-for'] ?? '').split(',').map((e) => e.trim()).filter(Boolean).length;
}

/**
 * Loopback, private-range and unique-local addresses (and their ::ffff: forms).
 * On the public host a player never has one, so seeing one means the address is
 * a proxy's and every player behind it would share a per-address allowance.
 */
export function isPrivateAddress(address) {
  let a = String(address ?? '').trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) a = mapped[1];
  if (a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (!m) return false;
  const first = Number(m[1]);
  const second = Number(m[2]);
  return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function isLocalOrPrivateHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Whether a WebSocket upgrade may proceed. Browsers always send Origin, so this
 * stops other websites from driving rooms with a visitor's browser; a missing
 * Origin means a script or native client, which could forge it anyway.
 */
export function originAllowed(req, { allowedOrigins, public: isPublic }) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host === req.headers.host) return true;
  const normal = origin.replace(/\/+$/, '').toLowerCase();
  if (allowedOrigins.some((o) => o.replace(/\/+$/, '').toLowerCase() === normal)) return true;
  return !isPublic && parsed.protocol === 'http:' && isLocalOrPrivateHost(parsed.hostname);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// Text compresses to a fraction of its size; fonts, PNGs and icons are already compressed.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.md']);

// Compressed once per file version rather than per request. The key is the path;
// size and mtime say whether the cached bytes still match what is on disk.
const gzipCache = new Map();

async function gzipped(file, stat) {
  const cached = gzipCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.body;
  const body = gzipSync(await fs.readFile(file), { level: 9 });
  gzipCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, body });
  return body;
}

function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  // Weak comparison: a client may send several tags, and may drop the W/ prefix.
  const strip = (tag) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => strip(tag) === strip(etag));
}

/**
 * Resolve a URL path inside ROOT, refusing anything that climbs out of it (null).
 * On the public host it also refuses files that are not the app (false): hidden
 * folders such as .git and .claude, and the server and test sources.
 */
function resolvePath(pathname, isPublic = false) {
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  if (isPublic) {
    const segments = relative.split(/[/\\]+/).filter(Boolean);
    const first = segments[0]?.toLowerCase();
    if (segments.some((s) => s.startsWith('.')) || first === 'server' || first === 'test') return false;
  }
  const target = join(ROOT, relative === '/' || relative === sep ? 'index.html' : relative);
  if (!target.startsWith(ROOT)) return null;
  return target;
}

async function serve(req, res, file, headOnly) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return json(res, 404, { error: 'not found' });
  }
  if (stat.isDirectory()) return serve(req, res, join(file, 'index.html'), headOnly);
  const ext = extname(file).toLowerCase();
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  // no-cache means "revalidate before reuse"; with an ETag that is a 304, not a download.
  const headers = {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    etag,
  };
  // A 304 must carry the headers a 200 would, Vary included, or a cache could
  // reuse the revalidated entry for a client that sent a different Accept-Encoding.
  const compressible = COMPRESSIBLE.has(ext);
  if (compressible) headers.vary = 'accept-encoding';
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (compressible && /\bgzip\b/i.test(req.headers['accept-encoding'] ?? '')) {
    const body = await gzipped(file, stat);
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': body.length });
    return res.end(headOnly ? undefined : body);
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (headOnly) return res.end();
  return createReadStream(file).pipe(res);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': TYPES['.json'], 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Build the HTTP server, the rooms and the WebSocket endpoint without listening,
 * so tests can start it on an ephemeral port.
 * @param {Partial<ReturnType<typeof readEnv>>} [overrides]
 */
export function createAppServer(overrides = {}) {
  const config = { ...readEnv(), ...overrides };
  const log = config.log ?? console.warn;
  const hub = new RoomHub({
    public: config.public,
    advertisedHost: config.public ? null : primaryAddress(),
    port: config.port,
    maxRooms: config.maxRooms,
    maxRoomsPerIp: config.maxRoomsPerIp,
    log,
  });

  // A flood hitting a per-IP limit must not become a flood of log lines.
  let lastLimitLog = 0;
  const logLimit = (text, ip, req) => {
    const now = Date.now();
    if (now - lastLimitLog < LIMIT_LOG_INTERVAL_MS) return;
    lastLimitLog = now;
    log(`${text}: address ${ip}, X-Forwarded-For entries ${forwardedEntries(req)}, TRUST_PROXY_HOPS=${config.trustProxyHops}`);
  };
  // A chain shorter than TRUST_PROXY_HOPS means clientIp() is falling back to
  // its leftmost-entry guess, which a client can choose; say so once.
  let warnedShortChain = false;
  const checkChain = (req) => {
    if (warnedShortChain || !config.trustProxyHops) return;
    const entries = forwardedEntries(req);
    if (entries >= config.trustProxyHops) return;
    warnedShortChain = true;
    log(`X-Forwarded-For has ${entries} entries but TRUST_PROXY_HOPS=${config.trustProxyHops}; client addresses may be wrong or forgeable`);
  };

  const server = createServer(async (req, res) => {
    try {
      checkChain(req);
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        // Open room pages on other origins ping this to keep a sleeping free-tier host awake.
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': 2,
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        });
        return res.end(req.method === 'HEAD' ? undefined : 'ok');
      }
      if (url.pathname === '/api/info') {
        const info = {
          ok: true,
          host: config.public ? null : primaryAddress(),
          port: config.port,
          addresses: config.public ? [] : lanAddresses(),
          rooms: hub.rooms.size,
        };
        // The caller's own address only: lets a deploy check TRUST_PROXY_HOPS by
        // opening this URL and seeing whether it shows their address or a proxy's.
        if (config.public) {
          info.clientAddress = clientIp(req, config.trustProxyHops);
          info.forwardedEntries = forwardedEntries(req);
        }
        return json(res, 200, info);
      }
      const file = resolvePath(url.pathname, config.public);
      if (file === false) return json(res, 404, { error: 'not found' });
      if (!file) return json(res, 400, { error: 'bad path' });
      return await serve(req, res, file, req.method === 'HEAD');
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error) });
    }
  });

  const perIp = new Map();
  /** @type {Map<string, number[]>} upgrade attempt times by address, inside the rate window */
  const upgradeTimes = new Map();
  const pruneUpgrades = (now) => {
    for (const [ip, times] of upgradeTimes) {
      while (times.length && times[0] <= now - UPGRADE_WINDOW_MS) times.shift();
      if (!times.length) upgradeTimes.delete(ip);
    }
  };
  // Entries are pruned when their address returns, but addresses that never come
  // back would sit here for ever without this.
  const upgradeSweep = setInterval(() => pruneUpgrades(Date.now()), UPGRADE_WINDOW_MS);
  upgradeSweep.unref?.();

  const sockets = attachWebSocket(server, {
    path: '/lan',
    verifyUpgrade(req) {
      checkChain(req);
      if (config.public && config.publicHosts.length && !config.publicHosts.includes(hostName(req.headers.host))) {
        return { status: 403, reason: 'Forbidden' };
      }
      // Before the rate limiter: a hostile page can fire cross-site attempts from
      // a visitor's browser, and those must not spend the visitor's upgrade budget.
      if (!originAllowed(req, config)) return { status: 403, reason: 'Forbidden' };
      const ip = clientIp(req, config.trustProxyHops);
      // A private address on the public host is a proxy's, not a player's; with
      // it the per-IP limits would throttle everyone behind the proxy together.
      const proxyAddress = config.public && isPrivateAddress(ip);
      if (proxyAddress) {
        logLimit('per-IP limits skipped, TRUST_PROXY_HOPS looks wrong (client address is private or loopback)', ip, req);
      } else {
        const now = Date.now();
        const times = upgradeTimes.get(ip) ?? [];
        while (times.length && times[0] <= now - UPGRADE_WINDOW_MS) times.shift();
        if (times.length >= config.upgradesPerIp) {
          upgradeTimes.set(ip, times);
          logLimit('per-IP upgrade rate limit hit', ip, req);
          return { status: 429, reason: 'Too Many Requests' };
        }
        times.push(now);
        upgradeTimes.set(ip, times);
      }
      if (sockets.connections.size >= config.maxConnections) return { status: 503, reason: 'Service Unavailable' };
      if (!proxyAddress && (perIp.get(ip) ?? 0) >= config.maxConnPerIp) {
        logLimit('per-IP connection cap hit', ip, req);
        return { status: 429, reason: 'Too Many Requests' };
      }
      return true;
    },
    onConnection(conn, req) {
      const ip = clientIp(req, config.trustProxyHops);
      conn.data.ip = ip;
      conn.data.ipTrusted = !(config.public && isPrivateAddress(ip));
      conn.data.forwardedEntries = forwardedEntries(req);
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      conn.on('close', () => {
        const left = (perIp.get(ip) ?? 1) - 1;
        if (left > 0) perIp.set(ip, left);
        else perIp.delete(ip);
      });
      hub.attach(conn);
    },
  });

  return {
    server,
    hub,
    sockets,
    config,
    /** @returns {Promise<number>} the port actually bound */
    listen(port = config.port, host = config.host) {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolveListen(server.address().port);
        });
      });
    },
    close() {
      clearInterval(upgradeSweep);
      hub.close();
      sockets.close();
      server.closeAllConnections?.();
      return new Promise((resolveClose) => (server.listening ? server.close(() => resolveClose()) : resolveClose()));
    },
  };
}

function printBanner(config) {
  if (config.public) {
    console.log(`Card Games online host listening on port ${config.port}; allowed origins: ${config.allowedOrigins.join(', ')}`);
    return;
  }
  const addresses = lanAddresses();
  const line = '─'.repeat(54);
  console.log(`\n${line}`);
  console.log('  Card Games — local network host');
  console.log(line);
  console.log(`  This machine : http://localhost:${config.port}`);
  if (addresses.length) {
    for (const entry of addresses) {
      console.log(`  On the LAN   : http://${entry.address}:${config.port}   (${entry.name})`);
    }
    console.log('\n  Everyone opens one of the LAN addresses in a browser,');
    console.log('  then Local multiplayer → Join room and types the code.');
  } else {
    console.log('  No private network address found. Other devices will not be');
    console.log('  able to reach this host until it joins a Wi-Fi or LAN.');
  }
  console.log(`${line}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const app = createAppServer();
  app.listen().then(() => printBanner(app.config));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}
