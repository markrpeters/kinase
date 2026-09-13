// run-scout-tool.mjs — jiti mock suite for src/scout-tool.ts + src/lib/scout-core.ts.
// Covers: parseScoutStream (text_delta accumulation, tool counting, retries,
// stopReason:error detection), coerceScoutArgs aliases, knownNodes/resolveNodeModel
// (local default, SCOUT_MODEL override, SCOUT_MODEL_<NODE> extra nodes, unknown-node
// Error), buildScoutPrompt, registration, prepareArguments, empty-question Error, e2e
// with mocked exec + audit entry, unknown-node Error, provider-error Seam, no-answer
// Seam, timeout Seam, pi-missing Error, exec-throw Error. No model, no network, no
// subprocess: pi.exec is a mock. Live pi behavior is a separate, manual probe.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

let fails = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) fails++;
};

// A second node for routing tests. resolveNodeModel reads process.env at CALL time, so
// this must be set for the whole suite (scripts/run-suites.sh unsets inherited SCOUT_*).
process.env.SCOUT_MODEL_NODE2 = "node2/small-model";

// ---------- core unit tests ----------
const core = await jiti.import(`../src/lib/scout-core.ts?x=${Math.random()}`);
const { parseScoutStream, coerceScoutArgs, resolveNodeModel, knownNodes, defaultNode, buildScoutPrompt, DEFAULT_NODE, DEFAULT_MODEL_REF } = core;

// NDJSON stream fixtures (shapes captured from pi -p --mode json, v0.84.2).
const td = (d) => JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: d } });
const tool = JSON.stringify({ type: "tool_execution_start", toolName: "grep" });
const endOk = JSON.stringify({ type: "agent_end", willRetry: false });
const msgErr = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
const retry = JSON.stringify({ type: "auto_retry_start" });

const GOOD = [tool, td("The server listens on "), td("port 8089 "), td("(scripts/server.sh:12)."), endOk].join("\n") + "\n";
{
  const p = parseScoutStream(GOOD);
  check("parse: answer from text_delta only", p.answer === "The server listens on port 8089 (scripts/server.sh:12).");
  check("parse: tool counted", p.toolCalls === 1);
  check("parse: finish end", p.finish === "end" && p.errored === false && p.retries === 0);
}
{
  // provider/serving error: empty content, retries, stopReason error (unsupported model architecture)
  const ERR = [msgErr, retry, msgErr, retry, msgErr, JSON.stringify({ type: "agent_end", willRetry: false })].join("\n") + "\n";
  const p = parseScoutStream(ERR);
  check("parse: errored empty stream", p.answer === "" && p.errored === true && p.retries === 2 && p.toolCalls === 0);
}
{
  // concluded with no text but no error (drove a tool, emitted nothing)
  const NOANS = [tool, endOk].join("\n") + "\n";
  const p = parseScoutStream(NOANS);
  check("parse: no-answer non-errored", p.answer === "" && p.errored === false && p.toolCalls === 1);
  check("parse: garbage lines skipped", parseScoutStream("not json\n" + GOOD).answer.includes("8089"));
}

// coerceScoutArgs
check(
  "coerce: aliases + node lowercase + hint",
  (() => {
    const a = coerceScoutArgs({ query: "Q?", target: "NODE2", pattern: "presets.ini" });
    const b = coerceScoutArgs("just a string");
    const c = coerceScoutArgs(null);
    return (
      a.question === "Q?" && a.node === "node2" && a.search_hint === "presets.ini" &&
      b.question === "just a string" && b.node === "" &&
      c.question === "" && c.node === "" && c.search_hint === ""
    );
  })(),
);

