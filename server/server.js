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
 * No dependencies. Node 20 or newer.
 */

import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.js';
import { RoomHub } from './rooms.js';
import { lanAddresses, primaryAddress } from './lan.js';
import { DEFAULT_PORT } from '../src/net/roomcode.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const HOST = process.env.HOST || '0.0.0.0';

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

const hub = new RoomHub({ advertisedHost: primaryAddress(), port: PORT });

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/api/info') {
      return json(res, 200, {
        ok: true,
        host: primaryAddress(),
        port: PORT,
        addresses: lanAddresses(),
        rooms: hub.rooms.size,
      });
    }
    const file = resolvePath(url.pathname);
    if (!file) return json(res, 400, { error: 'bad path' });
    return await serve(res, file, req.method === 'HEAD');
  } catch (error) {
    return json(res, 500, { error: String(error?.message ?? error) });
  }
});

/** Resolve a URL path inside ROOT, refusing anything that climbs out of it. */
function resolvePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = join(ROOT, relative === '/' || relative === sep ? 'index.html' : relative);
  if (!target.startsWith(ROOT)) return null;
  return target;
}

async function serve(res, file, headOnly) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return json(res, 404, { error: 'not found' });
  }
  if (stat.isDirectory()) return serve(res, join(file, 'index.html'), headOnly);
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  if (headOnly) return res.end();
  return createReadStream(file).pipe(res);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': TYPES['.json'], 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

attachWebSocket(server, { path: '/lan', onConnection: (conn) => hub.attach(conn) });

server.listen(PORT, HOST, () => {
  const addresses = lanAddresses();
  const line = '─'.repeat(54);
  console.log(`\n${line}`);
  console.log('  Card Games — local network host');
  console.log(line);
  console.log(`  This machine : http://localhost:${PORT}`);
  if (addresses.length) {
    for (const entry of addresses) {
      console.log(`  On the LAN   : http://${entry.address}:${PORT}   (${entry.name})`);
    }
    console.log('\n  Everyone opens one of the LAN addresses in a browser,');
    console.log('  then Local multiplayer → Join room and types the code.');
  } else {
    console.log('  No private network address found. Other devices will not be');
    console.log('  able to reach this host until it joins a Wi-Fi or LAN.');
  }
  console.log(`${line}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    hub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
