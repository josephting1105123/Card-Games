# Card Games — working agreement

## Default workflow for any change a player can see

1. **Plan first.** Write the spec — what the player should see, in what order,
   with what timings and positions — before touching code. The spec is what the
   work is audited against, so it has to be specific enough to fail.
2. **Hand implementation to subagents.** Spawn `ui-implementer` agents (Sonnet,
   xhigh effort) with the spec. Split the work so two agents never hold the same
   file. Keep the auditing to the orchestrator.
3. **Audit in the app, not in the diff.** The orchestrator reloads the running
   app in Chromium, drives it to the state in question, samples the DOM through
   the transition, and looks at the screenshots. A green `npm test` is a
   precondition, never the evidence.
4. **Ship only what has been seen working.** Commit, PR, merge, then confirm the
   deploy.

The point of step 3: a build that is green from the code side and wrong on the
screen is a failed build. Every fix gets checked by seeing it.

## Verifying UI in this environment

There is no Chrome extension and no in-app browser here. The equivalent is
Playwright driving the pre-installed Chromium:

```js
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
```

Scripts go in the scratchpad, never in the repo. The one exception is
`tools/dealcheck.mjs` and friends: UI gates that live in the repo but are run by
hand, because CI has no browser. `npm test` stays browser-free.

Phone landscape is 844x390; also check 1280x720. The felt is reached with
`button.tile` -> `.tiles button.tile:nth-child(1)` -> `.lobby:not([disabled])`.

## Context

`.claude/settings.json` sets `autoCompactWindow` to 440000, so auto-compact
fires at roughly 350k tokens (it triggers at 80% of the assumed window). It is a
session-wide setting and applies to subagent contexts too.

## House rules

- Zero dependencies, no build step. ES modules are served exactly as written, so
  nothing may be added to package.json and nothing may require compiling.
- `src/games/` and `src/core/` never touch the DOM — the LAN host runs them.
- Animate transform and opacity only.
- Colours, type and motion curves live in `styles/tokens.css`; component sheets
  read them.
- `--card-w` is declared on `.table` and overridden only on cards. Never space a
  fan with a percentage margin: it resolves against the row, not the card.
- Run `node tools/stamp-sw.mjs` after changing any precached file.
- Comments explain why. No decorative ones.
