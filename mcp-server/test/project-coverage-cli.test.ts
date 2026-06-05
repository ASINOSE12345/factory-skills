import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { runProjectCoverage, renderMarkdown, discoverRepos, type ProjectCoverageReport } from "../src/project-coverage-cli";
import { resetProjectAliasCache } from "../src/neurons";

const roots: string[] = [];

interface NeuronSpec {
  cat: "errors" | "decisions" | "patterns" | "foundations" | "business";
  id: string; // must carry the right prefix for its category (NE-/ND-/NP-/NF-/NB-)
  project?: string;
  scope?: string;
  body?: string;
}

/** Build a temp factory root with neurons + bare `.git` repo dirs. No mocks. */
function setupFactory(opts: {
  neurons: NeuronSpec[];
  repos: string[]; // top-level repo dir names (each gets a .git dir)
  nested?: Array<{ parent: string; child: string }>; // repo nested inside a repo
  bare?: string[]; // "<name>.git" bare repos
}): string {
  const root = mkdtempSync(join(tmpdir(), "cov-cli-"));
  roots.push(root);
  const neuronsDir = join(root, "neurons");
  for (const n of opts.neurons) {
    const d = join(neuronsDir, n.cat);
    mkdirSync(d, { recursive: true });
    const fm: string[] = ["type: x"];
    if (n.project !== undefined) fm.push(`project: ${n.project}`);
    if (n.scope !== undefined) fm.push(`scope: ${n.scope}`);
    fm.push("created: '2026-06-01'");
    writeFileSync(join(d, `${n.id}.md`), `---\n${fm.join("\n")}\n---\n\n# ${n.id}: title\n\n${n.body ?? "body"}\n`);
  }
  for (const r of opts.repos) mkdirSync(join(root, r, ".git"), { recursive: true });
  for (const { parent, child } of opts.nested ?? []) mkdirSync(join(root, parent, child, ".git"), { recursive: true });
  for (const b of opts.bare ?? []) {
    const d = join(root, b);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(d, "objects"), { recursive: true });
  }
  return root;
}

/** Recursive content snapshot (path → sha256) to prove zero writes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** The canonical fixture exercising every coverage bucket + anomalies + refs. */
function fullFixture(): string {
  return setupFactory({
    neurons: [
      { cat: "errors", id: "NE-001", project: "alpha" },
      { cat: "errors", id: "NE-002", project: "beta" },
      { cat: "patterns", id: "NP-001", project: "beta" },
      { cat: "errors", id: "NE-003", scope: "global" },
      { cat: "business", id: "NB-001", scope: "cross-project" },
      { cat: "errors", id: "NE-004" }, // no project/scope → unknown
      { cat: "decisions", id: "ND-001" }, // no project/scope → unknown
      { cat: "foundations", id: "NF-001", project: "orphanlib" }, // neuron-only project (no repo)
      {
        cat: "errors",
        id: "NE-005",
        project: "alpha",
        body: "Refs: NE-9999 and PAT-FX-010 and UV-7 and #123 and ZZ-42",
      },
    ],
    repos: ["alpha", "beta", "beta-v2", "gamma", "factory-tools"],
    nested: [{ parent: "alpha", child: "embedded" }],
    bare: ["legacy-backup.git"],
  });
}

beforeEach(() => {
  delete process.env.FACTORY_PROJECT_ALIASES_FILE;
  delete process.env.FACTORY_ROOT;
  resetProjectAliasCache();
});

