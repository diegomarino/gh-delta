#!/usr/bin/env bash
# Regenerate the README example artifacts: fixtures -> casts -> SVG.
#
# Requires: node, npx (svg-term-cli@2.1.1), jq. Optional: rsvg-convert (local preview).
# Run from the repo root:  npm run examples:svg
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$ROOT/tools/examples/build"
IMG="$ROOT/docs/img"
WINDOW=(--window --padding 18)

echo "→ generating casts"
node "$ROOT/tools/examples/generate-cast.mjs" "$BUILD"

# End-of-stream timestamp (ms), minus a small margin, for a still final frame.
end_ms() {
  node -e '
    const fs = require("fs");
    const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").slice(1).map(JSON.parse);
    console.log(Math.max(0, Math.floor(rows[rows.length - 1][0] * 1000) - 100));
  ' "$1"
}

render_still() {
  local name="$1"
  echo "→ still  $name.svg"
  npx -y svg-term-cli@2.1.1 --in "$BUILD/$name.cast" --out "$IMG/$name.svg" "${WINDOW[@]}" \
    --at "$(end_ms "$BUILD/$name.cast")"
}

render_animated() {
  local name="$1"
  echo "→ anim   $name.svg"
  npx -y svg-term-cli@2.1.1 --in "$BUILD/$name.cast" --out "$IMG/$name.svg" "${WINDOW[@]}"
  node "$ROOT/tools/examples/add-progress-bar.mjs" "$IMG/$name.svg" "$BUILD/$name.cast"
}

render_animated demo
render_still usage
render_still text-output
render_still json-output

echo "✓ wrote SVGs to docs/img/"
echo "  (preview a still: rsvg-convert -z 2 docs/img/text-output.svg -o /tmp/preview.png)"
