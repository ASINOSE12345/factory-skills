#!/usr/bin/env node

/**
 * Bootstrap hook for Claude Code SessionStart events.
 *
 * READ-ONLY: emits neuron + session context to stdout as additionalContext.
 * Never writes files, never touches memory. Degrades to minimal output (or
 * silence) on any missing/unreadable input, and never blocks the session.
 *
 * Input:
 *   - argv[2] (optional) = factory/project root
 *   - fallback: FACTORY_ROOT env, then process.cwd()
 * Output:
 *   - stdout: bootstrap text (captured by Claude Code as additionalContext)
 *   - exit 0 always
 *
 * Usage in settings.json:
 *   "SessionStart": [{ "matcher": "startup|resume|compact",
 *     "hooks": [{ "type": "command", "command": "node bootstrap-hook.js /path/to/project" }]
 *   }]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveNeuronsDir, getStats } from "./neurons.js";

const MAX_TITLE = 100;
const MAX_PREVIEW = 200;

/**
 * Resolve the Claude config home (`~/.claude`). Honors the CLAUDE_HOME env var so
 * tests can point it at a temp dir; real behavior (homedir()/.claude) is unchanged
 * when CLAUDE_HOME is unset.
 */
export function resolveClaudeHome(): string {
  return process.env.CLAUDE_HOME || join(homedir(), ".claude");
}

/** Collapse whitespace, trim, and hard-cap length. Never throws. */
function clip(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Most-recent plan (title + short preview) from `<claudeHome>/plans/*.md`, or []. */
function activePlanLines(claudeHome: string): string[] {
  const planDir = join(claudeHome, "plans");
  if (!existsSync(planDir)) return [];
  try {
    const plans = readdirSync(planDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f, mtime: statSync(join(planDir, f)).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime);
    if (plans.length === 0) return [];
    const content = readFileSync(join(planDir, plans[0].name), "utf-8");
    const title = clip(content.match(/^#\s+(.+)$/m)?.[1] ?? plans[0].name, MAX_TITLE);
    const preview = clip(content.replace(/^#.+\n/, ""), MAX_PREVIEW);
    return [`📋 Plan activo: ${title}`, `   ${preview}...`, ""];
  } catch {
    return []; // unreadable plan dir/file — degrade silently
  }
}

/** Last archived session line from the factory MEMORY.md under `<claudeHome>/projects`, or []. */
function lastSessionLines(claudeHome: string): string[] {
  const projectsDir = join(claudeHome, "projects");
  if (!existsSync(projectsDir)) return [];
  try {
    const memoryPath = readdirSync(projectsDir)
      .filter((d) => d.toLowerCase().includes("factory"))
      .map((d) => join(projectsDir, d, "memory", "MEMORY.md"))
      .find((p) => existsSync(p));
    if (!memoryPath) return [];
    const sessions = readFileSync(memoryPath, "utf-8")
      .split("\n")
      .filter((l) => /^- Session \d{4}-/.test(l));
    if (sessions.length === 0) return [];
    const last = sessions[sessions.length - 1].replace(/^- /, "");
    return [`📌 Última sesión: ${clip(last, MAX_PREVIEW)}`, ""];
  } catch {
    return []; // unreadable memory — degrade silently
  }
}

/**
 * Build the SessionStart bootstrap text. Pure and read-only.
 * Returns "" when there is no neurons dir (the caller exits 0 without blocking).
 */
export function buildBootstrap(projectRoot: string, claudeHome: string = resolveClaudeHome()): string {
  const neuronsDir = resolveNeuronsDir(projectRoot);
  if (!neuronsDir) return "";

  const stats = getStats(neuronsDir);

  // Empty knowledge base → minimal hint only.
  if (stats.total === 0) {
    return [
      "🧠 Neuron system active but empty.",
      "Use create_neuron to capture errors, decisions, and patterns.",
    ].join("\n");
  }

  const lines: string[] = [
    ...activePlanLines(claudeHome),
    ...lastSessionLines(claudeHome),
    `🧠 Knowledge base: ${stats.total} neurons (NE:${stats.errors} ND:${stats.decisions} NP:${stats.patterns} NF:${stats.foundations} NB:${stats.business})`,
    "Use search_neurons before implementing. Use create_neuron to capture new knowledge.",
    "Neuron content loads automatically on first Edit/Write (re-bootstrap by plan-gate hook).",
  ];
  return lines.join("\n");
}

// Execute only when run directly (`node bootstrap-hook.js`), not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const projectRoot = process.argv[2] || process.env.FACTORY_ROOT || process.cwd();
  const output = buildBootstrap(projectRoot);
  if (output) console.log(output);
  process.exit(0);
}