// knownNodes / defaultNode / resolveNodeModel
check("nodes: local always present with the placeholder default", (() => {
  const n = knownNodes({});
  return DEFAULT_NODE === "local" && n["local"] === DEFAULT_MODEL_REF && Object.keys(n).length === 1;
})());
check("nodes: SCOUT_MODEL overrides the local model", knownNodes({ SCOUT_MODEL: "ollama/other:1b" }).local === "ollama/other:1b");
check("nodes: SCOUT_MODEL_<NAME> defines extra nodes (lowercased)", (() => {
  const n = knownNodes({ SCOUT_MODEL_GPU2: "gpu2/m", SCOUT_MODEL_Box3: "box3/m", SCOUT_MODEL_: "ignored", SCOUT_MODEL_EMPTY: "  " });
  return n.gpu2 === "gpu2/m" && n.box3 === "box3/m" && !("" in n) && !("empty" in n) && Object.keys(n).length === 3;
})());
check("nodes: SCOUT_MODEL_LOCAL wins over SCOUT_MODEL", knownNodes({ SCOUT_MODEL: "a/b", SCOUT_MODEL_LOCAL: "c/d" }).local === "c/d");
check("nodes: defaultNode local unless SCOUT_DEFAULT_NODE", defaultNode({}) === "local" && defaultNode({ SCOUT_DEFAULT_NODE: "GPU2" }) === "gpu2");
check(
  "resolve: local default -> provider/model split",
  (() => {
    const d = resolveNodeModel("local", {});
    return d.ref === DEFAULT_MODEL_REF && d.provider === "ollama" && d.model === DEFAULT_MODEL_REF.slice("ollama/".length) && d.node === "local";
  })(),
);
check("resolve: default node local when unset", resolveNodeModel("", {}).node === "local");
check("resolve: SCOUT_DEFAULT_NODE override", resolveNodeModel("", { SCOUT_DEFAULT_NODE: "gpu2", SCOUT_MODEL_GPU2: "gpu2/m" }).node === "gpu2");
check(
  "resolve: extra node via SCOUT_MODEL_<NODE>",
  (() => {
    const r = resolveNodeModel("gpu2", { SCOUT_MODEL_GPU2: "gpu2/small:3b" });
    return r.ref === "gpu2/small:3b" && r.provider === "gpu2" && r.model === "small:3b";
  })(),
);
check(
  "resolve: unknown node -> Error: listing known nodes",
  (() => {
    try {
      resolveNodeModel("mars", { SCOUT_MODEL_GPU2: "gpu2/m" });
      return false;
    } catch (e) {
      return /^Error: unknown scout node "mars"/.test(e.message) && /known nodes: gpu2, local/.test(e.message) && /SCOUT_MODEL_MARS/.test(e.message);
    }
  })(),
);

// buildScoutPrompt
check("prompt: base is grep-first single-sentence", /grep/.test(buildScoutPrompt("")) && !/Scope your search/.test(buildScoutPrompt("")));
check("prompt: hint appended", buildScoutPrompt("presets.ini").includes("Scope your search to: presets.ini"));

// ---------- tool wiring tests ----------
async function boot(execImpl, env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const tools = [];
  const entries = [];
  const pi = {
    registerTool: (t) => tools.push(t),
    appendEntry: (type, data) => entries.push({ type, ...data }),
    exec: execImpl,
    on: () => {},
  };
  const mod = await jiti.import(`../src/scout-tool.ts?x=${Math.random()}`);
  mod.default(pi);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return { tool: tools[0], tools, entries };
}

const okExec = async () => ({ stdout: GOOD, stderr: "", code: 0, killed: false });

{
  const { tool, tools } = await boot(okExec);
  check("registration: one scout tool", tools.length === 1 && tool.name === "scout");
  check("registration: promptSnippet set", typeof tool.promptSnippet === "string" && tool.promptSnippet.includes("scout"));
  check("registration: guidelines nonempty", Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length >= 1);

  const pa = tool.prepareArguments;
  check(
    "prepareArguments aliases",
    pa({ query: "x" }).question === "x" && pa("x").question === "x" && pa({}).question === "" && pa(null).question === "",
  );

  let emptyErr = null;
  try {
    await tool.execute("tc", { question: "  " }, undefined, undefined, {});
  } catch (e) {
    emptyErr = e;
  }
  check("empty question -> Error:", emptyErr !== null && /^Error: scout needs a question/.test(emptyErr.message));
}

