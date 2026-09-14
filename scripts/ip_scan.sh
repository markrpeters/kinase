#!/usr/bin/env bash
# ip_scan.sh — identifier-safety scan over the git-tracked text files of a repository.
#
# Usage: scripts/ip_scan.sh <repo path> <out dir>
# Writes one hit list per pattern to <out dir>/<pattern>.txt (file:line:text), prints a
# per-pattern summary, and exits non-zero if ANY pattern classed HIGH or MED has a hit.
# Meant as a release gate for code extracted from a private working repo: it catches
# the identifiers that leak most often (private/public IPs, UUIDs, tenant/case ids,
# vendor-console URLs, corporate hostname schemes, DOMAIN\user, e-mail addresses,
# credential-shaped assignments, hashes, home-directory paths, and language that
# admits data came from a live environment). Loopback, RFC 5737 documentation
# ranges (192.0.2/24, 198.51.100/24, 203.0.113/24) and example.* mail domains are
# allowed by construction.
#
# Severity: HIGH = must never ship; MED = almost always a leak, review and remove;
# LOW = usually benign, listed for the reviewer.
#
# Private terms (optional): organisation-specific identifiers that must never appear in
# the tree (an employer name, a hostname scheme, a case-id form). Supplied as extended
# regex alternatives joined with "|" in IP_SCAN_PRIVATE_TERMS (how CI reads them from a
# repository secret) and/or one regex per line in scripts/ip_scan.private (gitignored,
# for local runs). Scanned case-insensitively as one extra HIGH pattern; the summary
# line reports how many terms were loaded so an empty secret cannot pass as a full one.
#
# This script is excluded from its own scan (its pattern strings would match themselves).
# Note: `file` reports .ts/.mjs as application/javascript, so the type filter must name
# javascript explicitly — a bare text/ filter silently skips all the source files.
set -uo pipefail
REPO="${1:?repo path}"; OUT="${2:?out dir}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"; : > "$OUT/grep-errors.txt"
cd "$REPO" || exit 1

# Excluded from the scan: this script (its pattern strings match themselves) and its
# positive-control self-test (it plants fictional identifiers on purpose).
SELF="$(git ls-files --full-name -- "${BASH_SOURCE[0]}" 2>/dev/null || true)"
SELFTEST="$(git ls-files --full-name -- "$(dirname "${BASH_SOURCE[0]}")/ip_scan_selftest.sh" 2>/dev/null || true)"
git ls-files -z | xargs -0 file --mime-type 2>/dev/null | grep -E 'text/|json|xml|csv|javascript|typescript|ecmascript|yaml|toml|x-empty' | cut -d: -f1 \
  | { if [ -n "$SELF" ]; then grep -vxF "$SELF"; else cat; fi; } \
  | { if [ -n "$SELFTEST" ]; then grep -vxF "$SELFTEST"; else cat; fi; } > "$OUT/files.txt"
N=$(wc -l < "$OUT/files.txt"); echo "$(pwd): $N text files tracked"

bad=0
scan() { # <severity> <name> <grep args...>
  local sev="$1" name="$2"; shift 2
  # Matcher: a pattern that carries -P (PCRE, for lookaheads) must NOT also get -E — GNU
  # grep rejects "conflicting matchers" (exit 2) and, with stderr discarded, a dead pattern
  # would report zero hits forever. ERE is the default for everything else.
  local m="-E"; case "$1" in -*P*) m="" ;; esac
  if [ -s "$OUT/files.txt" ]; then
    xargs -a "$OUT/files.txt" -d '\n' grep -nHI $m "$@" 2> "$OUT/$name.err" > "$OUT/$name.txt"
    [ -s "$OUT/$name.err" ] && sed "s/^/[$name] /" "$OUT/$name.err" >> "$OUT/grep-errors.txt"; rm -f "$OUT/$name.err"
  else
    : > "$OUT/$name.txt"
  fi
  local hits files; hits=$(wc -l < "$OUT/$name.txt"); files=$(cut -d: -f1 "$OUT/$name.txt" | sort -u | wc -l)
  printf "  %-4s %-22s %4d hits  %3d files\n" "$sev" "$name" "$hits" "$files"
  if [ "$hits" -gt 0 ] && { [ "$sev" = HIGH ] || [ "$sev" = MED ]; }; then bad=$((bad+1)); fi
}

