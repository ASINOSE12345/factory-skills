#!/usr/bin/env node

/**
 * Plan-First Gate — PreToolUse hook for Claude Code.
 *
 * Injects relevant neuron knowledge BEFORE code changes happen.
 * Does NOT block execution — only adds context.
 *
 * Triggers:
 *   1. Edit/Write on code files (.ts, .py, .tsx, .jsx) → search neurons by file keywords
 *   2. Bash with git push/commit → remind pre-push patterns
 *   3. First Edit/Write of session → re-bootstrap with task-relevant neurons
 *
 * Metrics (tracked in /tmp/plan-gate-metrics.json):
 *   - hits_useful: times a relevant neuron was injected
 *   - noise: times an irrelevant neuron was injected (manually logged)
 *   - total_invocations: total hook calls
 *   - skipped: calls where no context was needed
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { resolveNeuronsDir, searchNeuronsSync, listNeurons, toBreadcrumb } from "./neurons.js";
import { planGateStateFile, planGateMetricsFile } from "./runtime-paths.js";

// ─── Types ──────────────────────────────────────────────────

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: {
    command?: string;
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    [key: string]: unknown;
  };
}

interface HookOutput {
  hookSpecificOutput: {
    additionalContext?: string;
  };
}

// ─── State tracking ─────────────────────────────────────────

// State/metrics file paths come from runtime-paths (single source; default /tmp).

interface GateState {
  session_id: string;
  files_seen: string[];      // Files already injected — skip duplicates
  rebootstrapped: boolean;   // First Edit/Write re-bootstrap done
}

function loadState(sessionId: string): GateState {
  try {
    if (existsSync(planGateStateFile())) {
      const state = JSON.parse(readFileSync(planGateStateFile(), "utf-8")) as GateState;
      if (state.session_id === sessionId) return state;
    }
  } catch { /* fresh state */ }
  return { session_id: sessionId, files_seen: [], rebootstrapped: false };
}

function saveState(state: GateState): void {
  try {
    writeFileSync(planGateStateFile(), JSON.stringify(state), "utf-8");
  } catch { /* non-critical */ }
}

function trackMetric(key: string): void {
  try {
    const metrics = existsSync(planGateMetricsFile())
      ? JSON.parse(readFileSync(planGateMetricsFile(), "utf-8"))
      : { hits_useful: 0, noise: 0, total_invocations: 0, skipped: 0, since: new Date().toISOString().split("T")[0] };
    metrics[key] = (metrics[key] ?? 0) + 1;
    writeFileSync(planGateMetricsFile(), JSON.stringify(metrics, null, 2), "utf-8");
  } catch { /* non-critical */ }
}

// ─── Keyword extraction ─────────────────────────────────────

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".vue", ".svelte"]);