{
  // e2e: answer returned, audit entry records the dispatch; argv carries the bare regime
  let seenArgv = null;
  const spy = async (_bin, argv) => { seenArgv = argv; return { stdout: GOOD, stderr: "", code: 0, killed: false }; };
  const { tool, entries } = await boot(spy);
  const res = await tool.execute("tc", { question: "server port?", node: "node2", search_hint: "scripts/server.sh" }, undefined, undefined, {});
  check("e2e: answer text returned", res.content[0].text.includes("8089"));
  check("e2e: details node/model", res.details.node === "node2" && res.details.model === "small-model" && res.details.tool_calls === 1);
  check("e2e: argv bare regime", seenArgv.includes("--no-extensions") && seenArgv[seenArgv.indexOf("--tools") + 1] === "read,grep,find,ls" && seenArgv[seenArgv.indexOf("--model") + 1] === "node2/small-model" && seenArgv[seenArgv.length - 1] === "server port?");
  check(
    "e2e: audit entry",
    entries.length === 1 &&
      entries[0].type === "scout" &&
      entries[0].node === "node2" &&
      entries[0].provider === "node2" &&
      entries[0].question === "server port?" &&
      entries[0].search_hint === "scripts/server.sh" &&
      entries[0].tool_calls === 1 &&
      entries[0].errored === false &&
      typeof entries[0].wall_ms === "number",
  );
}

{
  // default node = local when node omitted
  const { tool } = await boot(okExec);
  const res = await tool.execute("tc", { question: "x" }, undefined, undefined, {});
  check("e2e: default node local", res.details.node === "local");
}

{
  // unknown node -> Error:
  const { tool } = await boot(okExec);
  let err = null;
  try {
    await tool.execute("tc", { question: "x", node: "mars" }, undefined, undefined, {});
  } catch (e) {
    err = e;
  }
  check("unknown node -> Error:", err !== null && /^Error: unknown scout node "mars"/.test(err.message));
}

{
  // provider/serving error (empty + stopReason error) -> Seam:, audit still recorded
  const errExec = async () => ({ stdout: [msgErr, retry, msgErr].join("\n") + "\n", stderr: "unknown model architecture", code: 0, killed: false });
  const { tool, entries } = await boot(errExec);
  let err = null;
  try {
    await tool.execute("tc", { question: "x", node: "local" }, undefined, undefined, {});
  } catch (e) {
    err = e;
  }
  check("provider error -> Seam:", err !== null && /^Seam: scout provider error on local/.test(err.message));
  check("provider error: audit recorded before throw", entries.length === 1 && entries[0].errored === true);
}

{
  // concluded empty (no error) -> Seam: no answer
  const noAnsExec = async () => ({ stdout: [tool, endOk].join("\n") + "\n", stderr: "", code: 0, killed: false });
  const { tool: t } = await boot(noAnsExec);
  let err = null;
  try {
    await t.execute("tc", { question: "x" }, undefined, undefined, {});
  } catch (e) {
    err = e;
  }
  check("no-answer -> Seam:", err !== null && /^Seam: scout on local .* concluded with no answer/.test(err.message));
}

{
  // failure paths: timeout, pi missing, exec throws
  const cases = [
    ["killed -> Seam timeout", async () => ({ stdout: "", stderr: "", code: 0, killed: true }), /^Seam: scout timed out/],
    ["code 127 -> Error pi missing", async () => ({ stdout: "", stderr: "", code: 127, killed: false }), /^Error: pi binary not found/],
    ["exec rejects -> Error run", async () => { throw new Error("spawn ENOENT"); }, /^Error: could not run pi/],
  ];
  for (const [name, impl, re] of cases) {
    const { tool } = await boot(impl);
    let err = null;
    try {
      await tool.execute("tc", { question: "x" }, undefined, undefined, {});
    } catch (e) {
      err = e;
    }
    check(`fail path: ${name}`, err !== null && re.test(err.message));
  }
}

{
  // char budget truncation
  const long = "y".repeat(200);
  const bigExec = async () => ({ stdout: td(long) + "\n" + endOk + "\n", stderr: "", code: 0, killed: false });
  const { tool } = await boot(bigExec, { SCOUT_MAX_CHARS: "50" });
  const res = await tool.execute("tc", { question: "x" }, undefined, undefined, {});
  check("budget: truncated to max", res.content[0].text.length === 50 && res.details.truncated === true);
}

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
