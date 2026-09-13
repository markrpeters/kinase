/**
 * scout-core — pure, testable helpers for scout-tool.ts.
 *
 * The scout tool dispatches a single-fact repository lookup to a small LOCAL model
 * running as a bare pi subprocess. Code owns dispatch, node routing and result
 * extraction; the model fills the one narrow slot a small model handles well: drive
 * its own grep/read, then conclude in one sentence with a citation.
 *
 * Everything here is side-effect-free so the jiti mock suite can exercise it without
 * a live model. The tool wiring (pi.exec + pi.appendEntry) lives in scout-tool.ts.
 *
 * Node model (localhost by default):
 *   - One node named "local" always exists. Its model ref is SCOUT_MODEL (a full
 *     "provider/id", e.g. "ollama/qwen2.5:7b") or DEFAULT_MODEL_REF when unset.
 *   - Any environment variable SCOUT_MODEL_<NAME>="provider/id" defines a further node
 *     called <name> (lowercased) — e.g. SCOUT_MODEL_GPU2="gpu2/qwen2.5:7b" where
 *     "gpu2" is a provider you declared in ~/.pi/agent/models.json pointing at another
 *     machine. SCOUT_MODEL_LOCAL overrides the local node the same way.
 *   - SCOUT_DEFAULT_NODE picks which node a call without `node` goes to (default "local").
 */

/** Result-extraction contract: the answer is the assistant text_delta stream, NEVER
 * tool_execution_end.result. A serving fault surfaces as message_end stopReason:"error"
 * (e.g. the model server rejects the model's architecture) — we detect it so the tool
 * raises a Seam instead of silently returning empty. */
export interface ScoutStream {
  answer: string;
  toolCalls: number;
  toolErrors: number; // tool_execution_end events with isError === true
  finish: string | null;
  errored: boolean; // any assistant message_end with stopReason === "error"
  retries: number; // auto_retry_start count
}

/** Parse pi `-p --mode json` NDJSON. Defensive: unknown lines are skipped, never throw. */
export function parseScoutStream(stdout: string): ScoutStream {
  const text: string[] = [];
  let toolCalls = 0;
  let toolErrors = 0;
  let finish: string | null = null;
  let errored = false;
  let retries = 0;
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (s === "") continue;
    let e: unknown;
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof e !== "object" || e === null) continue;
    const ev = e as Record<string, unknown>;
    switch (ev["type"]) {
      case "message_update": {
        const ame = ev["assistantMessageEvent"];
        if (ame && typeof ame === "object") {
          const a = ame as Record<string, unknown>;
          if (a["type"] === "text_delta" && typeof a["delta"] === "string") text.push(a["delta"]);
        }
        break;
      }
      case "tool_execution_start":
        toolCalls++;
        break;
      case "tool_execution_end":
        if (ev["isError"] === true) toolErrors++;
        break;
      case "auto_retry_start":
        retries++;
        break;
      case "agent_end":
        finish = ev["willRetry"] === true ? "willRetry" : "end";
        break;
      case "message_end": {
        const m = ev["message"];
        if (m && typeof m === "object") {
          const msg = m as Record<string, unknown>;
          if (msg["role"] === "assistant" && msg["stopReason"] === "error") errored = true;
        }
        break;
      }
    }
  }
  return { answer: text.join("").trim(), toolCalls, toolErrors, finish, errored, retries };
}

const QUESTION_KEYS = ["question", "query", "q", "task", "ask", "prompt", "text"] as const;
const NODE_KEYS = ["node", "target", "host"] as const;
const HINT_KEYS = ["search_hint", "hint", "pattern", "search", "scope"] as const;

export interface ScoutArgs {
  question: string;
  node: string;
  search_hint: string;
}

/** Tolerate local-model argument drift (small models rename parameters). Never throws.
 * node/search_hint default to "" — resolveNodeModel maps "" to the default node. */
