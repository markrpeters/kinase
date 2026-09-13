// run-runner-tool.mjs — jiti mock suite for src/runner-tool.ts + src/lib/runner-core.ts +
// src/lib/collect-core.ts.
// Covers: coerceRunnerArgs (aliases, args object/JSON-string/missing, node lowercase,
// task), resolveInheritedTool (empty/self/inactive/missing-source Error, builtin vs
// custom extPath), buildRunnerArgv (--no-extensions + -e custom / no -e builtin,
// --tools <name>, --thinking off, positional last), buildRunnerPrompt/UserMessage,
// parseRunnerStream (done/abort/unknown/abort-wins/tool_error/empty), and tool wiring
// with an INJECTED spawnPi + mocked getActiveTools/getAllTools: registration,
// prepareArguments, e2e done (result + status + audit), e2e abort (returned, marker),
// unknown-tool Error, self Error (recursion guard), unknown-node Error, timeout Seam,
// provider-error Seam, empty Seam, pi-missing Error, truncation, argv shape; fanout
// coercion + wiring (isolation, concurrency proof, caps); collection filing with an
// injected fs; recall filtering, hydration and budget. No model, no network, no
// subprocess. Live pi behavior is a separate, manual probe.
import { createJiti } from "jiti";
import { join } from "node:path";

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
const core = await jiti.import(`../src/lib/runner-core.ts?x=${Math.random()}`);
const {
  coerceRunnerArgs,
  coerceFanoutArgs,
  parseJobsString,
  resolveInheritedTool,
  buildRunnerArgv,
  buildRunnerPrompt,
  buildRunnerUserMessage,
  parseRunnerStream,
  lastToolResult,
  toolResultText,
  BUILTIN_TOOLS,
} = core;

// NDJSON fixtures (shapes captured from pi -p --mode json, v0.84.2).
const td = (d) => JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: d } });
const toolStart = JSON.stringify({ type: "tool_execution_start", toolName: "run_query" });
const toolEndErr = JSON.stringify({ type: "tool_execution_end", isError: true });
const toolEndOk = JSON.stringify({ type: "tool_execution_end", isError: false });
const toolEndData = (text) => JSON.stringify({ type: "tool_execution_end", isError: false, result: { content: [{ type: "text", text }], details: {} } });
const endOk = JSON.stringify({ type: "agent_end", willRetry: false });
const msgErr = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
const retry = JSON.stringify({ type: "auto_retry_start" });

const DONE = [toolStart, td("count=3\nrows: a,b,c\n"), td("DONE\n"), endOk].join("\n") + "\n";
const ABORT = [toolStart, td("ABORT could not bind args\n"), endOk].join("\n") + "\n";
const UNKNOWN = [toolStart, td("here are the rows but no status line"), endOk].join("\n") + "\n";
const TOOLERR = [toolStart, toolEndErr, td("Error: bad SQL — no such column\nDONE\n"), endOk].join("\n") + "\n";

// coerceRunnerArgs
check(
  "coerce: aliases + node lowercase + args object + task",
  (() => {
    const a = coerceRunnerArgs({ tool_name: "run_query", target: "NODE2", arguments: { query_id: "q1" }, note: "why" });
    return a.tool === "run_query" && a.node === "node2" && a.args.query_id === "q1" && a.task === "why";
  })(),
);
check(
  "coerce: args as JSON string parsed",
  (() => {
    const a = coerceRunnerArgs({ tool: "run_query", args: '{"query_id":"q2"}' });
    return a.args.query_id === "q2";
  })(),
);
check(
  "coerce: missing/garbage args -> {} , null -> empty",
  (() => {
    const a = coerceRunnerArgs({ tool: "x" });
    const b = coerceRunnerArgs({ tool: "x", args: "not json" });
    const c = coerceRunnerArgs(null);
    return (
      Object.keys(a.args).length === 0 &&
      Object.keys(b.args).length === 0 &&
      c.tool === "" && c.node === "" && Object.keys(c.args).length === 0
    );
  })(),
);

// resolveInheritedTool
const ALL = [
  { name: "run_query", sourceInfo: { path: "/abs/data-tools.mjs" } },
  { name: "read", sourceInfo: { path: "" } },
  { name: "runner", sourceInfo: { path: "/abs/runner-tool.mjs" } },
  { name: "orphan", sourceInfo: {} },
];
const ACTIVE = ["run_query", "read", "runner", "orphan"];
check(
  "resolve: custom tool -> extPath, not builtin",
  (() => {
    const r = resolveInheritedTool("run_query", "runner", ACTIVE, ALL);
    return r.name === "run_query" && r.extPath === "/abs/data-tools.mjs" && r.builtin === false;
  })(),
);
check(
  "resolve: builtin -> extPath null, builtin true",
  (() => {
    const r = resolveInheritedTool("read", "runner", ACTIVE, ALL);
    return r.builtin === true && r.extPath === null && BUILTIN_TOOLS.includes("read");
  })(),
);
const throwsErr = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};
check("resolve: empty tool -> Error:", throwsErr(() => resolveInheritedTool("", "runner", ACTIVE, ALL), /^Error: runner needs a tool/));
check("resolve: self -> Error: (recursion guard)", throwsErr(() => resolveInheritedTool("runner", "runner", ACTIVE, ALL), /cannot delegate to itself/));
check("resolve: inactive tool -> Error:", throwsErr(() => resolveInheritedTool("ghost", "runner", ACTIVE, ALL), /is not active in this session/));
check("resolve: custom w/o sourceInfo.path -> Error:", throwsErr(() => resolveInheritedTool("orphan", "runner", ACTIVE, ALL), /no sourceInfo\.path/));

