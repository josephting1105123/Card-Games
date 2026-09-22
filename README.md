# Card Games

A collection of classic card games in the browser. Dou Di Zhu (斗地主) is playable
now; the rest are queued and keep their place in the menu.

No build step, no dependencies, no accounts. The whole app is ES modules served
as-is, which is why it installs straight from GitHub Pages and why the local
network host is a single `node` command with nothing to install first.

```
npm test                  # 81 tests, about 1.5 seconds
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
root.

This needs one manual step, once: **Settings → Pages → Source → GitHub Actions**.
There is no way around it from inside the workflow — creating a Pages site is
beyond what the default `GITHUB_TOKEN` is allowed to do, and
`configure-pages`'s `enablement` input fails with *Resource not accessible by
integration*. Until it is set, the deploy job fails with *Get Pages site failed*;
after it is set, re-run the workflow and every later push deploys on its own.

The site then appears at `https://<user>.github.io/Card-Games/`. Open it and use
your browser's *Install* or *Add to Home Screen*: it is a PWA, caches itself on
first load, and then runs with no network at all.

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

Each table is priced by its **pot** — what each of the three seats puts up — and
every threshold in the game is counted in pots rather than set by hand, so the
ladder cannot drift out of step with itself:

| | In pots | At the starter table |
| --- | --- | --- |
| A stack, and the opening purse | 25 | 25,000 |
| Enough to sit down | 6 | 6,000 |
| Leaving the rescue table | 6 | 6,000 |
| Bankrupt below | 1 | 1,000 |

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
do it. Below **1,000** — one pot at the cheapest table, so you can no longer play
at all — you move to the **rescue table**: a 400 pot against the weakest bot,
where a loss cannot take your balance below zero.

You leave it at **6,000**, which is not a round number picked for the feel of it:
it is exactly the starter table's entry. Holding somebody in rescue past the
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
  host's own address. The app says this rather than failing mysteriously.
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

## Layout

```
index.html              app shell
sw.js                   service worker: precache everything, run offline
manifest.webmanifest    PWA manifest (installs landscape)
styles/tokens.css       palette, type scale, motion, elevation — the only :root
src/core/               cards, seeded RNG, Elo, chips and lobbies, coins, profile
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

### The type and the tokens

Everything is set in **EB Garamond** — menus, table, buttons and the card indices
alike. Nothing in the app uses a sans face, and a test enforces that.

The CSS follows the structure of the OffBridge site: `styles/tokens.css` owns the
palette, the fluid type scale, the motion curves, the radius and spacing steps and
the z-index order, and it is the only sheet with a `:root` block or an
`@font-face`. `app.css` and `table.css` read those variables and nothing else,
which a test also checks. The palette is this app's own — green baize, gold rule,
claret — and there is no light theme: a card table lit from above does not have
one.

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
the two ceilings and the bankruptcy cycle, Elo, coin formatting and the fact that
no real currency appears in the app, room codes, the WebSocket handshake and framing, a full two-client LAN
hand over a real socket, chip conservation when caps bite, a client vanishing
without a close frame, the offline manifest, and that no module imports a Node
built-in into the browser, sets anything in a sans face, or defines a design
token outside `tokens.css`.

## Licence

MIT. See `LICENSE`.
