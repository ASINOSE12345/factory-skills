import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadGeminiKey, resolveKeyFile } from "../src/gemini-key";

const dirs: string[] = [];
function tmpKeyfile(content: string, mode = 0o600): string {
  const d = mkdtempSync(join(tmpdir(), "gk-"));
  dirs.push(d);
  const f = join(d, "gemini.key");
  writeFileSync(f, content);
  chmodSync(f, mode);
  return f;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("resolveKeyFile", () => {
  it("honors FACTORY_GEMINI_KEY_FILE", () => {
    expect(resolveKeyFile({ FACTORY_GEMINI_KEY_FILE: "/x/y.key" } as NodeJS.ProcessEnv)).toBe("/x/y.key");
  });
  it("defaults to ~/.config/factory/gemini.key", () => {
    expect(resolveKeyFile({} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".config", "factory", "gemini.key"));
  });
});

describe("loadGeminiKey — secure, fail-soft, never leaks", () => {
  it("ok: a 0600 keyfile yields the TRIMMED key", () => {
    const f = tmpKeyfile("AIzaTESTKEY_value_123\n", 0o600);
    const r = loadGeminiKey(f);
    expect(r.ok).toBe(true);
    expect(r.key).toBe("AIzaTESTKEY_value_123"); // trailing newline stripped
  });

  it("false: missing file (does not throw)", () => {
    const r = loadGeminiKey("/no/such/keyfile.key");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
    expect(r.key).toBeUndefined();
  });

  it("false: group/other-accessible keyfile is REFUSED", () => {
    const f = tmpKeyfile("AIzaSECRET\n", 0o644);
    const r = loadGeminiKey(f);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/group\/other-accessible|chmod 600/);
    expect(r.key).toBeUndefined();
  });

  it("false: empty keyfile", () => {
    const f = tmpKeyfile("   \n", 0o600);
    const r = loadGeminiKey(f);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/empty/);
  });

  it("never puts the key in the reason string", () => {
    const f = tmpKeyfile("AIzaSUPERSECRETvalue\n", 0o644); // refused → reason returned
    const r = loadGeminiKey(f);
    expect(r.reason).not.toContain("AIzaSUPERSECRETvalue");
  });
});
