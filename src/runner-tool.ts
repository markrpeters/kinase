/**
 * runner-tool — the generic task RUNNER + FANOUT, plus RECALL over what they collected.
 *
 * Registers THREE tools; the first two share one validated dispatch core (`dispatchOne`):
 *   - `runner`  — delegate ONE prescribed tool call (tool + exact args) to a bare small-model
 *                 subagent on a configured node; it calls the tool once, reports the result,
 *                 ends with DONE (or ABORT + reason). Explicit dispatch; synchronous per call.
 *   - `fanout`  — delegate K such jobs CONCURRENTLY (Promise.all over dispatchOne — each
 *                 spawns its own subprocess → independent node inference). One caller call,
 *                 structured per-job results back, failures ISOLATED (one job's Seam never
 *                 kills the batch). CODE owns the parallelism, not a weak orchestrator model
 *                 emitting K well-formed parallel tool calls.
 *   - `recall`  — one-call filtered load of the append-only collection store that runner and
 *                 fanout file every return into (see lib/collect-core.ts).
 *
 * The runner is TOOL-AGNOSTIC: it inherits whatever tools the parent session has. Both
 * dispatch tools run the subagent BARE (`--no-extensions`: no other extension, hook or
 * package loads), thinking OFF, inheriting the parent's env via node:child_process.spawn.
 *
 * pi surface used (installed 0.84.2): pi.getActiveTools()/getAllTools(); ToolInfo.sourceInfo
 * .path; ExecOptions has NO env field → spawn WITH env; pi tool execution default is
 * "parallel", so fanout's concurrent spawns overlap; CLI flags verified via `pi --help`.
 * Result channel = assistant text_delta.
 *
 * Error contract (errors THROWN so pi sets isError):
 *   "Error: ..." — model-visible, actionable (unknown tool/node, empty args, pi missing).
 *   "Seam: ..."  — infrastructure fault (timeout, provider/serving error, empty stream).
 * A scout ABORT is a legitimate reported outcome, RETURNED with details.status="abort".
 * `runner` throws Error:/Seam: on a failed dispatch; `fanout` NEVER throws for a per-job
 * failure (it reports each job's status incl. error/seam) — only for an empty jobs list.
 *
 * Env knobs (no hardcoded paths in logic):
 *   RUNNER_PI_BIN / SCOUT_PI_BIN  pi binary (default: repo-local ../node_modules/.bin/pi, else "pi")
 *   RUNNER_TIMEOUT_MS         per-call ms  (default 300000 — long data jobs)
 *   RUNNER_MAX_CHARS          report budget (default 8000)
 *   RUNNER_MAX_FANOUT         max jobs per fanout call (default 8 — guards a runaway caller)
 *   RUNNER_COLLECT_DIR        collection store directory ("" / unset = collection disabled)
 *   RUNNER_COLLECT_MAX_INLINE inline result cap before a sidecar file (default 32768)
 *   RUNNER_COLLECT_PHASE      phase label filed on each record (default "collect")
 *   RUNNER_RECALL_MAX_CHARS   total result chars recall returns in full (default 16000)
 *   node routing reuses scout-core's SCOUT_MODEL / SCOUT_MODEL_<NODE> / SCOUT_DEFAULT_NODE.
 *   The subagent inherits the parent's env (process.env) via spawn, so whatever the
 *   delegated tool needs from the environment travels with it.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRunnerArgv,
  buildRunnerPrompt,
  buildRunnerUserMessage,
  coerceFanoutArgs,
  coerceRunnerArgs,
  parseRunnerStream,
  resolveInheritedTool,
  resolveNodeModel,
  type RunnerArgs,
  type RunnerStatus,
} from "./lib/runner-core.ts";
import {
  buildCollectRecord,
  coerceCollectQuery,
  collectReadme,
  filterCollected,
  parseCollectedIndex,
  resolveCollectDir,
  splitInline,
  type CollectInput,
  type CollectRecord,
} from "./lib/collect-core.ts";
import { defaultNode } from "./lib/scout-core.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
// recall is local-read-only — like runner/fanout it is nonsensical to DELEGATE to a scout,
// so it joins the recursion/sense guard.
const SELF_NAMES = ["runner", "fanout", "recall"];

function resolvePiBin(): string {
  const override = process.env["RUNNER_PI_BIN"] ?? process.env["SCOUT_PI_BIN"];
  if (override && override.trim() !== "") return override;
  const local = resolve(EXT_DIR, "../node_modules/.bin/pi");
  return existsSync(local) ? local : "pi";
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}
export type SpawnPi = (
  piBin: string,
  argv: string[],
  opts: { signal?: AbortSignal; timeoutMs: number },
) => Promise<SpawnResult>;

/** Default spawner: node:child_process.spawn WITH env (the whole reason this diverges from
 * pi.exec). stdin ignored (a headless pi must never wait on a terminal), timeout + abort
 * SIGKILL the child. Injectable so the jiti suite runs with no live model. */
