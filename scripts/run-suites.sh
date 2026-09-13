#!/usr/bin/env bash
# Run every test/run-*.mjs jiti mock suite and fail loudly on the first one that does
# not pass. Each suite is gated on BOTH its exit code AND the literal "ALL PASSED"
# marker — silence must not masquerade as success.
#
# Hermetic env: the suites assume no scout/runner knobs are set (a model running this
# from inside a pi session inherits that session's env). Unset them and say so.
set -uo pipefail

cleared=()
for v in $(compgen -e); do
  case "$v" in
    SCOUT_*|RUNNER_*) unset "$v"; cleared+=("$v") ;;
  esac
done
[ ${#cleared[@]} -eq 0 ] || echo "  (cleared inherited env: ${cleared[*]})"

cd "$(dirname "$0")/.."

[ -e node_modules/jiti ] || {
  echo "node_modules missing — run: npm ci && bash scripts/setup.sh" >&2
  exit 1
}

pass=0 fail=0 failed=()
for f in test/run-*.mjs; do
  out="$(node "$f" 2>&1)"; rc=$?
  n="$(grep -c '^PASS' <<<"$out")"
  if [ $rc -eq 0 ] && grep -q "ALL PASSED" <<<"$out"; then
    printf "  PASS  %s (%s checks)\n" "$f" "$n"; pass=$((pass+1))
  else
    printf "  FAIL  %s (exit %d)\n" "$f" "$rc"; failed+=("$f")
    sed 's/^/        /' <<<"$out" | grep -v '^        PASS' | tail -25
    fail=$((fail+1))
  fi
done

echo
echo "mock suites: $pass passed, $fail failed"
[ $fail -eq 0 ] || { printf 'failing: %s\n' "${failed[*]}" >&2; exit 1; }
