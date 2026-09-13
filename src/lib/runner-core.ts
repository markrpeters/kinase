/**
 * runner-core — pure, testable helpers for runner-tool.ts (the generic task RUNNER).
 *
 * A scout is a task RUNNER, not a reasoner: tool call → wait → report findings + status
 * → DONE (or ABORT + reason). The runner is TOOL-AGNOSTIC: it inherits the parent
 * session's own action tools, so it serves any harness. Dispatch is EXPLICIT: the
 * caller names the tool + args; the scout's only job is to make that one prescribed
 * call and report. Small local models handle this shape reliably where free-form
 * delegation fails.
 *
 * The tool-inheritance mechanic (pi 0.84.2):
 *   - pi.getActiveTools(): string[]  — the parent's currently-active tool names.
 *   - pi.getAllTools(): ToolInfo[]   — each with sourceInfo.path = the extension file
 *     that registered it. So we resolve a requested custom tool to the exact -e
 *     extension file to load in the subagent.
 *   - Behavior that lives in pi.on() hooks never appears in getActiveTools() and is
 *     absent under `--no-extensions` (explicit -e paths still work). "Parent's action
 *     tools, bare of everything else" falls out for free — no allow/deny bookkeeping.
 *
 * Everything here is side-effect-free so the jiti mock suite exercises it with no live
 * model; the spawn glue (node:child_process.spawn WITH env — ExecOptions has no env
 * field, so pi.exec cannot pass environment through) lives in runner-tool.ts.
 */

import { parseScoutStream, resolveNodeModel } from "./scout-core.ts";
export { resolveNodeModel };

/** Built-in tool names (SDK: read, bash, edit, write, grep, find, ls). A requested
 * built-in needs no -e extension; a custom/extension tool is loaded from its
 * sourceInfo.path. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

const TOOL_KEYS = ["tool", "tool_name", "toolName", "name", "call"] as const;
const NODE_KEYS = ["node", "target", "host"] as const;
const ARGS_KEYS = ["args", "arguments", "params", "input", "parameters"] as const;
const TASK_KEYS = ["task", "note", "instruction", "why"] as const;

export interface RunnerArgs {
  node: string;
  tool: string;
  args: Record<string, unknown>;
  task: string;
}

/** Tolerate local-model argument drift (parameter renames). Never throws. `args` is
 * normalized to an object: a JSON string is parsed, anything else that isn't an object
 * becomes {}. node/task default to "". */
export function coerceRunnerArgs(raw: unknown): RunnerArgs {
  const pickStr = (rec: Record<string, unknown>, keys: readonly string[]): string => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
      if (typeof v === "number") return String(v);
    }
    return "";
  };
  const toObj = (v: unknown): Record<string, unknown> => {
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    if (typeof v === "string" && v.trim() !== "") {
      try {
        const p = JSON.parse(v);
        if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
      } catch {
        /* not JSON — fall through */
      }
    }
    return {};
  };
  if (!raw || typeof raw !== "object") return { node: "", tool: "", args: {}, task: "" };
  const rec = raw as Record<string, unknown>;
  return {
    node: pickStr(rec, NODE_KEYS).toLowerCase(),
    tool: pickStr(rec, TOOL_KEYS),
    args: toObj((() => {
      for (const k of ARGS_KEYS) if (k in rec) return rec[k];
      return undefined;
    })()),
    task: pickStr(rec, TASK_KEYS),
  };
}

/** Coerce a fanout call's `jobs` into an array of RunnerArgs. Tolerant: accepts the
 * array under `jobs`/`tasks`/`calls`, or a raw array, or a JSON string of either. Each
 * element is normalized by coerceRunnerArgs. Never throws; returns [] on garbage. */
export function coerceFanoutArgs(raw: unknown): RunnerArgs[] {
  let arr: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    arr = rec["jobs"] ?? rec["tasks"] ?? rec["dispatches"] ?? rec["calls"] ?? rec["items"];
  }
  if (typeof arr === "string") {
    const parsed = parseJobsString(arr);
    if (parsed === null) return [];
    arr = parsed;
  }
  if (!Array.isArray(arr)) return [];
  return arr.map(coerceRunnerArgs);
}

