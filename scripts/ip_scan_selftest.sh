#!/usr/bin/env bash
# ip_scan_selftest.sh — positive control for scripts/ip_scan.sh.
#
# A gate that only ever says PASS proves nothing. This builds a throwaway git repo
# containing planted identifiers of every HIGH/MED class plus a private term, runs the
# scan against it, and asserts the scan FAILS. Then it plants nothing and asserts the
# scan PASSES. The planted strings are all fictional; the throwaway repo lives under
# mktemp and is deleted on exit. Runs with no model, no network.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCAN="$HERE/ip_scan.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

mkrepo() { # <dir>
  mkdir -p "$1" && cd "$1" && git init -q && git config user.email ci@example.com && git config user.name ci
  cp "$SCAN" ip_scan.sh
}

echo "== positive control: planted identifiers must FAIL the scan"
mkrepo "$T/dirty"
cat > notes.md <<'PLANT'
tenant: contoso-east
INC-20240117 opened by CORP\jdoe from 10.42.7.19
console: https://falcon.us-2.crowdstrike.com/_cid=abc
api_key = "sk_live_0123456789abcdef0123"
PLANT
git add -A && git commit -qm plant
if IP_SCAN_PRIVATE_TERMS="fictional-employer,Project Zebra" bash ip_scan.sh . "$T/out-dirty" > "$T/dirty.log" 2>&1; then
  echo "SELFTEST FAILED: scan passed a tree with planted identifiers"; cat "$T/dirty.log"; exit 1
fi
# every planted class must be individually caught
for pat in tenant case_ids domain_backslash_user rfc1918 vendor_console_urls secrets; do
  [ -s "$T/out-dirty/$pat.txt" ] || { echo "SELFTEST FAILED: pattern '$pat' missed its plant"; cat "$T/dirty.log"; exit 1; }
done
echo "   caught: tenant case_ids domain_backslash_user rfc1918 vendor_console_urls secrets"

echo "== private terms: a planted term must FAIL the scan"
mkrepo "$T/term"
echo "internal codename: Project Zebra (do not ship)" > note.txt
git add -A && git commit -qm plant
if IP_SCAN_PRIVATE_TERMS="fictional-employer, project zebra" bash ip_scan.sh . "$T/out-term" > "$T/term.log" 2>&1; then
  echo "SELFTEST FAILED: private term not caught"; cat "$T/term.log"; exit 1
fi
[ -s "$T/out-term/private_terms.txt" ] || { echo "SELFTEST FAILED: private_terms.txt empty"; cat "$T/term.log"; exit 1; }
echo "   caught: private_terms"

echo "== negative control: a clean tree must PASS"
mkrepo "$T/clean"
printf 'hello from 192.0.2.10 (RFC 5737 documentation range)\ncontact: dev@example.com\n' > note.txt
git add -A && git commit -qm clean
IP_SCAN_PRIVATE_TERMS="fictional-employer" bash ip_scan.sh . "$T/out-clean" > "$T/clean.log" 2>&1 \
  || { echo "SELFTEST FAILED: clean tree did not pass"; cat "$T/clean.log"; exit 1; }
echo "   clean tree passed"
echo "SELFTEST PASSED: scan fails on plants, passes on clean"
