import { describe, it, expect } from "vitest";
import type { Neuron, NeuronCategory } from "../src/neurons";
import {
  detectSuperseded,
  detectStale,
  detectUnreliablePatterns,
  detectPossibleDuplicates,
  detectProjectMix,
  analyzeGaps,
} from "../src/gap-analysis";

/** Real in-memory fixture (not a mock): a fully-formed Neuron object. */
function makeNeuron(over: Partial<Neuron> & { category: NeuronCategory }): Neuron {
  return {
    filename: over.filename ?? "NE-001.md",
    filepath: over.filepath ?? `/tmp/${over.filename ?? "NE-001.md"}`,
    category: over.category,
    frontmatter: over.frontmatter ?? {},
    content: over.content ?? "body",
    title: over.title ?? "Test",
    modified: over.modified ?? new Date("2026-05-01"),
  };
}

const NOW = new Date("2026-05-31");

describe("detectStale (knowledge age, not file mtime)", () => {
  it("flags a perishable neuron whose created date is old even if mtime is recent", () => {
    const n = makeNeuron({
      filename: "NE-100.md",
      category: "errors",
      frontmatter: { created: "2026-01-01" },
      modified: new Date("2026-05-30"), // recent mtime (bulk re-sync) must NOT save it
    });
    const stale = detectStale([n], { now: NOW, staleDays: 60 });
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe("NE-100");
    expect(stale[0].date_source).toBe("created");
  });

  it("does NOT flag a recently created neuron", () => {
    const n = makeNeuron({ filename: "NE-101.md", category: "errors", frontmatter: { created: "2026-05-20" } });
    expect(detectStale([n], { now: NOW, staleDays: 60 })).toHaveLength(0);
  });

  it("uses `date` when `created` is absent", () => {
    const n = makeNeuron({ filename: "NE-102.md", category: "errors", frontmatter: { date: "2026-01-01" } });
    const stale = detectStale([n], { now: NOW, staleDays: 60 });
    expect(stale).toHaveLength(1);
    expect(stale[0].date_source).toBe("date");
  });

  it("falls back to mtime when the frontmatter date is invalid", () => {
    const n = makeNeuron({
      filename: "NE-103.md",
      category: "errors",
      frontmatter: { created: "not-a-date" },
      modified: new Date("2026-01-01"),
    });
    const stale = detectStale([n], { now: NOW, staleDays: 60 });
    expect(stale).toHaveLength(1);
    expect(stale[0].date_source).toBe("modified");
  });

  it("handles a Date-typed created (gray-matter parses unquoted YAML dates as Date)", () => {
    const n = makeNeuron({
      filename: "NE-104.md",
      category: "errors",
      frontmatter: { created: new Date("2026-01-01") },
    });
    const stale = detectStale([n], { now: NOW, staleDays: 60 });
    expect(stale).toHaveLength(1);
    expect(stale[0].date_source).toBe("created");
  });

  it("never flags graduated patterns (durable)", () => {
    const n = makeNeuron({
      filename: "NP-1.md",
      category: "patterns",
      frontmatter: { created: "2025-01-01", status: "graduated" },
    });
    expect(detectStale([n], { now: NOW, staleDays: 60 })).toHaveLength(0);
  });

  it("never flags foundations (durable category)", () => {
    const n = makeNeuron({ filename: "NF-1.md", category: "foundations", frontmatter: { created: "2024-01-01" } });
    expect(detectStale([n], { now: NOW, staleDays: 60 })).toHaveLength(0);
  });
});

describe("detectSuperseded", () => {
  it("detects status:superseded", () => {
    const n = makeNeuron({ filename: "NP-2.md", category: "patterns", frontmatter: { status: "superseded" } });
    expect(detectSuperseded([n])).toHaveLength(1);
  });
  it("detects superseded_by", () => {
    const n = makeNeuron({ filename: "NP-3.md", category: "patterns", frontmatter: { superseded_by: "NP-9" } });
    expect(detectSuperseded([n])[0].superseded_by).toBe("NP-9");
  });
  it("no false positive on a healthy neuron", () => {
    const n = makeNeuron({ filename: "NP-4.md", category: "patterns", frontmatter: { status: "validated" } });
    expect(detectSuperseded([n])).toHaveLength(0);
  });
});