afterEach(() => {
  delete process.env.FACTORY_PROJECT_ALIASES_FILE;
  delete process.env.FACTORY_ROOT;
  resetProjectAliasCache();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("project-coverage — read-only (zero writes)", () => {
  it("never writes to the factory root and never creates .factory/", () => {
    const root = fullFixture();
    const before = snapshot(root);
    const report = runProjectCoverage({ factoryRoot: root });
    renderMarkdown(report);
    const after = snapshot(root);
    expect(after).toEqual(before);
    expect(existsSync(join(root, ".factory"))).toBe(false);
  });
});

describe("project-coverage — coverage classification", () => {
  it("covered_direct: a sole repo with a direct project-specific match", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    const alpha = report.repos.find((r) => r.repo_id === "alpha")!;
    expect(alpha.classification).toBe("covered");
    expect(alpha.global_only).toBe(false);
    expect(alpha.direct_neuron_count).toBe(2);
    expect(report.coverage.covered).toContain("alpha");
  });

  it("ambiguous: multi-repo cluster without a registry (with evidence)", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    expect(report.coverage.ambiguous).toEqual(expect.arrayContaining(["beta", "beta-v2"]));
    const beta = report.repos.find((r) => r.repo_id === "beta")!;
    expect(beta.classification).toBe("ambiguous");
    expect(beta.siblings).toContain("beta-v2");
    expect(beta.evidence.join(" ")).toMatch(/multi-repo/i);
    // never sold as covered
    expect(report.coverage.covered).not.toContain("beta");
    expect(report.coverage.covered).not.toContain("beta-v2");
  });

  it("uncovered (plain): a repo with no neurons and no candidate", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    const gamma = report.repos.find((r) => r.repo_id === "gamma")!;
    expect(gamma.classification).toBe("uncovered");
    expect(gamma.global_only).toBe(false);
  });

  it("global_only: uncovered with a 'global-only' note, counted separately", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    const ft = report.repos.find((r) => r.repo_id === "factory-tools")!;
    expect(ft.classification).toBe("uncovered");
    expect(ft.global_only).toBe(true);
    expect(ft.evidence.join(" ")).toMatch(/global/i);
    expect(report.coverage.covered).not.toContain("factory-tools");
  });

  it("summary separates covered_direct / ambiguous_candidates / uncovered / global_only", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    expect(report.summary.repos_total).toBe(5);
    expect(report.summary.covered_direct).toBe(1); // alpha
    expect(report.summary.ambiguous_candidates).toBe(2); // beta, beta-v2
    expect(report.summary.uncovered).toBe(1); // gamma (NOT global_only)
    expect(report.summary.global_only).toBe(1); // factory-tools
    // global_only is excluded from the plain uncovered count, never from covered
    expect(report.summary.covered_direct + report.summary.ambiguous_candidates + report.summary.uncovered + report.summary.global_only).toBe(report.summary.repos_total);
  });
});

describe("project-coverage — anomalies (separate, never merged)", () => {
  it("reports nested repos and bare repos as anomalies, not as top-level repos", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    const types = report.anomalies.map((a) => a.type).sort();
    expect(types).toEqual(["bare_repo", "nested_repo"]);
    // anomalies are not in the classified repos
    const ids = report.repos.map((r) => r.repo_id);
    expect(ids).not.toContain("embedded");
    expect(ids).not.toContain("legacy-backup.git");
    expect(report.summary.anomalies).toBe(2);
  });
});

describe("project-coverage — neuron scope accounting", () => {
  it("counts global and unknown-scope neurons", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    expect(report.neurons.total).toBe(9);
    expect(report.neurons.global).toBe(2); // NE-003 (global) + NB-001 (cross-project)
    expect(report.neurons.unknown_scope.length).toBe(2); // NE-004, ND-001
  });

  it("groups unknown_scope by category", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    const byCat = report.neurons.unknown_scope_by_category;
    expect(byCat.errors).toBe(1);
    expect(byCat.decisions).toBe(1);
    expect(byCat.patterns).toBe(0);
    expect(byCat.foundations).toBe(0);
    expect(byCat.business).toBe(0);
    const total = Object.values(byCat).reduce((a, b) => a + b, 0);
    expect(total).toBe(report.neurons.unknown_scope.length);
  });

  it("surfaces a project token that has neurons but no local repo", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    const orphan = report.detected_projects.find((p) => p.canonical === "orphanlib")!;
    expect(orphan.source).toBe("neuron");
    expect(orphan.has_local_repo).toBe(false);
    expect(report.summary.projects_with_neurons_no_repo).toBe(1);
  });
});

