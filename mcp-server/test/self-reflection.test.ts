import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clusterMirrors,
  buildCitationGraph,
  reflectCitationGraph,
  detectContradictionCandidates,
  reflectSelfKnowledge,
  detectDogmaCandidates,
} from "../src/self-reflection";
import { reflect } from "../src/reflect";
import { resetProjectAliasCache, type Neuron, type NeuronCategory } from "../src/neurons";

// ── In-memory neuron builder (pure-detector tests, no disk) ──────────────────

function mk(
  id: string,
  category: NeuronCategory,
  o: { project?: string; scope?: string; content?: string; fm?: Record<string, unknown> } = {},
): Neuron {
  return {
    filename: `${id}.md`,
    filepath: `/tmp/${id}.md`,
    category,
    frontmatter: { ...(o.project ? { project: o.project } : {}), ...(o.scope ? { scope: o.scope } : {}), ...o.fm },
    content: o.content ?? id,
    title: id,
    modified: new Date("2026-01-01"),
  };
}

function vecMap(pairs: Array<[string, number[]]>): Map<string, number[]> {
  return new Map(pairs.map(([id, v]) => [`${id}.md`, v]));
}

beforeEach(() => {
  delete process.env.FACTORY_PROJECT_ALIASES_FILE;
  delete process.env.FACTORY_ROOT;
  resetProjectAliasCache();
});

// ── Detector 1: clusterMirrors ───────────────────────────────────────────────

describe("clusterMirrors", () => {
  it("clusters near-identical neurons of the same category+scope (high conf at ≥4)", () => {
    const ns = ["NB-1", "NB-2", "NB-3", "NB-4"].map((id) => mk(id, "business", { project: "ProjectAlpha" }));
    const v = vecMap(ns.map((n) => [n.filename.replace(".md", ""), [1, 0, 0]] as [string, number[]]));
    const f = clusterMirrors(ns, v, 0.97);
    expect(f).toHaveLength(1);
    expect(f[0].ids).toHaveLength(4);
    expect(f[0].confidence).toBe("high");
    expect(f[0].dimension).toBe("mirror_cluster");
  });
  it("does NOT cross scope boundaries", () => {
    const ns = [mk("NB-1", "business", { project: "ProjectAlpha" }), mk("NB-2", "business", { project: "ProjectBeta" })];
    const v = vecMap([["NB-1", [1, 0, 0]], ["NB-2", [1, 0, 0]]]);
    expect(clusterMirrors(ns, v, 0.97)).toHaveLength(0);
  });
  it("does NOT cluster below threshold", () => {
    const ns = [mk("NB-1", "business", { project: "ProjectAlpha" }), mk("NB-2", "business", { project: "ProjectAlpha" })];
    const v = vecMap([["NB-1", [1, 0, 0]], ["NB-2", [0.8, 0.6, 0]]]); // cosine 0.8 < 0.97
    expect(clusterMirrors(ns, v, 0.97)).toHaveLength(0);
  });
});

// ── Detector 2: citation graph ───────────────────────────────────────────────

describe("buildCitationGraph / reflectCitationGraph", () => {
  it("flags a dangling reference to a non-existent ID", () => {
    const a = mk("NP-1", "patterns", { content: "as discussed in NE-999 we do X" });
    const b = mk("NE-1", "errors", { content: "real error" });
    const g = buildCitationGraph([a, b]);
    expect(g.danglingRefs).toContainEqual({ from: "NP-1", to: "NE-999" });
    const f = reflectCitationGraph([a, b]);
    expect(f.some((x) => x.evidence.join(" ").includes("NE-999"))).toBe(true);
  });
  it("counts inbound degree and records a real edge (no dangling)", () => {
    const a = mk("NP-1", "patterns", { content: "see NE-1 for the failure" });
    const b = mk("NE-1", "errors", { content: "real error" });
    const g = buildCitationGraph([a, b]);
    expect(g.inDegree.get("NE-1")).toBe(1);
    expect(g.danglingRefs).toHaveLength(0);
  });
  it("orphan analysis is STRUCTURAL: an isolated NF is an orphan, an isolated NE is not", () => {
    const g = buildCitationGraph([mk("NF-9", "foundations", { content: "standalone" }), mk("NE-9", "errors", { content: "lone error" })]);
    expect(g.orphans).toContain("NF-9");
    expect(g.orphans).not.toContain("NE-9");
  });
});

// ── Detector 3: contradiction candidates ─────────────────────────────────────