// buildRunnerArgv
{
  const custom = buildRunnerArgv({
    ref: "ollama/small-model:3b",
    tool: { name: "run_query", extPath: "/abs/data-tools.mjs", builtin: false },
    systemPrompt: "SYS",
    userMessage: "USER",
  });
  check("argv: --no-extensions present", custom.includes("--no-extensions"));
  check("argv: -e extPath for custom", custom[custom.indexOf("-e") + 1] === "/abs/data-tools.mjs");
  check("argv: --tools <name>", custom[custom.indexOf("--tools") + 1] === "run_query");
  check("argv: --thinking off", custom[custom.indexOf("--thinking") + 1] === "off");
  check("argv: --model ref", custom[custom.indexOf("--model") + 1].startsWith("ollama/"));
  check("argv: system prompt appended", custom[custom.indexOf("--append-system-prompt") + 1] === "SYS");
  check("argv: user message is last positional", custom[custom.length - 1] === "USER");

  const builtin = buildRunnerArgv({
    ref: "node2/x",
    tool: { name: "read", extPath: null, builtin: true },
    systemPrompt: "S",
    userMessage: "U",
  });
  check("argv: no -e for builtin", !builtin.includes("-e"));
  check("argv: --tools read for builtin", builtin[builtin.indexOf("--tools") + 1] === "read");
}

// prompt / user message
check("prompt: names the one tool + forces DONE/ABORT", (() => {
  const p = buildRunnerPrompt("run_query");
  return p.includes("`run_query`") && p.includes("DONE") && p.includes("ABORT") && /exactly once/i.test(p);
})());
check("userMessage: exact args JSON + task note", (() => {
  const m = buildRunnerUserMessage("run_query", { query_id: "q1" }, "context");
  return m.includes('{"query_id":"q1"}') && m.includes("run_query") && m.includes("context");
})());
check("userMessage: no task line when task empty", !buildRunnerUserMessage("t", {}, "").includes("Context ("));

// parseRunnerStream
check("parse: DONE -> status done + text", (() => {
  const p = parseRunnerStream(DONE);
  return p.status === "done" && p.text.includes("count=3") && p.toolCalls === 1 && p.errored === false;
})());
check("parse: ABORT -> status abort", (() => parseRunnerStream(ABORT).status === "abort")());
check("parse: no sentinel -> unknown", (() => parseRunnerStream(UNKNOWN).status === "unknown")());
check("parse: ABORT wins over DONE", (() => {
  const both = [td("DONE\n"), td("ABORT changed my mind\n"), endOk].join("\n") + "\n";
  return parseRunnerStream(both).status === "abort";
})());
check("parse: tool_execution_end isError -> tool_error (overrides DONE)", (() => {
  const p = parseRunnerStream(TOOLERR);
  return p.status === "tool_error" && p.toolErrors === 1;
})());
check("parse: ABORT wins over tool_error", (() => parseRunnerStream([toolStart, toolEndErr, td("ABORT giving up\n"), endOk].join("\n") + "\n").status === "abort")());
check("parse: tool_execution_end ok -> not counted (status done)", (() => parseRunnerStream([toolStart, toolEndOk, td("rows\nDONE\n"), endOk].join("\n") + "\n").status === "done")());
check("parse: empty stream", (() => {
  const p = parseRunnerStream([msgErr, retry].join("\n") + "\n");
  return p.text === "" && p.errored === true && p.status === "unknown";
})());
check("parse: verbatim toolResult lifted from tool_execution_end", (() => {
  const s = [toolStart, toolEndData("a|1\nb|2"), td("the rows were a and b\nDONE\n"), endOk].join("\n") + "\n";
  const p = parseRunnerStream(s);
  return p.toolResult === "a|1\nb|2" && p.text.startsWith("the rows") && p.status === "done";
})());
check("parse: toolResult empty when the stream carried none", parseRunnerStream(DONE).toolResult === "");
// A DONE with NO tool_execution_start is a fabricated report (seen live: the model echoes
// the call as JSON text, invents output, types DONE). Never "done".
check("parse: DONE with zero tool calls -> no_call", (() => {
  const p = parseRunnerStream([td('{"name":"grep","arguments":{"pattern":"x"}}\nsrc/index.ts:5: x\nDONE\n'), endOk].join("\n") + "\n");
  return p.status === "no_call" && p.toolCalls === 0 && p.toolResult === "";
})());
check("parse: no sentinel and zero tool calls -> no_call (not unknown)", parseRunnerStream([td("I would run it like this"), endOk].join("\n") + "\n").status === "no_call");
check("parse: ABORT with zero tool calls stays abort", parseRunnerStream([td("ABORT path missing\n"), endOk].join("\n") + "\n").status === "abort");
check("parse: DONE with one tool call stays done", parseRunnerStream(DONE).status === "done");
check("parse: trailing DONE on the result line -> done", parseRunnerStream([toolStart, td("0.84.2 DONE"), endOk].join("\n") + "\n").status === "done");
check("parse: DONE mid-prose is not a sentinel", parseRunnerStream([toolStart, td("the DONE flag was set, then more"), endOk].join("\n") + "\n").status === "unknown");
check("lastToolResult: last successful wins, errored skipped", (() => {
  const s = [toolEndData("first"), toolEndData("second"), JSON.stringify({ type: "tool_execution_end", isError: true, result: { content: [{ type: "text", text: "bad" }] } })].join("\n");
  return lastToolResult(s) === "second";
})());
check("toolResultText: bare string / string content / garbage", toolResultText("s") === "s" && toolResultText({ content: "c" }) === "c" && toolResultText(null) === "" && toolResultText({ content: [{ type: "image" }] }) === "");

