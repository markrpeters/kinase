#!/usr/bin/env bash
# IP-safety scan for this repository. Exits non-zero on any HIGH or MED hit,
# and exits 2 if any pattern fails to run (a pattern that cannot run is a
# pattern that never hits, which is worse than no pattern at all).
#
# CANONICAL COPY: markrpeters/public-repo-denylist, scanner/ip_scan.sh. Every
# consuming repository vendors this file byte-for-byte together with
# ip_scan_selftest.sh, setup-private-terms.sh and the ip_scan.sha256 pin; the
# self-test fails when a vendored copy drifts from the pin. Fix it at the
# source, regenerate the pin, re-vendor. Do not edit a vendored copy.
#
# Scans every git-tracked text file (or every file under the tree when not in
# a git repo), excluding this script, its self-test, the private-terms file
# and the sha256 pin (whose hashes would trip the sha256 class), and writes one hit list per pattern to $OUT (default: scan-results/,
# git-ignored). scripts/ip_scan_selftest.sh is the positive control: it plants
# one fictional identifier per class and requires this scan to fail on each.
#
# Severity policy:
#   HIGH  identifies a real environment on its own — case/ticket ids, tenant
#         ids, vendor console URLs, corporate hostname schemes, real e-mail
#         addresses, absolute home / mount paths, credentials, file hashes,
#         UUIDs. Organisation-specific terms (an employer or customer name,
#         an AD domain prefix) must NOT live in this file, or the scanner
#         becomes the leak: put them in scripts/ip_scan.private (git-ignored,
#         one extended regex per line) or in the IP_SCAN_PRIVATE_TERMS
#         environment variable (regex alternatives separated by "|"), which is
#         how CI supplies them from a secret. Both are scanned as HIGH,
#         case-insensitively, and the summary line reports how many terms
#         were loaded so an empty or truncated secret cannot pass as a full
#         one. A term may carry its own "|" inside a group; only a "|" at
#         parenthesis depth 0 separates terms.
#   MED   would need context to be harmless — RFC1918 addresses, internal AD
#         domains, DOMAIN\user tokens, generic hostname shapes. Test fixtures
#         in this repo use RFC 5737 documentation addresses and invented
#         names precisely so that MED stays at zero without an allowlist.
#   LOW   informational only, never fails the gate — public IPs outside the
#         documentation ranges, words that suggest real data was handled.
#
# Matcher notes (learned the hard way, see the self-test):
#   * A pattern needing PCRE (lookaheads) is flagged -P; everything else gets
#     -E. GNU grep rejects -E and -P together ("conflicting matchers", exit 2),
#     so scan() adds -E only when no -P flag is present.
#   * grep's stderr is captured, never discarded. Any grep error fails the run.
#   * Inside an ERE bracket expression a backslash is literal, so "[_\-/]" is
#     an invalid range. Put "-" last instead.
#   * A single backslash in a file is matched by "\\" in the pattern. "\\\\"
#     matches two and silently misses DOMAIN\user and C:\Users\name.
#   * file(1) reports .ts/.mjs as application/javascript (and some builds say
#     typescript/ecmascript), so the type filter names them explicitly — a bare
#     "text/" filter silently skips every TypeScript source file. And if file(1)
#     is missing altogether the file list is empty and a scan of nothing would
#     PASS, so its absence is fatal.
#
# Usage: scripts/ip_scan.sh [repo-root] [out-dir] [--require-private]
#   --require-private  exit 3 if zero private terms were loaded (used by the
#                      pre-commit hook installed by scripts/setup-private-terms.sh).
#                      Without it a zero count prints a visible warning.
set -uo pipefail
REQUIRE_PRIVATE=0; ARGS=()
for a in "$@"; do case "$a" in --require-private) REQUIRE_PRIVATE=1 ;; *) ARGS+=("$a") ;; esac; done
set -- "${ARGS[@]+"${ARGS[@]}"}"
ROOT=${1:-$(cd "$(dirname "$0")/.." && pwd)}
OUT=${2:-$ROOT/scan-results}
SELF=scripts/ip_scan.sh
SELFTEST=scripts/ip_scan_selftest.sh
PRIVATE=scripts/ip_scan.private
PIN=scripts/ip_scan.sha256
command -v file >/dev/null 2>&1 || { echo "BROKEN: file(1) is not installed; the file list would be empty and a scan of nothing passes"; exit 2; }
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
: > "$OUT/grep-errors.txt"
cd "$ROOT" || exit 2

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -z
else
    find . -type f -not -path './.git/*' -not -path './.venv/*' -not -path './scan-results/*' -print0
fi | xargs -0 file --mime-type 2>/dev/null \
   | grep -E 'text/|json|xml|csv|yaml|toml|javascript|typescript|ecmascript|x-empty' | cut -d: -f1 | sed 's#^\./##' \
   | grep -vxF "$SELF" | grep -vxF "$SELFTEST" | grep -vxF "$PRIVATE" | grep -vxF "$PIN" | grep -v '^scan-results/' > "$OUT/files.txt"

N=$(wc -l < "$OUT/files.txt")
echo "scanning $N text files under $ROOT"
if [ "$N" -eq 0 ]; then
    echo "BROKEN: no text files found under $ROOT (wrong root, empty tree, or file(1) misbehaving); a scan of nothing must not pass"
    exit 2
fi

