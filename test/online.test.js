import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createAppServer, clientIp, originAllowed } from '../server/server.js';
import { S2C } from '../src/net/protocol.js';

const PAGES = 'https://josephting1105123.github.io';
// Under PUBLIC a loopback client address is read as a proxy's and exempt from the per-IP
// limits, so tests of those limits arrive "through a proxy" from a routable address.
const FROM = { 'X-Forwarded-For': '203.0.113.9' };

async function start(options = {}) {
  const app = createAppServer({ public: true, log: () => {}, ...options });
  const port = await app.listen(0, '127.0.0.1');
  return { app, port };
}

/**
 * A bare-bones client over a TCP socket. Node's built-in WebSocket can't set an
 * Origin header, and the point of these tests is what the server does with one.
 */
function rawConnect(port, { origin, host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const lines = [
      'GET /lan HTTP/1.1',
      `Host: ${host ?? `127.0.0.1:${port}`}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
    ];
    if (origin !== undefined) lines.push(`Origin: ${origin}`);
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    let buffer = Buffer.alloc(0);
    let status = null;
    const client = { socket, frames: [], waiters: [], get status() { return status; } };

    const drain = () => {
      while (buffer.length >= 2) {
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + length) return;
        client.frames.push({ opcode: buffer[0] & 0x0f, payload: buffer.subarray(offset, offset + length) });
        buffer = buffer.subarray(offset + length);
      }
      for (const waiter of client.waiters.splice(0)) waiter();
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (status === null) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer.subarray(0, end).toString())[1]);
        buffer = buffer.subarray(end + 4);
        resolve(client);
      }
      drain();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      client.closed = true;
      if (status === null) reject(new Error('closed before a response'));
      for (const waiter of client.waiters.splice(0)) waiter();
    });
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  });
}

/** Wait until `find` returns something truthy from the frames or the socket closes. */
async function until(client, find) {
  for (;;) {
    const found = find(client.frames);
    if (found) return found;
    if (client.closed) throw new Error('socket closed first');
    await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), 2000);
      client.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
    if (!find(client.frames) && !client.closed) throw new Error('timed out waiting for a frame');
  }
}

function maskedText(text) {
  const body = Buffer.from(text, 'utf8');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(body.map((byte, i) => byte ^ mask[i & 3]));
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
}

/** Any opcode, optionally unfinished (fin: false) or past 125 bytes, masked as a client must. */
function maskedFrame(opcode, payload, { fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(body.map((byte, i) => byte ^ mask[i & 3]));
  const first = (fin ? 0x80 : 0) | opcode;
  let header;
  if (body.length < 126) {
    header = Buffer.from([first, 0x80 | body.length]);
  } else {
    header = Buffer.from([first, 0x80 | 126, body.length >> 8, body.length & 0xff]);
  }
  return Buffer.concat([header, mask, masked]);
}

const sendJson = (client, value) => client.socket.write(maskedText(JSON.stringify(value)));
const closeCode = (frames) => {
  const close = frames.find((f) => f.opcode === 0x8);
  return close ? close.payload.readUInt16BE(0) : null;
};
const errorWithCode = (code) => (frames) => frames.find(
  (f) => f.opcode === 0x1 && JSON.parse(f.payload.toString()).code === code,
);
const roomFrame = (frames) => frames.find((f) => f.opcode === 0x1 && JSON.parse(f.payload.toString()).t === S2C.ROOM);
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const finish = async (app, clients = []) => {
  for (const client of clients) client.socket.destroy();
  await app.close();
};

test('/healthz answers ok with a permissive CORS header and no caching', async () => {
  const { app, port } = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const head = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'HEAD' });
    assert.equal(head.status, 200);
  } finally {
    await finish(app);
  }
});

test('an upgrade is refused for a foreign Origin and accepted for allowed or absent ones', async () => {
  const { app, port } = await start();
  const clients = [];
  try {
    const bad = await rawConnect(port, { origin: 'https://evil.example' });
    assert.equal(bad.status, 403);
    clients.push(bad);
    for (const origin of [PAGES, `${PAGES}/`, 'https://www.entropicsoftwarelabs.com', `http://127.0.0.1:${port}`, undefined]) {
      const ok = await rawConnect(port, { origin });
      clients.push(ok);
      assert.equal(ok.status, 101, `origin ${origin} should be accepted`);
    }
  } finally {
    await finish(app, clients);
  }
});