describe("detectContradictionCandidates", () => {
  it("flags a same-topic pair with opposite polarity as needs_judge", () => {
    const a = mk("NE-10", "errors", { content: "avoid this; it is deprecated and forbidden" });
    const b = mk("NE-11", "errors", { content: "always prefer this; it is required and must hold" });
    const v = vecMap([["NE-10", [1, 0, 0]], ["NE-11", [0.9, 0.43589, 0]]]); // cosine ≈ 0.90
    const f = detectContradictionCandidates([a, b], v);
    expect(f).toHaveLength(1);
    expect(f[0].needs_judge).toBe(true);
    expect(f[0].dimension).toBe("contradiction_candidate");
  });
  it("does NOT flag near-identical pairs (that's a mirror, not a contradiction)", () => {
    const a = mk("NE-10", "errors", { content: "avoid this deprecated thing" });
    const b = mk("NE-11", "errors", { content: "always use this required thing" });
    const v = vecMap([["NE-10", [1, 0, 0]], ["NE-11", [1, 0, 0]]]); // cosine 1.0 ≥ hi
    expect(detectContradictionCandidates([a, b], v)).toHaveLength(0);
  });
  it("does NOT flag same-polarity pairs", () => {
    const a = mk("NE-10", "errors", { content: "always prefer X" });
    const b = mk("NE-11", "errors", { content: "always prefer Y" });
    const v = vecMap([["NE-10", [1, 0, 0]], ["NE-11", [0.9, 0.43589, 0]]]);
    expect(detectContradictionCandidates([a, b], v)).toHaveLength(0);
  });
});

// ── Detector 4: self-knowledge ───────────────────────────────────────────────

describe("reflectSelfKnowledge", () => {
  const errs = [mk("NE-20", "errors"), mk("NE-21", "errors"), mk("NE-22", "errors")];
  const v = vecMap([["NE-20", [1, 0, 0]], ["NE-21", [1, 0, 0]], ["NE-22", [1, 0, 0]]]);
  it("flags a recurring error cluster with NO covering pattern (high conf at ≥3)", () => {
    const f = reflectSelfKnowledge(errs, v);
    expect(f).toHaveLength(1);
    expect(f[0].ids).toEqual(["NE-20", "NE-21", "NE-22"]);
    expect(f[0].confidence).toBe("high");
  });
  it("does NOT flag when a pattern already covers the cluster", () => {
    const p = mk("NP-20", "patterns");
    const v2 = new Map(v);
    v2.set("NP-20.md", [1, 0, 0]); // sim 1.0 with the errors ≥ patSim → covered
    expect(reflectSelfKnowledge([...errs, p], v2)).toHaveLength(0);
  });
  it("does NOT cluster a single unique error", () => {
    const f = reflectSelfKnowledge([mk("NE-30", "errors"), mk("NE-31", "errors")], vecMap([["NE-30", [1, 0, 0]], ["NE-31", [0, 1, 0]]]));
    expect(f).toHaveLength(0);
  });
});

// ── Detector 5: dogma candidates ─────────────────────────────────────────────

describe("detectDogmaCandidates", () => {
  const now = new Date("2026-06-01");
  it("flags an old, graduated, never-missed pattern", () => {
    const p = mk("NP-30", "patterns", { fm: { status: "graduated", hits: 10, misses: 0, created: "2026-01-01" } });
    const f = detectDogmaCandidates([p], { now });
    expect(f.some((x) => x.ids[0] === "NP-30")).toBe(true);
  });
  it("does NOT flag a fresh pattern", () => {
    const p = mk("NP-31", "patterns", { fm: { status: "new", hits: 1, misses: 0, created: "2026-05-30" } });
    expect(detectDogmaCandidates([p], { now }).some((x) => x.ids[0] === "NP-31")).toBe(false);
  });
  it("does NOT flag a high-authority pattern that HAS recorded misses (it's being challenged)", () => {
    const p = mk("NP-32", "patterns", { fm: { status: "graduated", hits: 10, misses: 2, created: "2026-01-01" } });
    expect(detectDogmaCandidates([p], { now }).some((x) => x.ids[0] === "NP-32")).toBe(false);
  });
  it("flags a decision that invokes a freeze/axiom as justification (needs_human)", () => {
    const d = mk("ND-30", "decisions", { content: "we don't touch this due to factory freeze" });
    const f = detectDogmaCandidates([d], { now });
    const hit = f.find((x) => x.ids[0] === "ND-30");
    expect(hit).toBeTruthy();
    expect(hit!.needs_human).toBe(true);
  });
});