describe("detectUnreliablePatterns", () => {
  it("flags misses >= hits with misses > 0", () => {
    const n = makeNeuron({ filename: "NP-5.md", category: "patterns", frontmatter: { hits: 1, misses: 3 } });
    expect(detectUnreliablePatterns([n])).toHaveLength(1);
  });
  it("does not flag when misses = 0", () => {
    const n = makeNeuron({ filename: "NP-6.md", category: "patterns", frontmatter: { hits: 5, misses: 0 } });
    expect(detectUnreliablePatterns([n])).toHaveLength(0);
  });
});

describe("detectPossibleDuplicates", () => {
  it("flags a pair with cosine >= 0.85", () => {
    const a = makeNeuron({ filename: "NE-200.md", category: "errors" });
    const b = makeNeuron({ filename: "NE-201.md", category: "errors" });
    const vectors = new Map<string, number[]>([
      ["NE-200.md", [1, 0, 0]],
      ["NE-201.md", [0.99, 0.01, 0]],
    ]);
    const dups = detectPossibleDuplicates([a, b], vectors);
    expect(dups).toHaveLength(1);
    expect(dups[0].similarity).toBeGreaterThanOrEqual(0.85);
  });
  it("does not flag a dissimilar pair (< 0.85)", () => {
    const a = makeNeuron({ filename: "NE-202.md", category: "errors" });
    const b = makeNeuron({ filename: "NE-203.md", category: "errors" });
    const vectors = new Map<string, number[]>([
      ["NE-202.md", [1, 0, 0]],
      ["NE-203.md", [0, 1, 0]],
    ]);
    expect(detectPossibleDuplicates([a, b], vectors)).toHaveLength(0);
  });
  it("returns nothing when vectors are missing", () => {
    const a = makeNeuron({ filename: "NE-204.md", category: "errors" });
    const b = makeNeuron({ filename: "NE-205.md", category: "errors" });
    expect(detectPossibleDuplicates([a, b], undefined)).toHaveLength(0);
  });
});

describe("detectProjectMix (5-state scope model)", () => {
  const mk = (file: string, fm: Record<string, unknown>) =>
    makeNeuron({ filename: file, category: "errors", frontmatter: fm });

  it("ProjectAlpha + alias of ProjectAlpha → NOT mixed", () => {
    const r = detectProjectMix([mk("a.md", { project: "ProjectAlpha" }), mk("b.md", { project: "projectalpha" })], false);
    expect(r.mixed).toBe(false);
    expect(r.projects).toHaveLength(1);
  });
  it("ProjectAlpha + ProjectBeta → mixed", () => {
    const r = detectProjectMix([mk("a.md", { project: "ProjectAlpha" }), mk("b.md", { project: "ProjectBeta" })], false);
    expect(r.mixed).toBe(true);
    expect(r.projects).toHaveLength(2);
  });
  it("ProjectAlpha + cross-project → NOT mixed", () => {
    const r = detectProjectMix([mk("a.md", { project: "ProjectAlpha" }), mk("b.md", { scope: "cross-project" })], false);
    expect(r.mixed).toBe(false);
  });
  it("ProjectAlpha + factory → NOT mixed", () => {
    const r = detectProjectMix([mk("a.md", { project: "ProjectAlpha" }), mk("b.md", { scope: "factory" })], false);
    expect(r.mixed).toBe(false);
  });
  it("a neuron with no project/scope is unknown, not global", () => {
    const r = detectProjectMix([mk("a.md", {})], false);
    expect(r.unknown).toBe(1);
    expect(r.projects).toHaveLength(0);
  });
  it("an explicit project filter suppresses the mix flag", () => {
    const r = detectProjectMix([mk("a.md", { project: "ProjectAlpha" }), mk("b.md", { project: "ProjectBeta" })], true);
    expect(r.mixed).toBe(false);
  });
});

describe("analyzeGaps (orchestration)", () => {
  it("reports empty confidence when there are no results", () => {
    const g = analyzeGaps({ scored: [] });
    expect(g.confidence).toBe("empty");
  });
  it("surfaces a stale detector hit through notes", () => {
    const stale = makeNeuron({
      filename: "NE-300.md",
      category: "errors",
      frontmatter: { created: "2026-01-01", project: "ProjectAlpha" },
    });
    const g = analyzeGaps({ scored: [{ neuron: stale, score: 5, semanticScore: 0 }], now: NOW, staleDays: 60 });
    expect(g.stale).toHaveLength(1);
    expect(g.notes.some((n) => n.includes("NE-300"))).toBe(true);
  });
});