// ---------- tool wiring tests ----------
async function boot(spawnImpl, { active = ACTIVE, all = ALL, env = {}, fs, throwAppend = false } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const tools = [];
  const entries = [];
  const pi = {
    registerTool: (t) => tools.push(t),
    appendEntry: (type, data) => {
      if (throwAppend) throw new Error("appendEntry boom");
      entries.push({ type, ...data });
    },
    getActiveTools: () => active,
    getAllTools: () => all,
    on: () => {},
  };
  const mod = await jiti.import(`../src/runner-tool.ts?x=${Math.random()}`);
  mod.default(pi, { spawnPi: spawnImpl, ...(fs ? { fs } : {}) });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const tool = tools.find((t) => t.name === "runner");
  const fanout = tools.find((t) => t.name === "fanout");
  const recall = tools.find((t) => t.name === "recall");
  return { tool, fanout, recall, tools, entries };
}

/** In-memory CollectFs mock: records every write + honors existsSync so the README/dir
 * created-once path is exercised. `failAppend` makes appendFileSync throw (best-effort). */
function mockFs(opts = {}) {
  const files = new Map(); // path -> content
  const dirs = new Set();
  return {
    files,
    dirs,
    existsSync: (p) => files.has(p) || dirs.has(p),
    mkdirSync: (p) => dirs.add(p),
    writeFileSync: (p, data) => files.set(p, data),
    appendFileSync: (p, data) => {
      if (opts.failAppend) throw new Error("disk full");
      files.set(p, (files.get(p) ?? "") + data);
    },
    readFileSync: (p) => {
      if (opts.failReadRef && p.endsWith(".txt")) throw new Error("ENOENT sidecar");
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
  };
}

const ok = (stdout) => async () => ({ stdout, stderr: "", code: 0, killed: false });

{
  const { tool, fanout, recall, tools } = await boot(ok(DONE));
  check("registration: exactly runner + fanout + recall", tools.length === 3 && tool.name === "runner" && fanout.name === "fanout" && recall.name === "recall");
  check("registration: no workflow/brief/report tools", !tools.some((t) => /workflow|brief|report/.test(t.name)));
  check("registration: fanout params have jobs array", fanout.parameters?.properties?.jobs?.type === "array");
  check("registration: promptSnippet set", typeof tool.promptSnippet === "string" && tool.promptSnippet.includes("runner"));
  check("registration: guidelines nonempty", Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length >= 1);
  check("registration: params have tool/args/node/task", (() => {
    const props = tool.parameters?.properties ?? {};
    return "tool" in props && "args" in props && "node" in props && "task" in props;
  })());
  const pa = tool.prepareArguments;
  check("prepareArguments aliases", pa({ tool_name: "run_query" }).tool === "run_query" && pa(null).tool === "");
}

{
  // e2e DONE: result + status, audit entry, correct argv to spawnPi
  let seenArgv = null;
  const spy = async (_bin, argv) => {
    seenArgv = argv;
    return { stdout: DONE, stderr: "", code: 0, killed: false };
  };
  const { tool, entries } = await boot(spy);
  const res = await tool.execute("tc", { tool: "run_query", args: { query_id: "q1" }, node: "node2" }, undefined);
  check("e2e done: text returned", res.content[0].text.includes("count=3"));
  check("e2e done: details.status done", res.details.status === "done" && res.details.node === "node2" && res.details.tool === "run_query");
  check("e2e done: argv routed to node + tool", seenArgv.includes("--no-extensions") && seenArgv[seenArgv.indexOf("--tools") + 1] === "run_query" && seenArgv[seenArgv.indexOf("--model") + 1] === "node2/small-model");
  check("e2e done: -e loads the tool's extension", seenArgv[seenArgv.indexOf("-e") + 1] === "/abs/data-tools.mjs");
  check(
    "e2e done: audit entry",
    entries.length === 1 &&
      entries[0].type === "runner" &&
      entries[0].node === "node2" &&
      entries[0].tool === "run_query" &&
      entries[0].status === "done" &&
      entries[0].args.query_id === "q1" &&
      entries[0].tool_calls === 1 &&
      typeof entries[0].wall_ms === "number",
  );
}

{
  // e2e ABORT: returned (not thrown), marker prefix, status abort
  const { tool } = await boot(ok(ABORT));
  const res = await tool.execute("tc", { tool: "run_query", args: {} }, undefined);
  check("e2e abort: not thrown, status abort", res.details.status === "abort");
  check("e2e abort: marker prefix", res.content[0].text.startsWith("[runner ABORT on local]"));
}

{
  // default node local when node omitted; SCOUT_DEFAULT_NODE re-routes
  const { tool } = await boot(ok(DONE));
  const res = await tool.execute("tc", { tool: "run_query" }, undefined);
  check("e2e: default node local", res.details.node === "local");
  process.env.SCOUT_DEFAULT_NODE = "node2";
  const res2 = await tool.execute("tc", { tool: "run_query" }, undefined);
  delete process.env.SCOUT_DEFAULT_NODE;
  check("e2e: SCOUT_DEFAULT_NODE re-routes an unqualified job", res2.details.node === "node2");
}

{
  // e2e tool_error: delegated tool errored -> returned (not thrown), deterministic status
  const { tool, fanout } = await boot(ok(TOOLERR));
  const res = await tool.execute("tc", { tool: "run_query", args: {} }, undefined);
  check("e2e tool_error: not thrown, status tool_error", res.details.status === "tool_error");
  check("e2e tool_error: marker prefix", res.content[0].text.startsWith("[runner tool_error on local]"));
  const fres = await fanout.execute("f", { jobs: [{ tool: "run_query", node: "local" }] }, undefined);
  const arr = JSON.parse(fres.content[0].text);
  check("fanout tool_error: per-job status tool_error, dispatch ok", arr[0].status === "tool_error" && fres.details.ok === 1);
}

// Error paths
const execErr = async (fn) => {
  const { tool } = await boot(ok(DONE));
  let err = null;
  try {
    await tool.execute("tc", fn, undefined);
  } catch (e) {
    err = e;
  }
  return err;
};
check("unknown tool -> Error:", (await execErr({ tool: "ghost" }))?.message.includes("is not active"));
check("self tool -> Error: (recursion guard)", (await execErr({ tool: "runner" }))?.message.includes("cannot delegate to itself"));
check("unknown node -> Error:", (await execErr({ tool: "run_query", node: "mars" }))?.message.includes('unknown scout node "mars"'));
check("empty tool -> Error:", (await execErr({ args: {} }))?.message.includes("runner needs a tool"));

// Seam / infra paths
{
  const cases = [
    ["killed -> Seam timeout", async () => ({ stdout: "", stderr: "", code: 0, killed: true }), /^Seam: runner timed out/],
    ["code 127 -> Error pi missing", async () => ({ stdout: "", stderr: "", code: 127, killed: false }), /^Error: pi binary not found/],
    ["provider error -> Seam", async () => ({ stdout: [msgErr, retry, msgErr].join("\n") + "\n", stderr: "bad arch", code: 0, killed: false }), /^Seam: runner provider error/],
    ["empty concluded -> Seam", async () => ({ stdout: [toolStart, endOk].join("\n") + "\n", stderr: "", code: 0, killed: false }), /^Seam: runner on local .* produced no output/],
    ["spawn throws -> Error run", async () => { throw new Error("boom"); }, /^Error: could not run pi/],
  ];
  for (const [name, impl, re] of cases) {
    const { tool } = await boot(impl);
    let err = null;
    try {
      await tool.execute("tc", { tool: "run_query", args: {} }, undefined);
    } catch (e) {
      err = e;
    }
    check(`seam/error: ${name}`, err !== null && re.test(err.message));
  }
}

{
  // truncation to RUNNER_MAX_CHARS
  const long = td("z".repeat(200) + "\nDONE\n");
  const { tool } = await boot(ok(toolStart + "\n" + long + "\n" + endOk + "\n"), { env: { RUNNER_MAX_CHARS: "40" } });
  const res = await tool.execute("tc", { tool: "run_query", args: {} }, undefined);
  check("budget: truncated to max", res.content[0].text.length === 40 && res.details.truncated === true);
}

// ---------- fanout: coercion ----------
check("fanout coerce: jobs array + node lowercase", (() => {
  const j = coerceFanoutArgs({ jobs: [{ tool: "a" }, { tool: "b", node: "NODE2" }] });
  return j.length === 2 && j[1].node === "node2" && j[0].tool === "a";
})());
check("fanout coerce: raw array", coerceFanoutArgs([{ tool: "a" }]).length === 1);
check("fanout coerce: JSON string", coerceFanoutArgs('[{"tool":"a"}]').length === 1);
check("fanout coerce: garbage -> []", coerceFanoutArgs(null).length === 0 && coerceFanoutArgs({}).length === 0 && coerceFanoutArgs("nope").length === 0);
// tolerant salvage of a model-double-encoded jobs STRING (a small model emitted jobs as a
// string with a trailing comma after ] -> strict JSON.parse "Extra data")
check("parseJobsString: trailing comma after ] (observed failure)", (() => {
  const s = '[{"tool":"query_database","args":{"sql":"SELECT 1"},"node":"local"},{"tool":"query_database","args":{"sql":"SELECT 2"},"node":"node2"}],';
  const p = parseJobsString(s);
  return Array.isArray(p) && p.length === 2 && p[0].tool === "query_database";
})());
check("parseJobsString: trailing comma before ]", (() => {
  const p = parseJobsString('[{"tool":"a","node":"local"},]');
  return Array.isArray(p) && p.length === 1;
})());
check("parseJobsString: extra data after ]", (() => {
  const p = parseJobsString('[{"tool":"a"}]  <end>');
  return Array.isArray(p) && p.length === 1;
})());
check("parseJobsString: clean string still parses", parseJobsString('[{"tool":"a"}]').length === 1);
check("parseJobsString: unsalvageable -> null", parseJobsString("not json at all") === null);
check("fanout coerce: recovers the trailing-comma string", (() => {
  const bad = '[{"tool":"query_database","args":{"sql":"SELECT 1"},"node":"local"}],';
  const jobs = coerceFanoutArgs({ jobs: bad });
  return jobs.length === 1 && jobs[0].tool === "query_database" && jobs[0].node === "local";
})());

// ---------- fanout: wiring ----------
{
  // e2e: two jobs both done -> results array + fanout audit entry
  const { fanout, entries } = await boot(ok(DONE));
  const res = await fanout.execute("f", { jobs: [{ tool: "run_query", args: { sql: "a" }, node: "local" }, { tool: "run_query", args: { sql: "b" }, node: "node2" }] }, undefined);
  const arr = JSON.parse(res.content[0].text);
  check("fanout e2e: 2 results", Array.isArray(arr) && arr.length === 2);
  check("fanout e2e: per-job status done + node", arr[0].status === "done" && arr[0].node === "local" && arr[1].node === "node2");
  check("fanout e2e: details ok=2", res.details.jobs === 2 && res.details.ok === 2);
  check("fanout e2e: fanout audit entry", entries.some((e) => e.type === "fanout" && e.ok === 2 && e.jobs === 2));
  check("fanout e2e: per-job runner audit entries tagged via=fanout", entries.filter((e) => e.type === "runner" && e.via === "fanout").length === 2);
}

{
  // failure isolation: one bad job (inactive tool) does not sink the others; no throw
  const { fanout } = await boot(ok(DONE));
  const res = await fanout.execute("f", { jobs: [{ tool: "run_query", node: "local" }, { tool: "ghost", node: "node2" }] }, undefined);
  const arr = JSON.parse(res.content[0].text);
  check("fanout isolation: good job done, bad job error, both returned", arr[0].status === "done" && arr[1].status === "error" && /not active/.test(arr[1].error));
  check("fanout isolation: ok=1", res.details.ok === 1);
}

{
  // unknown node in one job is isolated too, and names the known nodes
  const { fanout } = await boot(ok(DONE));
  const res = await fanout.execute("f", { jobs: [{ tool: "run_query", node: "mars" }, { tool: "run_query" }] }, undefined);
  const arr = JSON.parse(res.content[0].text);
  check("fanout isolation: unknown node -> that job error, other done", arr[0].status === "error" && /unknown scout node "mars"/.test(arr[0].error) && arr[1].status === "done");
}

{
  // self-delegation guarded per-job (recursion) — reported, not thrown
  const { fanout } = await boot(ok(DONE));
  const res = await fanout.execute("f", { jobs: [{ tool: "runner", node: "local" }, { tool: "fanout", node: "local" }] }, undefined);
  const arr = JSON.parse(res.content[0].text);
  check("fanout: self/runner and self/fanout jobs -> error status", arr[0].status === "error" && arr[1].status === "error" && /itself/.test(arr[0].error) && /itself/.test(arr[1].error));
}

{
  // empty jobs -> Error
  const { fanout } = await boot(ok(DONE));
  let err = null;
  try { await fanout.execute("f", { jobs: [] }, undefined); } catch (e) { err = e; }
  check("fanout empty -> Error:", err !== null && /needs a non-empty jobs array/.test(err.message));
}

{
  // cap -> Error
  const { fanout } = await boot(ok(DONE), { env: { RUNNER_MAX_FANOUT: "2" } });
  let err = null;
  try { await fanout.execute("f", { jobs: [{ tool: "run_query" }, { tool: "run_query" }, { tool: "run_query" }] }, undefined); } catch (e) { err = e; }
  check("fanout over cap -> Error:", err !== null && /cap is 2/.test(err.message));
}

{
  // CONCURRENCY PROOF: a slow spawner tracks max in-flight; Promise.all must overlap all jobs.
  let inflight = 0, maxInflight = 0;
  const slow = (_bin, _argv, _opts) =>
    new Promise((r) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      setTimeout(() => { inflight--; r({ stdout: DONE, stderr: "", code: 0, killed: false }); }, 120);
    });
  const { fanout } = await boot(slow);
  const t0 = Date.now();
  await fanout.execute("f", { jobs: [{ tool: "run_query", node: "local" }, { tool: "run_query", node: "node2" }, { tool: "run_query", node: "local" }] }, undefined);
  const wall = Date.now() - t0;
  check("fanout concurrency: all 3 jobs in-flight simultaneously", maxInflight === 3);
  check("fanout concurrency: wall ~= max not sum (<300ms for 3x120ms)", wall < 300);
}