describe("project-coverage — references (legacy never confused with broken)", () => {
  it("classifies a non-existent neuron id as broken (not legacy)", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    const broken = report.references.broken_neuron_refs.map((r) => r.ref);
    expect(broken).toContain("NE-9999");
    expect(broken).not.toContain("PAT-FX-010");
    expect(broken).not.toContain("UV-7");
    expect(broken).not.toContain("#123");
  });

  it("classifies PAT-/product-/issue refs as legacy (not broken, not unknown)", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    const legacy = report.references.legacy_or_external_refs;
    const refs = legacy.map((r) => r.ref);
    expect(refs).toEqual(expect.arrayContaining(["PAT-FX-010", "UV-7", "#123"]));
    expect(refs).not.toContain("NE-9999");
    const pat = legacy.find((r) => r.ref === "PAT-FX-010")!;
    expect(pat.kind).toBe("pattern-id");
    // the inner "FX-010" sub-segment must NOT leak into unknown refs
    expect(report.references.unknown_refs.map((r) => r.ref)).not.toContain("FX-010");
  });

  it("classifies a foreign ref shape as unknown", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    expect(report.references.unknown_refs.map((r) => r.ref)).toContain("ZZ-42");
  });

  it("resolves refs to suffixed/sub-namespaced filenames (real corpus scheme, no false broken)", () => {
    // The corpus names files like NE-329-ts-errors-introduced.md, NF-f409-...,
    // NB-F-001-..., NB-UV-def4-...  The id is the LEADING token; a bare ref to it
    // must resolve, not be flagged broken.
    const root = setupFactory({
      neurons: [
        { cat: "errors", id: "NE-777-some-descriptive-slug", project: "alpha", body: "related: NB-F-009" },
        { cat: "business", id: "NB-F-009-pricing-frameworks", project: "alpha", body: "see NE-777 and NE-9999" },
      ],
      repos: ["alpha"],
    });
    const broken = runProjectCoverage({ factoryRoot: root }).references.broken_neuron_refs.map((r) => r.ref);
    expect(broken).toContain("NE-9999"); // genuinely missing
    expect(broken).not.toContain("NE-777"); // exists as NE-777-some-descriptive-slug.md
    expect(broken).not.toContain("NB-F-009"); // exists as NB-F-009-pricing-frameworks.md
  });
});

describe("project-coverage — output formats", () => {
  it("produces parseable JSON with the contract keys", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    const round = JSON.parse(JSON.stringify(report)) as ProjectCoverageReport;
    expect(round.factory_root).toBeTruthy();
    for (const k of ["repos", "detected_projects", "coverage", "neurons", "references", "recommendations"]) {
      expect(round).toHaveProperty(k);
    }
    expect(round.coverage).toHaveProperty("covered");
    expect(round.coverage).toHaveProperty("uncovered");
    expect(round.coverage).toHaveProperty("ambiguous");
  });

  it("produces Markdown with all required sections", () => {
    const md = renderMarkdown(runProjectCoverage({ factoryRoot: fullFixture() }));
    for (const heading of [
      "## Executive Summary",
      "## Local Repositories",
      "## Coverage",
      "## Unknown-scope Neurons (by category)",
      "## Broken Neuron References",
      "## Legacy / External References",
      "## Recommendations",
    ]) {
      expect(md).toContain(heading);
    }
  });
});

describe("project-coverage — alias collisions", () => {
  it("detects an alias declared under two canonicals", () => {
    const root = fullFixture();
    const aliasFile = join(roots[roots.length - 1], "aliases.json");
    writeFileSync(aliasFile, JSON.stringify({ alpha: ["shared"], beta: ["shared"] }));
    process.env.FACTORY_PROJECT_ALIASES_FILE = aliasFile;
    resetProjectAliasCache();
    const report = runProjectCoverage({ factoryRoot: root });
    const collision = report.aliases.collisions.find((c) => c.alias === "shared")!;
    expect(collision).toBeTruthy();
    expect(collision.canonicals).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("reports no collisions when there is no aliases file", () => {
    const report = runProjectCoverage({ factoryRoot: fullFixture() });
    expect(report.aliases.source_file).toBeNull();
    expect(report.aliases.collisions).toEqual([]);
  });
});

describe("discoverRepos — detection primitives", () => {
  it("finds working trees, a nested repo, and a bare repo", () => {
    const root = fullFixture();
    const raw = discoverRepos(root, 3);
    const bare = raw.filter((r) => r.gitType === "bare").map((r) => r.name);
    expect(bare).toContain("legacy-backup.git");
    const names = raw.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["alpha", "beta", "beta-v2", "gamma", "factory-tools", "embedded"]));
  });

  it("throws a clear error when the neurons dir is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "cov-cli-empty-"));
    roots.push(root);
    expect(() => runProjectCoverage({ factoryRoot: root })).toThrow(/neurons dir not found/);
  });
});
