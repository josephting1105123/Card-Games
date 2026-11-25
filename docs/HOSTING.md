# Card Games: hosting

Publishing to GitHub Pages and running the online multiplayer server. For playing on a local network, see the [README](../README.md#local-multiplayer).

## GitHub Pages

Push to `main` and the Pages workflow publishes the repo
root.

This needs one manual step, once: **Settings → Pages → Source → GitHub Actions**.
There is no way around it from inside the workflow — creating a Pages site is
beyond what the default `GITHUB_TOKEN` is allowed to do, and
`configure-pages`'s `enablement` input fails with *Resource not accessible by
integration*. Until it is set, the deploy job fails with *Get Pages site failed*;
after it is set, re-run the workflow and every later push deploys on its own.

The site then appears at **<https://josephting1105123.github.io/Card-Games/>**. Open it and use your browser's *Install* or
*Add to Home Screen*: it is a PWA, caches itself on first load, and then runs
with no network at all.

## Online play

The same `server/server.js` runs as a public host, so the GitHub Pages copy of the
app can play multiplayer: one player creates a room, shares the code or invite link,
and friends join from anywhere. `render.yaml` describes it as a Render Blueprint on
the **Entropic Software Labs** account: one free web service named `card-games`,
started with `node server/server.js`, health-checked on `/healthz`.

- **Domain.** `cards.entropicsoftwarelabs.com`. Add a CNAME in Cloudflare pointing
  at the service's `<name>.onrender.com` host, then add the domain under the
  service's Custom Domains. The app connects to `wss://cards.entropicsoftwarelabs.com/lan`.
- **Free-tier sleep.** Render stops an idle free service after about 15 minutes. The
  first game after a quiet spell waits about a minute for it to wake. Rooms live in
  memory, so a sleep or a deploy loses them. Open room pages ping `/healthz` every
  4 minutes to keep it awake.
- **Testing before DNS.** `?server=wss://…/lan` points the client at another host, but
  only on a page served from localhost: on the public page a crafted link could
  otherwise send players to someone else's server. Serve the app locally with
  `node server/server.js`, add `http://localhost:8787` to the service's
  `ALLOWED_ORIGINS` for the test, and open
  `http://localhost:8787/?server=wss://<name>.onrender.com/lan`. That host only takes
  WebSockets once `PUBLIC_HOSTS=*` is set (below); remove both again afterwards.
- **After the first deploy,** open `https://cards.entropicsoftwarelabs.com/api/info`
  and compare `clientAddress` with your real public address. `TRUST_PROXY_HOPS=3`
  matches Render behind Cloudflare, as measured for Quick Vote. If it shows a
  Cloudflare or Render address instead, the value is wrong: the server logs a warning
  and stops enforcing per-address limits for private addresses, but a wrong public
  proxy address would put every player in one bucket (3 rooms, 20 connections,
  10 connects per 10 seconds).
- **Host pin.** With `PUBLIC=1`, WebSockets are only accepted through
  `cards.entropicsoftwarelabs.com`. The onrender.com hostname has fewer proxies in
  front of it, so a client connecting there could write its own `X-Forwarded-For`
  entry and dodge the per-address limits.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | 8787 | Port to listen on. Render sets it. |
| `HOST` | `0.0.0.0` | Address to bind. |
| `PUBLIC` | unset | `1` for the online host: no LAN address is advertised and private-network origins are not trusted. |
| `ALLOWED_ORIGINS` | `https://josephting1105123.github.io`, `https://entropicsoftwarelabs.com`, `https://www.entropicsoftwarelabs.com` | Comma-separated origins allowed to open a WebSocket. A missing Origin and the server's own host are always allowed. Without `PUBLIC`, http pages on localhost and private addresses are allowed too. |
| `TRUST_PROXY_HOPS` | 0 | Proxies in front. The client is that many entries from the right in `X-Forwarded-For`; 0 uses the socket address. |
| `MAX_CONN_PER_IP` | 20 | Live WebSocket connections per client address; the next one gets a 429. |
| `UPGRADES_PER_IP` | 10 | WebSocket connects allowed per client address in any 10 seconds; more get a 429. |
| `MAX_CONNECTIONS` | 1000 | Live WebSocket connections in total; the next one gets a 503. |
| `MAX_ROOMS` | 300 | Rooms open at once. Empty rooms are dropped first when it is reached. |
| `MAX_ROOMS_PER_IP` | 3 | Rooms with players in them that one client address may have created. |
| `PUBLIC_HOSTS` | `cards.entropicsoftwarelabs.com` when `PUBLIC` is set | Comma-separated hostnames a WebSocket may connect through. `*` accepts any, for testing before DNS. Ignored without `PUBLIC`. |

A connection that sends more than 40 frames of any kind in 10 seconds is closed with
code 1008, and so is one that tries five room codes or resume tokens that don't exist.