function extractKeywords(filePath: string, oldStr?: string, newStr?: string): string[] {
  const keywords: string[] = [];

  // From file path: directory names + filename without extension
  const parts = filePath.split("/").filter(Boolean);
  for (const part of parts) {
    const clean = part.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").toLowerCase();
    if (clean.length > 2) keywords.push(clean);
  }

  // From change content
  const changeText = `${oldStr ?? ""} ${newStr ?? ""}`;

  // Extract PascalCase words (component names)
  const pascalWords = changeText.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)*/g) ?? [];
  keywords.push(...pascalWords.map((w) => w.toLowerCase()));

  // Extract import paths
  const imports = changeText.match(/from ['"]([^'"]+)['"]/g) ?? [];
  for (const imp of imports) {
    const path = imp.replace(/from ['"]|['"]/g, "");
    keywords.push(path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "");
  }

  // Extract significant words from change content (lowercase, >3 chars, no stop words)
  const stopWords = new Set(["const", "function", "return", "import", "export", "from", "this", "that", "with", "have", "been", "will", "undefined", "null", "true", "false", "string", "number"]);
  const words = changeText.toLowerCase().match(/[a-záéíóúñ]{4,}/g) ?? [];
  for (const w of words) {
    if (!stopWords.has(w)) keywords.push(w);
  }

  // Deduplicate and filter
  return [...new Set(keywords)].filter((k) => k.length > 2).slice(0, 15);
}

// ─── Formatting ─────────────────────────────────────────────

function formatNeuronContext(neurons: ReturnType<typeof listNeurons>, label: string): string {
  if (neurons.length === 0) return "";
  const lines = [`\n🧠 ${label}:`];
  for (const n of neurons) {
    const icon = n.category === "patterns" ? "🔄" : n.category === "errors" ? "⚠️" : "📎";
    lines.push(`  ${icon} ${toBreadcrumb(n)}`);
  }
  return lines.join("\n");
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  // Read hook input from stdin
  const inputRaw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(Buffer.concat(chunks).toString("utf-8")), 2000);
  });

  if (!inputRaw.trim()) process.exit(0);

  let input: HookInput;
  try {
    input = JSON.parse(inputRaw);
  } catch {
    process.exit(0);
  }

  trackMetric("total_invocations");

  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};

  // Only act on Edit, Write, and Bash
  if (!["Edit", "Write", "Bash"].includes(toolName)) {
    trackMetric("skipped");
    process.exit(0);
  }

  // Resolve neurons directory
  const neuronsDir = resolveNeuronsDir(input.cwd || process.cwd());
  if (!neuronsDir) {
    trackMetric("skipped");
    process.exit(0);
  }

  const state = loadState(input.session_id);
  let contextParts: string[] = [];

  // ── Edit/Write: inject relevant neurons ──
  if (toolName === "Edit" || toolName === "Write") {
    const filePath = toolInput.file_path ?? "";
    const ext = extname(filePath);

    // Only act on code files
    if (!CODE_EXTENSIONS.has(ext)) {
      trackMetric("skipped");
      process.exit(0);
    }

    const fileKey = basename(filePath);

    // Re-bootstrap: first code Edit/Write of the session
    if (!state.rebootstrapped) {
      state.rebootstrapped = true;

      // Search neurons relevant to this first file
      const keywords = extractKeywords(filePath, toolInput.old_string, toolInput.new_string);
      const query = keywords.join(" ");

      if (query.trim()) {
        // Get patterns and errors relevant to the task
        const patterns = searchNeuronsSync(neuronsDir, query, "patterns").slice(0, 3);
        const errors = searchNeuronsSync(neuronsDir, query, "errors").slice(0, 2);

        if (patterns.length > 0 || errors.length > 0) {
          contextParts.push(formatNeuronContext(patterns, "Patterns relevantes a tu tarea"));
          contextParts.push(formatNeuronContext(errors, "Errores previos relacionados"));
          trackMetric("hits_useful");
        }
      }

      state.files_seen.push(fileKey);
      saveState(state);
    }
    // Subsequent edits: only inject if NEW file (not seen before)
    else if (!state.files_seen.includes(fileKey)) {
      state.files_seen.push(fileKey);

      const keywords = extractKeywords(filePath, toolInput.old_string, toolInput.new_string);
      const query = keywords.join(" ");

      if (query.trim()) {
        const relevant = searchNeuronsSync(neuronsDir, query)
          .filter((n) => n.category === "patterns" || n.category === "errors")
          .slice(0, 2);

        if (relevant.length > 0) {
          contextParts.push(formatNeuronContext(relevant, "Conocimiento relevante"));
          trackMetric("hits_useful");
        }
      }

      saveState(state);
    } else {
      // Already injected for this file — skip
      trackMetric("skipped");
      process.exit(0);
    }
  }

  // ── Bash: git push/commit reminders ──
  if (toolName === "Bash") {
    const cmd = toolInput.command ?? "";

    if (cmd.includes("git push") || cmd.includes("git commit")) {
      // Search for pre-push patterns
      const pushPatterns = searchNeuronsSync(neuronsDir, "push commit tsc template PR pre-push", "patterns")
        .slice(0, 3);

      if (pushPatterns.length > 0) {
        contextParts.push(formatNeuronContext(pushPatterns, "Recordatorio pre-push"));
        trackMetric("hits_useful");
      }
    } else {
      trackMetric("skipped");
      process.exit(0);
    }
  }

  // ── Output context ──
  if (contextParts.length === 0) {
    trackMetric("skipped");
    process.exit(0);
  }

  const output: HookOutput = {
    hookSpecificOutput: {
      additionalContext: contextParts.filter(Boolean).join("\n"),
    },
  };

  console.log(JSON.stringify(output));
  process.exit(0);
}

main().catch(() => {
  // Never crash the hook — exit silently
  process.exit(0);
});
