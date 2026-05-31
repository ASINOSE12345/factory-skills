/**
 * Gap analysis for neuron retrieval — the "think" layer.
 *
 * Inspired by GBrain's `think` vs `search` split: search returns pages,
 * think returns the answer set PLUS an honest account of what the brain
 * does NOT know yet (superseded, stale, duplicated, weak-coverage).
 *
 * 100% deterministic — zero LLM calls. Every signal is computed from data
 * that already exists in the corpus (frontmatter + the embeddings cache).
 *
 * The detector functions (detectSuperseded/detectStale/…) are pure and
 * exported so the batch dream-scan can reuse the exact same logic.
 */

import type { Neuron } from "./neurons.js";
import { projectScopeOf } from "./neurons.js";
import { cosineSimilarity } from "./embeddings.js";

export interface ScoredNeuronInput {
  neuron: Neuron;
  score: number;
  semanticScore: number;
}

export interface GapReport {
  confidence: "strong" | "moderate" | "weak" | "empty";
  coverage_note: string;
  superseded: Array<{ id: string; superseded_by: string | null; superseded_on: string | null }>;
  stale: Array<{ id: string; last_touched: string; days_old: number; date_source: "created" | "date" | "modified" }>;
  possible_duplicates: Array<{ a: string; b: string; similarity: number }>;
  unreliable_patterns: Array<{ id: string; hits: number; misses: number }>;
  project_mix: { mixed: boolean; projects: string[]; unknown: number };
  notes: string[];
}

// Categories whose knowledge decays with time, vs durable patterns/foundations.
const PERISHABLE = new Set<Neuron["category"]>(["errors", "decisions", "business"]);

const DUP_THRESHOLD = 0.85;