/** Tolerant parse of a jobs value the model double-encoded as a JSON STRING. Small local
 * models have been observed to emit `jobs` as a string AND append trailing junk (`[…]`
 * followed by a stray comma → "Extra data"), which strict JSON.parse rejects. Salvage
 * it: try as-is, then slice to the outermost [...], then strip trailing commas before a
 * closing token. Returns the array, or null if nothing parses to an array. */
export function parseJobsString(s: string): unknown[] | null {
  const t = s.trim();
  const candidates = [t];
  const i = t.indexOf("[");
  const j = t.lastIndexOf("]");
  if (i >= 0 && j > i) candidates.push(t.slice(i, j + 1)); // drop leading/trailing extra data
  for (const cand of candidates) {
    for (const v of [cand, cand.replace(/,(\s*[\]}])/g, "$1")]) {
      try {
        const p = JSON.parse(v);
        if (Array.isArray(p)) return p;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null;
}

export interface InheritedTool {
  name: string;
  extPath: string | null; // absolute extension file to -e; null for a built-in
  builtin: boolean;
}

/**
 * Resolve a requested tool against the parent session's live toolset (the
 * tool-inheritance mechanic, scoped to the one explicit tool). Throws Error: (model-
 * visible, actionable) on every rejection so the caller can adapt:
 *   - empty tool name
 *   - the runner ITSELF (recursion guard)
 *   - a tool the parent does not currently have active
 *   - a custom tool whose sourceInfo.path is missing (cannot -e it)
 */
export function resolveInheritedTool(
  toolName: string,
  selfName: string,
  activeTools: string[],
  allTools: ReadonlyArray<{ name: string; sourceInfo?: { path?: string } }>,
): InheritedTool {
  if (toolName === "") {
    throw new Error('Error: runner needs a tool — call it as {"tool":"<name>","args":{…}}');
  }
  if (toolName === selfName) {
    throw new Error(`Error: runner cannot delegate to itself ("${selfName}") — pick an action/data tool`);
  }
  if (!activeTools.includes(toolName)) {
    throw new Error(
      `Error: tool "${toolName}" is not active in this session — active tools: ${activeTools.join(", ") || "(none)"}`,
    );
  }
  if ((BUILTIN_TOOLS as readonly string[]).includes(toolName)) {
    return { name: toolName, extPath: null, builtin: true };
  }
  const info = allTools.find((t) => t.name === toolName);
  const path = info?.sourceInfo?.path;
  if (!path || path.trim() === "") {
    throw new Error(
      `Error: cannot resolve the extension file for tool "${toolName}" (no sourceInfo.path) — the runner cannot load it into the subagent`,
    );
  }
  return { name: toolName, extPath: path, builtin: false };
}

/** Build the argv for the bare subagent pi process. `--no-extensions` skips every
 * installed package/extension; explicit `-e <extPath>` still loads the one tool-
 * providing extension; `--tools <name>` allowlists ONLY that tool (built-ins included,
 * so the scout can call nothing else); thinking OFF (no reasoning loops). The
 * instruction is the positional prompt; the runner contract is the appended system
 * prompt. */
export function buildRunnerArgv(opts: {
  ref: string;
  tool: InheritedTool;
  systemPrompt: string;
  userMessage: string;
}): string[] {
  const argv = [
    "--model", opts.ref,
    "-p", "--mode", "json",
    "--no-session", "--no-context-files", "--no-skills", "--no-extensions",
  ];
  if (!opts.tool.builtin && opts.tool.extPath) {
    argv.push("-e", opts.tool.extPath);
  }
  argv.push("--tools", opts.tool.name);
  argv.push("--thinking", "off");
  argv.push("--append-system-prompt", opts.systemPrompt);
  argv.push(opts.userMessage);
  return argv;
}

/** The runner-contract system prompt: one prescribed call, then a forced status line.
 * Deliberately narrow — the scout does not choose a tool or reason about the task; it
 * executes exactly what it was handed and reports. */
export function buildRunnerPrompt(toolName: string): string {
  return (
    "You are a task RUNNER, not a reasoner. You have exactly one tool: " +
    `\`${toolName}\`. Call it EXACTLY ONCE with the arguments you are given — do not ` +
    "alter, add, or drop arguments, and do not call anything else. After the tool " +
    "returns, report its result verbatim (do not summarize or interpret it), then end " +
    "your reply with a line containing only `DONE`. If you cannot run the tool (bad " +
    "arguments, tool error you cannot fix), end your reply with a line `ABORT` " +
    "followed by the reason. Never omit the final DONE or ABORT line."
  );
}

/** The concrete instruction handed as the positional user prompt: the tool + its exact
 * argument JSON, plus any optional free-text note from the caller. */
export function buildRunnerUserMessage(toolName: string, args: Record<string, unknown>, task: string): string {
  const argsJson = JSON.stringify(args);
  const lines = [
    `Call the tool \`${toolName}\` exactly once with these arguments:`,
    argsJson,
  ];
  if (task) lines.push(`Context (for your reference only, do not act on it beyond the call): ${task}`);
  lines.push("Then report the tool result verbatim and end with DONE (or ABORT + reason).");
  return lines.join("\n");
}

export type RunnerStatus = "done" | "abort" | "tool_error" | "no_call" | "unknown";

export interface RunnerStream {
  status: RunnerStatus;
  text: string; // full accumulated assistant text (the report)
  /** The VERBATIM result of the last successful delegated tool call, lifted from the
   * `tool_execution_end` event (json mode carries `result.content[].text`). "" when the
   * stream carried none. The scout's `text` is its NARRATION of this — tiny models
   * summarize and rename labels; the harness files and gates on the DATA, not the
   * narration. */
  toolResult: string;
  toolCalls: number;
  toolErrors: number;
  finish: string | null;
  errored: boolean;
  retries: number;
}

/** Lift the text content of a `tool_execution_end` event's result (pi json mode:
 * `{result:{content:[{type:"text",text}], details}, isError}`); tolerant of a bare string
 * result. Never throws. */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as Record<string, unknown>)["text"] === "string" ? ((c as Record<string, unknown>)["text"] as string) : ""))
    .filter((t) => t !== "")
    .join("\n");
}

