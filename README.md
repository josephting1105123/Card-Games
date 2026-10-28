# Card Games

### [▶ Play it here](https://josephting1105123.github.io/Card-Games/)

[![Deploy](https://github.com/josephting1105123/Card-Games/actions/workflows/pages.yml/badge.svg)](https://github.com/josephting1105123/Card-Games/actions/workflows/pages.yml)
[![Tests](https://github.com/josephting1105123/Card-Games/actions/workflows/ci.yml/badge.svg)](https://github.com/josephting1105123/Card-Games/actions/workflows/ci.yml)

A collection of classic card games in the browser. Dou Di Zhu (斗地主), Big Two
(锄大地) and Blackjack are playable now; the rest are queued and keep their
place in the menu.

Open the link above on a phone and add it to your home screen: it installs like
an app, opens full screen in landscape, and runs with no signal at all.

No build step, no dependencies, no accounts. The whole app is ES modules served
as-is, which is why it installs straight from GitHub Pages and why the local
network host is a single `node` command with nothing to install first.

```
npm test                  # 93 tests, about 1.5 seconds
node server/server.js     # host for local network play, also serves the app
```

## What is here

| Game | Status |
| --- | --- |
| **Dou Di Zhu** 斗地主 | Playable — single player and local multiplayer |
| **Big Two** 锄大地 | Playable — single player |
| **Blackjack** (American and Malaysian/Ban Luck) | Playable — single player |
| Niu Niu 牛牛 | Planned |
| Texas Hold'em | Planned |

## Installing

**From GitHub Pages.** Push to `main` and the Pages workflow publishes the repo
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

**From a folder.** Any static server works, or use the bundled one:

```bash
node server/server.js          # http://localhost:8787
PORT=9000 node server/server.js
```

The table is dealt across, so it wants landscape. On a phone in portrait the app
says so rather than squashing the fan.

## Dou Di Zhu rules

The default ("classic") rule set, no house variations.

- 54 cards, three players, 17 each, three face down for the landlord.
- `3 < 4 < … < K < A < 2 < small joker < big joker`.
- Bidding: in turn each player calls 1, 2 or 3 points or passes. A call must beat
  the standing call, a call of 3 ends bidding at once, and three passes redeal.
- The landlord takes the three face-down cards (20 in hand) and leads.
- Combinations: single, pair, trio, trio with a single or a pair, straight of five
  or more, three or more consecutive pairs, aeroplanes (consecutive trios, with
  single or pair wings), four with two, bombs, and the rocket. Chains may not pass
  the ace — 2s and jokers never join one.
- A bomb beats anything but a higher bomb or the rocket. The rocket beats
  everything.
- Stake multiplier = points called × 2 per bomb or rocket × 2 for a spring
  (landlord wins with neither farmer having played) or an anti-spring (farmers win
  and the landlord played only his opening hand).

## Big Two rules

52 cards, no jokers, four players, 13 each — no bidding, no bottom, everyone
plays their own hand from the deal.

- `3 < 4 < … < K < A < 2`; suits only ever break a tie, ranked `♦ < ♣ < ♥ < ♠`.
- Whoever holds the 3♦ leads the first trick and must include it in that lead.
- Combinations: single, pair, triple, or a five-card hand — Big Two has no
  four-card play of its own. Five-card hands rank straight < flush < full house
  < four of a kind (plus one kicker) < straight flush, regardless of the ranks
  involved, and ties within a type fall back to suit.
- Turns go counter-clockwise from you: right, then across, then left. Passing
  three times in a row clears the trick back to whoever is still standing, who
  leads next with anything they choose.
- A hand ends the instant a seat empties. Every seat still holding cards pays
  the winner `cards left × rate`, where rate is the table's pot ÷ 10 — flat,
  with no multiplier to compound it.

## Chips, tables and the loss cap

Each table is priced by its **pot** — what each of the three seats puts up — and
every threshold in the game is counted in pots rather than set by hand, so the
ladder cannot drift out of step with itself:

| | In pots | At the starter table |
| --- | --- | --- |
| A stack, and the opening purse | 25 | 25,000 |
| Enough to sit down | 6 | 6,000 |
| Leaving the rescue table | 6 | 6,000 |
| Rescue table opens below | 6 | 6,000 |

The swing of a hand is therefore the same share of your money whichever table you
sit at: a landlord at the base multiplier risks 4 pots, which is a sixth of a
stack everywhere.

Every table starts at a **×2 multiplier**, which is a floor: points called, bombs
and springs only raise it. The landlord settles for twice a farmer.

| Table | Pot / person | Entry (6 pots) | A full stack (25 pots) | Bots | Nominal rating |
| --- | --- | --- | --- | --- | --- |
| Rescue | 400 | — | 10,000 | Novice | 800 |
| Starter | 1,000 | 6,000 | 25,000 | Casual | 1,000 |
| Bronze | 10,000 | 60,000 | 250,000 | Steady | 1,200 |
| Silver | 50,000 | 300,000 | 1,250,000 | Sharp | 1,400 |
| Gold | 100,000 | 600,000 | 2,500,000 | Expert | 1,600 |
| Ruby | 500,000 | 3,000,000 | 12,500,000 | Master | 1,800 |
| Legend | 1,000,000 | 6,000,000 | 25,000,000 | Grandmaster | 2,000 |

**Why six pots to sit down.** It is the smallest stack at which an ordinary hand
is settled in full. A landlord at the base ×2 multiplier risks 4 pots, and the
bankroll cap allows 75% of the stack, so at five pots or fewer (0.75 × 5 = 3.75)
the emergency cap fires on a perfectly normal loss. A table you cannot lose an
ordinary hand at is a table you should not be sitting at, and the cap should be
for disasters rather than for Tuesdays.

So a fresh purse of 25,000 opens the starter table and nothing else. Bronze wants
60,000, which is a first milestone rather than a free gift.

### The two ceilings

**No single hand moves more than 50 pots**, won or lost. The landlord risks twice
a farmer, so exposure is `2 × multiplier` pots and that ceiling only bites past a
multiplier of 25 — in practice ×32 or more, which is three bombs and a spring on a
three-point call. It is a backstop against a runaway chain, not a routine clamp.

That distinction is the whole point. An earlier version capped at 6 pots, which
bites above a multiplier of **4**: every bomb past the first paid nothing, so the
doubling mechanic was decoration. A ceiling that binds on ordinary hands makes
winning flat and losing riskless in the same stroke.

**Losses are held down a second time, by bankroll**: never more than 75% of what
you hold. One disastrous hand cannot wipe you out, which is what makes the big
rooms playable — walk into the 1M table with a bad hand and a quarter of your
stack always survives. Winnings are *not* held down that way. A win you could not
have afforded to lose is the one worth having, so a landlord at ×16 collects all
32 pots whatever their balance.

**Bankruptcy is still reachable.** Two bad landlord hands from a fresh stack will
do it. Below **6,000** — the starter table's entry, so you can no longer sit at
any normal table — the **rescue table** opens: a 400 pot against the weakest bot.
Blackjack has one too, taking bets of 100 to 400 with no chips needed. Losses
there are capped at 75% of your balance, so a loss cannot take it below zero and
a bomb hand cannot wipe you out.

You leave it at **6,000**, the same number it opens at, which is not a round
number picked for the feel of it: it is exactly the starter table's entry, so
there is no balance at which nothing is playable. Holding somebody in rescue past the
point a normal table will have them is pointless, and releasing them before it
only sends them back — the earlier threshold of 2,000 handed a player two pots,
which one ordinary landlord hand took most of. Six pots is about a dozen net
hands at the 400 pot: a stint rather than a sentence.

## How the bots scale

The bot only ever sees a seat view: its own hand, everyone's card counts, the
played pile, and the three revealed bottom cards. Raising the difficulty means
better judgement, never more information.

Two dials do most of the work. **Accuracy** is the chance of playing the move the
evaluation ranked first; the rest of the time it samples a softmax over the
remaining moves, so a mistake is a plausible worse move rather than noise.
**Temperature** sets how far those slips wander. Three switches come on as the
stakes rise: not fighting your own partner, counting the played pile, and
discipline about breaking a bomb.

Measured over 4,000 identical deals per row, one bot of each strength against a
table of two "Steady" bots (`node tools/sim.mjs 4000`):

| Skill | Accuracy | Win rate | Chips per hand (stake units) |
| --- | --- | --- | --- |
| Novice | 0.45 | 37.8% | −1.10 |
| Casual | 0.62 | 46.0% | −0.32 |
| Steady | 0.72 | 50.3% | +0.10 |
| Sharp | 0.80 | 53.6% | +0.29 |
| Expert | 0.86 | 54.3% | +0.36 |
| Master | 0.92 | 55.9% | +0.49 |
| Grandmaster | 0.97 | 57.6% | +0.65 |

Two honest caveats. The nominal ratings in the table above are difficulty labels
used for the Elo arithmetic, not measured ratings — Dou Di Zhu is two against one
with a lot of luck, so even a large skill gap moves the win rate by tens of
points, not hundreds. And the evaluation is a hand-shape heuristic, not a search:
`estimatePlays` greedily decomposes a hand into playable groups in O(r²) over the
15 distinct ranks, which is an approximation of the true minimum, not the minimum
itself. The top table plays a strong club game, not a solved one.

## Elo

One rating per game, starting at 1,200. Standard Elo with the opponents' mean
rating standing in for a single opponent, K falling from 32 to 24 to 16 as the
rating rises, and a larger K for the first ten games so a new rating settles
quickly.

## Local multiplayer

Everyone on the same Wi-Fi, joined by a five-character code. One machine hosts:

```bash
node server/server.js
```

It prints a `http://192.168.x.x:8787` address. Everyone opens that address, picks
**Local multiplayer → Join room**, and types the code the host reads out. The host
sets the pot, the starting stack, the base multiplier, the hand ceiling and how many
of the three seats people take — bots fill the rest.

The host is authoritative: it shuffles, runs the bots, validates every move
against the same rules module the browser uses, and sends each seat only that
seat's hand. If someone drops mid-hand a bot takes the seat so the table does not
wedge.

Two things worth knowing:

- **The host serves the app as well as the rooms.** That is deliberate. A page
  loaded from GitHub Pages over HTTPS is not allowed by the browser to open a
  plain `ws://` connection to a private address, so LAN play needs everyone on the
  host's own address. The GitHub Pages copy plays through the online server
  instead (see Online play below).
- **A room deals its own coins.** Single player is a persistent purse of Chips
  with an Elo attached. A room's money is temporary: dealt out when the room
  opens, gone when it closes, never touching anybody's purse. The host picks
  **silver** for a quick game or **gold** for a heavy one — same arithmetic, no
  exchange rate, just the scale the table opens at: silver a pot of 10, gold a
  pot of 1,000. The stack follows the pot at 25× in both cases, and keeps
  following it as the host edits the pot until they type a stack of their own.
- **Nothing here stands for real money.** There are no real currencies in the
  app, no payments, no transfers, and no way to move a balance off the device. A
  test keeps it that way.

The WebSocket server is implemented here (`server/ws.js`, ~230 lines) rather than
pulled from npm, so hosting needs no install and there is no dependency tree to
audit.

### Online play

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

## Layout

```
index.html              app shell
sw.js                   service worker: precache everything, run offline
                        (its cache name is a hash of what it caches, stamped by
                        tools/stamp-sw.mjs and checked by the tests)
manifest.webmanifest    PWA manifest (installs landscape)
styles/tokens.css       palette, type scale, motion, elevation — the only :root
src/core/               cards, seeded RNG, Elo, chips and lobbies, coins, profile
src/games/doudizhu/     rules, move generation, engine, bot, match runner
src/ui/                 card art, table view, screens, solo controller
src/net/                room codes, wire protocol, LAN client
server/                 static + WebSocket host, rooms, LAN addresses
assets/fonts/           Bricolage Grotesque, self-hosted (OFL)
assets/textures/        the tablecloth print
tools/                  icon generator, bot simulator
test/                   64 tests, node:test, no runner to install
```

`src/games/**` and `src/core/**` never touch the DOM — the LAN host imports the
same files — and a test enforces it.

### Reading the table

The felt is laid out so it does not have to be read in words. Each play lands in
front of the seat that made it — left, right, or just above your own fan — and
the cards travel in from that seat as they appear, so who moved is answered by
where the cards are and how they got there. The play still standing is the bright
one; a finished trick greys out rather than blinking away, so you can see what
just happened.

A hand is dealt with a short shuffle-and-deal flourish, and when nothing in your
hand can answer what is on the table the whole fan greys out and stops
responding, leaving Pass as the only live control — said without a sentence.

There is exactly one caption on the felt: two words naming the play you have to
beat, under the play that stands. Everything else the table used to say — a
running commentary of "Rong (Casual): Pair 3", a bubble by each seat repeating
it, a pill for whose turn it is — is gone. The seat on turn is ringed, the pot
rides along with the table's name, and the only words left in the head-up display
are the coin you are counting in.

### Keeping it fast

The table is drawn for phones, so the render path is built around two rules.

**The deck's artwork exists once.** All 54 faces and the back are defined as SVG
`<symbol>`s at start-up; every card on the table is a `<use>` of one of them,
cloned from a two-node prototype. Before that, each card parsed a fresh SVG
document, and a single table update parsed forty-four of them. Colour and
typeface reach the artwork as inherited properties (`color`, `font-family`),
because outer CSS cannot select inside a `<use>` shadow tree.

**Nothing is rebuilt unless it changed.** The hand, the bottom three and the
bidding panel each carry a signature and skip the work when it matches; the
opponents' card backs are added and removed by the difference rather than torn
down. A bot playing one card used to re-make the whole twenty-card fan.

Shadows are `box-shadow` on the element rather than `filter: drop-shadow` on the
artwork, and every animation moves only `transform` and `opacity`.

Measured at 844x390 with the CPU throttled 6x, which is roughly a mid-range
phone:

| | Before | After |
| --- | --- | --- |
| One table update | 136 ms | 2.2 ms |
| Tap a card to painted | 260 ms | 20 ms |
| Building the deck's artwork | — | 33 ms, once |

**The menu loads only the menu.** Each table (`solo.js`, `big2.js`,
`blackjack.js`) is imported when you open it, and the deck's artwork is built by
the first table that needs it instead of at boot. Walking the static imports from
`src/main.js`, the menu went from 31 modules / 380 KB to 14 modules / 116 KB, and
the 33 ms artwork build no longer sits in front of the first paint. Once the menu
is up and idle, the Dou Di Zhu table is fetched in the background, since it is the
most common next tap; Big Two and Blackjack load on demand. (Module and size
counts are from the import graph, not a timed run.)

The LAN host (`server/server.js`) gzips text files (Blackjack's module goes from
69.8 KB to 19.2 KB on the wire) and answers `If-None-Match` with a 304, so
`no-cache` revalidation costs a header, not a download.

### The cards

Drawn as SVG at run time (`src/ui/cardart.js`): white stock with flat red and
black ink, indices in Bricolage Grotesque, traditional pip layouts for the spot
cards, a red joker and a black one, and a red back with a white lattice. Suit
shapes live in one hidden symbol sheet that every card references, so a
twenty-card fan is cheap to build. The icons are drawn pixel by pixel and written
as PNG by `tools/make-icons.mjs` with nothing but `node:zlib`.

### The type and the tokens

The look is the open-house card table from the
[Entropic Software Labs card games page](https://entropicsoftwarelabs.com/card-games/):
a cream vinyl tablecloth printed with red peonies and green leaves, a red banner
across the top, card-stock panels and red stool-coloured buttons. The OffBridge
site and the rest of entropicsoftwarelabs.com share a dark look with a green
accent, and this app keeps its own look, separate from both. Light is the only theme, as on that page. At
the table the print is laid under a cream wash so the cards read over it.

Headings, buttons, labels and the card indices are set in **Bricolage Grotesque**;
body text is the system sans face. A test checks that headings lead with
Bricolage and that nothing still names the old Garamond.

`styles/tokens.css` owns the palette, the fluid type scale, the motion curves, the
radius and spacing steps and the z-index order, and it is the only sheet with a
`:root` block or an `@font-face`. `app.css` and `table.css` read those variables
and nothing else, which a test also checks.

The font is committed to the repository rather than linked from a font CDN
(`assets/fonts/`, SIL Open Font License, see the README there). A `<link>` to
Google Fonts would mean the installed app fell back to a system face with no
network, and would tell a third party every time somebody opened a table. The
Latin subset is about 130 KB and is precached with the tablecloth texture and
everything else. Characters outside it, such as the suit glyphs and the Chinese
titles, fall through to the sans CJK faces listed in `--font-display`.

## Tests

```bash
npm test                     # everything
node --test test/rules.test.js
node tools/sim.mjs 3000      # bot ladder report
```

Covered: every combination type and rejection, the beats relation, move
generation, bidding, turn order, springs, deck conservation over 100 bot games,
the two ceilings and the bankruptcy cycle, Elo, coin formatting and the fact that
no real currency appears in the app, room codes, the WebSocket handshake and framing, a full two-client LAN
hand over a real socket, chip conservation when caps bite, a client vanishing
without a close frame, the offline manifest, and that no module imports a Node
built-in into the browser, sets anything in a sans face, or defines a design
token outside `tokens.css`.

## Licence

MIT. See `LICENSE`.
