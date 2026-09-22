# Card Games

A collection of classic card games in the browser. Dou Di Zhu (斗地主) is playable
now; the rest are queued and keep their place in the menu.

No build step, no dependencies, no accounts. The whole app is ES modules served
as-is, which is why it installs straight from GitHub Pages and why the local
network host is a single `node` command with nothing to install first.

```
npm test                  # 78 tests, about 1.5 seconds
node server/server.js     # host for local network play, also serves the app
```

## What is here

| Game | Status |
| --- | --- |
| **Dou Di Zhu** 斗地主 | Playable — single player and local multiplayer |
| Big Two 锄大地 | Planned, next in the queue |
| Blackjack (American and Malaysian) | Planned |
| Niu Niu 牛牛 | Planned |
| Texas Hold'em | Planned |

## Installing

**From GitHub Pages.** Push to `main` and the Pages workflow publishes the repo
root. In the repository settings, set Pages → Source → *GitHub Actions* once, and
the site appears at `https://<user>.github.io/Card-Games/`. Open it and use your
browser's *Install* or *Add to Home Screen*: it is a PWA, caches itself on first
load, and then runs with no network at all.

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

## Chips, tables and the loss cap

You start with **10,000 chips**. Each table is priced by its pot — what each of
the three seats puts up. Every table starts at a **×2 multiplier**, which is a
floor: points called, bombs and springs only raise it. The landlord settles for
twice a farmer.

| Table | Pot / person | Entry | Bots | Nominal rating | Max loss per hand |
| --- | --- | --- | --- | --- | --- |
| Rescue | 400 | — | Novice | 800 | your balance (no bankruptcy) |
| Starter | 1,000 | 1,000 | Casual | 1,000 | 6 × pot |
| Bronze | 10,000 | 12,000 | Steady | 1,200 | 4 × pot |
| Silver | 50,000 | 60,000 | Sharp | 1,400 | 3 × pot |
| Gold | 100,000 | 120,000 | Expert | 1,600 | 3 × pot |
| Ruby | 500,000 | 600,000 | Master | 1,800 | 2.5 × pot |
| Legend | 1,000,000 | 1,200,000 | Grandmaster | 2,000 | 2 × pot |

**Losses are capped twice**: by the table (pot × its cap factor) and by your
bankroll — no single hand can take more than 60% of what you hold. That second cap
is the one that makes the big rooms playable: walk into the 1M table with a bad
hand and you cannot be wiped out in one deal. Winnings are never capped.

**Bankruptcy is still reachable**, because a run of capped losses grinds you down.
Below 1,000 chips you are moved to the **rescue table**: a 400 pot against the
weakest bot, where a loss cannot take your balance below zero, until you hold
2,000 again. Then the normal rooms reopen.

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
sets the pot, the starting chips, the base multiplier, the loss cap and how many
of the three seats people take — bots fill the rest.

The host is authoritative: it shuffles, runs the bots, validates every move
against the same rules module the browser uses, and sends each seat only that
seat's hand. If someone drops mid-hand a bot takes the seat so the table does not
wedge.

Two things worth knowing:

- **The host serves the app as well as the rooms.** That is deliberate. A page
  loaded from GitHub Pages over HTTPS is not allowed by the browser to open a
  plain `ws://` connection to a private address, so LAN play needs everyone on the
  host's own address. The app says this rather than failing mysteriously.
- **A room keeps its own score, in its own currency.** Single player is always in
  Chips; a room defaults to ringgit and the host can pick from ringgit, Singapore
  and US dollars, pounds, euro, yuan, Taiwan dollars, points or matchsticks. The
  minimum pot is 1, so a room can be priced at RM 5 rather than five thousand of
  something. Room balances never touch your single-player purse or your Elo.
- **The currency is a label.** There are no payments, no transfers and no way to
  move a balance off the device. Choosing "RM" writes RM in front of a number,
  exactly like writing it on a scorepad.

The WebSocket server is implemented here (`server/ws.js`, ~230 lines) rather than
pulled from npm, so hosting needs no install and there is no dependency tree to
audit.

## Layout

```
index.html              app shell
sw.js                   service worker: precache everything, run offline
manifest.webmanifest    PWA manifest (installs landscape)
src/core/               cards, seeded RNG, Elo, chips and lobbies, currency, profile
src/games/doudizhu/     rules, move generation, engine, bot, match runner
src/ui/                 card art, table view, screens, solo controller
src/net/                room codes, wire protocol, LAN client
server/                 static + WebSocket host, rooms, LAN addresses
assets/fonts/           EB Garamond, self-hosted (OFL)
tools/                  icon generator, bot simulator
test/                   64 tests, node:test, no runner to install
```

`src/games/**` and `src/core/**` never touch the DOM — the LAN host imports the
same files — and a test enforces it.

### The cards

Drawn as SVG at run time (`src/ui/cardart.js`): ivory stock with a double gold
rule, engraved indices, traditional pip layouts for the spot cards, quatrefoil
cartouches on the courts and aces, and a guilloche back in burgundy and gold. Suit
shapes live in one hidden symbol sheet that every card references, so a
twenty-card fan is cheap to build. The icons are drawn pixel by pixel and written
as PNG by `tools/make-icons.mjs` with nothing but `node:zlib`.

### The type

Everything is set in **EB Garamond** — menus, table, buttons and the card indices
alike. Nothing in the app uses a sans face, and a test enforces that.

The font is committed to the repository rather than linked from a font CDN
(`assets/fonts/`, SIL Open Font License, see the README there). A `<link>` to
Google Fonts would mean the installed app fell back to Times with no network, and
would tell a third party every time somebody opened a table. The Latin subsets
come to about 200 KB and are precached with everything else.

Two consequences worth knowing. Garamond has a small x-height, so the interface
runs a size or two larger than it would in a sans face and the small uppercase
labels are tracked out rather than shrunk. And anything outside the Latin subsets
— the suit pips ♠♥♣♦, the arrows, the Chinese titles — falls through to the next
serif in the stack, which is why `--font` lists a serif CJK face before the
generic fallbacks.

## Tests

```bash
npm test                     # everything
node --test test/rules.test.js
node tools/sim.mjs 3000      # bot ladder report
```

Covered: every combination type and rejection, the beats relation, move
generation, bidding, turn order, springs, deck conservation over 100 bot games,
the loss caps and the bankruptcy cycle, Elo, currency formatting and the room
default, room codes, the WebSocket handshake and framing, a full two-client LAN
hand over a real socket, chip conservation when caps bite, a client vanishing
without a close frame, the offline manifest, and that no module imports a Node
built-in into the browser or sets anything in a sans face.

## Licence

MIT. See `LICENSE`.
