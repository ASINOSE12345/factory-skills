#!/usr/bin/env node
/**
 * dream-scan — read-only, deterministic, corpus-wide scan of the neuron brain.
 *
 * A GLOBAL sweep (NOT query-driven): it reuses the pure detectors from
 * gap-analysis.ts over the ENTIRE corpus, instead of a top-K result set.
 *
 * 100% READ-ONLY: never writes neurons/, MEMORY.md, issues, PRs, or any state.
 * No LLM, no network beyond reading the local embeddings cache. The "cycle"
 * (consolidation / issues, with an opt-in LLM judge) is a SEPARATE, later phase.
 *
 * Output is capped: every list is sorted deterministically, sliced to a cap
 * (max_pairs for duplicates, max_items for the rest), and the FULL count is
 * reported as total_* — so nothing is silently dropped and the MCP result
 * stays small enough for the agent's context.
 */

import { pathToFileURL } from "node:url";
import { listNeurons, resolveNeuronsDir, type Neuron } from "./neurons.js";
import { getNeuronVectors } from "./embeddings.js";
import {
  detectStale,
  detectSuperseded,
  detectUnreliablePatterns,
  detectPossibleDuplicates,
  detectUnknownScope,
  type GapReport,
} from "./gap-analysis.js";

// Threshold calibrated against the real corpus: 0.85 → ~7800 pairs (noise), 0.93 → ~195.
export const DEFAULT_THRESHOLD = 0.93;
export const DEFAULT_STALE_DAYS = 60;
export const DEFAULT_MAX_PAIRS = 100;
export const DEFAULT_MAX_ITEMS = 1000; // CLI/core default: show full detail (corpus lists < cap)
export const MIN_THRESHOLD = 0.8;
export const MAX_PAIRS_CAP = 1000;
export const MAX_ITEMS_CAP = 1000;

export interface DreamScanReport {
  generated_at: string;
  corpus_root: string;
  corpus_size: number;
  threshold: number;
  stale_days: number;
  max_pairs: number;
  max_items: number;
  // Full counts BEFORE the caps (no silent truncation) + the capped, sorted lists.
  total_possible_duplicates: number;
  possible_duplicates: GapReport["possible_duplicates"];
  total_superseded: number;
  superseded: GapReport["superseded"];
  total_stale: number;
  stale: GapReport["stale"];
  total_unreliable_patterns: number;
  unreliable_patterns: GapReport["unreliable_patterns"];
  total_unknown_scope: number;
  unknown_scope: Array<{ id: string; category: Neuron["category"] }>;
}

export interface DreamScanOptions {
  threshold?: number;
  staleDays?: number;
  maxPairs?: number;
  maxItems?: number;
  now?: Date;
}

/** Validate scan parameters. Returns an error message or null. Enforced in CLI and core. */
export function validateScanParams(
  threshold: number,
  staleDays: number,
  maxPairs: number,
  maxItems: number,
): string | null {
  if (!(threshold >= MIN_THRESHOLD && threshold <= 1)) return `threshold must be in [${MIN_THRESHOLD}, 1] (got ${threshold})`;
  if (!(Number.isInteger(staleDays) && staleDays > 0)) return `stale-days must be a positive integer (got ${staleDays})`;
  if (!(Number.isInteger(maxPairs) && maxPairs > 0 && maxPairs <= MAX_PAIRS_CAP))
    return `max-pairs must be an integer in [1, ${MAX_PAIRS_CAP}] (got ${maxPairs})`;
  if (!(Number.isInteger(maxItems) && maxItems > 0 && maxItems <= MAX_ITEMS_CAP))
    return `max-items must be an integer in [1, ${MAX_ITEMS_CAP}] (got ${maxItems})`;
  return null;
}

/**
 * Run a read-only, corpus-wide scan. Reuses the gap-analysis pure detectors —
 * no logic is duplicated here. Each list is sorted deterministically and capped;
 * total_* reports the full count. Throws on out-of-range params (defense in depth).
 */
export function dreamScan(neuronsDir: string, opts: DreamScanOptions = {}): DreamScanReport {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const err = validateScanParams(threshold, staleDays, maxPairs, maxItems);
  if (err) throw new Error(err);
  const now = opts.now ?? new Date();

  const all = listNeurons(neuronsDir);
  const vectors = getNeuronVectors(neuronsDir, all.map((n) => n.filename));

  // Deterministic ordering before capping (so the top-N is stable & meaningful).
  const allDups = detectPossibleDuplicates(all, vectors, threshold).sort((a, b) => b.similarity - a.similarity);
  const allStale = detectStale(all, { now, staleDays }).sort((a, b) => b.days_old - a.days_old);
  const allUnknown = detectUnknownScope(all).sort((a, b) => a.id.localeCompare(b.id));
  const allSuperseded = detectSuperseded(all).sort((a, b) => a.id.localeCompare(b.id));
  const allUnreliable = detectUnreliablePatterns(all).sort((a, b) => b.misses - a.misses);

  return {
    generated_at: now.toISOString(),
    corpus_root: neuronsDir,
    corpus_size: all.length,
    threshold,
    stale_days: staleDays,
    max_pairs: maxPairs,
    max_items: maxItems,
    total_possible_duplicates: allDups.length,
    possible_duplicates: allDups.slice(0, maxPairs),
    total_superseded: allSuperseded.length,
    superseded: allSuperseded.slice(0, maxItems),
    total_stale: allStale.length,
    stale: allStale.slice(0, maxItems),
    total_unreliable_patterns: allUnreliable.length,
    unreliable_patterns: allUnreliable.slice(0, maxItems),
    total_unknown_scope: allUnknown.length,
    unknown_scope: allUnknown.slice(0, maxItems),
  };
}