export function coerceScoutArgs(args: unknown): ScoutArgs {
  const pick = (rec: Record<string, unknown>, keys: readonly string[]): string => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
      if (typeof v === "number") return String(v);
    }
    return "";
  };
  if (typeof args === "string") return { question: args.trim(), node: "", search_hint: "" };
  if (args && typeof args === "object") {
    const rec = args as Record<string, unknown>;
    return {
      question: pick(rec, QUESTION_KEYS),
      node: pick(rec, NODE_KEYS).toLowerCase(),
      search_hint: pick(rec, HINT_KEYS),
    };
  }
  return { question: "", node: "", search_hint: "" };
}

/** The always-present node: the model server on this machine. */
export const DEFAULT_NODE = "local";

/** Placeholder model for the local node when SCOUT_MODEL is unset. Any small model that
 * ACTUALLY emits tool calls through your server will do; the provider half must match a
 * provider declared in ~/.pi/agent/models.json (see config/models.json). Verified live
 * (Ollama 0.32): qwen2.5:7b, llama3.1:8b, granite4.1:3b, gemma4:e4b call the tool;
 * qwen2.5-coder:7b echoes the call as text and fabricates output (status "no_call"). */
export const DEFAULT_MODEL_REF = "ollama/qwen2.5:7b";

const NODE_ENV_PREFIX = "SCOUT_MODEL_";

/** The node table resolved from the environment (pure): "local" from SCOUT_MODEL /
 * DEFAULT_MODEL_REF, plus one node per SCOUT_MODEL_<NAME> variable (name lowercased;
 * SCOUT_MODEL_LOCAL overrides the local entry). */
export function knownNodes(env: NodeJS.ProcessEnv): Record<string, string> {
  const nodes: Record<string, string> = {};
  const local = env["SCOUT_MODEL"];
  nodes[DEFAULT_NODE] = local && local.trim() !== "" ? local.trim() : DEFAULT_MODEL_REF;
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(NODE_ENV_PREFIX) || !v || v.trim() === "") continue;
    const name = k.slice(NODE_ENV_PREFIX.length).toLowerCase();
    if (name !== "") nodes[name] = v.trim();
  }
  return nodes;
}

/** The node a call without an explicit `node` goes to. */
export function defaultNode(env: NodeJS.ProcessEnv): string {
  const d = env["SCOUT_DEFAULT_NODE"];
  return d && d.trim() !== "" ? d.trim().toLowerCase() : DEFAULT_NODE;
}

export interface NodeResolution {
  node: string;
  ref: string; // provider/id passed to pi --model
  provider: string;
  model: string;
}

/** Map a node name to its provider/model ref via the environment node table. Unknown
 * node → Error: (model-visible, actionable, lists the known nodes). */
export function resolveNodeModel(node: string, env: NodeJS.ProcessEnv): NodeResolution {
  const nodes = knownNodes(env);
  const chosen = node === "" ? defaultNode(env) : node;
  const ref = nodes[chosen];
  if (!ref) {
    const known = Object.keys(nodes).sort().join(", ");
    throw new Error(
      `Error: unknown scout node "${chosen}" — known nodes: ${known} ` +
        `(define one with ${NODE_ENV_PREFIX}${chosen.toUpperCase()}="provider/id").`,
    );
  }
  const slash = ref.indexOf("/");
  return {
    node: chosen,
    ref,
    provider: slash > 0 ? ref.slice(0, slash) : "",
    model: slash > 0 ? ref.slice(slash + 1) : ref,
  };
}

/** The bare-scout system prompt: tight, single-fact, grep-first. A search_hint scopes
 * the evidence (the main accuracy lever) when the caller can pre-target the file or
 * pattern. */
export function buildScoutPrompt(searchHint: string): string {
  const base =
    "You are a fast read-only investigator. Use grep/find/ls/read to search the repository, " +
    "then answer in one sentence with the value and a file:line citation. " +
    "Start with grep for the pattern; never call read on a directory.";
  return searchHint
    ? `${base}\nScope your search to: ${searchHint}`
    : base;
}
