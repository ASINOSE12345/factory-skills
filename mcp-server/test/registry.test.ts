import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, validateRegistry, normalizeToken } from "../src/registry";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function writeRegistry(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  roots.push(dir);
  const p = join(dir, "projects.json");
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
}

const VALID = {
  version: 1,
  projects: [
    { project_id: "urbanvistacapital", status: "active", aliases: ["uv", "urbanvista"], repos: [{ repo_id: "UrbanVistaCapital-portal-inmobiliario", role: "app" }] },
    { project_id: "peoplesynapse-v1", status: "archived", aliases: ["ps-v1"], repos: [{ repo_id: "PeopleSynapse-v1", status: "archived" }] },
    { project_id: "softwarefactory", status: "active", is_global: true, aliases: ["sf", "factory"], repos: [{ repo_id: "factory-skills", role: "platform" }] },
  ],
};

describe("registry — loadRegistry (valid)", () => {
  it("indexes projects, aliases and repos", () => {
    const reg = loadRegistry(writeRegistry(VALID));
    expect(reg.projectById.has("urbanvistacapital")).toBe(true);
    // alias + canonical resolve to the project_id
    expect(reg.aliasToProject.get(normalizeToken("uv"))).toBe("urbanvistacapital");
    expect(reg.aliasToProject.get(normalizeToken("urbanvistacapital"))).toBe("urbanvistacapital");
    // repo bound by normalized dir name
    const b = reg.repoToProject.get(normalizeToken("UrbanVistaCapital-portal-inmobiliario"));
    expect(b?.project_id).toBe("urbanvistacapital");
  });

  it("a repo inherits the project status unless it declares its own", () => {
    const reg = loadRegistry(writeRegistry(VALID));
    expect(reg.repoToProject.get(normalizeToken("UrbanVistaCapital-portal-inmobiliario"))?.repo_status).toBe("active");
    expect(reg.repoToProject.get(normalizeToken("PeopleSynapse-v1"))?.repo_status).toBe("archived");
  });

  it("no collisions on a clean registry", () => {
    const reg = loadRegistry(writeRegistry(VALID));
    expect(reg.aliasCollisions).toEqual([]);
    expect(reg.repoCollisions).toEqual([]);
  });
});

describe("registry — structural validation (throws, no silent fallback)", () => {
  it("throws on a duplicate project_id", () => {
    expect(() => loadRegistry(writeRegistry({ version: 1, projects: [{ project_id: "a", status: "active" }, { project_id: "a", status: "active" }] }))).toThrow(/duplicate project_id/);
  });
  it("throws on an invalid status", () => {
    expect(() => loadRegistry(writeRegistry({ version: 1, projects: [{ project_id: "a", status: "live" }] }))).toThrow(/status must be one of/);
  });
  it("throws on a missing project_id", () => {
    expect(() => loadRegistry(writeRegistry({ version: 1, projects: [{ status: "active" }] }))).toThrow(/project_id must be a non-empty string/);
  });
  it("throws when projects is not an array", () => {
    expect(() => loadRegistry(writeRegistry({ version: 1, projects: {} }))).toThrow(/`projects` must be an array/);
  });
  it("throws when version is missing", () => {
    expect(() => loadRegistry(writeRegistry({ projects: [] }))).toThrow(/`version` must be a number/);
  });
  it("throws on an invalid repo status", () => {
    expect(() => loadRegistry(writeRegistry({ version: 1, projects: [{ project_id: "a", status: "active", repos: [{ repo_id: "r", status: "nope" }] }] }))).toThrow(/repos\[0\].*status must be one of/);
  });
  it("throws on invalid JSON", () => {
    expect(() => loadRegistry(writeRegistry("{ not json"))).toThrow(/not valid JSON/);
  });
  it("throws on a missing file", () => {
    expect(() => loadRegistry("/no/such/registry-xyz.json")).toThrow(/file not found/);
  });
});

describe("registry — semantic collisions (recorded, not thrown)", () => {
  it("records an alias claimed by two projects", () => {
    const reg = loadRegistry(writeRegistry({
      version: 1,
      projects: [
        { project_id: "alpha", status: "active", aliases: ["shared"] },
        { project_id: "beta", status: "active", aliases: ["shared"] },
      ],
    }));
    const c = reg.aliasCollisions.find((x) => x.alias === normalizeToken("shared"));
    expect(c?.project_ids).toEqual(["alpha", "beta"]);
  });

  it("records a repo claimed by two projects", () => {
    const reg = loadRegistry(writeRegistry({
      version: 1,
      projects: [
        { project_id: "alpha", status: "active", repos: [{ repo_id: "dup" }] },
        { project_id: "beta", status: "active", repos: [{ repo_id: "dup" }] },
      ],
    }));
    const c = reg.repoCollisions.find((x) => x.repo_id === normalizeToken("dup"));
    expect(c?.project_ids).toEqual(["alpha", "beta"]);
  });
});

describe("registry — validateRegistry returns the typed object", () => {
  it("returns the registry for valid input", () => {
    const out = validateRegistry(VALID);
    expect(out.version).toBe(1);
    expect(out.projects.length).toBe(3);
  });
});