/** The verbatim result of the LAST successful tool call in a json-mode stream ("" if none).
 * Defensive: unknown lines skipped, never throws. */
export function lastToolResult(stdout: string): string {
  let out = "";
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (s === "") continue;
    let e: unknown;
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const ev = e as Record<string, unknown>;
    if (ev["type"] !== "tool_execution_end" || ev["isError"] === true) continue;
    const t = toolResultText(ev["result"]);
    if (t !== "") out = t;
  }
  return out;
}

/** Parse a pi `-p --mode json` NDJSON stream for the runner: reuse the scout parser for
 * the text_delta channel + tool/error/retry counts, then classify a DETERMINISTIC
 * status — do NOT trust the tiny model's DONE/ABORT text alone. Precedence:
 *   abort      — the scout explicitly bailed (ABORT sentinel), the most informative signal;
 *   tool_error — the delegated tool call itself errored (tool_execution_end isError), a real
 *                outcome the harness surfaces even if the model mistakenly typed DONE;
 *   no_call    — the stream carries NO tool_execution_start: the model never invoked its
 *                one tool, so whatever it "reported" is fabricated. Seen live: a small
 *                model echoes the call as JSON text, invents output, types DONE. A DONE
 *                with zero calls is therefore never "done". (An EMPTY stream with no
 *                call stays unknown — nothing was reported, so nothing was fabricated;
 *                dispatch turns it into a Seam anyway.)
 *   done       — DONE sentinel, at least one tool call, no tool error;
 *   unknown    — no sentinel (the caller still gets the raw text, never blind).
 * ABORT matches on its own line; DONE on its own line or as the final token — both
 * case-sensitive, to avoid tripping on prose. */
export function parseRunnerStream(stdout: string): RunnerStream {
  const base = parseScoutStream(stdout);
  const hasAbort = /(^|\n)\s*ABORT\b/.test(base.answer);
  // DONE on its own line, or as the last token of the reply ("0.84.2 DONE" — seen live).
  const hasDone = /(^|\n)\s*DONE\s*(\n|$)/.test(base.answer) || /\bDONE\s*$/.test(base.answer);
  const status: RunnerStatus = hasAbort
    ? "abort"
    : base.toolErrors > 0
      ? "tool_error"
      : base.toolCalls === 0 && base.answer !== ""
        ? "no_call"
        : hasDone
          ? "done"
          : "unknown";
  return {
    status,
    text: base.answer,
    toolResult: lastToolResult(stdout),
    toolCalls: base.toolCalls,
    toolErrors: base.toolErrors,
    finish: base.finish,
    errored: base.errored,
    retries: base.retries,
  };
}