const defaultSpawnPi: SpawnPi = (piBin, argv, opts) =>
  new Promise<SpawnResult>((resolveP) => {
    const child = spawn(piBin, argv, {
      env: process.env,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const onAbort = () => {
      killed = true;
      child.kill("SIGKILL");
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const done = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolveP(r);
    };
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => done({ stdout, stderr: stderr + String(e), code: 127, killed }));
    child.on("close", (code) => done({ stdout, stderr, code: code ?? 0, killed }));
  });

/** The subset of node:fs the collection filer needs. Injectable so the jiti suite mocks
 * it (assert the written index line + sidecar split + that a write fault does NOT throw). */
export interface CollectFs {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts: { recursive: true }): void;
  appendFileSync(p: string, data: string): void;
  writeFileSync(p: string, data: string): void;
  readFileSync(p: string): string;
}
const defaultCollectFs: CollectFs = {
  existsSync,
  mkdirSync: (p, opts) => void mkdirSync(p, opts),
  appendFileSync: (p, data) => appendFileSync(p, data),
  writeFileSync: (p, data) => writeFileSync(p, data),
  readFileSync: (p) => readFileSync(p, "utf8"),
};

/** Best-effort forensic append: `pi.appendEntry` must NEVER break a dispatch (the never-
 * throws contract — a throw here would reject a whole `fanout` batch and skip collection
 * filing). Any failure is swallowed; the live return is the source of truth, the audit trail
 * is durability. Every appendEntry in this file goes through here. */
function safeAppend(pi: ExtensionAPI, type: string, data: Record<string, unknown>): void {
  try {
    pi.appendEntry(type, data);
  } catch {
    /* audit is best-effort; a logging fault never fails the tool */
  }
}

/** The single mapping from a DispatchOutcome to its reportable status string, so fanout's
 * per-job result and the collection filer never diverge (done|abort|tool_error|unknown for a
 * successful dispatch; error|seam for a failed one). */
function outcomeStatus(o: DispatchOutcome): string {
  return o.ok ? o.status ?? "unknown" : o.errorKind ?? "error";
}

/** Config for the collection-filing layer (resolved once at boot from env). */
export interface CollectCfg {
  collectDir: string; // "" => collection DISABLED
  collectMaxInline: number;
  collectPhase: string;
  recallBudget: number; // total result chars recall returns in full before stubbing the rest
}

/** Load + filter the collected store for `recall`. Reads index.jsonl (tolerant parse),
 * applies the deterministic filter, then returns records under a TOTAL-chars budget.
 *
 * Budget discipline: inclusion is decided NEWEST-first using each record's `result_chars`
 * (recorded at filing time) — so the most recent, most-relevant returns come back in full
 * and the budget is never spent reading a record that will be stubbed. Only INCLUDED
 * records are hydrated (a `result_ref` sidecar is read back in then); a stub keeps its real
 * `result_ref` (a genuine sidecar the reasoner can `read`) and is flagged `over_budget` —
 * never a fabricated ref. Output stays in chronological order. Never throws: an unreadable
 * included sidecar becomes a noted record. */
