# Example artifacts

The README screenshots and demo are **generated**, not hand-captured, so they
stay in lockstep with the report shape. A schema change to `lib/contract.mjs`
breaks `test/examples.test.mjs`, which forces a fixture update and a re-render.

## Files

| File                   | Role                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures.mjs`         | Frozen `report` objects — the single source of truth for the data shown.                                                                             |
| `generate-cast.mjs`    | Renders the fixtures through the **real** renderers (`lib/text-output.mjs`, `JSON.stringify`, `jq -C`) into asciicast v2 files. No network, no `gh`. |
| `render.sh`            | Turns casts into SVGs with `svg-term`. Wired to `npm run examples:svg`.                                                                              |
| `add-progress-bar.mjs` | Post-processes the animated `demo.svg` to overlay a bottom-edge playback progress bar (SMIL, synced to the loop duration).                           |
| `build/`               | Intermediate `.cast` files (git-ignored; regenerated on demand).                                                                                     |

Output SVGs land in `../../docs/img/`:
`demo.svg` (animated hero), `usage.svg`, `text-output.svg`, `json-output.svg`.

## Regenerate

```bash
npm run examples:svg      # fixtures -> casts -> docs/img/*.svg
```

Requirements: `node`, `npx` (pulls `svg-term-cli@2.1.1` on demand), and `jq`
(for the colored JSON sample). `rsvg-convert` is optional, for local preview:

```bash
rsvg-convert -z 2 docs/img/text-output.svg -o /tmp/preview.png
```

## Notes

- **Faithfulness:** every terminal line is produced by the same code paths the
  CLI uses, so the artifacts match a live run byte-for-byte. `ci`/`reviews`
  digests are opaque by design (see the `opaque: true` detail rows).
- **Determinism:** timing jitter comes from a seeded LCG, so regenerating an
  unchanged fixture yields an identical cast — a stable git diff.
- **Animated SVG preview:** `svg-term` animates via CSS; `rsvg-convert` renders
  only the first frame. Use `--at <ms>` for a specific still, or open the SVG in
  a browser. GitHub renders the animation correctly.
- **Styling conventions:** typed commands render in bold bright white so they
  stand out from normal-weight output; still frames auto-size the terminal height
  so nothing scrolls off; the animated demo carries a bottom progress bar so a
  deliberate pause never looks frozen.