echo "pattern scan:"
scan HIGH secrets -iE '(api[_-]?key|secret|token|password|passwd|bearer)\s*[:=]\s*["'"'"']?[A-Za-z0-9_/+-]{12,}'
scan HIGH tenant -i 'tenant'
scan HIGH vendor_console_urls -iE '(secureworks\.com|taegis|ctpx\.|crowdstrike\.com/|falcon\.(us|eu)-[0-9]|_cid=|humio|logscale|sentinelone\.net|security\.microsoft\.com|splunkcloud\.com|\.kibana\.|elastic-cloud\.com|paloaltonetworks\.com/|xdr\.|siem\.)'
scan HIGH case_ids -E '\b(INV|INC|CASE|TKT|SIR|IR|TICKET|ALERT)[-_ ]?[0-9]{4,}\b'
scan HIGH hostnames -E '\b(DESKTOP|LAPTOP|WKS|WS|PC|SRV|DC|EXCH|SQL|FS|APP|WEB|VM|HV|LT|WIN)[0-9]*-[A-Z0-9]{3,}\b|\bUS[A-Z]{4,}[A-Z0-9]*[0-9][A-Z0-9]*\b'
scan HIGH domain_backslash_user -P '\b[A-Z][A-Z0-9-]{2,}\\+[A-Za-z][A-Za-z0-9._-]{2,}\b'
scan HIGH emails -iP '\b[a-z0-9._%+-]+@(?!example\.|test\.|localhost|users\.noreply|noreply)[a-z0-9.-]+\.[a-z]{2,}\b'
scan HIGH internal_domains -iE '\b[a-z0-9-]+\.(corp|local|internal|lan|intra|ad|priv|dmz)\b'
scan HIGH sha256 -E '\b[0-9a-f]{64}\b'
scan MED  rfc1918 -E '\b(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})\b'
scan MED  public_ip -P '\b(?!10\.|127\.|0\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|172\.(1[6-9]|2[0-9]|3[01])\.)([1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\b'
scan MED  user_home -E '/home/[a-z]+|C:\\\\Users\\\\[A-Za-z]+'
scan MED  realdata -iE '(real[- ]?(data|telemetry|incident|case|customer|alert)|from prod|production data|sanitiz|redact|anonymi|scrub)'
scan MED  customer -iE '\b(customer|client name|clientname|account name|acct)\b'
scan MED  work_ids -E '\b(W|P[12]-|DD-|H)[0-9]{1,3}[a-z]?\b'
PRIV_TERMS="${IP_SCAN_PRIVATE_TERMS:-}"
PRIVATE_FILE="$(dirname "${BASH_SOURCE[0]}")/ip_scan.private"
if [ -f "$PRIVATE_FILE" ]; then
  FILE_TERMS="$(grep -v '^[[:space:]]*#' "$PRIVATE_FILE" | grep -v '^[[:space:]]*$' | paste -sd'|' -)"
  PRIV_TERMS="${PRIV_TERMS:+$PRIV_TERMS|}$FILE_TERMS"
fi
if [ -n "$PRIV_TERMS" ]; then
  # Count top-level alternatives: a "|" at parenthesis depth 0 separates terms, so a
  # regex like cooper(vision|surgical) still counts as one.
  NTERMS="$(printf '%s' "$PRIV_TERMS" | awk 'BEGIN{d=0;n=1} {for(i=1;i<=length($0);i++){c=substr($0,i,1); if(c=="\\"){i++;continue} if(c=="(")d++; else if(c==")")d--; else if(c=="|"&&d==0)n++}} END{print n}')"
  scan HIGH "private_terms($NTERMS terms)" -i "($PRIV_TERMS)"
else
  printf "  %-4s %-22s %s\n" HIGH private_terms "(skipped: IP_SCAN_PRIVATE_TERMS unset, no $PRIVATE_FILE)"
fi
scan LOW  uuid '\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b'

echo
if [ -s "$OUT/grep-errors.txt" ]; then
  echo "SCAN BROKEN: grep reported errors (a pattern that cannot run is a pattern that never hits):"
  sort -u "$OUT/grep-errors.txt" | head -5; exit 2
fi
if [ "$bad" -gt 0 ]; then
  echo "SCAN FAILED: $bad HIGH/MED pattern(s) with hits — see $OUT/*.txt"
  for f in "$OUT"/*.txt; do
    [ "$(basename "$f")" = files.txt ] && continue
    [ -s "$f" ] && { echo "--- $(basename "$f" .txt)"; head -20 "$f"; }
  done
  exit 1
fi
echo "SCAN CLEAN: zero HIGH/MED hits over $N tracked text files"
