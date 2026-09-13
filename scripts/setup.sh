#!/usr/bin/env bash
# Wire node_modules so tsc and the test/run-*.mjs jiti suites resolve pi's real .d.ts
# and runtime packages, and check the installed pi against PI_VERSION.
#
# Normal path: `npm ci` at the repo root installs the PINNED pi (package.json) plus
# jiti/typescript. npm hoists @earendil-works/pi-ai next to pi-coding-agent; typebox
# (used by pi-ai's `Type`) stays nested under pi-coding-agent, so we link it up.
#
# Fallback (no npm / offline): PI_ROOT=/path/to/@earendil-works/pi-coding-agent links
# everything from an existing pi install; else the `pi` on PATH is located and used.
#
# Local-first matters beyond convenience — it keeps the tsc gate honest: we typecheck
# against the same pi version the launchers run.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"
PINNED="$(cat "$REPO/PI_VERSION")"
NM="$REPO/node_modules"
mkdir -p "$NM/@earendil-works"

ROOT=""
if [ -f "$NM/@earendil-works/pi-coding-agent/package.json" ]; then
  ROOT="$NM/@earendil-works/pi-coding-agent"
  echo "using repo-local pi (npm ci): $ROOT"
elif [ -n "${PI_ROOT:-}" ] && [ -f "$PI_ROOT/package.json" ]; then
  ROOT="$PI_ROOT"
  echo "using PI_ROOT: $ROOT"
  ln -sfn "$ROOT" "$NM/@earendil-works/pi-coding-agent"
else
  PI="$(command -v pi || true)"
  [ -n "$PI" ] || {
    echo "pi not found. Run 'npm ci' here first (installs the pinned pi), or set PI_ROOT." >&2
    exit 1
  }
  ROOT="$(dirname "$(dirname "$(realpath "$PI")")")"   # dist/cli.js -> package root
  [ -f "$ROOT/package.json" ] || { echo "not a pi package root: $ROOT" >&2; exit 1; }
  echo "WARNING: repo-local pi missing; falling back to PATH pi: $ROOT" >&2
  ln -sfn "$ROOT" "$NM/@earendil-works/pi-coding-agent"
fi

VER="$(node -p "require('$ROOT/package.json').version")"
echo "pi version $VER, pinned $PINNED"
[ "$VER" = "$PINNED" ] || echo "WARNING: version drift vs PI_VERSION — re-run tsc + suites before trusting results." >&2

# Link what npm did not hoist. `-e` (exists) so an npm-installed copy is never clobbered.
link_if_missing() { # <published name> <source path under pi>
  local name="$1" src="$2"
  [ -e "$NM/$name" ] && return 0
  [ -e "$src" ] || { echo "missing in pi install: $src" >&2; return 1; }
  mkdir -p "$(dirname "$NM/$name")"
  ln -sfn "$src" "$NM/$name"
  echo "linked $name -> $src"
}
link_if_missing @earendil-works/pi-ai  "$ROOT/node_modules/@earendil-works/pi-ai"
link_if_missing @earendil-works/pi-tui "$ROOT/node_modules/@earendil-works/pi-tui"
link_if_missing typebox                "$ROOT/node_modules/typebox"
link_if_missing jiti                   "$ROOT/node_modules/jiti"
link_if_missing @types/node            "$ROOT/node_modules/@types/node"

for p in @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui typebox jiti @types/node; do
  [ -e "$NM/$p" ] || { echo "BROKEN link: node_modules/$p" >&2; exit 1; }
done

echo "node_modules ready. Next:  npm run typecheck && npm test"