// ── Orchestrator: reflect (disk fixture, read-only, deterministic) ───────────

function writeNeuron(dir: string, category: string, name: string, frontmatter: string, body: string) {
  const d = join(dir, category);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), `---\n${frontmatter}\n---\n\n# ${name.replace(".md", "")}: ${body}\n\n${body}\n`);
}

function snapshot(dir: string): string {
  return (readdirSync(dir, { recursive: true }) as string[])
    .sort()
    .map((f) => {
      const s = statSync(join(dir, f));
      return `${f}:${s.isFile() ? `${s.size}:${s.mtimeMs}` : "dir"}`;
    })
    .join("|");
}

describe("reflect — orchestrator over a real fixture", () => {
  let root: string;
  let neuronsDir: string;
  const NOW = new Date("2026-06-01T00:00:00Z");

  beforeAll(() => {
    delete process.env.FACTORY_PROJECT_ALIASES_FILE;
    delete process.env.FACTORY_ROOT;
    resetProjectAliasCache();
    root = mkdtempSync(join(tmpdir(), "reflect-"));
    neuronsDir = join(root, "neurons");
    // 4 identical business captures (mirror cluster, high) ...
    for (let i = 1; i <= 4; i++) writeNeuron(neuronsDir, "business", `NB-${i}.md`, "project: ProjectAlpha\ncreated: 2026-01-01", "same captured note");
    // ... and 3 recurring errors with no covering pattern (self_knowledge, high).
    for (let i = 1; i <= 3; i++) writeNeuron(neuronsDir, "errors", `NE-${i}.md`, "project: ProjectAlpha\ncreated: 2026-01-01", "the same deploy mistake again");
    const entries: Record<string, { vector: number[]; updated: string }> = {};
    for (let i = 1; i <= 4; i++) entries[`NB-${i}.md`] = { vector: [1, 0, 0], updated: "2026-01-01" };
    for (let i = 1; i <= 3; i++) entries[`NE-${i}.md`] = { vector: [0, 1, 0], updated: "2026-01-01" };
    writeFileSync(join(root, ".neuron-embeddings.json"), JSON.stringify({ model: "test", dimensions: 3, entries }));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    resetProjectAliasCache();
  });

  const reportOpts = {
    mode: "report" as const,
    dryRun: true,
    createIssues: false,
    writeProposedNeurons: false,
    maxActions: 100,
    maxItems: 25,
    reflection: { now: NOW },
  };

  it("produces findings and a full audit of planned actions", () => {
    const r = reflect(neuronsDir, reportOpts);
    expect(r.corpus_size).toBe(7);
    expect(r.total_findings).toBeGreaterThanOrEqual(2);
    expect(r.findings.mirror_cluster.total).toBeGreaterThanOrEqual(1);
    expect(r.findings.self_knowledge.total).toBeGreaterThanOrEqual(1);
    expect(r.planned_actions.length).toBe(r.action_summary.total);
  });

  it("in report + dry-run, NOTHING is executed and NOTHING is blocked (all proposed)", () => {
    const r = reflect(neuronsDir, reportOpts);
    expect(r.action_summary.executed).toBe(0);
    expect(r.action_summary.blocked).toBe(0);
    expect(r.action_summary.proposed).toBe(r.action_summary.total);
  });

  it("CP2A safety net: even autonomous + flags on + dry_run=false executes NOTHING", () => {
    const r = reflect(neuronsDir, { ...reportOpts, mode: "autonomous", dryRun: false, createIssues: true, writeProposedNeurons: true });
    expect(r.action_summary.executed).toBe(0); // no execution layer yet → degraded to proposed
  });

  it("is READ-ONLY: the corpus directory is byte-identical before and after", () => {
    const before = snapshot(neuronsDir);
    reflect(neuronsDir, { ...reportOpts, mode: "autonomous", dryRun: false, createIssues: true, writeProposedNeurons: true });
    expect(snapshot(neuronsDir)).toBe(before);
  });

  it("is DETERMINISTIC: two runs with the same `now` yield identical findings", () => {
    const a = reflect(neuronsDir, reportOpts);
    const b = reflect(neuronsDir, reportOpts);
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
    expect(JSON.stringify(a.planned_actions)).toBe(JSON.stringify(b.planned_actions));
  });

  it("reports honest embeddings coverage", () => {
    const r = reflect(neuronsDir, reportOpts);
    expect(r.embeddings_covered).toBe(7);
  });
});