// ==================== collection filing ====================
const collect = await jiti.import(`../src/lib/collect-core.ts?x=${Math.random()}`);
const { buildCollectRecord, splitInline, resolveCollectDir, collectReadme } = collect;

const fixedDeps = { now: () => new Date("2026-01-02T00:00:00.000Z"), id: () => "abc123" };
const mkInput = (over = {}) => ({
  status: "done", node: "local", provider: "ollama", model: "small-model", tool: "run_query",
  args: { sql: "SELECT 1" }, tool_calls: 1, wall_ms: 42, result: "count=3\nrows", ...over,
});

// collect-core units
check("collect buildCollectRecord: fields + full result_chars + defaults", (() => {
  const r = buildCollectRecord(mkInput(), "collect", [], fixedDeps);
  return r.ts === "2026-01-02T00:00:00.000Z" && r.collect_id === "abc123" && r.phase === "collect" &&
    r.node === "local" && r.provider === "ollama" && r.model === "small-model" && r.tool === "run_query" &&
    r.args.sql === "SELECT 1" && r.status === "done" && r.tool_calls === 1 && r.wall_ms === 42 &&
    r.result === "count=3\nrows" && r.result_chars === "count=3\nrows".length && Array.isArray(r.tags) && r.tags.length === 0;
})());
check("collect buildCollectRecord: phase default + tags passthrough", (() => {
  const r = buildCollectRecord(mkInput(), "", ["hunt", "phase1"], fixedDeps);
  return r.phase === "collect" && r.tags.length === 2 && r.tags[0] === "hunt";
})());
check("collect buildCollectRecord: scout_note kept + capped", (() => {
  const short = buildCollectRecord(mkInput({ scout_note: "narration" }), "collect", [], fixedDeps);
  const long = buildCollectRecord(mkInput({ scout_note: "n".repeat(1000) }), "collect", [], fixedDeps);
  const none = buildCollectRecord(mkInput({ scout_note: "  " }), "collect", [], fixedDeps);
  return short.scout_note === "narration" && long.scout_note.length < 1000 && long.scout_note.endsWith("[…]") && !("scout_note" in none);
})());
check("collect splitInline: under cap -> inline, no sidecar", (() => {
  const r = buildCollectRecord(mkInput({ result: "short" }), "collect", [], fixedDeps);
  const s = splitInline(r, 32768);
  return s.sidecar === undefined && s.line.result === "short" && s.line.result_ref === undefined && s.line.result_chars === 5;
})());
check("collect splitInline: over cap -> sidecar + result_ref, chars kept", (() => {
  const body = "x".repeat(100);
  const r = buildCollectRecord(mkInput({ result: body }), "collect", [], fixedDeps);
  const s = splitInline(r, 10);
  return s.sidecar && s.sidecar.name === "abc123.txt" && s.sidecar.body === body &&
    s.line.result === undefined && s.line.result_ref === "abc123.txt" && s.line.result_chars === 100;
})());
check("collect resolveCollectDir: RUNNER_COLLECT_DIR (trimmed)", resolveCollectDir({ RUNNER_COLLECT_DIR: " /x/collected " }) === "/x/collected");
check("collect resolveCollectDir: disabled when unset/blank", resolveCollectDir({}) === "" && resolveCollectDir({ RUNNER_COLLECT_DIR: "  " }) === "");
check("collect readme names the schema", (() => { const t = collectReadme(); return t.includes("index.jsonl") && t.includes("result_ref") && /deferred/i.test(t); })());

