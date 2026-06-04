import { describe, it, expect, afterEach } from "vitest";
import { getProvider, resolveCachePath, PROVIDER_NAMES } from "../src/embedding-providers";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("getProvider — registry", () => {
  it("knows gemini/openai/local", () => {
    expect([...PROVIDER_NAMES].sort()).toEqual(["gemini", "local", "openai"]);
  });

  it("gemini default: model + dimensions", () => {
    const p = getProvider("gemini");
    expect(p.name).toBe("gemini");
    expect(p.model).toBe("gemini-embedding-001");
    expect(p.dimensions).toBe(3072);
  });

  it("openai default: model + dimensions", () => {
    const p = getProvider("openai");
    expect(p.name).toBe("openai");
    expect(p.model).toBe("text-embedding-3-small");
    expect(p.dimensions).toBe(1536);
  });

  it("rejects an unknown provider", () => {
    expect(() => getProvider("bogus")).toThrow(/unknown embedding provider/);
  });

  it("rejects a model with no known dimensions (never guesses)", () => {
    expect(() => getProvider("gemini", "some-other-model")).toThrow(/unknown model/);
    expect(() => getProvider("openai", "nope")).toThrow(/unknown model/);
  });
});

describe("hasCredentials — reads the right env, no leak", () => {
  it("gemini reflects GEMINI_API_KEY", () => {
    delete process.env.GEMINI_API_KEY;
    expect(getProvider("gemini").hasCredentials()).toBe(false);
    process.env.GEMINI_API_KEY = "x-test";
    expect(getProvider("gemini").hasCredentials()).toBe(true);
  });

  it("openai reflects OPENAI_API_KEY", () => {
    delete process.env.OPENAI_API_KEY;
    expect(getProvider("openai").hasCredentials()).toBe(false);
    process.env.OPENAI_API_KEY = "x-test";
    expect(getProvider("openai").hasCredentials()).toBe(true);
  });

  it("local has no credentials", () => {
    expect(getProvider("local").hasCredentials()).toBe(false);
  });
});

describe("stubs — embed() throws (not implemented)", () => {
  it("openai stub throws and never returns a vector", async () => {
    await expect(getProvider("openai").embed("hi")).rejects.toThrow(/not implemented/);
  });
  it("local stub throws", async () => {
    await expect(getProvider("local").embed("hi")).rejects.toThrow(/not implemented/);
  });
});

describe("resolveCachePath — separation prevents mixing", () => {
  const neuronsDir = "/tmp/whatever/neurons";
  it("gemini default → legacy .neuron-embeddings.json", () => {
    expect(resolveCachePath(getProvider("gemini"), neuronsDir)).toBe("/tmp/whatever/.neuron-embeddings.json");
  });
  it("openai → scoped file", () => {
    expect(resolveCachePath(getProvider("openai"), neuronsDir)).toBe(
      "/tmp/whatever/.neuron-embeddings.openai.text-embedding-3-small.json",
    );
  });
  it("local → scoped file (distinct from gemini and openai)", () => {
    const g = resolveCachePath(getProvider("gemini"), neuronsDir);
    const o = resolveCachePath(getProvider("openai"), neuronsDir);
    const l = resolveCachePath(getProvider("local"), neuronsDir);
    expect(new Set([g, o, l]).size).toBe(3); // all distinct → no shared file
  });
});