test('a private-network http Origin is refused in public mode and accepted otherwise', async () => {
  const origin = 'http://192.168.1.20:8787';
  const pub = await start({ public: true });
  const lan = await start({ public: false });
  const clients = [];
  try {
    const refused = await rawConnect(pub.port, { origin });
    clients.push(refused);
    assert.equal(refused.status, 403);
    for (const allowed of [origin, 'http://localhost:5173', 'http://10.0.0.4', 'http://172.20.1.1:8787']) {
      const accepted = await rawConnect(lan.port, { origin: allowed });
      clients.push(accepted);
      assert.equal(accepted.status, 101, `${allowed} should be accepted off the public host`);
    }
    const stillRefused = await rawConnect(lan.port, { origin: 'https://evil.example' });
    clients.push(stillRefused);
    assert.equal(stillRefused.status, 403);
    const publicAddress = await rawConnect(lan.port, { origin: 'http://8.8.8.8' });
    clients.push(publicAddress);
    assert.equal(publicAddress.status, 403);
  } finally {
    for (const client of clients) client.socket.destroy();
    await pub.app.close();
    await lan.app.close();
  }
});

test('the per-IP cap answers 429 to the connection past the limit and frees a slot on close', async () => {
  const { app, port } = await start({ maxConnPerIp: 2, trustProxyHops: 1 });
  const clients = [];
  try {
    const first = await rawConnect(port, { headers: FROM });
    const second = await rawConnect(port, { headers: FROM });
    clients.push(first, second);
    assert.equal(first.status, 101);
    assert.equal(second.status, 101);
    const third = await rawConnect(port, { headers: FROM });
    clients.push(third);
    assert.equal(third.status, 429);

    // A bare FIN leaves the server side half-open until the next heartbeat, so say goodbye properly.
    first.socket.write(Buffer.from([0x88, 0x80, 1, 2, 3, 4]));
    for (let i = 0; i < 50 && app.sockets.connections.size > 1; i++) await new Promise((r) => setTimeout(r, 20));
    const fourth = await rawConnect(port, { headers: FROM });
    clients.push(fourth);
    assert.equal(fourth.status, 101, 'closing a connection frees its slot');
  } finally {
    await finish(app, clients);
  }
});