// wiring: collection DISABLED by default (no env) -> no writes, no collect entry
{
  const fs = mockFs();
  const { tool, entries } = await boot(ok(DONE), { fs });
  await tool.execute("tc", { tool: "run_query", args: { sql: "a" } }, undefined);
  check("collect off: no fs writes", fs.files.size === 0 && fs.dirs.size === 0);
  check("collect off: no collect audit entry", !entries.some((e) => e.type === "collect"));
}

// wiring: collection ON -> full-fidelity line even when the caller return is capped
{
  const dir = "/work/collected";
  // a result LONGER than RUNNER_MAX_CHARS so the returned text is truncated but the store is full
  const longBody = "R".repeat(500);
  const fullText = longBody + "\nDONE"; // parseScoutStream trims the trailing newline
  const longStream = [toolStart, td(longBody + "\n"), td("DONE\n"), endOk].join("\n") + "\n";
  const fs = mockFs();
  const { tool, entries } = await boot(ok(longStream), { fs, env: { RUNNER_COLLECT_DIR: dir, RUNNER_MAX_CHARS: "40" } });
  const res = await tool.execute("tc", { tool: "run_query", args: { sql: "a" }, node: "node2" }, undefined);
  const lines = (fs.files.get(join(dir, "index.jsonl")) ?? "").trim().split("\n").filter(Boolean);
  const rec = JSON.parse(lines[0]);
  check("collect on: dir created", fs.dirs.has(dir));
  check("collect on: README written with schema", (fs.files.get(join(dir, "README")) ?? "").includes("index.jsonl"));
  check("collect on: exactly one index line", lines.length === 1);
  check("collect on: FULL result stored (not the 40-char caller cap)", rec.result === fullText && rec.result_chars === fullText.length);
  check("collect on: caller return WAS capped to 40", res.content[0].text.length === 40 && res.details.truncated === true);
  check("collect on: record manifest fields", rec.node === "node2" && rec.provider === "node2" && rec.model === "small-model" && rec.tool === "run_query" && rec.status === "done" && rec.tool_calls === 1 && rec.args.sql === "a" && rec.phase === "collect");
  check("collect on: collect audit entry", entries.some((e) => e.type === "collect" && e.node === "node2" && e.status === "done" && e.result_chars === fullText.length));
}

