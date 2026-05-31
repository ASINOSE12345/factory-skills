import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Neuron } from "../src/neurons";
import {
  canonicalProject,
  isGlobalScope,
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
    delete process.env.FACTORY_ROOT;
    resetProjectAliasCache();
  });
  afterEach(() => {
    delete process.env.FACTORY_PROJECT_ALIASES_FILE;
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
