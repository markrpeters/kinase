#!/usr/bin/env bash
# setup-private-terms.sh — fetch the author's private scan terms and install the
# pre-commit scan hook. Safe to run in any clone: if you are not the author the
# script prints one line and exits 0, and the scanner runs its public classes only.
#
# The terms live in the private repository markrpeters/public-repo-denylist as
# common.private. They are copied to scripts/ip_scan.private (git-ignored) and CI
# receives the same list through the IP_SCAN_PRIVATE_TERMS repository secret.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/.." && pwd)
DENYLIST_REPO=markrpeters/public-repo-denylist
OWNER=markrpeters
SCAN_OUT=scan-out

if ! gh auth status >/dev/null 2>&1 || [ "$(gh api user --jq .login 2>/dev/null)" != "$OWNER" ]; then
    echo "private scan terms unavailable; public classes only"; exit 0
fi

TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
if ! gh api -H 'Accept: application/vnd.github.raw+json' "repos/$DENYLIST_REPO/contents/common.private" > "$TMP" 2>/dev/null || [ ! -s "$TMP" ]; then
    echo "could not fetch common.private from $DENYLIST_REPO; keeping any existing scripts/ip_scan.private" >&2; exit 1
fi
N=$(grep -cv '^[[:space:]]*#\|^[[:space:]]*$' "$TMP")
mv "$TMP" "$HERE/ip_scan.private"; trap - EXIT
git -C "$ROOT" check-ignore -q scripts/ip_scan.private || { echo "scripts/ip_scan.private is NOT git-ignored; refusing to continue" >&2; exit 1; }
echo "loaded $N private terms into scripts/ip_scan.private (git-ignored)"

HOOK="$(git -C "$ROOT" rev-parse --git-path hooks)/pre-commit"
mkdir -p "$(dirname "$HOOK")"
cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
# Installed by scripts/setup-private-terms.sh: IP-safety scan, private terms required.
ROOT=$(git rev-parse --show-toplevel)
exec bash "$ROOT/scripts/ip_scan.sh" "$ROOT" "$ROOT/scan-out" --require-private
HOOKEOF
chmod +x "$HOOK"
echo "installed pre-commit hook at $HOOK (runs ip_scan.sh --require-private)"