// wiring: verbatim tool output is the filed result; scout narration rides along as scout_note
{
  const dir = "/work/collected";
  const stream = [toolStart, toolEndData("a|1\nb|2"), td("two rows, a and b\nDONE\n"), endOk].join("\n") + "\n";
  const fs = mockFs();
  const { tool } = await boot(ok(stream), { fs, env: { RUNNER_COLLECT_DIR: dir } });
  const res = await tool.execute("tc", { tool: "run_query", args: {} }, undefined);
  const rec = JSON.parse((fs.files.get(join(dir, "index.jsonl")) ?? "").trim());
  check("collect data: result = verbatim tool output, scout_note = narration", rec.result === "a|1\nb|2" && rec.scout_note === "two rows, a and b\nDONE");
  check("caller return: verbatim tool output, not the narration", res.content[0].text === "a|1\nb|2" && res.details.tool_calls === 1);
}

// wiring: sidecar split when a single result exceeds RUNNER_COLLECT_MAX_INLINE
{
  const dir = "/work/collected";
  const body = "S".repeat(300);
  const fullText = body + "\nDONE";
  const stream = [toolStart, td(body + "\n"), td("DONE\n"), endOk].join("\n") + "\n";
  const fs = mockFs();
  const { tool } = await boot(ok(stream), { fs, env: { RUNNER_COLLECT_DIR: dir, RUNNER_COLLECT_MAX_INLINE: "50" } });
  await tool.execute("tc", { tool: "run_query", args: {} }, undefined);
  const rec = JSON.parse((fs.files.get(join(dir, "index.jsonl")) ?? "").trim());
  check("collect sidecar: index line carries result_ref, drops result", rec.result === undefined && typeof rec.result_ref === "string" && rec.result_ref.endsWith(".txt"));
  check("collect sidecar: sidecar file holds the full body", (fs.files.get(join(dir, rec.result_ref)) ?? "") === fullText && rec.result_chars === fullText.length);
}

// wiring: FAILURES are filed too (via fanout, which collects instead of throwing)
{
  const dir = "/work/collected";
  const fs = mockFs();
  const { fanout } = await boot(ok(DONE), { fs, env: { RUNNER_COLLECT_DIR: dir } });
  await fanout.execute("f", { jobs: [{ tool: "run_query", node: "local" }, { tool: "ghost", node: "node2" }] }, undefined);
  const recs = (fs.files.get(join(dir, "index.jsonl")) ?? "").trim().split("\n").map((l) => JSON.parse(l));
  check("collect failures: both jobs filed", recs.length === 2);
  check("collect failures: good=done, bad=error with message in result", recs.some((r) => r.status === "done") && recs.some((r) => r.status === "error" && /not active/.test(r.result)));
}

// wiring: a filing fault NEVER fails the dispatch (best-effort) — logs collect_seam
{
  const dir = "/work/collected";
  const fs = mockFs({ failAppend: true });
  const { tool, entries } = await boot(ok(DONE), { fs, env: { RUNNER_COLLECT_DIR: dir } });
  let threw = false;
  let res = null;
  try { res = await tool.execute("tc", { tool: "run_query", args: {} }, undefined); } catch { threw = true; }
  check("collect best-effort: dispatch still succeeds despite write fault", threw === false && res.details.status === "done");
  check("collect best-effort: collect_seam forensic entry recorded", entries.some((e) => e.type === "collect_seam" && /disk full/.test(e.message)));
}

