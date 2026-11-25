# Card Games: design notes

How the economy, the bots and the table rendering work, and why. The [README](../README.md) covers playing and running the app.

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

## Reading the table

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

## Keeping it fast

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

## The cards

Drawn as SVG at run time (`src/ui/cardart.js`): white stock with flat red and
black ink, indices in Bricolage Grotesque, traditional pip layouts for the spot
cards, a red joker and a black one, and a red back with a white lattice. Suit
shapes live in one hidden symbol sheet that every card references, so a
twenty-card fan is cheap to build. The icons are drawn pixel by pixel and written
as PNG by `tools/make-icons.mjs` with nothing but `node:zlib`.

## The type and the tokens

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
