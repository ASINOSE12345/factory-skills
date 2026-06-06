import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { runProjectCoverage, renderMarkdown, discoverRepos, parseArgs, applyRegistryProjection, type ProjectCoverageReport } from "../src/project-coverage-cli";
import { loadRegistry } from "../src/registry";
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

/** Write a temp registry file and return its path. */
function writeRegistryFile(projects: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cov-reg-"));
  roots.push(dir);
  const p = join(dir, "projects.json");
  writeFileSync(p, JSON.stringify({ version: 1, projects }));
  return p;
}

/** A registry that binds every working-tree repo of fullFixture():
 *  alpha (covered), beta multi-repo (beta covered + beta-v2 archived),
 *  gamma external, factory-tools under a global project. */
const FULL_REGISTRY = [
  { project_id: "alpha", status: "active", repos: [{ repo_id: "alpha", role: "app" }] },
  { project_id: "beta", status: "active", repos: [{ repo_id: "beta", role: "core" }, { repo_id: "beta-v2", role: "legacy", status: "archived" }] },
  { project_id: "gamma", status: "external", repos: [{ repo_id: "gamma" }] },
  { project_id: "platform", status: "active", is_global: true, repos: [{ repo_id: "factory-tools", role: "platform" }] },
];

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

describe("project-coverage — strict CLI parsing (no silent fallback)", () => {
  it("parses valid args (json default, markdown→md, integer depth)", () => {
    expect(parseArgs(["--factory-root", "/x", "--format", "md"])).toMatchObject({ factoryRoot: "/x", format: "md" });
    expect(parseArgs(["--factory-root", "/x", "--format", "markdown"]).format).toBe("md");
    expect(parseArgs(["--factory-root", "/x", "--repo-max-depth", "2"]).repoMaxDepth).toBe(2);
    expect(parseArgs(["--factory-root", "/x"]).format).toBe("json");
  });

  it("rejects an unknown --format value instead of falling back to json", () => {
    expect(() => parseArgs(["--factory-root", "/x", "--format", "yaml"])).toThrow(/--format must be one of/);
  });

  it("rejects a non-positive-integer --repo-max-depth", () => {
    expect(() => parseArgs(["--factory-root", "/x", "--repo-max-depth", "1.5"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--factory-root", "/x", "--repo-max-depth", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--factory-root", "/x", "--repo-max-depth", "abc"])).toThrow(/positive integer/);
  });

  it("rejects a missing value after a flag", () => {
    expect(() => parseArgs(["--factory-root"])).toThrow(/missing value for --factory-root/);
    expect(() => parseArgs(["--factory-root", "--format", "json"])).toThrow(/missing value for --factory-root/);
  });

  it("rejects an unknown argument", () => {
    expect(() => parseArgs(["--factory-root", "/x", "--bogus"])).toThrow(/unknown argument/);
  });
});