function loadRecall(
  fs: CollectFs,
  cfg: CollectCfg,
  q: ReturnType<typeof coerceCollectQuery>,
): { records: CollectRecord[]; matched: number; returned_full: number; budget_hit: boolean } {
  const idx = join(cfg.collectDir, "index.jsonl");
  const all = parseCollectedIndex(fs.readFileSync(idx));
  const matched = filterCollected(all, q); // ascending by ts, already limited

  // Decide inclusion newest-first (by result_chars, no disk read); keep any that still fit.
  const includeFull = new Set<string>();
  let spent = 0;
  for (let i = matched.length - 1; i >= 0; i--) {
    const rec = matched[i];
    const len = rec.result_chars ?? (rec.result?.length ?? 0);
    if (spent + len <= cfg.recallBudget) {
      includeFull.add(rec.collect_id);
      spent += len;
    }
  }

  const records: CollectRecord[] = [];
  let returnedFull = 0;
  for (const rec of matched) {
    if (includeFull.has(rec.collect_id)) {
      // hydrate the full body (inline result, or read the sidecar) — only for included records
      let body = rec.result;
      if (body === undefined && rec.result_ref) {
        try {
          body = fs.readFileSync(join(cfg.collectDir, rec.result_ref));
        } catch {
          const noted: CollectRecord = { ...rec, result: `(sidecar ${rec.result_ref} unreadable — read it directly)` };
          records.push(noted);
          returnedFull++;
          continue;
        }
      }
      const out: CollectRecord = { ...rec, result: body ?? "" };
      delete out.result_ref; // hydrated — the ref is redundant in the returned record
      records.push(out);
      returnedFull++;
    } else {
      // over-budget stub: drop the body, flag it, keep a REAL sidecar ref if one exists
      // (an inline record keeps no ref — narrow the filter/limit instead of "reading" it).
      const stub: CollectRecord = { ...rec, over_budget: true };
      delete stub.result;
      records.push(stub);
    }
  }
  return { records, matched: matched.length, returned_full: returnedFull, budget_hit: returnedFull < matched.length };
}

/** File ONE delegated return into the collected store. DETERMINISTIC + code-owned: the
 * harness files it, never the model. BEST-EFFORT — a filing fault logs a `collect_seam`
 * forensic warning and returns; it NEVER alters the dispatch outcome or throws (the live
 * return is the source of truth). No-op when collection is disabled (`collectDir` empty).
 * Files SUCCESS (full result text) and FAILURE (the error/seam message) alike, so the store
 * is a complete delegation trail. */
function fileCollected(
  pi: ExtensionAPI,
  fs: CollectFs,
  cfg: CollectCfg,
  ctx: { job: RunnerArgs; outcome: DispatchOutcome; fullText: string; provider: string; model: string; tags?: string[] },
): void {
  if (!cfg.collectDir) return;
  try {
    const dir = cfg.collectDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const readme = join(dir, "README");
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, collectReadme());

    const input: CollectInput = {
      status: outcomeStatus(ctx.outcome),
      node: ctx.outcome.node,
      provider: ctx.provider,
      model: ctx.model,
      tool: ctx.outcome.tool,
      args: ctx.job.args,
      tool_calls: ctx.outcome.tool_calls ?? 0,
      wall_ms: ctx.outcome.wall_ms,
      // The store holds the DATA (verbatim tool output) when the stream carried it; the
      // scout's narration rides along as a capped note. Without a captured result (older
      // streams, mocks) the scout text is the result.
      result: ctx.outcome.ok ? (ctx.outcome.toolResult || ctx.fullText) : ctx.outcome.message ?? "",
      ...(ctx.outcome.ok && ctx.outcome.toolResult ? { scout_note: ctx.fullText } : {}),
    };
    const rec = buildCollectRecord(input, cfg.collectPhase, ctx.tags ?? []);
    const { line, sidecar } = splitInline(rec, cfg.collectMaxInline);
    if (sidecar) fs.writeFileSync(join(dir, sidecar.name), sidecar.body);
    fs.appendFileSync(join(dir, "index.jsonl"), JSON.stringify(line) + "\n");

    safeAppend(pi, "collect", {
      collect_id: rec.collect_id,
      dir,
      phase: rec.phase,
      node: rec.node,
      tool: rec.tool,
      status: rec.status,
      result_chars: rec.result_chars,
      sidecar: sidecar ? sidecar.name : null,
    });
  } catch (e) {
    // best-effort durability: a filing fault never fails the dispatch.
    safeAppend(pi, "collect_seam", { dir: cfg.collectDir, message: e instanceof Error ? e.message : String(e) });
  }
}