/** Human-readable markdown rendering. "showing X of Y" per section; proposals, not changes. */
export function formatMarkdown(r: DreamScanReport): string {
  const lines: string[] = [];
  lines.push(`# Dream Scan — ${r.corpus_root}`);
  lines.push("");
  lines.push(
    `Generated: ${r.generated_at} · corpus: ${r.corpus_size} neurons · threshold: ${r.threshold} · stale > ${r.stale_days}d`,
  );
  lines.push("");
  lines.push("> Read-only analysis — **propuestas, no cambios aplicados.**");
  lines.push("");

  lines.push(`## Near-duplicates (showing ${r.possible_duplicates.length} of ${r.total_possible_duplicates})`);
  for (const d of r.possible_duplicates) lines.push(`- ${d.a} ≈ ${d.b} (${d.similarity})`);
  lines.push("");
  lines.push(`## Superseded (showing ${r.superseded.length} of ${r.total_superseded})`);
  for (const s of r.superseded) lines.push(`- ${s.id}${s.superseded_by ? ` → ${s.superseded_by}` : ""}`);
  lines.push("");
  lines.push(`## Stale (showing ${r.stale.length} of ${r.total_stale})`);
  for (const s of r.stale) lines.push(`- ${s.id} (${s.days_old}d, by ${s.date_source})`);
  lines.push("");
  lines.push(`## Unreliable patterns (showing ${r.unreliable_patterns.length} of ${r.total_unreliable_patterns})`);
  for (const p of r.unreliable_patterns) lines.push(`- ${p.id} (${p.hits}h / ${p.misses}m)`);
  lines.push("");
  lines.push(`## Unknown scope (showing ${r.unknown_scope.length} of ${r.total_unknown_scope})`);
  for (const u of r.unknown_scope) lines.push(`- ${u.id} (${u.category})`);
  lines.push("");
  return lines.join("\n");
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

const USAGE =
  "Usage: dream-scan <neuronsRoot|projectRoot> [--threshold 0.93] [--stale-days 60] [--max-pairs 100] [--max-items 1000] [--format json|md]\n" +
  "Read-only, deterministic corpus-wide scan. Writes nothing. Accepts a project root or a neurons/ dir.\n";

type FlagResult = { value: string; error?: undefined } | { value?: undefined; error: string };

/** Parse a flag's value. Missing flag → default; present-but-no-value → error (never silent default). */
function rawFlag(args: string[], name: string, def: string): FlagResult {
  const i = args.indexOf(name);
  if (i === -1) return { value: def };
  if (i + 1 >= args.length || args[i + 1].startsWith("--")) return { error: `${name} requires a value` };
  return { value: args[i + 1] };
}

function numFlag(args: string[], name: string, def: number): { value: number; error?: undefined } | { value?: undefined; error: string } {
  const r = rawFlag(args, name, String(def));
  if (r.error) return { error: r.error };
  const v = Number(r.value);
  if (!Number.isFinite(v)) return { error: `${name} must be a number (got "${r.value}")` };
  return { value: v };
}

/** Exit codes: 0 ok · 1 args/config invalid · 2 runtime error. */
export function mainCli(argv: string[]): number {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  // Accept a project root OR a neurons/ dir — resolve explicitly, fail loudly otherwise.
  const neuronsDir = resolveNeuronsDir(argv[0]);
  if (!neuronsDir) {
    process.stderr.write(`[dream-scan] no neurons/ directory found from: ${argv[0]}\n`);
    return 1;
  }

  const t = numFlag(argv, "--threshold", DEFAULT_THRESHOLD);
  const s = numFlag(argv, "--stale-days", DEFAULT_STALE_DAYS);
  const m = numFlag(argv, "--max-pairs", DEFAULT_MAX_PAIRS);
  const mi = numFlag(argv, "--max-items", DEFAULT_MAX_ITEMS);
  for (const r of [t, s, m, mi]) {
    if (r.error) {
      process.stderr.write(`[dream-scan] ${r.error}\n`);
      return 1;
    }
  }

  const f = rawFlag(argv, "--format", "json");
  if (f.error) {
    process.stderr.write(`[dream-scan] ${f.error}\n`);
    return 1;
  }
  if (f.value !== "json" && f.value !== "md") {
    process.stderr.write(`[dream-scan] --format must be "json" or "md" (got "${f.value}")\n`);
    return 1;
  }

  const verr = validateScanParams(t.value!, s.value!, m.value!, mi.value!);
  if (verr) {
    process.stderr.write(`[dream-scan] ${verr}\n`);
    return 1;
  }

  try {
    const report = dreamScan(neuronsDir, { threshold: t.value!, staleDays: s.value!, maxPairs: m.value!, maxItems: mi.value! });
    process.stdout.write(f.value === "md" ? formatMarkdown(report) + "\n" : JSON.stringify(report, null, 2) + "\n");
    return 0;
  } catch (e) {
    process.stderr.write(`[dream-scan] error: ${(e as Error).message}\n`);
    return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
// Set exitCode (not process.exit) so Node drains stdout — process.exit() truncates large piped output.
if (invokedDirectly) process.exitCode = mainCli(process.argv.slice(2));
