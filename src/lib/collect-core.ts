/**
 * collect-core — pure, testable helpers for the deterministic collection-filing layer.
 *
 * Why: a cheap orchestrator fans out scouts to COLLECT data and file it away (no
 * interpretation); a later, heavier reasoning pass works over the COLLECTED substrate.
 * A fanout/runner return otherwise lives only in the calling session's context (lost on
 * a new session, at risk from compaction) and the forensic `appendEntry` keeps only a
 * 300-char preview. This layer adds a durable, FULL-FIDELITY, append-only store a
 * fresh phase-2 session can load.
 *
 * CODE-OWNED, not model-trusted: the harness files every delegated return itself; it
 * never asks a weak orchestrator to file correctly. Every write is one atomic append,
 * nothing mutated or deleted, the store fully replayable.
 *
 * Everything here is side-effect-free (import of node:path only, for a deterministic
 * join) so the jiti suite exercises it with no fs; the fs writes live in runner-tool.ts
 * (`fileCollected`) with an INJECTED fs so the loop is still mock-testable.
 */
import { join } from "node:path";

/** One append-only record per delegated return: the dispatch manifest + the full result. */
export interface CollectRecord {
  ts: string;
  collect_id: string;
  phase: string;
  node: string;
  provider: string;
  model: string;
  tool: string;
  args: unknown;
  status: string; // done|abort|tool_error|no_call|unknown | error|seam
  tool_calls: number;
  wall_ms: number;
  result_chars: number;
  result?: string; // the FULL result (inline) — the verbatim tool output when the stream carried it, else the scout text …
  result_ref?: string; // … or the sidecar basename when it exceeds the inline cap
  /** The scout's own narration (capped) when `result` is the verbatim tool output. */
  scout_note?: string;
  over_budget?: boolean; // recall marks a record it stubbed because the recall budget was spent
  tags: string[];
}

/** The normalized inputs a caller assembles from a DispatchOutcome + closure state.
 * `result` is the FULL text on success, or the error/seam message on a failed dispatch. */
export interface CollectInput {
  status: string;
  node: string;
  provider: string;
  model: string;
  tool: string;
  args: unknown;
  tool_calls: number;
  wall_ms: number;
  result: string;
  /** Scout narration to keep beside a verbatim-tool-output `result` (capped at filing). */
  scout_note?: string;
}

const SCOUT_NOTE_CAP = 600;

/** Injectable clock + id so the jiti suite gets deterministic records. */
export interface CollectDeps {
  now?: () => Date;
  id?: () => string;
}

/** A short, sortable-ish, collision-resistant id (time36 + 6 random36). Injectable. */
export function defaultCollectId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Build a full-fidelity record from normalized inputs. `result_chars` is the FULL length
 * (recorded even when the body is later split to a sidecar). Never throws. */
export function buildCollectRecord(
  input: CollectInput,
  phase: string,
  tags: string[],
  deps: CollectDeps = {},
): CollectRecord {
  const ts = (deps.now ? deps.now() : new Date()).toISOString();
  const collect_id = (deps.id ?? defaultCollectId)();
  const result = input.result ?? "";
  return {
    ts,
    collect_id,
    phase: phase || "collect",
    node: input.node ?? "",
    provider: input.provider ?? "",
    model: input.model ?? "",
    tool: input.tool ?? "",
    args: input.args ?? {},
    status: input.status ?? "unknown",
    tool_calls: input.tool_calls ?? 0,
    wall_ms: input.wall_ms ?? 0,
    result_chars: result.length,
    result,
    ...(input.scout_note && input.scout_note.trim() !== ""
      ? { scout_note: input.scout_note.length > SCOUT_NOTE_CAP ? input.scout_note.slice(0, SCOUT_NOTE_CAP) + " […]" : input.scout_note }
      : {}),
    tags: Array.isArray(tags) ? tags : [],
  };
}

/** Split a record whose inline `result` exceeds `maxInline` into an index line (with
 * `result_ref` instead of `result`) plus a sidecar `<collect_id>.txt`. Under the cap the
 * line is returned as-is (a shallow copy) with no sidecar. Pure — the caller does the fs. */