// ==================== recall ====================
const { parseCollectedIndex, filterCollected, coerceCollectQuery } = collect;

const rec = (over = {}) => JSON.stringify(buildCollectRecord(mkInput(over), over.phase ?? "collect", over.tags ?? [], { now: () => new Date(over.ts ?? "2026-01-02T00:00:00.000Z"), id: () => over.id ?? "x" }));
// a small index.jsonl body across nodes/status/time
const INDEX = [
  rec({ id: "a", ts: "2026-01-02T00:00:01.000Z", node: "local", status: "done", tool: "query_database", result: "AAA" }),
  rec({ id: "b", ts: "2026-01-02T00:00:02.000Z", node: "node2", status: "tool_error", tool: "query_database", result: "BBB" }),
  rec({ id: "c", ts: "2026-01-02T00:00:03.000Z", node: "local", status: "done", tool: "grep", result: "CCC" }),
].join("\n") + "\n";

// parseCollectedIndex
check("recall parse: tolerant JSONL, skips garbage/blank", (() => {
  const recs = parseCollectedIndex(INDEX + "not json\n\n" + rec({ id: "d", status: "done" }));
  return recs.length === 4 && recs[0].collect_id === "a";
})());
check("recall parse: empty/undefined -> []", parseCollectedIndex("").length === 0 && parseCollectedIndex(undefined).length === 0);

// filterCollected
const RECS = parseCollectedIndex(INDEX);
check("recall filter: by status done", filterCollected(RECS, { status: "done" }).every((r) => r.status === "done") && filterCollected(RECS, { status: "done" }).length === 2);
check("recall filter: by node case-insensitive", filterCollected(RECS, { node: "NODE2" }).length === 1);
check("recall filter: by tool", filterCollected(RECS, { tool: "grep" }).length === 1);
check("recall filter: since bound", filterCollected(RECS, { since: "2026-01-02T00:00:02.000Z" }).length === 2);
check("recall filter: sorted ascending by ts", (() => { const f = filterCollected(RECS, {}); return f[0].collect_id === "a" && f[2].collect_id === "c"; })());
check("recall filter: limit keeps most recent N", (() => { const f = filterCollected(RECS, { limit: 2 }); return f.length === 2 && f[0].collect_id === "b" && f[1].collect_id === "c"; })());
check("recall filter: no match -> []", filterCollected(RECS, { node: "mars" }).length === 0);

// coerceCollectQuery
check("recall coerce: aliases + node lowercase + numeric limit", (() => {
  const q = coerceCollectQuery({ tool_name: "query_database", target: "LOCAL", status: "done", limit: "5", after: "2026-01-01" });
  return q.tool === "query_database" && q.node === "local" && q.status === "done" && q.limit === 5 && q.since === "2026-01-01";
})());
check("recall coerce: garbage -> {}", Object.keys(coerceCollectQuery(null)).length === 0 && Object.keys(coerceCollectQuery("x")).length === 0);

// registration
{
  const { recall, tools } = await boot(ok(DONE), { env: { RUNNER_COLLECT_DIR: "/work/collected" } });
  check("recall registration: tool present, 3 tools total", tools.length === 3 && recall && recall.name === "recall");
  check("recall registration: optional filter params", (() => { const p = recall.parameters?.properties ?? {}; return "tool" in p && "node" in p && "status" in p && "since" in p && "limit" in p; })());
}

// wiring: disabled store -> Error
{
  const { recall } = await boot(ok(DONE)); // no collect env
  let err = null;
  try { await recall.execute("r", {}, undefined); } catch (e) { err = e; }
  check("recall disabled -> Error:", err !== null && /no collected store/.test(err.message));
}

// wiring: no index yet -> empty, not error
{
  const dir = "/work/collected";
  const fs = mockFs(); // dir empty, index absent
  const { recall } = await boot(ok(DONE), { fs, env: { RUNNER_COLLECT_DIR: dir } });
  const res = await recall.execute("r", {}, undefined);
  check("recall no index: returns empty, details.matched 0", res.details.matched === 0 && res.content[0].text.includes("no collected records"));
}

// wiring: filter + full-fidelity load + forensic entry
{
  const dir = "/work/collected";
  const fs = mockFs();
  fs.files.set(join(dir, "index.jsonl"), INDEX);
  const { recall, entries } = await boot(ok(DONE), { fs, env: { RUNNER_COLLECT_DIR: dir } });
  const res = await recall.execute("r", { status: "done" }, undefined);
  const arr = JSON.parse(res.content[0].text);
  check("recall load: only done, full results, ascending", arr.length === 2 && arr[0].result === "AAA" && arr[1].result === "CCC");
  check("recall load: details matched/returned_full", res.details.matched === 2 && res.details.returned_full === 2 && res.details.budget_hit === false);
  check("recall load: forensic recall entry", entries.some((e) => e.type === "recall" && e.matched === 2 && e.query.status === "done"));
}

// wiring: sidecar hydration — a result_ref record is read back to full text
{
  const dir = "/work/collected";
  const fs = mockFs();
  // one split (over inline cap) record produced by the REAL filing path
  const big = "Z".repeat(200);
  const stream = [toolStart, td(big + "\n"), td("DONE\n"), endOk].join("\n") + "\n";
  const { tool } = await boot(ok(stream), { fs, env: { RUNNER_COLLECT_DIR: dir, RUNNER_COLLECT_MAX_INLINE: "50" } });
  await tool.execute("tc", { tool: "run_query", args: {} }, undefined); // files a sidecar record
  const { recall } = await boot(ok(DONE), { fs, env: { RUNNER_COLLECT_DIR: dir } });
  const res = await recall.execute("r", {}, undefined);
  const arr = JSON.parse(res.content[0].text);
  const hydrated = arr[arr.length - 1];
  check("recall sidecar: hydrated to full body, result_ref dropped", hydrated.result === big + "\nDONE" && hydrated.result_ref === undefined);
}