FAIL=0
SCAN_NOTE=""
scan() {  # scan <severity> <name> [grep flags...] <pattern>
    local sev=$1 name=$2; shift 2
    # Per-pattern matcher: -P patterns must not also get -E.
    local m="-E" a
    for a in "$@"; do case "$a" in -*P*) m="" ;; esac; done
    if [ -s "$OUT/files.txt" ]; then
        xargs -a "$OUT/files.txt" -d '\n' grep -nHI $m "$@" 2> "$OUT/$name.err" > "$OUT/$name.txt"
    else
        : > "$OUT/$name.txt"; : > "$OUT/$name.err"
    fi
    if [ -s "$OUT/$name.err" ]; then
        sed "s/^/[$name] /" "$OUT/$name.err" >> "$OUT/grep-errors.txt"
    fi
    rm -f "$OUT/$name.err"
    local hits files
    hits=$(wc -l < "$OUT/$name.txt"); files=$(cut -d: -f1 "$OUT/$name.txt" | sort -u | wc -l)
    printf '%-5s %-22s %4d hits %3d files%s\n' "$sev" "$name" "$hits" "$files" "${SCAN_NOTE:+  ($SCAN_NOTE)}"
    SCAN_NOTE=""
    if [ "$hits" -gt 0 ] && [ "$sev" != LOW ]; then FAIL=1; fi
}

# ---- HIGH: identifies a real environment on its own ------------------------
scan HIGH case_ids            '\b(INV|INC|CASE|TKT|SIR|TICKET|ALERT)[-_ ]?[0-9]{4,}\b'
scan HIGH tenant          -i  'tenant'
scan HIGH vendor_urls     -i  '(secureworks\.com|taegis|ctpx\.|crowdstrike\.com/|falcon\.(us|eu)-[0-9]|humio|logscale)'
scan HIGH corp_hostnames      '\b(US|UK)[A-Z]{3}[A-Z0-9]{5,}\b'
scan HIGH emails          -iP '\b[a-z0-9._%+-]+@(?!example\.|test\.|localhost|users\.noreply|noreply)[a-z0-9.-]+\.[a-z]{2,}\b'
scan HIGH user_home           '(/home/[a-z]+|/mnt/[a-z]|~/[A-Za-z]|C:\\+Users\\+[A-Za-z]+)'
scan HIGH secrets         -i  '(api[_-]?key|secret|token|password|passwd|bearer)\s*[:=]\s*["'"'"']?[A-Za-z0-9_/+-]{12,}'
scan HIGH sha256              '\b[0-9a-f]{64}\b'
scan HIGH uuid                '\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b'

# ---- HIGH: organisation-specific terms supplied out-of-band -----------------
PRIV_TERMS=${IP_SCAN_PRIVATE_TERMS:-}
if [ -f "$PRIVATE" ]; then
    FILE_TERMS=$(grep -v '^\s*#' "$PRIVATE" | grep -v '^\s*$' | paste -sd '|')
    PRIV_TERMS="${PRIV_TERMS:+$PRIV_TERMS|}$FILE_TERMS"
fi
if [ -n "$PRIV_TERMS" ]; then
    # Count top-level alternatives: "|" at parenthesis depth 0; escaped chars skipped.
    NTERMS=$(printf '%s' "$PRIV_TERMS" | awk 'BEGIN{d=0;n=1} {for(i=1;i<=length($0);i++){c=substr($0,i,1); if(c=="\\"){i++;continue} if(c=="(")d++; else if(c==")")d--; else if(c=="|"&&d==0)n++}} END{print n}')
    SCAN_NOTE="$NTERMS terms"
    scan HIGH private_terms -i "($PRIV_TERMS)"
else
    printf '%-5s %-22s (skipped: no %s and IP_SCAN_PRIVATE_TERMS unset)\n' HIGH private_terms "$PRIVATE"
    if [ "$REQUIRE_PRIVATE" -eq 1 ]; then
        echo "REFUSED: --require-private is set but zero private terms were loaded."
        echo "         Run scripts/setup-private-terms.sh (author) or drop the flag (public classes only)."
        exit 3
    fi
    echo "WARNING: zero private terms loaded; public classes only. Author: run scripts/setup-private-terms.sh"
fi

# ---- MED: needs context to be harmless --------------------------------------
scan MED  rfc1918             '\b(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})\b'
scan MED  internal_domains -i '\b[a-z0-9-]+\.(corp|local|internal|lan|intra|priv|dmz)\b'
scan MED  domain_user     -P  '\b[A-Z][A-Z0-9-]{2,}\\+[A-Za-z][A-Za-z0-9._-]{2,}\b'
scan MED  hostnames           '\b(DESKTOP|LAPTOP|WKS|WS|PC|SRV|DC|EXCH|SQL|FS|APP|WEB|VM|HV|LT|WIN)[0-9]*-[A-Z0-9]{3,}\b'

# ---- LOW: informational -----------------------------------------------------
scan LOW  public_ip       -P  '\b(?!10\.|127\.|0\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|172\.(1[6-9]|2[0-9]|3[01])\.)([1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\b'
scan LOW  realdata_words  -i  '(real[- ]?(data|telemetry|incident|case|customer|alert)|from prod|production data)'

if [ -s "$OUT/grep-errors.txt" ]; then
    echo "BROKEN: grep reported errors; a pattern that cannot run never hits"
    sort -u "$OUT/grep-errors.txt" | head -10
    exit 2
fi
if [ "$FAIL" -ne 0 ]; then
    echo "FAIL: HIGH/MED hits found — see $OUT/<pattern>.txt"
    for f in "$OUT"/*.txt; do
        case "$(basename "$f")" in files.txt|grep-errors.txt|public_ip.txt|realdata_words.txt) continue ;; esac
        [ -s "$f" ] && { echo "--- $(basename "$f" .txt)"; head -20 "$f"; }
    done
    exit 1
fi
echo "PASS: zero HIGH/MED hits"
