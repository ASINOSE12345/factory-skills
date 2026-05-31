import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listNeurons, searchNeuronsSync, resetProjectAliasCache } from "../src/neurons";

/**
 * Integration test over REAL markdown files on disk (no mocks): exercises
 * parseNeuron → listNeurons → searchNeuronsSync → filterByProject end-to-end.
 */

let dir: string;

function writeNeuron(root: string, category: string, name: string, frontmatter: string, firstLine: string, body: string): void {
  const d = join(root, category);
  mkdirSync(d, { recursive: true });
  const id = name.replace(".md", "");
  writeFileSync(join(d, name), `---\n${frontmatter}\n---\n\n# ${id}: ${firstLine}\n\n${body}\n`);
}

beforeAll(() => {
  // Deterministic: no external alias file, seed only.
  delete process.env.FACTORY_PROJECT_ALIASES_FILE;
  delete process.env.FACTORY_ROOT;
  resetProjectAliasCache();

  dir = mkdtempSync(join(tmpdir(), "neurons-"));
  writeNeuron(dir, "errors", "NE-900.md",
    "project: UrbanVistaCapital\ncreated: 2026-01-01\ndomain: auth",
    "Auth token refresh fails",
    "Authentication token refresh fails on session expiry.");
  writeNeuron(dir, "errors", "NE-901.md",
    "project: PeopleSynapse\ncreated: 2026-05-01\ndomain: interview",
    "Transcription drops sentence",
    "Interview session transcription drops the last sentence.");
  writeNeuron(dir, "patterns", "NP-900.md",
    "scope: cross-project\ncreated: 2026-03-01\ndomain: deployment",
    "Deploy edge functions safely",
    "Always deploy edge functions with --no-verify-jwt.");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listNeurons (real markdown files)", () => {
  it("parses all neurons with frontmatter", () => {
    const all = listNeurons(dir);
    expect(all).toHaveLength(3);
    const ne900 = all.find((n) => n.filename === "NE-900.md")!;
    expect(ne900.frontmatter.project).toBe("UrbanVistaCapital");
    // gray-matter parses an unquoted ISO date as a Date; the type now reflects that.
    const created = ne900.frontmatter.created;
    const createdIso = created instanceof Date ? created.toISOString() : String(created);
    expect(createdIso).toContain("2026-01-01");
    expect(ne900.category).toBe("errors");
  });
  it("lists by a single category", () => {
    expect(listNeurons(dir, "patterns")).toHaveLength(1);
  });
});

describe("searchNeuronsSync (real files, keyword-only)", () => {
  it("finds the relevant neuron by content keyword", () => {
    const res = searchNeuronsSync(dir, "authentication token");
    expect(res[0].filename).toBe("NE-900.md");
  });
  it("without a project filter, both project neurons match a shared keyword", () => {
    const ids = searchNeuronsSync(dir, "session", "errors").map((n) => n.filename);
    expect(ids).toContain("NE-900.md");
    expect(ids).toContain("NE-901.md");
  });
  it("a project filter scopes to the canonical project (uv → UrbanVistaCapital)", () => {
    const ids = searchNeuronsSync(dir, "session", "errors", "uv").map((n) => n.filename);
    expect(ids).toContain("NE-900.md");
    expect(ids).not.toContain("NE-901.md"); // PeopleSynapse excluded
  });
  it("a cross-project neuron is visible under any project filter", () => {
    const ids = searchNeuronsSync(dir, "deploy edge functions", "patterns", "peoplesynapse").map((n) => n.filename);
    expect(ids).toContain("NP-900.md");
  });
});
