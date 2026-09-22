# Fonts

**EB Garamond**, by the EB Garamond Project Authors, licensed under the SIL Open
Font License 1.1 (`OFL.txt`). A digital revival of Claude Garamont's sixteenth
century romans.

The files here are the Latin subsets of the variable font as served by Google
Fonts (weight axis 400–800), saved into the repository rather than linked. The
app is offline-first: a `<link>` to a font CDN would mean the installed PWA
rendered in a fallback face with no network, and would tell a third party every
time somebody opened the table.

| File | Subset | Style |
| --- | --- | --- |
| `eb-garamond-latin.woff2` | latin | roman |
| `eb-garamond-latin-ext.woff2` | latin-ext | roman |
| `eb-garamond-italic-latin.woff2` | latin | italic |

Characters outside those subsets — the suit pips ♠♥♣♦, the arrows, and any
Chinese — fall through to the next serif in the stack, which is what
`--font` in `styles/app.css` is for.

To refresh them, take the URLs from
`https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..800;1,400..700`
and keep the `unicode-range` values in step with the `@font-face` rules.
