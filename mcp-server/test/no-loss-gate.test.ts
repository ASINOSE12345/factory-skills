import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { runNoLossGate, collectCorpusTokens, CRITICAL_TOKENS } from "../src/no-loss-gate-cli";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Temp neurons dir with NE-* files carrying the given project/scope tokens. */
function setupNeurons(specs: Array<{ project?: string; scope?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "nlg-"));
  roots.push(root);
  const dir = join(root, "neurons", "errors");
  mkdirSync(dir, { recursive: true });
  specs.forEach((s, i) => {
    const id = `NE-${String(i + 1).padStart(3, "0")}`;
    const fm: string[] = ["type: x"];
    if (s.project !== undefined) fm.push(`project: ${s.project}`);
    if (s.scope !== undefined) fm.push(`scope: ${s.scope}`);
    fm.push("created: '2026-06-06'");
    writeFileSync(join(dir, `${id}.md`), `---\n${fm.join("\n")}\n---\n\n# ${id}: t\n\nbody\n`);
  });
  return join(root, "neurons");
}

function writeReg(projects: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "nlg-reg-"));
  roots.push(dir);
  const p = join(dir, "projects.json");
  writeFileSync(p, JSON.stringify({ version: 1, projects }));
  return p;
}

// The real shipped registry (in-repo, present in CI). Used as a "good" registry.
const REAL_REG = resolve("config/projects.json");

describe("no-loss-gate — PASS with the shipped registry", () => {
  it("preserves the partition; only relabels (e.g. factory-os) appear; critical pass", () => {
    const neuronsDir = setupNeurons([{ project: "uv" }, { project: "ps" }, { project: "factory-os" }, { scope: "factory" }]);
    const r = runNoLossGate({ neuronsDir, registryPath: REAL_REG });
    expect(r.pass).toBe(true);
    expect(r.merges).toEqual([]);
    expect(r.splits).toEqual([]);
    expect(r.critical_failures).toEqual([]);
    expect(r.unexpected_relabels).toEqual([]);
    expect(r.unknown_regressions).toEqual([]);
    // factory-os is the expected, allowlisted relabel (factoryos → factory-os)
    expect(r.allowed_relabels.some((c) => c.token === "factory-os" && c.old === "factoryos" && c.new === "factory-os")).toBe(true);
  });
});

