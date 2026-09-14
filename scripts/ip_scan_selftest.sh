#!/usr/bin/env bash
# ip_scan_selftest.sh — positive control for scripts/ip_scan.sh.
#
# CANONICAL COPY: markrpeters/public-repo-denylist, scanner/ip_scan_selftest.sh.
# Vendored byte-for-byte into every consuming repository; see ip_scan.sh.
#
# A gate that only ever says PASS proves nothing. For every HIGH and MED class
# the scanner knows, this builds a throwaway git repo containing exactly one
# planted, fictional identifier of that class, runs the scan, and requires it
# to FAIL with a hit recorded under that class. LOW classes must record a hit
# but not fail the gate. A clean tree must PASS, and an unrunnable pattern
# must make the scan exit 2 rather than report zero hits. The throwaway repos
# live under mktemp and are deleted on exit. No model, no network.
#
# Before any of that it checks the vendored copy itself: the three scanner
# files must match the sha256 pin beside them (ip_scan.sha256), and when the
# hygiene source is present on this machine the pin must match the source's
# pin, so a copy that drifted from the canonical one fails here instead of
# scanning with stale patterns. The pin file lists ip_scan.sh,
# ip_scan_selftest.sh and setup-private-terms.sh; regenerate it at the source
# with `sha256sum ip_scan.sh ip_scan_selftest.sh setup-private-terms.sh > ip_scan.sha256`.
#
# Finally, if scripts/ip_scan.private is present, it reports the number of
# private terms the scanner loads from it, so every consuming repository can
# be checked for the SAME count (a truncated fetch shows up as a smaller one).
#
# Usage: scripts/ip_scan_selftest.sh
#   IP_SCAN_HYGIENE_DIR  directory holding the source pin (default:
#                        $HOME/public-repo-denylist/scanner); absent = skipped.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCAN="$HERE/ip_scan.sh"
PIN="$HERE/ip_scan.sha256"
HYGIENE="${IP_SCAN_HYGIENE_DIR:-$HOME/public-repo-denylist/scanner}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
# Pipe-joined regex alternatives exactly as CI supplies them; the middle term carries
# its own "|" inside a group and must count as ONE term (3 terms total).
PRIV='fictional-employer|proj(ect|) zebra|\bZBR[0-9]+\b'
failures=0

echo "== pin: the vendored scanner files must match ip_scan.sha256"
if [ ! -f "$PIN" ]; then
    echo "  FAILED: $PIN missing (vendor it with the scanner)"; failures=$((failures + 1))
elif (cd "$HERE" && sha256sum -c --quiet "$PIN" > "$T/pin.log" 2>&1); then
    echo "  $(wc -l < "$PIN") files match the pin"
else
    echo "  FAILED: vendored copy drifted from the pin"; sed 's/^/      /' "$T/pin.log"; failures=$((failures + 1))
fi
if [ -f "$HYGIENE/ip_scan.sha256" ] && [ -f "$PIN" ]; then
    if [ "$(cd "$HYGIENE" && pwd -P)" = "$(cd "$HERE" && pwd -P)" ]; then
        echo "  this is the hygiene source"
    elif cmp -s "$HYGIENE/ip_scan.sha256" "$PIN"; then
        echo "  pin matches the hygiene source"
    else
        echo "  FAILED: pin differs from the hygiene source at $HYGIENE (re-vendor)"; failures=$((failures + 1))
    fi
else
    echo "  hygiene source not present at $HYGIENE; pin check only"
fi

mkrepo() {  # mkrepo <dir> <planted line>
    mkdir -p "$1" && ( cd "$1" && git init -q && git config user.email ci@example.com \
        && git config user.name ci && printf '%s\n' "$2" > note.txt && git add -A && git commit -qm plant )
}

# plant <expect: fail|pass> <class> <line>
plant() {
    local expect=$1 cls=$2 line=$3 rc=0
    local dir="$T/$cls" out="$T/out-$cls"
    mkrepo "$dir" "$line"
    IP_SCAN_PRIVATE_TERMS="$PRIV" bash "$SCAN" "$dir" "$out" > "$T/$cls.log" 2>&1 || rc=$?
    local hits=0; [ -s "$out/$cls.txt" ] && hits=$(wc -l < "$out/$cls.txt")
    local ok=1
    if [ "$rc" -eq 2 ]; then ok=0
    elif [ "$hits" -eq 0 ]; then ok=0
    elif [ "$expect" = fail ] && [ "$rc" -eq 0 ]; then ok=0
    elif [ "$expect" = pass ] && [ "$rc" -ne 0 ]; then ok=0
    fi
    if [ "$ok" -eq 1 ]; then
        printf '  %-4s %-18s caught (%d hit, exit %d)\n' "$expect" "$cls" "$hits" "$rc"
    else
        printf '  %-4s %-18s MISSED (%d hits, exit %d)\n' "$expect" "$cls" "$hits" "$rc"
        sed 's/^/      /' "$T/$cls.log" | head -25
        failures=$((failures + 1))
    fi
}

