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

  it("contains exactly the expected entries (v2 ontology)", () => {
    const reg = loadRegistry(REG);
    const ids = [...reg.projectById.keys()].sort();
    expect(ids).toEqual(
      ["factory-os", "jbcodingiot", "jbcodingiot-org", "olguisclass", "paperclip", "peoplesynapse", "softwarefactory", "urbanvistacapital"].sort(),
    );
    // still excluded by operator decision
    expect(reg.projectById.has("paperclip-platform")).toBe(false);
    expect(reg.projectById.has("factory-knowledge")).toBe(false);
    expect(reg.projectById.has("peoplesynapse-v1")).toBe(false);
  });

  it("organization & source_lineage are present but NEVER resolvable projects (excluded from alias index)", () => {
    const reg = loadRegistry(REG);
    expect(reg.projectById.get("jbcodingiot-org")?.entity_type).toBe("organization");
    expect(reg.projectById.get("paperclip")?.entity_type).toBe("source_lineage");
    expect(reg.projectById.get("paperclip")?.status).toBe("legacy");
    // excluded from the alias index → a neuron can never resolve to them
    expect(reg.aliasToProject.get(normalizeToken("jbcodingiot-org"))).toBeUndefined();
    expect(reg.aliasToProject.get(normalizeToken("paperclip"))).toBeUndefined();
    // org id is normalize-distinct from the product token (no collision)
    expect(normalizeToken("jbcodingiot-org")).not.toBe(normalizeToken("jbcodingiot"));
    expect(reg.aliasToProject.get(normalizeToken("jbcodingiot"))).toBe("jbcodingiot");
  });

  it("v2 fields are populated additively on existing entries", () => {
    const reg = loadRegistry(REG);
    expect(reg.projectById.get("urbanvistacapital")?.entity_type).toBe("client");
    expect(reg.projectById.get("urbanvistacapital")?.reuse_scope).toBe("tenant_private");
    expect(reg.projectById.get("jbcodingiot")?.entity_type).toBe("project");
    expect(reg.projectById.get("jbcodingiot")?.lineage).toEqual(["paperclip"]);
    expect(reg.projectById.get("factory-os")?.entity_type).toBe("operating_system");
    expect(reg.projectById.get("softwarefactory")?.is_global).toBe(true);
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
