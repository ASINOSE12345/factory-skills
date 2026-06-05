import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadRegistry, normalizeToken } from "../src/registry";

// Locks the SHIPPED registry (config/projects.json) against the loader contract
// and the PR-3C checkpoint decisions. Runs from the mcp-server cwd (vitest).
const REG = resolve("config/projects.json");

describe("config/projects.json — shipped registry is valid", () => {
  it("loads without throwing and has no alias/repo collisions", () => {
    expect(existsSync(REG)).toBe(true);
    const reg = loadRegistry(REG);
    expect(reg.aliasCollisions).toEqual([]);
    expect(reg.repoCollisions).toEqual([]);
    expect(reg.raw.version).toBe(1);
  });

  it("contains exactly the expected project_ids (checkpoint decisions)", () => {
    const reg = loadRegistry(REG);
    const ids = [...reg.projectById.keys()].sort();
    expect(ids).toEqual(
      ["factory-os", "jbcodingiot", "olguisclass", "peoplesynapse", "softwarefactory", "urbanvistacapital"].sort(),
    );
    // explicitly excluded by operator decision
    expect(reg.projectById.has("paperclip")).toBe(false);
    expect(reg.projectById.has("paperclip-platform")).toBe(false);
    expect(reg.projectById.has("factory-knowledge")).toBe(false);
    expect(reg.projectById.has("peoplesynapse-v1")).toBe(false);
  });

  it("jbcodingiot carries the web aliases (so the seed can be removed in PR-3C)", () => {
    const reg = loadRegistry(REG);
    expect(reg.aliasToProject.get(normalizeToken("jbcodingiotweb"))).toBe("jbcodingiot");
    expect(reg.aliasToProject.get(normalizeToken("jbcodingiot-web"))).toBe("jbcodingiot");
    expect(reg.aliasToProject.get(normalizeToken("jbc"))).toBe("jbcodingiot");
  });

  it("PeopleSynapse-v1 is folded under peoplesynapse as an archived repo", () => {
    const reg = loadRegistry(REG);
    const b = reg.repoToProject.get(normalizeToken("PeopleSynapse-v1"));
    expect(b?.project_id).toBe("peoplesynapse");
    expect(b?.repo_status).toBe("archived");
  });

  it("nested jbcodingiot_WEB_NEW is NOT in the registry (it is an anomaly)", () => {
    const reg = loadRegistry(REG);
    expect(reg.repoToProject.has(normalizeToken("jbcodingiot_WEB_NEW"))).toBe(false);
    expect(reg.repoToProject.has(normalizeToken("WEB JB Coding IOT (1)"))).toBe(false);
  });
});
