import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Neuron } from "../src/neurons";
import {
  canonicalProject,
  canonicalProjectLegacy,
  isGlobalScope,
  isGlobalScopeLegacy,
  projectScopeOf,
  resetProjectAliasCache,
} from "../src/neurons";

function mkNeuron(fm: Record<string, unknown>): Neuron {
  return {
    filename: "NE-001.md",
    filepath: "/tmp/NE-001.md",
    category: "errors",
    frontmatter: fm,
    content: "x",
    title: "x",
    modified: new Date(),
  };
}

describe("canonicalProject", () => {
  beforeEach(() => {
    delete process.env.FACTORY_PROJECT_ALIASES_FILE;
    delete process.env.FACTORY_PROJECT_REGISTRY_FILE;
    delete process.env.FACTORY_ROOT;
    resetProjectAliasCache();
  });
  afterEach(() => {
    delete process.env.FACTORY_PROJECT_ALIASES_FILE;
    delete process.env.FACTORY_PROJECT_REGISTRY_FILE;
    resetProjectAliasCache();
  });

  it("resolves a seed alias to its canonical token", () => {
    expect(canonicalProject("uv")).toBe("urbanvistacapital");
    expect(canonicalProject("UrbanVista")).toBe("urbanvistacapital");
  });

  it("normalizes spaces / underscores / hyphens", () => {
    expect(canonicalProject("People_Synapse")).toBe("peoplesynapse");
    expect(canonicalProject("  PS  ")).toBe("peoplesynapse");
  });

  it("falls back to the normalized string for an unknown project", () => {
    expect(canonicalProject("BrandNewProject")).toBe("brandnewproject");
  });

  it("loads external aliases (extends the seed) without touching code", () => {
    const dir = mkdtempSync(join(tmpdir(), "aliases-"));
    const file = join(dir, "project-aliases.json");
    writeFileSync(file, JSON.stringify({ marsbase: ["mb", "mars", "marsbase"] }));
    process.env.FACTORY_PROJECT_ALIASES_FILE = file;
    resetProjectAliasCache();
    try {
      expect(canonicalProject("mb")).toBe("marsbase"); // from external file
      expect(canonicalProject("uv")).toBe("urbanvistacapital"); // seed still works
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to the seed when the external file is invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "aliases-"));
    const file = join(dir, "project-aliases.json");
    writeFileSync(file, "{ not valid json");
    process.env.FACTORY_PROJECT_ALIASES_FILE = file;
    resetProjectAliasCache();
    try {
      expect(canonicalProject("uv")).toBe("urbanvistacapital");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isGlobalScope", () => {
  it("treats global / factory / cross-project as global", () => {
    expect(isGlobalScope("global")).toBe(true);
    expect(isGlobalScope("factory")).toBe(true);
    expect(isGlobalScope("cross-project")).toBe(true);
  });
  it("a concrete project is not global", () => {
    expect(isGlobalScope("UrbanVistaCapital")).toBe(false);
  });
});

describe("projectScopeOf", () => {
  beforeEach(() => resetProjectAliasCache());
  it("returns global for a global scope", () => {
    expect(projectScopeOf(mkNeuron({ scope: "factory" }))).toBe("global");
  });
  it("returns the canonical project from the project field", () => {
    expect(projectScopeOf(mkNeuron({ project: "uv" }))).toBe("urbanvistacapital");
  });
  it("returns unknown when there is no project or scope", () => {
    expect(projectScopeOf(mkNeuron({}))).toBe("unknown");
  });
  it("a concrete project beats a generic scope:factory", () => {
    expect(projectScopeOf(mkNeuron({ project: "uv", scope: "factory" }))).toBe("urbanvistacapital");
  });
  it("an explicit cross-project scope wins over the project field", () => {
    expect(projectScopeOf(mkNeuron({ project: "uv", scope: "cross-project" }))).toBe("global");
  });
  it("an explicit global scope wins over the project field", () => {
    expect(projectScopeOf(mkNeuron({ project: "uv", scope: "global" }))).toBe("global");
  });
});

// ── PR-3C-e: registry-aware LIVE resolver vs registry-INDEPENDENT legacy ──────
describe("canonicalProject — registry wiring (live) vs legacy resolver", () => {
  function writeRegistry(projects: unknown[]): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, JSON.stringify({ version: 2, projects }));
    return { dir, file };
  }

  // factory-os exists only in the registry (its project_id normalizes to "factoryos"),
  // never in the seed → a clean probe for "did the registry get consulted?".
  const FIXTURE = [
    { project_id: "urbanvistacapital", status: "active", entity_type: "client", aliases: ["uv", "urbanvista"] },
    { project_id: "factory-os", status: "active", entity_type: "operating_system" },
    { project_id: "jbcodingiot", status: "active", entity_type: "project", aliases: ["jbcodingiotweb", "jbcodingiot-web"] },
    { project_id: "softwarefactory", status: "active", entity_type: "platform", is_global: true, aliases: ["sf", "factory"] },
    { project_id: "jbcodingiot-org", status: "active", entity_type: "organization" },
    { project_id: "paperclip", status: "legacy", entity_type: "source_lineage" },
  ];

  let tmp: { dir: string; file: string };
  beforeEach(() => {
    delete process.env.FACTORY_PROJECT_ALIASES_FILE;
    delete process.env.FACTORY_ROOT;
    tmp = writeRegistry(FIXTURE);
    process.env.FACTORY_PROJECT_REGISTRY_FILE = tmp.file;
    resetProjectAliasCache();
  });
  afterEach(() => {
    delete process.env.FACTORY_PROJECT_REGISTRY_FILE;
    delete process.env.FACTORY_PROJECT_ALIASES_FILE;
    resetProjectAliasCache();
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it("live canonicalProject uses the registry (factoryos → factory-os, absent from seed)", () => {
    expect(canonicalProject("factoryos")).toBe("factory-os");
    expect(canonicalProject("factory-os")).toBe("factory-os");
  });

  it("legacy canonicalProjectLegacy ignores the registry (factoryos stays raw)", () => {
    expect(canonicalProjectLegacy("factoryos")).toBe("factoryos");
    expect(canonicalProjectLegacy("uv")).toBe("urbanvistacapital"); // seed still resolves
  });

  it("legacy resolver is registry-INDEPENDENT even when the registry remaps a seed alias", () => {
    const remap = writeRegistry([{ project_id: "somethingelse", status: "active", aliases: ["uv"] }]);
    process.env.FACTORY_PROJECT_REGISTRY_FILE = remap.file;
    resetProjectAliasCache();
    try {
      expect(canonicalProject("uv")).toBe("somethingelse"); // live follows the registry
      expect(canonicalProjectLegacy("uv")).toBe("urbanvistacapital"); // legacy stays on seed
    } finally {
      rmSync(remap.dir, { recursive: true, force: true });
    }
  });

  it("organization / source_lineage never resolve as a project (raw fallback)", () => {
    expect(canonicalProject("paperclip")).toBe("paperclip"); // source_lineage excluded
    expect(canonicalProject("jbcodingiot-org")).toBe("jbcodingiotorg"); // organization excluded
    expect(canonicalProject("jbcodingiot")).toBe("jbcodingiot"); // distinct, real project
  });

  it("jbcodingiot-web folds into jbcodingiot via the registry", () => {
    expect(canonicalProject("jbcodingiot-web")).toBe("jbcodingiot");
    expect(canonicalProject("jbcodingiotweb")).toBe("jbcodingiot");
  });

  it("isGlobalScope and isGlobalScopeLegacy keep factory/sf/softwarefactory global", () => {
    for (const t of ["factory", "sf", "softwarefactory"]) {
      expect(isGlobalScope(t)).toBe(true);
      expect(isGlobalScopeLegacy(t)).toBe(true);
    }
    expect(isGlobalScope("uv")).toBe(false);
    expect(isGlobalScopeLegacy("uv")).toBe(false);
  });

  it("a missing registry file degrades to legacy without throwing", () => {
    process.env.FACTORY_PROJECT_REGISTRY_FILE = join(tmp.dir, "does-not-exist.json");
    resetProjectAliasCache();
    expect(() => canonicalProject("uv")).not.toThrow();
    expect(canonicalProject("uv")).toBe("urbanvistacapital"); // seed fallback
    expect(canonicalProject("factoryos")).toBe("factoryos"); // no registry → raw
  });

  it("an invalid registry file degrades to legacy without throwing", () => {
    const bad = join(tmp.dir, "bad.json");
    writeFileSync(bad, "{ not valid json");
    process.env.FACTORY_PROJECT_REGISTRY_FILE = bad;
    resetProjectAliasCache();
    expect(() => canonicalProject("uv")).not.toThrow();
    expect(canonicalProject("uv")).toBe("urbanvistacapital");
    expect(canonicalProject("factoryos")).toBe("factoryos");
  });

  it("resetProjectAliasCache clears caches so a swapped registry takes effect", () => {
    expect(canonicalProject("factoryos")).toBe("factory-os"); // primes the live cache
    const swap = writeRegistry([{ project_id: "fos2", status: "active", aliases: ["factoryos"] }]);
    process.env.FACTORY_PROJECT_REGISTRY_FILE = swap.file;
    expect(canonicalProject("factoryos")).toBe("factory-os"); // stale cache, no reset yet
    resetProjectAliasCache();
    try {
      expect(canonicalProject("factoryos")).toBe("fos2"); // reset → new registry honored
    } finally {
      rmSync(swap.dir, { recursive: true, force: true });
    }
  });

  it("external aliases file still works alongside the registry", () => {
    const adir = mkdtempSync(join(tmpdir(), "aliases-"));
    const afile = join(adir, "project-aliases.json");
    writeFileSync(afile, JSON.stringify({ marsbase: ["mb"] }));
    process.env.FACTORY_PROJECT_ALIASES_FILE = afile;
    resetProjectAliasCache();
    try {
      expect(canonicalProject("mb")).toBe("marsbase"); // external file
      expect(canonicalProject("factoryos")).toBe("factory-os"); // registry
      expect(canonicalProject("uv")).toBe("urbanvistacapital"); // registry/seed
    } finally {
      delete process.env.FACTORY_PROJECT_ALIASES_FILE;
      rmSync(adir, { recursive: true, force: true });
    }
  });
});
