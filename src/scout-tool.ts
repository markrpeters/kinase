/**
 * scout-tool — a registered `scout` tool that delegates a single-fact repository
 * lookup to a cheap LOCAL model subagent. The calling model uses `scout` to offload a
 * bounded investigation; CODE owns dispatch/routing/extraction, the scout model drives
 * its own grep/read and concludes. A right-sized small model in this regime (bare,
 * tight prompt, single fact) answers reliably; the same model wrapped in a full agent
 * harness does not — so the scout ALWAYS runs bare.
 *
 * pi surface used (installed 0.84.2): ToolDefinition / registerTool; pi.exec;
 * pi.appendEntry; the result channel is the assistant text_delta stream in
 * `pi -p --mode json`. Subprocess spawn = `--no-extensions --no-skills
 * --no-context-files --tools read,grep,find,ls`.
 *
 * Error contract:
 *   "Error: ..." — model-visible, actionable (empty question, unknown node, pi missing).
 *   "Seam: ..."  — infrastructure fault (timeout, provider/serving error, empty stream);
 *                  scored as harness/seam unreliability in forensics, not model error.
 *
 * Env knobs (no hardcoded paths in logic):
 *   SCOUT_PI_BIN        pi binary       (default: repo-local ../node_modules/.bin/pi, else "pi")
 *   SCOUT_MODEL         model for the "local" node, "provider/id" (default: lib/scout-core DEFAULT_MODEL_REF)
 *   SCOUT_MODEL_<NODE>  define a further node <node> = "provider/id" (see lib/scout-core.ts)
 *   SCOUT_DEFAULT_NODE  node if unset   (default: "local")
 *   SCOUT_THINKING      "off" forces --thinking off (default: model/provider default)
 *   SCOUT_TIMEOUT_MS    per-call ms     (default: 180000 — hard tasks on slow GPUs)
 *   SCOUT_MAX_CHARS     response budget (default: 4000)
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildScoutPrompt,
  coerceScoutArgs,
  parseScoutStream,
  resolveNodeModel,
} from "./lib/scout-core.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

function resolvePiBin(): string {
  const override = process.env["SCOUT_PI_BIN"];
  if (override && override.trim() !== "") return override;
  const local = resolve(EXT_DIR, "../node_modules/.bin/pi");
  return existsSync(local) ? local : "pi";
}

export default function (pi: ExtensionAPI) {
  const timeout = Number(process.env["SCOUT_TIMEOUT_MS"] ?? 180000);
  const maxChars = Number(process.env["SCOUT_MAX_CHARS"] ?? 4000);

  pi.registerTool(
    defineTool({
      name: "scout",
      label: "Delegated Scout (local model subagent)",
      description:
        "Delegate a single-fact repository lookup to a cheap local model subagent that drives " +
        "its own grep/read and returns one answer with a file:line citation. Use it to offload " +
        "a bounded investigation and keep your own context small. One question per call.",
      promptSnippet:
        "scout: delegate a single-fact repo lookup to a local model subagent — returns one answer with a file:line citation.",
      promptGuidelines: [
        "Use scout for a bounded, single-fact lookup you can state precisely; ask one question per call.",
        "Optionally pass search_hint (a file or grep pattern) to scope the scout's evidence and raise accuracy.",
        "Trust the returned answer+citation; verify only if the scout reports it could not conclude.",
      ],
      parameters: Type.Object({
        question: Type.String({
          description: "The single-fact lookup to delegate, e.g. 'What port does scripts/server.sh listen on?'",
        }),
        node: Type.Optional(
          Type.String({ description: "Which configured node to dispatch to (default: 'local' — see SCOUT_MODEL_<NODE>)." }),
        ),
        search_hint: Type.Optional(
          Type.String({ description: "Optional file path or grep pattern to scope the scout's search." }),
        ),
      }),
      prepareArguments: coerceScoutArgs,

      async execute(_toolCallId, params, signal) {
        const { question, node, search_hint } = coerceScoutArgs(params);
        if (question === "") {
          throw new Error('Error: scout needs a question — call it as {"question": "<single-fact lookup>"}');
        }
        const target = resolveNodeModel(node, process.env); // throws Error: on unknown node
        const piBin = resolvePiBin();
        const argv = [
          "--model", target.ref,
          "-p", "--mode", "json",
          "--no-session", "--no-extensions", "--no-skills", "--no-context-files",
          "--tools", "read,grep,find,ls",
        ];
        if ((process.env["SCOUT_THINKING"] ?? "").toLowerCase() === "off") {
          argv.push("--thinking", "off");
        }
        argv.push("--append-system-prompt", buildScoutPrompt(search_hint), question);

        const t0 = Date.now();
        let res;
        try {
          res = await pi.exec(piBin, argv, { signal, timeout });
        } catch (e) {
          throw new Error(
            `Error: could not run pi ("${piBin}"; set SCOUT_PI_BIN) — scout cannot dispatch: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        const wallMs = Date.now() - t0;
        if (res.killed) {
          throw new Error(`Seam: scout timed out after ${timeout}ms on ${target.node} (${target.model})`);
        }
        if (res.code === 127) {
          throw new Error(`Error: pi binary not found ("${piBin}"; set SCOUT_PI_BIN) — scout cannot dispatch`);
        }

        const parsed = parseScoutStream(res.stdout);
        const answer = parsed.answer.slice(0, maxChars);
        const truncated = parsed.answer.length > maxChars;

        // Forensic entry: enough to reconstruct the dispatch (node, model, evidence-driving,
        // outcome). Answer stored as a preview; the full stream is the subprocess's own trail.
        pi.appendEntry("scout", {
          node: target.node,
          provider: target.provider,
          model: target.model,
          question,
          search_hint: search_hint || null,
          tool_calls: parsed.toolCalls,
          finish: parsed.finish,
          errored: parsed.errored,
          retries: parsed.retries,
          chars: answer.length,
          truncated,
          wall_ms: wallMs,
          exit_code: res.code,
          answer_preview: answer.slice(0, 300),
        });

        if (parsed.answer === "") {
          if (parsed.errored) {
            throw new Error(
              `Seam: scout provider error on ${target.node} — ${target.model} produced no output ` +
                `(${parsed.retries} retries). Check the node serves this model (e.g. model architecture support). ` +
                `${res.stderr.slice(-200)}`,
            );
          }
          throw new Error(
            `Seam: scout on ${target.node} (${target.model}) concluded with no answer after ${parsed.toolCalls} tool call(s)`,
          );
        }

        return {
          content: [{ type: "text" as const, text: answer }],
          details: {
            node: target.node,
            model: target.model,
            tool_calls: parsed.toolCalls,
            chars: answer.length,
            truncated,
            wall_ms: wallMs,
          },
        };
      },
    }),
  );
}
