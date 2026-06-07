import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toolMetadata, toolMetadataMarkdown } from "../src/tool-metadata";

describe("toolMetadata", () => {
  it("reports the package version", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as { version: string };
    expect(toolMetadata().tool_version).toBe(pkg.version);
  });

  it("uses the injected timestamp as an ISO-8601 string", () => {
    const now = new Date("2026-06-06T12:34:56.000Z");
    expect(toolMetadata(now).generated_at).toBe("2026-06-06T12:34:56.000Z");
  });

  it("tool_git_sha is always a non-empty string (a sha or 'unknown')", () => {
    const sha = toolMetadata().tool_git_sha;
    expect(typeof sha).toBe("string");
    expect(sha.length).toBeGreaterThan(0);
  });

  it("never throws", () => {
    expect(() => toolMetadata()).not.toThrow();
  });

  it("markdown footer carries tool name, version, sha and timestamp", () => {
    const md = toolMetadataMarkdown("no-loss-gate", {
      tool_version: "0.1.0",
      tool_git_sha: "abc123def456",
      generated_at: "2026-06-06T12:34:56.000Z",
    });
    expect(md).toContain("no-loss-gate");
    expect(md).toContain("0.1.0");
    expect(md).toContain("abc123def456");
    expect(md).toContain("2026-06-06T12:34:56.000Z");
  });
});