test('forwarded addresses are counted from the right, by the configured number of hops', () => {
  const req = (xff) => ({ socket: { remoteAddress: '10.0.0.1' }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2, 3.3.3.3'), 0), '10.0.0.1');
  assert.equal(clientIp(req('9.9.9.9, 1.1.1.1, 2.2.2.2, 3.3.3.3'), 3), '1.1.1.1');
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2'), 3), '1.1.1.1', 'a short list falls back to the leftmost');
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2'), 1), '2.2.2.2');
  assert.equal(clientIp(req(undefined), 3), '10.0.0.1');
  const policy = { allowedOrigins: [PAGES], public: true };
  assert.equal(originAllowed({ headers: { origin: 'null', host: 'x' } }, policy), false);
});

test('the per-IP cap follows X-Forwarded-For when proxies are trusted', async () => {
  const { app, port } = await start({ maxConnPerIp: 1, trustProxyHops: 1 });
  const clients = [];
  try {
    const a = await rawConnect(port, { headers: { 'X-Forwarded-For': '7.7.7.7' } });
    const b = await rawConnect(port, { headers: { 'X-Forwarded-For': '8.8.8.8' } });
    const again = await rawConnect(port, { headers: { 'X-Forwarded-For': '7.7.7.7' } });
    clients.push(a, b, again);
    assert.equal(a.status, 101);
    assert.equal(b.status, 101, 'a different client address has its own allowance');
    assert.equal(again.status, 429);
  } finally {
    await finish(app, clients);
  }
});

test('41 messages inside ten seconds close the connection with 1008', async () => {
  const { app, port } = await start();
  const clients = [];
  try {
    const client = await rawConnect(port);
    clients.push(client);
    for (let i = 0; i < 41; i++) client.socket.write(maskedText('{}'));
    const close = await until(client, (frames) => frames.find((f) => f.opcode === 0x8));
    assert.equal(close.payload.readUInt16BE(0), 1008);
    assert.equal(close.payload.subarray(2).toString(), 'too many messages');
  } finally {
    await finish(app, clients);
  }
});

test('40 messages are fine', async () => {
  const { app, port } = await start();
  const clients = [];
  try {
    const client = await rawConnect(port);
    clients.push(client);
    for (let i = 0; i < 40; i++) client.socket.write(maskedText('{}'));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(client.frames.some((f) => f.opcode === 0x8), false);
    assert.notEqual(client.closed, true);
  } finally {
    await finish(app, clients);
  }
});

test('WELCOME advertises no host in public mode', async () => {
  const { app, port } = await start({ public: true });
  const clients = [];
  try {
    const client = await rawConnect(port, { origin: PAGES });
    clients.push(client);
    const frame = await until(client, (frames) => frames.find((f) => f.opcode === 0x1));
    const welcome = JSON.parse(frame.payload.toString());
    assert.equal(welcome.t, S2C.WELCOME);
    assert.equal(welcome.host, null);
  } finally {
    await finish(app, clients);
  }
});

const closeFrame = (frames) => frames.find((f) => f.opcode === 0x8);

test('a lobby is deleted the moment its last member leaves', async () => {
  const { app, port } = await start();
  const clients = [];
  try {
    const client = await rawConnect(port);
    clients.push(client);
    sendJson(client, { t: 'create', name: 'A' });
    await until(client, roomFrame);
    assert.equal(app.hub.rooms.size, 1);
    sendJson(client, { t: 'leave' });
    for (let i = 0; i < 50 && app.hub.rooms.size > 0; i++) await settle(20);
    assert.equal(app.hub.rooms.size, 0);
  } finally {
    await finish(app, clients);
  }
});

test('one address can hold only maxRoomsPerIp live rooms', async () => {
  const { app, port } = await start({ maxRoomsPerIp: 2, trustProxyHops: 1 });
  const clients = [];
  try {
    for (let i = 0; i < 2; i++) {
      const client = await rawConnect(port, { headers: FROM });
      clients.push(client);
      sendJson(client, { t: 'create', name: `P${i}` });
      await until(client, roomFrame);
    }
    const third = await rawConnect(port, { headers: FROM });
    clients.push(third);
    sendJson(third, { t: 'create', name: 'P2' });
    await until(third, errorWithCode('rate_limited'));
    assert.equal(app.hub.rooms.size, 2);

    // Leaving frees an allowance.
    sendJson(clients[0], { t: 'leave' });
    for (let i = 0; i < 50 && app.hub.rooms.size > 1; i++) await settle(20);
    sendJson(third, { t: 'create', name: 'P2' });
    await until(third, roomFrame);
  } finally {
    await finish(app, clients);
  }
});

test('a 126-byte ping closes the connection with 1002', async () => {
  const { app, port } = await start();
  const clients = [];
  try {
    const client = await rawConnect(port);
    clients.push(client);
    client.socket.write(maskedFrame(0x9, Buffer.alloc(126)));
    const close = await until(client, closeFrame);
    assert.equal(close.payload.readUInt16BE(0), 1002);
  } finally {
    await finish(app, clients);
  }
});

test('a fragmented control frame closes the connection with 1002', async () => {
  const { app, port } = await start();
  const clients = [];
  try {
    const client = await rawConnect(port);
    clients.push(client);
    client.socket.write(maskedFrame(0x9, 'hi', { fin: false }));
    const close = await until(client, closeFrame);
    assert.equal(close.payload.readUInt16BE(0), 1002);
  } finally {
    await finish(app, clients);
  }
});

test('a message of more than 64 fragments closes the connection', async () => {
  const { app, port } = await start();
  const clients = [];
  try {
    const client = await rawConnect(port);
    clients.push(client);
    client.socket.write(maskedFrame(0x1, 'x', { fin: false }));
    for (let i = 0; i < 70; i++) client.socket.write(maskedFrame(0x0, 'x', { fin: false }));
    const close = await until(client, closeFrame);
    assert.ok([1002, 1008].includes(close.payload.readUInt16BE(0)));
  } finally {
    await finish(app, clients);
  }
});

test('unfinished continuation frames count toward the flood limit', async () => {
  const { app, port } = await start();
  const clients = [];
  try {
    const client = await rawConnect(port);
    clients.push(client);
    client.socket.write(maskedFrame(0x1, 'x', { fin: false }));
    for (let i = 0; i < 45; i++) client.socket.write(maskedFrame(0x0, 'x', { fin: false }));
    const close = await until(client, closeFrame);
    assert.equal(close.payload.readUInt16BE(0), 1008);
  } finally {
    await finish(app, clients);
  }
});

test('pings count toward the flood limit', async () => {
  const { app, port } = await start();
  const clients = [];
  try {
    const client = await rawConnect(port);
    clients.push(client);
    for (let i = 0; i < 45; i++) client.socket.write(maskedFrame(0x9, ''));
    const close = await until(client, closeFrame);
    assert.equal(close.payload.readUInt16BE(0), 1008);
  } finally {
    await finish(app, clients);
  }
});

test('a client that half-closes frees its per-IP slot without waiting for the heartbeat', async () => {
  const { app, port } = await start({ maxConnPerIp: 1, trustProxyHops: 1 });
  const clients = [];
  try {
    const first = await rawConnect(port, { headers: FROM });
    clients.push(first);
    assert.equal(first.status, 101);
    first.socket.end();
    for (let i = 0; i < 50 && app.sockets.connections.size > 0; i++) await settle(20);
    const second = await rawConnect(port, { headers: FROM });
    clients.push(second);
    assert.equal(second.status, 101);
  } finally {
    await finish(app, clients);
  }
});

test('upgrades past the per-address rate are answered 429', async () => {
  const { app, port } = await start({ upgradesPerIp: 3, trustProxyHops: 1 });
  const clients = [];
  try {
    for (let i = 0; i < 3; i++) {
      const ok = await rawConnect(port, { headers: FROM });
      clients.push(ok);
      assert.equal(ok.status, 101);
    }
    const limited = await rawConnect(port, { headers: FROM });
    clients.push(limited);
    assert.equal(limited.status, 429);
  } finally {
    await finish(app, clients);
  }
});

test('the global connection cap answers 503', async () => {
  const { app, port } = await start({ maxConnections: 1 });
  const clients = [];
  try {
    const first = await rawConnect(port);
    clients.push(first);
    assert.equal(first.status, 101);
    const second = await rawConnect(port);
    clients.push(second);
    assert.equal(second.status, 503);
  } finally {
    await finish(app, clients);
  }
});

test('PUBLIC_HOSTS refuses an upgrade whose Host is not listed, and an empty list checks nothing', async () => {
  const { app, port } = await start({ publicHosts: ['cards.example.com'] });
  const open = await start({ publicHosts: [] });
  const clients = [];
  try {
    const wrong = await rawConnect(port);
    clients.push(wrong);
    assert.equal(wrong.status, 403);
    const right = await rawConnect(port, { host: 'Cards.Example.com:443' });
    clients.push(right);
    assert.equal(right.status, 101, 'the port is ignored and the name is case-insensitive');
    const unchecked = await rawConnect(open.port, { host: 'anything.test' });
    clients.push(unchecked);
    assert.equal(unchecked.status, 101);
  } finally {
    for (const client of clients) client.socket.destroy();
    await app.close();
    await open.app.close();
  }
});

test('the public host does not serve hidden folders or the server and test sources', async () => {
  const pub = await start({ public: true });
  const lan = await start({ public: false });
  try {
    const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`).then((res) => res.status);
    assert.equal(await get(lan.port, '/server/server.js'), 200, 'the LAN host still serves everything');
    assert.equal(await get(lan.port, '/.claude/settings.json'), 200);
    for (const path of ['/.claude/settings.json', '/server/server.js', '/test/online.test.js', '/Server/server.js', '/%2eclaude/settings.json', '/src/../server/server.js']) {
      assert.equal(await get(pub.port, path), 404, `${path} should be refused`);
    }
    assert.equal(await get(pub.port, '/src/net/protocol.js'), 200);
    assert.equal(await get(pub.port, '/'), 200);
  } finally {
    await pub.app.close();
    await lan.app.close();
  }
});

test('five failed room lookups close the connection with 1008', async () => {
  const { app, port } = await start();
  const clients = [];
  try {
    const client = await rawConnect(port);
    clients.push(client);
    for (let i = 0; i < 5; i++) sendJson(client, { t: 'join', code: 'NOPE', name: 'X' });
    const close = await until(client, closeFrame);
    assert.equal(close.payload.readUInt16BE(0), 1008);
    assert.ok(errorWithCode('rate_limited')(client.frames), 'the last miss says why');
  } finally {
    await finish(app, clients);
  }
});

test('limits read from the environment are clamped to at least 1', async () => {
  const { readEnv } = await import('../server/server.js');
  const env = readEnv({ MAX_CONN_PER_IP: '0', UPGRADES_PER_IP: '-4', MAX_CONNECTIONS: 'abc', MAX_ROOMS: '', MAX_ROOMS_PER_IP: '2.9', PUBLIC: '1', PUBLIC_HOSTS: ' A.com , ,b.com ' });
  assert.equal(env.maxConnPerIp, 1);
  assert.equal(env.upgradesPerIp, 1);
  assert.equal(env.maxConnections, 1000);
  assert.equal(env.maxRooms, 300);
  assert.equal(env.maxRoomsPerIp, 2);
  assert.deepEqual(env.publicHosts, ['a.com', 'b.com']);
});

test('PUBLIC_HOSTS defaults to the custom domain on the public host, "*" opts out, and a private host checks nothing', async () => {
  const { readEnv } = await import('../server/server.js');
  assert.deepEqual(readEnv({ PUBLIC: '1' }).publicHosts, ['cards.entropicsoftwarelabs.com']);
  assert.deepEqual(readEnv({ PUBLIC: '1', PUBLIC_HOSTS: '  ' }).publicHosts, ['cards.entropicsoftwarelabs.com']);
  assert.deepEqual(readEnv({ PUBLIC: '1', PUBLIC_HOSTS: '*' }).publicHosts, []);
  assert.deepEqual(readEnv({ PUBLIC: '1', PUBLIC_HOSTS: 'A.com, b.com' }).publicHosts, ['a.com', 'b.com']);
  assert.deepEqual(readEnv({}).publicHosts, []);
  assert.deepEqual(readEnv({ PUBLIC_HOSTS: 'a.com' }).publicHosts, [], 'not public: no Host check');
});

test('a flood of disallowed-Origin upgrades does not spend the same address upgrade budget', async () => {
  const { app, port } = await start({ upgradesPerIp: 3, trustProxyHops: 1 });
  const clients = [];
  try {
    for (let i = 0; i < 6; i++) {
      const bad = await rawConnect(port, { origin: 'https://evil.example', headers: FROM });
      clients.push(bad);
      assert.equal(bad.status, 403);
    }
    for (let i = 0; i < 3; i++) {
      const ok = await rawConnect(port, { headers: FROM });
      clients.push(ok);
      assert.equal(ok.status, 101, `upgrade ${i + 1} is still inside the budget`);
    }
    const limited = await rawConnect(port, { headers: FROM });
    clients.push(limited);
    assert.equal(limited.status, 429);
  } finally {
    await finish(app, clients);
  }
});

test('a wrong Host is refused before it can spend an upgrade', async () => {
  const { app, port } = await start({ upgradesPerIp: 1, trustProxyHops: 1, publicHosts: ['cards.example.com'] });
  const clients = [];
  try {
    for (let i = 0; i < 3; i++) {
      const wrong = await rawConnect(port, { headers: FROM });
      clients.push(wrong);
      assert.equal(wrong.status, 403);
    }
    const right = await rawConnect(port, { host: 'cards.example.com', headers: FROM });
    clients.push(right);
    assert.equal(right.status, 101);
  } finally {
    await finish(app, clients);
  }
});

test('/api/info on the public host shows the caller derived address and the forwarded chain length', async () => {
  const { app, port } = await start({ trustProxyHops: 2 });
  const lan = await start({ public: false });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { headers: { 'X-Forwarded-For': '203.0.113.9, 198.51.100.1' } });
    const info = await res.json();
    assert.equal(info.clientAddress, '203.0.113.9');
    assert.equal(info.forwardedEntries, 2);
    const bare = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
    assert.equal(bare.forwardedEntries, 0);
    const local = await (await fetch(`http://127.0.0.1:${lan.port}/api/info`)).json();
    assert.equal('clientAddress' in local, false, 'the LAN host adds nothing');
  } finally {
    await app.close();
    await lan.app.close();
  }
});

test('a private derived address on the public host is exempt from the per-IP limits and says why', async () => {
  const logs = [];
  const { app, port } = await start({ upgradesPerIp: 2, maxConnPerIp: 1, maxRoomsPerIp: 1, log: (text) => logs.push(text) });
  const clients = [];
  try {
    for (let i = 0; i < 4; i++) {
      const client = await rawConnect(port);
      clients.push(client);
      assert.equal(client.status, 101, `connection ${i + 1} from a proxy address is not throttled`);
    }
    for (let i = 0; i < 2; i++) {
      sendJson(clients[i], { t: 'create', name: `P${i}` });
      await until(clients[i], roomFrame);
    }
    assert.equal(app.hub.rooms.size, 2, 'the per-IP room cap does not apply either');
    assert.equal(logs.length, 1, 'logged once, not once per request');
    assert.match(logs[0], /TRUST_PROXY_HOPS looks wrong/);
  } finally {
    await finish(app, clients);
  }
});

test('hitting a per-IP limit logs the address and chain length, at most once a minute', async () => {
  const logs = [];
  const { app, port } = await start({ upgradesPerIp: 1, trustProxyHops: 1, log: (text) => logs.push(text) });
  const clients = [];
  try {
    const first = await rawConnect(port, { headers: FROM });
    clients.push(first);
    for (let i = 0; i < 3; i++) {
      const limited = await rawConnect(port, { headers: FROM });
      clients.push(limited);
      assert.equal(limited.status, 429);
    }
    assert.equal(logs.length, 1);
    assert.match(logs[0], /203\.0\.113\.9/);
    assert.match(logs[0], /X-Forwarded-For entries 1/);
    assert.match(logs[0], /upgrade rate/);
  } finally {
    await finish(app, clients);
  }
});

test('a forwarded chain shorter than TRUST_PROXY_HOPS is warned about once', async () => {
  const logs = [];
  const { app, port } = await start({ trustProxyHops: 3, log: (text) => logs.push(text) });
  try {
    await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /1 entries but TRUST_PROXY_HOPS=3/);
    await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'X-Forwarded-For': 'a, b, c' } });
    assert.equal(logs.length, 1);
  } finally {
    await app.close();
  }
});

test('private and loopback addresses are recognised, mapped forms included', async () => {
  const { isPrivateAddress } = await import('../server/server.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '::1', 'fc00::1', 'fd12:3456::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['203.0.113.9', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '2001:db8::1', '::ffff:203.0.113.9', 'unknown', 'fe80::1']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});
