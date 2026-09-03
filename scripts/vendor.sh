#!/usr/bin/env bash
# Bundles spoor into a single edge-safe ESM file for a site that cannot install
# from npm yet.
#
#   ./scripts/vendor.sh /path/to/site/lib/spoor
#
# Delete the vendored copy and `npm i @spoor/middleware @spoor/sinks` once the
# packages are published.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?usage: vendor.sh <output-dir>}"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"

mkdir -p "$OUT"
"$ROOT/node_modules/.bin/esbuild" "$ROOT/scripts/vendor-entry.mjs" \
  --bundle --format=esm --platform=neutral --target=es2022 \
  --outfile="$OUT/index.mjs" --log-level=warning \
  --banner:js="// GENERATED — do not edit.
// Bundled from github.com/varunmahajan1/spoor @ ${SHA}
//
// Vendored rather than installed because spoor is not on npm yet, and Vercel
// installs this site's dependencies from package.json. Regenerate with
// spoor's scripts/vendor.sh; replace with \`npm i @spoor/middleware
// @spoor/sinks\` once published.
//
// Edge-safe: no node: builtins, no dependencies, no filesystem access."

if grep -qE "from ['\"]node:" "$OUT/index.mjs"; then
  echo "ERROR: a node: builtin reached the bundle — it would break an edge runtime" >&2
  exit 1
fi
echo "vendored $(wc -c < "$OUT/index.mjs" | tr -d ' ') bytes → $OUT/index.mjs (spoor @ $SHA)"
