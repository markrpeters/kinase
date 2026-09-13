# kinase task runner. Install just: `apt install just` / `brew install just` / `cargo install just`.

_root := justfile_directory()

# list recipes
default:
    @just --list

# wire node_modules to the pinned pi and check the version against PI_VERSION
setup:
    bash {{_root}}/scripts/setup.sh

# tsc strict over src/ (against pi's installed .d.ts)
gate-tsc:
    cd {{_root}} && npx tsc -p tsconfig.json

# jiti mock suites (test/run-*.mjs) — no model, no network, no subprocess
gate-jiti:
    bash {{_root}}/scripts/run-suites.sh

# identifier-safety scan over tracked files (fails on any HIGH/MED hit), then its positive control
gate-scan:
    bash {{_root}}/scripts/ip_scan.sh {{_root}} {{_root}}/scan-out
    bash {{_root}}/scripts/ip_scan_selftest.sh

# every offline gate
gate: gate-tsc gate-jiti gate-scan

# interactive pi session with scout + runner + fanout + recall loaded (needs a model server)
ext:
    cd {{_root}} && pi -e {{_root}}/src/scout-tool.ts -e {{_root}}/src/runner-tool.ts

# non-interactive live fanout: 3 bounded jobs, prints the manifest (needs a model server)
demo:
    bash {{_root}}/scripts/demo.sh
