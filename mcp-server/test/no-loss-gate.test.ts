import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

describe("no-loss-gate — unexpected relabel (not on allowlist) → FAIL", () => {
  it("flags a relabel that is not in DEFAULT_ALLOWED_RELABELS", () => {
    const neuronsDir = setupNeurons([{ project: "alpha" }]); // seed: 'alpha' is self → unrecognized
    const reg = writeReg([{ project_id: "alphaproj", status: "active", aliases: ["alpha"] }]); // alpha → alphaproj
    const r = runNoLossGate({ neuronsDir, registryPath: reg });
    expect(r.pass).toBe(false);
    expect(r.unexpected_relabels.some((c) => c.token === "alpha" && c.new === "alphaproj")).toBe(true);
  });

  it("the same relabel PASSES when explicitly allowlisted (data, not code)", () => {
    const neuronsDir = setupNeurons([{ project: "alpha" }]);
    const reg = writeReg([{ project_id: "alphaproj", status: "active", aliases: ["alpha"] }]);
    const r = runNoLossGate({ neuronsDir, registryPath: reg, allowedRelabels: [{ from: "alpha", to: "alphaproj" }] });
    expect(r.unexpected_relabels).toEqual([]);
    expect(r.allowed_relabels.some((c) => c.token === "alpha")).toBe(true);
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