export function splitInline(
  rec: CollectRecord,
  maxInline: number,
): { line: CollectRecord; sidecar?: { name: string; body: string } } {
  const body = rec.result ?? "";
  if (maxInline <= 0 || body.length <= maxInline) {
    return { line: { ...rec } };
  }
  const name = `${rec.collect_id}.txt`;
  const line: CollectRecord = { ...rec };
  delete line.result;
  line.result_ref = name;
  return { line, sidecar: { name, body } };
}

/** Resolve the collected-store directory from the environment (pure).
 *   RUNNER_COLLECT_DIR (explicit) → that directory; else "" (collection DISABLED).
 * Point it at a directory that lives WITH the work it collects for (e.g. <project>/collected). */
export function resolveCollectDir(env: Record<string, string | undefined>): string {
  const explicit = env["RUNNER_COLLECT_DIR"];
  if (explicit && explicit.trim() !== "") return explicit.trim();
  return "";
}

/** A recall filter over the collected store. All fields optional; an absent field does
 * not constrain. Equality is case-insensitive; `since` is an ISO-8601 lower bound
 * (lexicographic compare, valid for the `ts` format); `limit` keeps the most recent N
 * after filtering. */
export interface CollectQuery {
  tool?: string;
  node?: string;
  status?: string;
  phase?: string;
  since?: string;
  limit?: number;
}

/** Tolerant parse of an index.jsonl body → the records it holds. Skips blank/garbage lines
 * (a single bad append never blinds the reader). Never throws. */
export function parseCollectedIndex(text: string): CollectRecord[] {
  const out: CollectRecord[] = [];
  for (const line of (text ?? "").split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === "object" && !Array.isArray(o)) out.push(o as CollectRecord);
    } catch {
      /* skip a malformed line — the rest of the store is still readable */
    }
  }
  return out;
}

/** Deterministic, code-owned filter over parsed records. Applies the equality predicates
 * + `since` bound, sorts ascending by `ts` (natural reading order), then keeps the most
 * recent `limit`. Pure; never throws. */
export function filterCollected(records: CollectRecord[], q: CollectQuery): CollectRecord[] {
  const eq = (a: unknown, b: string): boolean => String(a ?? "").toLowerCase() === b.toLowerCase();
  let out = records.filter((r) => {
    if (q.tool && !eq(r.tool, q.tool)) return false;
    if (q.node && !eq(r.node, q.node)) return false;
    if (q.status && !eq(r.status, q.status)) return false;
    if (q.phase && !eq(r.phase, q.phase)) return false;
    if (q.since && !(String(r.ts ?? "") >= q.since)) return false;
    return true;
  });
  out = out.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (q.limit && q.limit > 0 && out.length > q.limit) out = out.slice(out.length - q.limit);
  return out;
}

/** Tolerate local-model argument drift for a recall query. Never throws; unknown/garbage
 * fields are dropped, node lowercased. */
export function coerceCollectQuery(raw: unknown): CollectQuery {
  if (!raw || typeof raw !== "object") return {};
  const rec = raw as Record<string, unknown>;
  const str = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return undefined;
  };
  const num = (k: string): number | undefined => {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return undefined;
  };
  const q: CollectQuery = {};
  const tool = str(["tool", "tool_name", "toolName"]);
  if (tool) q.tool = tool;
  const node = str(["node", "target", "host"]);
  if (node) q.node = node.toLowerCase();
  const status = str(["status"]);
  if (status) q.status = status;
  const phase = str(["phase"]);
  if (phase) q.phase = phase;
  const since = str(["since", "after"]);
  if (since) q.since = since;
  const limit = num("limit");
  if (limit !== undefined) q.limit = limit;
  return q;
}

/** The one-time README written beside the store: names the schema and states that these
 * are RAW scout returns — interpretation is deferred to a reasoning pass. */
export function collectReadme(): string {
  return [
    "# collected/ — delegation collection store",
    "",
    "Raw, full-fidelity returns from delegated scout runs (runner/fanout), filed by the",
    "harness itself (code-owned, not model-trusted). Interpretation is DEFERRED to a",
    "later reasoning pass — nothing here is a verdict.",
    "",
    "index.jsonl — one append-only JSON record per delegated return:",
    "  { ts, collect_id, phase, node, provider, model, tool, args, status,",
    "    tool_calls, wall_ms, result_chars, result | result_ref, tags[] }",
    "A result larger than the inline cap is written to <collect_id>.txt and the index",
    "line carries result_ref instead of result. The store is append-only and replayable.",
    "",
  ].join("\n");
}