describe("project-coverage — CLI contract (subprocess on dist)", () => {
  const DIST = resolve("dist/project-coverage-cli.js");

  beforeAll(() => {
    if (!existsSync(DIST)) execSync("npm run build", { cwd: process.cwd(), stdio: "ignore" });
  }, 60000);

  it("`node dist/...` --format json writes PARSEABLE JSON to stdout (banner-free); progress to stderr", () => {
    const root = fullFixture();
    const res = spawnSync("node", [DIST, "--factory-root", root, "--format", "json"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    // Regression guard for the npm-banner blocker: stdout MUST be pure JSON.
    expect(res.stdout.trimStart().startsWith("{")).toBe(true);
    const parsed = JSON.parse(res.stdout) as ProjectCoverageReport; // throws → fails if stdout is contaminated
    expect(parsed.summary.repos_total).toBeGreaterThan(0);
    expect(res.stderr).toMatch(/\[project-coverage\]/); // progress on stderr
    expect(res.stdout).not.toMatch(/\[project-coverage\]/); // never on stdout
  });

  it("`node dist/...` --format md writes Markdown to stdout", () => {
    const root = fullFixture();
    const res = spawnSync("node", [DIST, "--factory-root", root, "--format", "md"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout.trimStart().startsWith("# Project Coverage Audit")).toBe(true);
  });

  it("`npm --silent run project-coverage` keeps stdout JSON-clean (documented npm form)", () => {
    const root = fullFixture();
    const res = spawnSync("npm", ["--silent", "run", "project-coverage", "--", "--factory-root", root, "--format", "json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });

  it("exits 1 on an invalid --format (no silent fallback)", () => {
    const root = fullFixture();
    const res = spawnSync("node", [DIST, "--factory-root", root, "--format", "yaml"], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/--format must be one of/);
  });

  it("exits 1 on a non-integer --repo-max-depth", () => {
    const root = fullFixture();
    const res = spawnSync("node", [DIST, "--factory-root", root, "--repo-max-depth", "1.5"], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/positive integer/);
  });
});

describe("project-coverage — registry projection (inert, read-only)", () => {
  it("baseline report has registry === null", () => {
    expect(runProjectCoverage({ factoryRoot: fullFixture() }).registry).toBeNull();
  });

  it("does NOT recompute summary — covered_direct stays the baseline direct-match value", () => {
    const base = runProjectCoverage({ factoryRoot: fullFixture() });
    const proj = applyRegistryProjection(base, loadRegistry(writeRegistryFile(FULL_REGISTRY)));
    // The whole point of the microfix: summary + coverage are the BASELINE values,
    // not recomputed by the registry. covered_direct never means "registry-bound".
    expect(proj.summary).toEqual(base.summary);
    expect(proj.coverage).toEqual(base.coverage);
    expect(proj.summary.ambiguous_candidates).toBe(2); // beta + beta-v2 still baseline-ambiguous
  });

  it("reports the projection under registry.* with an honest (weaker) name", () => {
    const proj = applyRegistryProjection(runProjectCoverage({ factoryRoot: fullFixture() }), loadRegistry(writeRegistryFile(FULL_REGISTRY)));
    const rg = proj.registry!;
    expect(rg.loaded).toBe(true);
    expect(rg.repos_bound).toBe(5);
    expect(rg.repos_unbound).toEqual([]);
    expect(rg.ambiguous_after).toBe(0);
    expect(rg.covered_project_specific.slice().sort()).toEqual(["alpha", "beta"]);
    expect(rg.archived).toEqual(["beta-v2"]);
    expect(rg.external).toEqual(["gamma"]);
    expect(rg.global_only).toEqual(["factory-tools"]);
  });

  it("archived/external/global repos are NOT counted as covered_project_specific", () => {
    const rg = applyRegistryProjection(runProjectCoverage({ factoryRoot: fullFixture() }), loadRegistry(writeRegistryFile(FULL_REGISTRY))).registry!;
    expect(rg.covered_project_specific).not.toContain("beta-v2"); // archived
    expect(rg.covered_project_specific).not.toContain("gamma"); // external
    expect(rg.covered_project_specific).not.toContain("factory-tools"); // global_only
  });

  it("annotates each repo with a registry view WITHOUT changing its baseline classification", () => {
    const base = runProjectCoverage({ factoryRoot: fullFixture() });
    const proj = applyRegistryProjection(base, loadRegistry(writeRegistryFile(FULL_REGISTRY)));
    const beta = proj.repos.find((r) => r.repo_id === "beta")!;
    const betaBase = base.repos.find((r) => r.repo_id === "beta")!;
    expect(beta.registry_classification).toBe("covered_project_specific");
    expect(beta.classification).toBe(betaBase.classification); // baseline untouched (ambiguous)
    expect(proj.repos.find((r) => r.repo_id === "beta-v2")!.registry_classification).toBe("archived");
    expect(proj.repos.find((r) => r.repo_id === "gamma")!.registry_classification).toBe("external");
    expect(proj.repos.find((r) => r.repo_id === "factory-tools")!.registry_classification).toBe("global_only");
  });

  it("repos absent from the registry are 'unbound' and keep their heuristic classification", () => {
    const reg = loadRegistry(writeRegistryFile([{ project_id: "alpha", status: "active", repos: [{ repo_id: "alpha" }] }]));
    const base = runProjectCoverage({ factoryRoot: fullFixture() });
    const proj = applyRegistryProjection(base, reg);
    expect(proj.registry!.covered_project_specific).toEqual(["alpha"]);
    expect(proj.registry!.repos_unbound).toEqual(expect.arrayContaining(["beta", "beta-v2", "gamma", "factory-tools"]));
    expect(proj.repos.find((r) => r.repo_id === "beta")!.registry_classification).toBe("unbound");
    expect(proj.coverage).toEqual(base.coverage); // baseline coverage unchanged
    expect(proj.registry!.ambiguous_after).toBeGreaterThan(0); // beta/beta-v2 unresolved by partial registry
  });

  it("surfaces registry alias collisions without throwing", () => {
    const reg = loadRegistry(writeRegistryFile([
      { project_id: "alpha", status: "active", aliases: ["shared"], repos: [{ repo_id: "alpha" }] },
      { project_id: "beta", status: "active", aliases: ["shared"], repos: [{ repo_id: "beta" }] },
    ]));
    const proj = applyRegistryProjection(runProjectCoverage({ factoryRoot: fullFixture() }), reg);
    expect(proj.registry!.alias_collisions.some((c) => c.alias === "shared")).toBe(true);
  });
});

describe("project-coverage — registry projection (subprocess on dist)", () => {
  const DIST = resolve("dist/project-coverage-cli.js");
  beforeAll(() => {
    if (!existsSync(DIST)) execSync("npm run build", { cwd: process.cwd(), stdio: "ignore" });
  }, 60000);

  it("--registry: registry block carries the projection; summary stays baseline (direct)", () => {
    const root = fullFixture();
    const regPath = writeRegistryFile(FULL_REGISTRY);
    const res = spawnSync("node", [DIST, "--factory-root", root, "--registry", regPath, "--format", "json"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as ProjectCoverageReport;
    expect(parsed.registry?.loaded).toBe(true);
    expect(parsed.registry?.ambiguous_after).toBe(0);
    expect(parsed.registry?.repos_bound).toBe(5);
    expect(parsed.registry?.covered_project_specific.length).toBe(2);
    expect(parsed.summary.ambiguous_candidates).toBe(2); // summary is baseline, NOT recomputed
  });

  it("exits 1 on a missing/invalid registry file (no silent fallback)", () => {
    const root = fullFixture();
    const res = spawnSync("node", [DIST, "--factory-root", root, "--registry", "/no/such/registry-xyz.json", "--format", "json"], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/invalid registry|file not found/);
  });
});

describe("project-coverage — registry v2 reporting (entity_type / reuse_scope / lineage)", () => {
  it("reports v2 metadata + aggregates WITHOUT changing summary or coverage", () => {
    const root = setupFactory({
      neurons: [{ cat: "errors", id: "NE-001", project: "alpha" }, { cat: "errors", id: "NE-002", project: "beta" }],
      repos: ["alpha", "beta"],
    });
    const base = runProjectCoverage({ factoryRoot: root });
    const reg = loadRegistry(writeRegistryFile([
      { project_id: "alpha", entity_type: "client", status: "active", reuse_scope: "tenant_private", aliases: ["alpha"], lineage: [] },
      { project_id: "beta", entity_type: "project", status: "active", reuse_scope: "internal", aliases: ["beta"], lineage: ["paperclip"] },
      { project_id: "myorg", entity_type: "organization", status: "active" },
      { project_id: "pc", entity_type: "source_lineage", status: "legacy", aliases: ["pc-alias"] },
    ]));
    const proj = applyRegistryProjection(base, reg);
    const rg = proj.registry!;

    // baseline untouched — the registry block is diagnostic, never recomputes coverage
    expect(proj.summary).toEqual(base.summary);
    expect(proj.coverage).toEqual(base.coverage);

    expect(rg.entity_type_counts).toEqual({ client: 1, project: 1, organization: 1, source_lineage: 1 });
    expect(rg.reuse_scope_counts).toEqual({ tenant_private: 1, internal: 1, unknown: 2 });
    expect(rg.lineage_counts).toEqual({ paperclip: 1 });
    expect(rg.source_lineage_entries).toEqual(["pc"]);
    expect(rg.entries_missing_reuse_scope.slice().sort()).toEqual(["myorg", "pc"]);

    const byId = Object.fromEntries(rg.entities.map((e) => [e.project_id, e]));
    expect(byId["alpha"].entity_type).toBe("client");
    expect(byId["beta"].lineage).toEqual(["paperclip"]);
    expect(byId["myorg"].indexed).toBe(false); // organization excluded from index
    expect(byId["pc"].indexed).toBe(false); // source_lineage excluded from index

    // organization & source_lineage NEVER count as project coverage
    expect(rg.covered_project_specific).not.toContain("pc");
    expect(rg.covered_project_specific).not.toContain("myorg");
  });

  it("v1 registry (no v2 fields) → entity_type=project, lineage=[], reuse_scope=null", () => {
    const root = setupFactory({ neurons: [{ cat: "errors", id: "NE-001", project: "alpha" }], repos: ["alpha"] });
    const reg = loadRegistry(writeRegistryFile([{ project_id: "alpha", status: "active", aliases: ["alpha"] }]));
    const rg = applyRegistryProjection(runProjectCoverage({ factoryRoot: root }), reg).registry!;
    const e = rg.entities.find((x) => x.project_id === "alpha")!;
    expect(e.entity_type).toBe("project");
    expect(e.lineage).toEqual([]);
    expect(e.reuse_scope).toBeNull();
    expect(rg.entries_missing_entity_type).toContain("alpha");
    expect(rg.entity_type_counts).toEqual({ project: 1 });
  });

  it("markdown documents that reuse_scope is NOT authZ", () => {
    const root = setupFactory({ neurons: [{ cat: "errors", id: "NE-001", project: "alpha" }], repos: ["alpha"] });
    const reg = loadRegistry(writeRegistryFile([{ project_id: "alpha", entity_type: "client", status: "active", reuse_scope: "tenant_private", aliases: ["alpha"] }]));
    const md = renderMarkdown(applyRegistryProjection(runProjectCoverage({ factoryRoot: root }), reg));
    expect(md).toMatch(/reuse_scope/);
    expect(md).toMatch(/NOT access control|not authZ/i);
  });
});
