# Fonts

**Bricolage Grotesque**, by Mathieu Triay, licensed under the SIL Open Font
License 1.1 (`OFL.txt`). It carries the headings, buttons, labels and numbers.

The file here is the Latin subset of the variable font (weight 200–800, width
75–100%), saved into the repository rather than linked. The app is offline-first:
a `<link>` to a font CDN would mean the installed PWA rendered in a fallback face
with no network, and would tell a third party every time somebody opened the
table.

| File | Subset | Style |
| --- | --- | --- |
| `bricolage-latin.woff2` | latin | roman, variable weight and width |

Characters outside that subset — the suit pips ♠♥♣♦, the arrows, and any
Chinese — fall through to the next face in `--font-display` in
`styles/tokens.css`. Running text is set in the system sans (`--font`), not in
Bricolage.

To refresh it, take the `latin` file from the Google Fonts CSS for Bricolage
Grotesque and keep the `font-weight` and `font-stretch` ranges in the
`@font-face` rule in step with the axes the file carries.