function idOf(n: Neuron): string {
  return n.filename.replace(".md", "");
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * Coerce a frontmatter value to a valid Date. Handles BOTH a string and a real
 * Date object — gray-matter parses an unquoted ISO date (`created: 2026-01-01`)
 * into a Date, not a string, so string-only handling would silently miss it.
 */
function toValidDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Age of a neuron's KNOWLEDGE (not its file): created → date → file mtime.
 * mtime is a poor proxy (a bulk re-sync resets it), so it is only the last resort.
 */
function knowledgeDate(n: Neuron): { date: Date; source: "created" | "date" | "modified" } {
  const c = toValidDate(n.frontmatter.created);
  if (c) return { date: c, source: "created" };
  const d = toValidDate(n.frontmatter.date);
  if (d) return { date: d, source: "date" };
  return { date: n.modified, source: "modified" };
}

// ── Pure detectors (reused by analyzeGaps AND the batch dream-scan) ──────────

export function detectSuperseded(neurons: Neuron[]): GapReport["superseded"] {
  const out: GapReport["superseded"] = [];
  for (const neuron of neurons) {
    const fm = neuron.frontmatter;
    if (fm.status === "superseded" || fm.superseded_by != null) {
      out.push({
        id: idOf(neuron),
        superseded_by: (fm.superseded_by as string) ?? null,
        superseded_on: (fm.superseded_on as string) ?? null,
      });
    }
  }
  return out;
}

export function detectStale(
  neurons: Neuron[],
  opts: { now?: Date; staleDays?: number } = {},
): GapReport["stale"] {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? 60;
  const out: GapReport["stale"] = [];
  for (const neuron of neurons) {
    if (!PERISHABLE.has(neuron.category)) continue; // patterns/foundations are durable
    if (neuron.frontmatter.status === "graduated") continue;
    const { date, source } = knowledgeDate(neuron);
    const days = daysBetween(now, date);
    if (days > staleDays) {
      out.push({
        id: idOf(neuron),
        last_touched: date.toISOString().split("T")[0],
        days_old: days,
        date_source: source,
      });
    }
  }
  return out;
}

export function detectUnreliablePatterns(neurons: Neuron[]): GapReport["unreliable_patterns"] {
  const out: GapReport["unreliable_patterns"] = [];
  for (const neuron of neurons) {
    if (neuron.category !== "patterns") continue;
    const hits = (neuron.frontmatter.hits as number) ?? 0;
    const misses = (neuron.frontmatter.misses as number) ?? 0;
    if (misses > 0 && misses >= hits) {
      out.push({ id: idOf(neuron), hits, misses });
    }
  }
  return out;
}

export function detectPossibleDuplicates(
  neurons: Neuron[],
  vectors?: Map<string, number[]>,
  threshold: number = DUP_THRESHOLD,
): GapReport["possible_duplicates"] {
  const out: GapReport["possible_duplicates"] = [];
  if (!vectors || neurons.length < 2) return out;
  for (let i = 0; i < neurons.length; i++) {
    for (let j = i + 1; j < neurons.length; j++) {
      const va = vectors.get(neurons[i].filename);
      const vb = vectors.get(neurons[j].filename);
      if (!va || !vb) continue;
      const sim = cosineSimilarity(va, vb);
      if (sim >= threshold) {
        out.push({ a: idOf(neurons[i]), b: idOf(neurons[j]), similarity: Number(sim.toFixed(3)) });
      }
    }
  }
  return out;
}

/**
 * Project-mix signal using the 5-state scope model:
 * global/factory/cross-project never count as a mix; unknown is reported
 * separately; only ≥2 distinct CONCRETE projects (without an explicit
 * project filter) is flagged as a risky mix.
 */
export function detectProjectMix(
  neurons: Neuron[],
  hadProjectFilter: boolean,
): GapReport["project_mix"] {
  const concrete = new Set<string>();
  let unknown = 0;
  for (const neuron of neurons) {
    const scope = projectScopeOf(neuron);
    if (scope === "global") continue;
    if (scope === "unknown") {
      unknown++;
      continue;
    }
    concrete.add(scope);
  }
  return {
    mixed: !hadProjectFilter && concrete.size >= 2,
    projects: [...concrete],
    unknown,
  };
}

export interface AnalyzeGapsOptions {
  /** Ranked results to scrutinize (already category/project filtered). */
  scored: ScoredNeuronInput[];
  /** How many top results to scrutinize (default 8). */
  topK?: number;
  /** filename → embedding vector, for cross-neuron duplicate detection. */
  vectors?: Map<string, number[]>;
  /** "Now" — injectable for testing. */
  now?: Date;
  /** A perishable neuron untouched for longer than this is flagged stale (default 60). */
  staleDays?: number;
  /** Whether the caller passed an explicit project filter. */
  hadProjectFilter?: boolean;
  /** Whether semantic search actually contributed to the ranking. */
  usedSemantic?: boolean;
}

/**
 * Compute a deterministic gap report over a ranked result set.
 * Orchestrates the pure detectors; does not duplicate their logic.
 */
export function analyzeGaps(opts: AnalyzeGapsOptions): GapReport {
  const {
    scored,
    topK = 8,
    vectors,
    now = new Date(),
    staleDays = 60,
    hadProjectFilter = false,
    usedSemantic = false,
  } = opts;

  const top = scored.slice(0, topK);
  const topNeurons = top.map((s) => s.neuron);
  const notes: string[] = [];

  // ── Confidence / coverage (depends on scores, not a pure neuron detector) ──
  let confidence: GapReport["confidence"];
  let coverage_note: string;
  if (top.length === 0) {
    confidence = "empty";
    coverage_note = "No neuron matches this query. Likely a genuine blind spot — consider capturing one.";
    notes.push("⚠ No matches — this is a hole in the knowledge base.");
  } else if (usedSemantic) {
    const topSem = top[0].semanticScore;
    if (topSem >= 0.7) {
      confidence = "strong";
      coverage_note = `Top match is semantically strong (sim ${topSem.toFixed(2)}).`;
    } else if (topSem >= 0.5) {
      confidence = "moderate";
      coverage_note = `Top match is semantically moderate (sim ${topSem.toFixed(2)}). Verify it actually answers the query.`;
    } else {
      confidence = "weak";
      coverage_note = `Top match is semantically weak (sim ${topSem.toFixed(2)}). The brain may not really cover this.`;
      notes.push("⚠ Weak semantic coverage — treat results as loosely related, not authoritative.");
    }
  } else {
    confidence = top[0].score > 6 ? "moderate" : "weak";
    coverage_note = "Keyword-only ranking (semantic search unavailable). Confidence is approximate.";
    notes.push("ℹ Semantic search was unavailable; ranking is keyword-only.");
  }

  // ── Pure detectors ──────────────────────────────────────────────────────
  const superseded = detectSuperseded(topNeurons);
  const stale = detectStale(topNeurons, { now, staleDays });
  const possible_duplicates = detectPossibleDuplicates(topNeurons, vectors);
  const unreliable_patterns = detectUnreliablePatterns(topNeurons);
  const project_mix = detectProjectMix(topNeurons, hadProjectFilter);

  if (superseded.length > 0) {
    notes.push(
      `⚠ ${superseded.length} result(s) SUPERSEDED — do not act on them: ` +
        superseded.map((s) => (s.superseded_by ? `${s.id}→${s.superseded_by}` : s.id)).join(", ") + ".",
    );
  }
  if (stale.length > 0) {
    notes.push(
      `⚠ ${stale.length} result(s) older than ${staleDays}d by creation date — may be outdated: ` +
        stale.map((s) => `${s.id}(${s.days_old}d)`).join(", ") + ".",
    );
  }
  if (possible_duplicates.length > 0) {
    notes.push(
      `◆ ${possible_duplicates.length} near-duplicate pair(s) — consolidation candidates: ` +
        possible_duplicates.map((d) => `${d.a}≈${d.b}`).join(", ") + ".",
    );
  }
  if (unreliable_patterns.length > 0) {
    notes.push(
      `⚠ ${unreliable_patterns.length} pattern(s) miss ≥ hit — low reliability: ` +
        unreliable_patterns.map((p) => `${p.id}(${p.hits}h/${p.misses}m)`).join(", ") + ".",
    );
  }
  if (project_mix.mixed) {
    notes.push(
      `ℹ Results mix ${project_mix.projects.length} projects (${project_mix.projects.join(", ")}) — ` +
        "pass a 'project' filter to scope (NE-295).",
    );
  }
  if (project_mix.unknown > 0) {
    notes.push(`ℹ ${project_mix.unknown} result(s) have no project/scope (unknown) — not treated as global.`);
  }

  return {
    confidence,
    coverage_note,
    superseded,
    stale,
    possible_duplicates,
    unreliable_patterns,
    project_mix,
    notes,
  };
}