// wiring: an unreadable included sidecar becomes a noted record, never a throw
{
  const dir = "/work/collected";
  const fs = mockFs({ failReadRef: true });
  const full = buildCollectRecord(mkInput({ result: "Q".repeat(100) }), "collect", [], { now: () => new Date("2026-01-02T00:00:01.000Z"), id: () => "gone" });
  const { line } = splitInline(full, 10);
  fs.files.set(join(dir, "index.jsonl"), JSON.stringify(line) + "\n");
  const { recall } = await boot(ok(DONE), { fs, env: { RUNNER_COLLECT_DIR: dir } });
  const res = await recall.execute("r", {}, undefined);
  const arr = JSON.parse(res.content[0].text);
  check("recall sidecar unreadable: noted record, returned_full counts it", /unreadable/.test(arr[0].result) && res.details.returned_full === 1);
}

// wiring: budget -> NEWEST kept full (by result_chars), older stubbed + flagged over_budget
{
  const dir = "/work/collected";
  const fs = mockFs();
  // three inline records of 100 chars each; budget 150 -> the newest fits, the older two stub
  const mk = (id, ts, body) => JSON.stringify(buildCollectRecord(mkInput({ result: body }), "collect", [], { now: () => new Date(ts), id: () => id }));
  fs.files.set(join(dir, "index.jsonl"), [
    mk("r1", "2026-01-02T00:00:01.000Z", "1".repeat(100)),
    mk("r2", "2026-01-02T00:00:02.000Z", "2".repeat(100)),
    mk("r3", "2026-01-02T00:00:03.000Z", "3".repeat(100)),
  ].join("\n") + "\n");
  const { recall } = await boot(ok(DONE), { fs, env: { RUNNER_COLLECT_DIR: dir, RUNNER_RECALL_MAX_CHARS: "150" } });
  const res = await recall.execute("r", {}, undefined);
  const arr = JSON.parse(res.content[0].text);
  check("recall budget: 1 full, budget_hit true, matched 3", res.details.returned_full === 1 && res.details.budget_hit === true && res.details.matched === 3);
  check("recall budget: NEWEST (r3) kept full, output stays chronological", arr[2].collect_id === "r3" && arr[2].result === "3".repeat(100));
  check("recall budget: older stubs flagged over_budget, no result, no fabricated result_ref", arr[0].over_budget === true && arr[0].result === undefined && arr[0].result_ref === undefined && arr[1].over_budget === true);
}

// wiring: over-budget SIDECAR record keeps its REAL ref and is NOT read (no wasted I/O)
{
  const dir = "/work/collected";
  const fs = mockFs();
  const reads = [];
  const baseRead = fs.readFileSync;
  fs.readFileSync = (p) => { reads.push(p); return baseRead(p); };
  const sc = (id, ts, body) => {
    const full = buildCollectRecord(mkInput({ result: body }), "collect", [], { now: () => new Date(ts), id: () => id });
    const { line, sidecar } = splitInline(full, 10); // force a sidecar
    fs.files.set(join(dir, sidecar.name), sidecar.body);
    return JSON.stringify(line);
  };
  // older A + newer B, each 100-char sidecar; budget 100 -> only B (newest) fits
  fs.files.set(join(dir, "index.jsonl"), [
    sc("A", "2026-01-02T00:00:01.000Z", "A".repeat(100)),
    sc("B", "2026-01-02T00:00:02.000Z", "B".repeat(100)),
  ].join("\n") + "\n");
  const { recall } = await boot(ok(DONE), { fs, env: { RUNNER_COLLECT_DIR: dir, RUNNER_RECALL_MAX_CHARS: "100" } });
  const res = await recall.execute("r", {}, undefined);
  const arr = JSON.parse(res.content[0].text);
  const A = arr.find((r) => r.collect_id === "A"), B = arr.find((r) => r.collect_id === "B");
  check("recall sidecar+budget: newest B hydrated full", B.result === "B".repeat(100) && B.result_ref === undefined);
  check("recall sidecar+budget: older A stubbed, keeps REAL result_ref, over_budget", A.result === undefined && A.result_ref === "A.txt" && A.over_budget === true);
  check("recall sidecar+budget: A.txt NOT read (budget decided before hydrate)", !reads.some((p) => p.endsWith("A.txt")) && reads.some((p) => p.endsWith("B.txt")));
}

// wiring: a throwing appendEntry NEVER breaks a dispatch or a fanout batch
{
  const { tool } = await boot(ok(DONE), { throwAppend: true });
  let threw = false, res = null;
  try { res = await tool.execute("tc", { tool: "run_query", args: {} }, undefined); } catch { threw = true; }
  check("safeAppend guard: runner survives a throwing appendEntry", threw === false && res.details.status === "done");
}
{
  const { fanout } = await boot(ok(DONE), { throwAppend: true, fs: mockFs(), env: { RUNNER_COLLECT_DIR: "/work/collected" } });
  let threw = false, res = null;
  try { res = await fanout.execute("f", { jobs: [{ tool: "run_query", node: "local" }, { tool: "run_query", node: "node2" }] }, undefined); } catch { threw = true; }
  const arr = res && JSON.parse(res.content[0].text);
  check("safeAppend guard: fanout batch isolation survives a throwing appendEntry", threw === false && arr.length === 2 && res.details.ok === 2);
}

// wiring: recall cannot be delegated (recursion/sense guard) via fanout
{
  const { fanout } = await boot(ok(DONE), { env: { RUNNER_COLLECT_DIR: "/work/collected" } });
  const res = await fanout.execute("f", { jobs: [{ tool: "recall", node: "local" }] }, undefined);
  const arr = JSON.parse(res.content[0].text);
  check("recall not delegatable: fanout job -> error 'itself'", arr[0].status === "error" && /itself/.test(arr[0].error));
}

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