describe("no-loss-gate — detects MERGE (knowledge mixing) → FAIL", () => {
  it("flags a registry that maps two distinct seed projects into one", () => {
    const neuronsDir = setupNeurons([{ project: "uv" }, { project: "ps" }]);
    // 'uv' (seed→urbanvistacapital) and 'ps' (seed→peoplesynapse) both forced to 'merged'
    const reg = writeReg([{ project_id: "merged", status: "active", aliases: ["uv", "ps"] }]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    expect(r.pass).toBe(false);
    expect(r.merges.length).toBeGreaterThan(0);
    const m = r.merges.find((x) => x.new_canonical === "merged")!;
    expect(m.old_canonicals).toEqual(expect.arrayContaining(["urbanvistacapital", "peoplesynapse"]));
  });
});

describe("no-loss-gate — detects SPLIT (group fragmentation) → FAIL", () => {
  it("flags a registry that splits one seed group across two projects", () => {
    const neuronsDir = setupNeurons([{ project: "uv" }, { project: "urbanvista" }]);
    // seed groups uv + urbanvista → urbanvistacapital; registry splits them
    const reg = writeReg([
      { project_id: "p1", status: "active", aliases: ["uv"] },
      { project_id: "p2", status: "active", aliases: ["urbanvista"] },
    ]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    expect(r.pass).toBe(false);
    expect(r.splits.length).toBeGreaterThan(0);
    const s = r.splits.find((x) => x.old_canonical === "urbanvistacapital")!;
    expect(s.new_canonicals).toEqual(expect.arrayContaining(["p1", "p2"]));
  });
});

describe("no-loss-gate — critical-token protection → FAIL when a registry drops one", () => {
  it("fails when the registry lacks factory-os (seed fallback ≠ expected)", () => {
    const neuronsDir = setupNeurons([{ project: "factory-os" }]);
    const reg = writeReg([{ project_id: "jbcodingiot", status: "active", aliases: ["jbc"] }]); // no factory-os
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    expect(r.pass).toBe(false);
    expect(r.critical_failures.some((c) => c.token === "factory-os")).toBe(true);
  });
});

describe("no-loss-gate — unexpected relabel (resolved → different resolved) → FAIL", () => {
  it("flags a RESOLVED→RESOLVED relabel that is not in DEFAULT_ALLOWED_RELABELS", () => {
    // 'uv' is seed-resolved → urbanvistacapital; the registry remaps it to a DIFFERENT
    // resolved project. That is real knowledge displacement, not growth → FAIL.
    const neuronsDir = setupNeurons([{ project: "uv" }]);
    const reg = writeReg([
      { project_id: "otherproject", status: "active", aliases: ["uv"] },
      { project_id: "factory-os", status: "active" }, // keep critical factory-os passing
    ]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    expect(r.pass).toBe(false);
    expect(r.unexpected_relabels.some((c) => c.token === "uv" && c.old === "urbanvistacapital" && c.new === "otherproject")).toBe(true);
    expect(r.newly_resolved.some((c) => c.token === "uv")).toBe(false); // NOT growth
  });

  it("the same relabel PASSES when explicitly allowlisted (data, not code)", () => {
    const neuronsDir = setupNeurons([{ project: "alpha" }]);
    const reg = writeReg([{ project_id: "alphaproj", status: "active", aliases: ["alpha"] }]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg, allowedRelabels: [{ from: "alpha", to: "alphaproj" }] });
    expect(r.unexpected_relabels).toEqual([]);
    expect(r.allowed_relabels.some((c) => c.token === "alpha")).toBe(true); // allowlist beats newly_resolved
    // (still fails overall only on critical tokens this minimal registry lacks — assert the relabel part)
  });
});

describe("no-loss-gate — unknown regression (seed-less mode) → FAIL", () => {
  it("flags a token that resolved under seed but falls back to raw with --no-seed-fallback", () => {
    const neuronsDir = setupNeurons([{ project: "uv" }]); // seed: uv → urbanvistacapital (recognized)
    const reg = writeReg([{ project_id: "other", status: "active" }]); // registry does NOT cover uv
    const r = runNoLossGate({ neuronsDir, registryPath: reg, seedFallback: false });
    expect(r.seed_fallback).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.unknown_regressions.some((c) => c.token === "uv" && c.old === "urbanvistacapital" && c.new === "uv")).toBe(true);
  });

  it("with seed fallback ON, the same token does NOT regress (seed still resolves it)", () => {
    const neuronsDir = setupNeurons([{ project: "uv" }]);
    const reg = writeReg([{ project_id: "other", status: "active" }]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg, seedFallback: true });
    expect(r.unknown_regressions).toEqual([]); // seed fallback keeps uv → urbanvistacapital
  });
});

