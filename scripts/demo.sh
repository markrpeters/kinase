#!/usr/bin/env bash
# demo.sh — one real fanout, non-interactively, and print the manifest.
#
# Needs a running model server that pi can reach (see config/models.json) and a small
# tool-calling model pulled there. Loads the two extension files into a headless pi
# session, asks the orchestrating model to make ONE fanout call with three bounded jobs,
# and prints what came back: the per-job status array, the collection-store index, and
# the session-log dispatch records.
#
#   SCOUT_MODEL          provider/id for the subagents (default: ollama/qwen2.5:7b)
#   KINASE_ORCHESTRATOR  provider/id for the orchestrating session (default: SCOUT_MODEL)
#   RUNNER_COLLECT_DIR   where the collection store lands (default: ./collected)
set -uo pipefail
cd "$(dirname "$0")/.."
export SCOUT_MODEL="${SCOUT_MODEL:-ollama/qwen2.5:7b}"
ORCH="${KINASE_ORCHESTRATOR:-$SCOUT_MODEL}"
export RUNNER_COLLECT_DIR="${RUNNER_COLLECT_DIR:-$(pwd)/collected}"
PI="${RUNNER_PI_BIN:-./node_modules/.bin/pi}"; [ -x "$PI" ] || PI=pi
OUT="${DEMO_OUT:-$RUNNER_COLLECT_DIR/demo-stream.ndjson}"
mkdir -p "$RUNNER_COLLECT_DIR"

read -r -d '' PROMPT <<'P'
Call the `fanout` tool exactly once with these three jobs, then stop:
{"jobs":[
 {"tool":"grep","args":{"pattern":"registerTool","path":"src"},"node":"local"},
 {"tool":"ls","args":{"path":"scripts"},"node":"local"},
 {"tool":"read","args":{"path":"PI_VERSION"},"node":"local"}
]}
Do not call any other tool and do not change the jobs. When the result comes back, reply with the single line: fanout complete.
P

echo "orchestrator: $ORCH   subagents: $SCOUT_MODEL   store: $RUNNER_COLLECT_DIR"
"$PI" --model "$ORCH" -p --mode json --no-session --no-extensions --no-skills --no-context-files \
  --thinking off \
  -e src/scout-tool.ts -e src/runner-tool.ts \
  --tools fanout,grep,ls,read \
  "$PROMPT" > "$OUT" 2> "$OUT.stderr"
rc=$?

node - "$OUT" <<'JS'
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
let calls = 0, fanouts = 0, text = "";
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.type === "tool_execution_start") calls++;
  if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") text += e.assistantMessageEvent.delta;
  if (e.type === "tool_execution_end" && e.toolName === "fanout") {
    fanouts++;
    const body = (e.result?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("");
    console.log("\n== fanout result (per-job manifest)");
    try {
      for (const r of JSON.parse(body)) {
        const head = (r.result ?? r.error ?? "").split("\n")[0].slice(0, 80);
        console.log(`  job ${r.job}  ${r.status.padEnd(10)} ${r.tool.padEnd(5)} node=${r.node}  ${String(r.wall_ms).padStart(6)} ms  ${head}`);
      }
    } catch { console.log(body); }
    console.log("== fanout details:", JSON.stringify(e.result?.details ?? {}));
  }
}
console.log(`\norchestrator tool calls: ${calls}   fanout calls: ${fanouts}   final text: ${JSON.stringify(text.trim().slice(0, 120))}`);
if (fanouts === 0) { console.error("DEMO FAILED: the orchestrator never called fanout — see " + process.argv[2] + ".stderr"); process.exit(1); }
JS
nrc=$?

if [ -f "$RUNNER_COLLECT_DIR/index.jsonl" ]; then
  echo; echo "== collection store: $RUNNER_COLLECT_DIR/index.jsonl (last 3 records)"
  tail -n 3 "$RUNNER_COLLECT_DIR/index.jsonl" | node -e '
    const rl=require("node:readline").createInterface({input:process.stdin});
    rl.on("line",l=>{try{const r=JSON.parse(l);const {id,ts,phase,via,node,tool,status,size,result_ref,...rest}=r;
      console.log("  "+JSON.stringify({id,ts,phase,via,node,tool,status,size,result_ref}));}catch{console.log("  "+l)}})'
fi
[ $rc -eq 0 ] && [ $nrc -eq 0 ] && echo "DEMO OK" || { echo "DEMO FAILED (pi exit $rc, parse exit $nrc)"; exit 1; }