/** Structured outcome of ONE dispatch — NEVER thrown. `runner` maps a failure to a throw;
 * `fanout` collects it. `ok:false` carries errorKind ("error"=model-visible/actionable,
 * "seam"=infra) + message for either path. */
export interface DispatchOutcome {
  ok: boolean;
  node: string;
  tool: string;
  wall_ms: number;
  model?: string;
  status?: RunnerStatus;
  text?: string;
  /** the UNTRUNCATED scout text (the caller-facing `text` is capped at cfg.maxChars). */
  fullText?: string;
  /** The VERBATIM delegated-tool result lifted from the stream ("" when absent). The store
   * files THIS — a tiny scout's narration summarizes and relabels, which is exactly what a
   * later data check must not be fooled by. */
  toolResult?: string;
  tool_calls?: number;
  truncated?: boolean;
  errorKind?: "error" | "seam";
  message?: string;
}

/** The shared single-dispatch spine. Resolves the inherited tool + node, spawns a bare
 * subagent WITH the parent's env, parses the forced status, appends a forensic entry, and
 * returns a structured outcome. Never throws — the caller decides throw-vs-collect. */
async function dispatchOne(
  pi: ExtensionAPI,
  spawnPi: SpawnPi,
  fs: CollectFs,
  cfg: { piBin: string; timeout: number; maxChars: number } & CollectCfg,
  job: RunnerArgs,
  via: string,
  tags: string[] = [],
): Promise<DispatchOutcome> {
  // Closure state the collection filer needs at the single tail (provider/model resolved
  // mid-flight; fullText = the UNTRUNCATED result — the store is full-fidelity even though
  // the caller-facing return is capped at cfg.maxChars).
  let provider = "";
  let model = "";
  let fullText = "";

  const outcome = await (async (): Promise<DispatchOutcome> => {
    const nodeLabel = job.node || defaultNode(process.env);
    let ref: string, extName: string, argv: string[];
    try {
      // Recursion guard first: neither runner nor fanout may be delegated, even if the
      // active-tool list is unusual (runner-core guards only the single passed selfName).
      if (SELF_NAMES.includes(job.tool)) {
        throw new Error(`Error: runner cannot delegate to itself ("${job.tool}") — pick an action/data tool`);
      }
      const inherited = resolveInheritedTool(job.tool, "runner", pi.getActiveTools(), pi.getAllTools());
      const target = resolveNodeModel(job.node, process.env);
      ref = target.ref;
      provider = target.provider;
      model = target.model;
      extName = inherited.name;
      argv = buildRunnerArgv({
        ref,
        tool: inherited,
        systemPrompt: buildRunnerPrompt(inherited.name),
        userMessage: buildRunnerUserMessage(inherited.name, job.args, job.task),
      });
      // shadow node label with the resolved node
      job = { ...job, node: target.node };
    } catch (e) {
      return { ok: false, node: nodeLabel, tool: job.tool, wall_ms: 0, errorKind: "error", message: e instanceof Error ? e.message : String(e) };
    }

    const t0 = Date.now();
    let res: SpawnResult;
    try {
      res = await spawnPi(cfg.piBin, argv, { timeoutMs: cfg.timeout });
    } catch (e) {
      return {
        ok: false, node: job.node, tool: extName, wall_ms: Date.now() - t0, errorKind: "error",
        message: `Error: could not run pi ("${cfg.piBin}"; set RUNNER_PI_BIN) — cannot dispatch: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const wallMs = Date.now() - t0;
    if (res.killed) {
      return { ok: false, node: job.node, tool: extName, wall_ms: wallMs, errorKind: "seam", message: `Seam: runner timed out after ${cfg.timeout}ms on ${job.node} (tool ${extName})` };
    }
    if (res.code === 127) {
      return { ok: false, node: job.node, tool: extName, wall_ms: wallMs, errorKind: "error", message: `Error: pi binary not found ("${cfg.piBin}"; set RUNNER_PI_BIN) — cannot dispatch` };
    }

    const parsed = parseRunnerStream(res.stdout);
    fullText = parsed.text; // capture the full result BEFORE the caller-facing cap
    const text = parsed.text.slice(0, cfg.maxChars);
    const truncated = parsed.text.length > cfg.maxChars;

    safeAppend(pi, "runner", {
      via,
      node: job.node,
      provider,
      model,
      tool: extName,
      args: job.args,
      task: job.task || null,
      status: parsed.status,
      tool_calls: parsed.toolCalls,
      finish: parsed.finish,
      errored: parsed.errored,
      retries: parsed.retries,
      chars: text.length,
      truncated,
      wall_ms: wallMs,
      exit_code: res.code,
      text_preview: text.slice(0, 300),
    });

    if (parsed.text === "") {
      const message = parsed.errored
        ? `Seam: runner provider error on ${job.node} — ${model} produced no output (${parsed.retries} retries). ${res.stderr.slice(-200)}`
        : `Seam: runner on ${job.node} (tool ${extName}) produced no output after ${parsed.toolCalls} tool call(s)`;
      return { ok: false, node: job.node, tool: extName, wall_ms: wallMs, errorKind: "seam", message };
    }

    return { ok: true, node: job.node, model, tool: extName, status: parsed.status, text, fullText, toolResult: parsed.toolResult, tool_calls: parsed.toolCalls, truncated, wall_ms: wallMs };
  })();

  // Durable, full-fidelity collection filing — best-effort, never alters `outcome`, no-op
  // when disabled. Every delegated return is filed (success + failure).
  fileCollected(pi, fs, cfg, { job, outcome, fullText, provider, model, tags });
  return outcome;
}

export default function (pi: ExtensionAPI, deps: { spawnPi?: SpawnPi; fs?: CollectFs } = {}) {
  const spawnPi = deps.spawnPi ?? defaultSpawnPi;
  const fs = deps.fs ?? defaultCollectFs;
  const cfg: { piBin: string; timeout: number; maxChars: number } & CollectCfg = {
    piBin: resolvePiBin(),
    timeout: Number(process.env["RUNNER_TIMEOUT_MS"] ?? 300000),
    maxChars: Number(process.env["RUNNER_MAX_CHARS"] ?? 8000),
    collectDir: resolveCollectDir(process.env),
    collectMaxInline: Number(process.env["RUNNER_COLLECT_MAX_INLINE"] ?? 32768),
    collectPhase: process.env["RUNNER_COLLECT_PHASE"] ?? "collect",
    recallBudget: Number(process.env["RUNNER_RECALL_MAX_CHARS"] ?? 16000),
  };
  const maxFanout = Number(process.env["RUNNER_MAX_FANOUT"] ?? 8);

  // ---- runner: one prescribed call ----
  pi.registerTool(
    defineTool({
      name: "runner",
      label: "Runner (delegated task-runner on a local model)",
      description:
        "Delegate ONE prescribed tool call to a cheap local model subagent. You name an " +
        "action/data tool active in this session plus its exact arguments; the runner runs " +
        "that single call on a configured node (thinking off) and returns the result with a " +
        "DONE/ABORT status. To run several in parallel, use `fanout` instead.",
      promptSnippet:
        "runner: delegate one prescribed tool call (tool + exact args) to a local model subagent — returns its result + DONE/ABORT status.",
      promptGuidelines: [
        "Only delegate a tool already active in this session; pass its arguments exactly as that tool expects.",
        "The runner does not reason — it makes the one call you specify and reports the result. Interpret the result yourself.",
        "For several delegations at once, use `fanout` (concurrent) rather than many sequential runner calls.",
        "Check details.status: 'done' succeeded, 'abort' means the scout could not run it (read the reason), 'unknown' means no status line was emitted.",
      ],
      parameters: Type.Object({
        tool: Type.String({ description: "Name of an action/data tool active in this session to delegate (e.g. 'grep')." }),
        args: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Exact arguments object for the delegated tool." })),
        node: Type.Optional(Type.String({ description: "Which configured node to dispatch to (default: 'local' — see SCOUT_MODEL_<NODE>)." })),
        task: Type.Optional(Type.String({ description: "Optional free-text context note for the scout (not acted on beyond the call)." })),
      }),
      prepareArguments: coerceRunnerArgs,

      async execute(_toolCallId, params) {
        const job = coerceRunnerArgs(params);
        const o = await dispatchOne(pi, spawnPi, fs, cfg, job, "runner");
        if (!o.ok) throw new Error(o.message);
        const marker =
          o.status === "abort" ? `[runner ABORT on ${o.node}]\n` : o.status === "tool_error" ? `[runner tool_error on ${o.node}]\n` : "";
        return {
          content: [{ type: "text" as const, text: marker + o.text! }],
          details: { status: o.status, node: o.node, model: o.model, tool: o.tool, tool_calls: o.tool_calls, chars: (o.text ?? "").length, truncated: o.truncated, wall_ms: o.wall_ms },
        };
      },
    }),
  );

  // ---- fanout: K prescribed calls, concurrently ----
  pi.registerTool(
    defineTool({
      name: "fanout",
      label: "Fanout (parallel delegated task-runners)",
      description:
        "Delegate SEVERAL prescribed tool calls at once, run CONCURRENTLY across the configured " +
        "nodes. Each job names an active tool + its exact args + a node; the fanout runs " +
        "them in parallel and returns one array of per-job results (status + result/reason). " +
        "One failing job does not stop the others. Use it to parallelize bounded work (e.g. " +
        "the same analysis split across nodes) and keep your own context small.",
      promptSnippet:
        "fanout: delegate K prescribed tool calls concurrently across nodes — returns an array of per-job {status, result/reason}.",
      promptGuidelines: [
        "Each job = {tool, args, node}: tool must be active in this session, args exactly as it expects, node a configured node name (default 'local').",
        "Spread jobs across different nodes to actually parallelize; jobs on the same node share that node's GPU.",
        "Read each job's status in the returned array: 'done'/'abort'/'unknown', or 'error'/'seam' if that one job could not run. Other jobs still return.",
        "Interpret the results yourself — the scouts only run the calls and report.",
      ],
      parameters: Type.Object({
        jobs: Type.Array(
          Type.Object({
            tool: Type.String({ description: "Active tool to delegate for this job." }),
            args: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Exact arguments for this job's tool." })),
            node: Type.Optional(Type.String({ description: "Configured node for this job (default 'local')." })),
            task: Type.Optional(Type.String({ description: "Optional context note for this job's scout." })),
          }),
          { description: "The delegated jobs to run concurrently (1..RUNNER_MAX_FANOUT)." },
        ),
      }),
      prepareArguments: (args: unknown) => ({ jobs: coerceFanoutArgs(args) }),

      async execute(_toolCallId, params) {
        const jobs = coerceFanoutArgs((params as { jobs?: unknown })?.jobs ?? params);
        if (jobs.length === 0) {
          throw new Error('Error: fanout needs a non-empty jobs array — call it as {"jobs":[{"tool":"…","args":{…},"node":"local"}, …]}');
        }
        if (jobs.length > maxFanout) {
          throw new Error(`Error: fanout got ${jobs.length} jobs but the cap is ${maxFanout} (set RUNNER_MAX_FANOUT) — split into batches`);
        }
        const t0 = Date.now();
        // Promise.all: each dispatchOne spawns its own subprocess → concurrent node inference.
        // dispatchOne never throws, so no job's failure rejects the batch.
        const outcomes = await Promise.all(jobs.map((j) => dispatchOne(pi, spawnPi, fs, cfg, j, "fanout")));
        const totalWall = Date.now() - t0;

        const results = outcomes.map((o, i) => ({
          job: i,
          node: o.node,
          tool: o.tool,
          status: outcomeStatus(o), // done|abort|tool_error|unknown | error|seam
          ...(o.ok ? { result: o.text } : { error: o.message }),
          wall_ms: o.wall_ms,
        }));
        const okCount = outcomes.filter((o) => o.ok).length;

        safeAppend(pi, "fanout", {
          jobs: jobs.length,
          ok: okCount,
          statuses: results.map((r) => r.status),
          total_wall_ms: totalWall,
          max_wall_ms: Math.max(0, ...outcomes.map((o) => o.wall_ms)),
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
          details: {
            jobs: jobs.length,
            ok: okCount,
            statuses: results.map((r) => r.status),
            total_wall_ms: totalWall,
            max_wall_ms: Math.max(0, ...outcomes.map((o) => o.wall_ms)),
          },
        };
      },
    }),
  );

  // ---- recall: one-call filtered load of the collected store (phase-2 reasoner) ----
  pi.registerTool(
    defineTool({
      name: "recall",
      label: "Recall (load the collected delegation store)",
      description:
        "Load previously COLLECTED scout returns (filed by runner/fanout) from the durable " +
        "store, filtered by tool/node/status/phase/since. Returns the matching " +
        "records with their FULL result text (up to a chars budget; the rest as manifest " +
        "stubs you can read by result_ref). Use it in a reasoning pass to work over already- " +
        "collected evidence WITHOUT re-querying — recall first, query the raw data only for gaps.",
      promptSnippet:
        "recall: load the collected delegation store (filter by tool/node/status/phase/since) — returns full-fidelity scout returns to reason over.",
      promptGuidelines: [
        "This reads the local collected store; it does not run anything on a node. Delegating it (runner/fanout) is rejected.",
        "Filter to narrow the load: status:'done' for successful returns, node/tool/phase to scope, since:<ISO ts> for recent, limit:N for the most recent N.",
        "Reason over the returned results yourself — they are RAW collected returns, not verdicts. Query the raw data only for what the store does not answer.",
        "If details.budget_hit is true, some matches came back as stubs (result_ref only) — narrow the filter or read a stub's ref for its full text.",
      ],
      parameters: Type.Object({
        tool: Type.Optional(Type.String({ description: "Only records for this delegated tool (e.g. 'grep')." })),
        node: Type.Optional(Type.String({ description: "Only records from this node (e.g. 'local')." })),
        status: Type.Optional(Type.String({ description: "Only this status: 'done' | 'abort' | 'tool_error' | 'unknown' | 'error' | 'seam'." })),
        phase: Type.Optional(Type.String({ description: "Only records filed under this phase label (default filing phase is 'collect')." })),
        since: Type.Optional(Type.String({ description: "Only records at/after this ISO-8601 timestamp." })),
        limit: Type.Optional(Type.Number({ description: "Keep only the most recent N matching records." })),
      }),
      prepareArguments: coerceCollectQuery,

      async execute(_toolCallId, params) {
        if (!cfg.collectDir) {
          throw new Error(
            "Error: recall has no collected store — set RUNNER_COLLECT_DIR to the directory runner/fanout file into",
          );
        }
        const idx = join(cfg.collectDir, "index.jsonl");
        if (!fs.existsSync(idx)) {
          return {
            content: [{ type: "text" as const, text: "[] (no collected records yet)" }],
            details: { matched: 0, returned_full: 0, budget_hit: false, dir: cfg.collectDir },
          };
        }
        const q = coerceCollectQuery(params);
        let loaded: ReturnType<typeof loadRecall>;
        try {
          loaded = loadRecall(fs, cfg, q);
        } catch (e) {
          throw new Error(`Seam: recall could not read the collected store at ${idx} — ${e instanceof Error ? e.message : String(e)}`);
        }

        safeAppend(pi, "recall", {
          dir: cfg.collectDir,
          query: q,
          matched: loaded.matched,
          returned_full: loaded.returned_full,
          budget_hit: loaded.budget_hit,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(loaded.records, null, 2) }],
          details: {
            matched: loaded.matched,
            returned_full: loaded.returned_full,
            budget_hit: loaded.budget_hit,
            dir: cfg.collectDir,
          },
        };
      },
    }),
  );
}