echo "== one plant per class: HIGH/MED must fail the scan, LOW must record a hit"
plant fail case_ids         'ticket INC-20240117 raised overnight'
plant fail tenant           'tenant: contoso-east'
plant fail vendor_urls      'console https://falcon.us-2.crowdstrike.com/ for detail'
plant fail corp_hostnames   'host USNYC01APP7 rebooted'
plant fail emails           'contact jdoe@contoso.com for access'
plant fail user_home        'copied from /home/jdoe and C:\Users\jdoe\Desktop'
plant fail secrets          'api_key = "sk_live_0123456789abcdef0123"'
plant fail sha256           'hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
plant fail uuid             'id 123e4567-e89b-12d3-a456-426614174000'
plant fail private_terms    'internal codename: Project Zebra (do not ship)'
plant fail rfc1918          'source 10.42.7.19 on the lab segment'
plant fail internal_domains 'share on fs01.corp via SMB'
plant fail domain_user      'logon by CORP\jdoe at 09:14'
plant fail hostnames        'endpoint DESKTOP-AB12CD isolated'
plant pass public_ip        'resolver 8.8.8.8 answered'
plant pass realdata_words   'this was tested on real customer data'

echo "== term count: the private_terms line must report 3 terms for the 3-term list"
if grep -q 'private_terms.*(3 terms)' "$T/private_terms.log"; then
    echo "  3 terms counted"
else
    echo "  FAILED: term count not reported or wrong"; grep private_terms "$T/private_terms.log" | sed 's/^/      /'; failures=$((failures + 1))
fi

echo "== typescript: a .ts source must be scanned, not skipped by the type filter"
mkdir -p "$T/ts" && ( cd "$T/ts" && git init -q && git config user.email ci@example.com && git config user.name ci \
    && printf 'export const tenant = "contoso-east";\n' > leak.ts && git add -A && git commit -qm plant )
rc=0; IP_SCAN_PRIVATE_TERMS="$PRIV" bash "$SCAN" "$T/ts" "$T/out-ts" > "$T/ts.log" 2>&1 || rc=$?
if [ "$rc" -eq 1 ] && [ -s "$T/out-ts/tenant.txt" ]; then
    echo "  .ts file scanned (tenant caught, exit 1)"
else
    echo "  FAILED: .ts file skipped or scan exited $rc"; sed 's/^/      /' "$T/ts.log" | head -25; failures=$((failures + 1))
fi

echo "== pin file: a vendored ip_scan.sha256 must not trip the sha256 class"
mkdir -p "$T/pinned/scripts" && ( cd "$T/pinned" && git init -q && git config user.email ci@example.com && git config user.name ci \
    && cp "$PIN" scripts/ip_scan.sha256 && echo 'nothing to see' > note.txt && git add -A && git commit -qm pin )
if IP_SCAN_PRIVATE_TERMS="$PRIV" bash "$SCAN" "$T/pinned" "$T/out-pinned" > "$T/pinned.log" 2>&1; then
    echo "  pin file excluded from the scan"
else
    echo "  FAILED: the pin file tripped the scan"; sed 's/^/      /' "$T/pinned.log" | head -25; failures=$((failures + 1))
fi

echo "== negative control: a clean tree must PASS"
mkrepo "$T/clean" 'hello from 192.0.2.10 (RFC 5737 documentation range), contact dev@example.com'
if IP_SCAN_PRIVATE_TERMS="$PRIV" bash "$SCAN" "$T/clean" "$T/out-clean" > "$T/clean.log" 2>&1; then
    echo "  clean tree passed"
else
    echo "  FAILED: clean tree did not pass"; sed 's/^/      /' "$T/clean.log" | head -25; failures=$((failures + 1))
fi

echo "== broken pattern: an unrunnable regex must exit 2, not report zero hits"
rc=0; IP_SCAN_PRIVATE_TERMS='[' bash "$SCAN" "$T/clean" "$T/out-broken" > "$T/broken.log" 2>&1 || rc=$?
if [ "$rc" -eq 2 ] && grep -q '^BROKEN' "$T/broken.log"; then
    echo "  broken pattern detected (exit 2)"
else
    echo "  FAILED: broken pattern exited $rc"; sed 's/^/      /' "$T/broken.log" | head -25; failures=$((failures + 1))
fi

echo "== loaded terms: what the scanner counts from scripts/ip_scan.private"
if [ -f "$HERE/ip_scan.private" ]; then
    FILE_TERMS=$(grep -v '^\s*#' "$HERE/ip_scan.private" | grep -v '^\s*$' | paste -sd '|')
    rc=0; IP_SCAN_PRIVATE_TERMS="$FILE_TERMS" bash "$SCAN" "$T/clean" "$T/out-loaded" > "$T/loaded.log" 2>&1 || rc=$?
    if [ "$rc" -eq 0 ] && grep -q 'private_terms.*terms)' "$T/loaded.log"; then
        echo "  loaded-term count: $(sed -n 's/.*private_terms.*(\([0-9]*\) terms).*/\1/p' "$T/loaded.log")"
    else
        echo "  FAILED: private file did not load cleanly (exit $rc)"; sed 's/^/      /' "$T/loaded.log" | head -25; failures=$((failures + 1))
    fi
else
    echo "  loaded-term count: none (no ip_scan.private; run setup-private-terms.sh)"
fi

echo "== empty tree: scanning zero files must exit 2, not PASS"
mkdir -p "$T/empty"
rc=0; IP_SCAN_PRIVATE_TERMS="$PRIV" bash "$SCAN" "$T/empty" "$T/out-empty" > "$T/empty.log" 2>&1 || rc=$?
if [ "$rc" -eq 2 ] && grep -q '^BROKEN' "$T/empty.log"; then
    echo "  empty tree refused (exit 2)"
else
    echo "  FAILED: empty tree exited $rc"; sed 's/^/      /' "$T/empty.log" | head -25; failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
    echo "SELFTEST FAILED: $failures check(s) did not behave"; exit 1
fi
echo "SELFTEST PASSED: pin intact, every class caught, clean tree passes, broken pattern is fatal"