describe("no-loss-gate — growth-safe: raw → resolved is newly_resolved, not a failure (PR-B)", () => {
  // A registry that recognizes critical factory-os so only the new project under test
  // is the variable. Critical uv/ps/jbc still resolve via the seed fallback (default).
  const baseProjects = [{ project_id: "factory-os", status: "active" }];

  it("Cartones SA (1 alias): cartones → cartones-sa is newly_resolved and PASSes", () => {
    const neuronsDir = setupNeurons([{ project: "cartones" }]);
    const reg = writeReg([...baseProjects, { project_id: "cartones-sa", status: "active", aliases: ["cartones"] }]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    expect(r.pass).toBe(true);
    expect(r.newly_resolved.some((c) => c.token === "cartones" && c.old === "cartones" && c.new === "cartones-sa")).toBe(true);
    expect(r.unexpected_relabels).toEqual([]);
    expect(r.merges).toEqual([]);
  });

  it("Cartones SA (2 aliases): both raw tokens → one new project, both newly_resolved, NO merge, PASS", () => {
    const neuronsDir = setupNeurons([{ project: "cartones" }, { project: "cartonessa" }]);
    const reg = writeReg([...baseProjects, { project_id: "cartones-sa", status: "active", aliases: ["cartones", "cartonessa"] }]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    expect(r.pass).toBe(true);
    expect(r.merges).toEqual([]); // raw olds converging into a new project is NOT a merge
    expect(r.newly_resolved.map((c) => c.token).sort()).toEqual(["cartones", "cartonessa"]);
  });

  it("factoryos → factory-os stays an allowed_relabel (allowlist beats newly_resolved), PASS", () => {
    const neuronsDir = setupNeurons([{ project: "factory-os" }]);
    const reg = writeReg([{ project_id: "factory-os", status: "active" }]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    expect(r.pass).toBe(true);
    expect(r.allowed_relabels.some((c) => c.token === "factory-os" && c.old === "factoryos" && c.new === "factory-os")).toBe(true);
    expect(r.newly_resolved.some((c) => c.token === "factory-os")).toBe(false); // allowlist precedence
  });

  it("a real MERGE of two RESOLVED seed canonicals still FAILs (refinement does not weaken merge)", () => {
    const neuronsDir = setupNeurons([{ project: "uv" }, { project: "ps" }]);
    const reg = writeReg([{ project_id: "merged", status: "active", aliases: ["uv", "ps"] }]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    expect(r.pass).toBe(false);
    expect(r.merges.some((m) => m.new_canonical === "merged")).toBe(true);
  });

  it("a clean seed-covering registry produces NO newly_resolved (no spurious growth)", () => {
    const neuronsDir = setupNeurons([{ project: "uv" }, { project: "ps" }, { scope: "factory" }]);
    const reg = writeReg([
      { project_id: "urbanvistacapital", status: "active", aliases: ["uv"] },
      { project_id: "peoplesynapse", status: "active", aliases: ["ps"] },
      { project_id: "factory-os", status: "active" },
    ]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    expect(r.pass).toBe(true);
    expect(r.newly_resolved).toEqual([]);
  });
});

describe("no-loss-gate — baseline `old` is registry-INDEPENDENT (keeps its teeth)", () => {
  it("a registry remapping a seed alias surfaces as a relabel whose `old` is the SEED value", () => {
    // If `old` had become registry-aware (the PR-3C-e blocker), both old & new
    // would be 'somethingelse' and the gate would flag nothing. It must not.
    const neuronsDir = setupNeurons([{ project: "uv" }]);
    const reg = writeReg([{ project_id: "somethingelse", status: "active", aliases: ["uv"] }]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    const rel = r.unexpected_relabels.find((x) => x.token === "uv");
    expect(rel).toBeDefined();
    expect(rel!.old).toBe("urbanvistacapital"); // proves old = seed/legacy, not the registry
    expect(rel!.new).toBe("somethingelse");
    expect(r.pass).toBe(false);
  });

  it("the seed fallback in `new` uses the LEGACY resolver, not the live registry-aware one", () => {
    // Registry does not cover 'uv'; with seed fallback ON, `new` must resolve it
    // via the legacy seed (urbanvistacapital) — a registry-free path.
    const neuronsDir = setupNeurons([{ project: "uv" }]);
    const reg = writeReg([{ project_id: "other", status: "active" }]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg, seedFallback: true });
    expect(r.unknown_regressions).toEqual([]);
    expect(r.unexpected_relabels.find((x) => x.token === "uv")).toBeUndefined(); // old==new==seed
  });
});

describe("no-loss-gate — helpers", () => {
  it("collectCorpusTokens returns distinct non-empty project/scope tokens", () => {
    const neuronsDir = setupNeurons([{ project: "uv" }, { project: "uv", scope: "global" }, { scope: "" }, {}]);
    expect(collectCorpusTokens(neuronsDir).sort()).toEqual(["global", "uv"]);
  });

  it("CRITICAL_TOKENS includes the operator-protected set", () => {
    const toks = CRITICAL_TOKENS.map((c) => c.token);
    for (const t of ["uv", "ps", "jbcodingiotweb", "jbcodingiot-web", "factory", "sf", "factory-os"]) {
      expect(toks).toContain(t);
    }
  });

  it("the shipped registry path exists (sanity)", () => {
    expect(existsSync(REAL_REG)).toBe(true);
  });
});

describe("no-loss-gate — CLI emits run/trace metadata (subprocess on dist)", () => {
  const DIST = resolve("dist/no-loss-gate-cli.js");
  beforeAll(() => {
    if (!existsSync(DIST)) execSync("npm run build", { cwd: process.cwd(), stdio: "ignore" });
  }, 60000);

  it("JSON output carries tool_version / tool_git_sha / generated_at and still PASSes", () => {
    const neuronsDir = setupNeurons([{ project: "uv" }, { project: "ps" }, { scope: "factory" }]);
    const res = spawnSync("node", [DIST, "--neurons-dir", neuronsDir, "--registry", REAL_REG, "--format", "json"], { encoding: "utf8" });
    expect(res.status).toBe(0); // PASS
    const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(parsed.tool).toBe("no-loss-gate");
    expect(parsed.pass).toBe(true);
    expect(typeof parsed.tool_version).toBe("string");
    expect((parsed.tool_version as string).length).toBeGreaterThan(0);
    expect(typeof parsed.tool_git_sha).toBe("string");
    expect((parsed.tool_git_sha as string).length).toBeGreaterThan(0);
    expect(String(parsed.generated_at)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("Markdown output carries the run/trace metadata footer", () => {
    const neuronsDir = setupNeurons([{ project: "uv" }, { scope: "factory" }]);
    const res = spawnSync("node", [DIST, "--neurons-dir", neuronsDir, "--registry", REAL_REG, "--format", "md"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Generated by `no-loss-gate`/);
  });
});
