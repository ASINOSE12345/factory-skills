import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  liveWritesAllowed,
  liveWriteBlocked,
  isLiveWriteBlocked,
  guardedCreateNeuron,
  guardedUpdatePatternCounter,
  LIVE_WRITE_DISABLED,
} from "../src/write-guard";

const savedEnv = { ...process.env };
const roots: string[] = [];

afterEach(() => {
  process.env = { ...savedEnv };
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmpNeurons(): string {
  const root = mkdtempSync(join(tmpdir(), "gw-"));
  roots.push(root);
  return join(root, "neurons");
}

function countMd(dir: string): number {
  if (!existsSync(dir)) return 0;
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => String(f).endsWith(".md")).length;
}

describe("liveWritesAllowed — explicit opt-in only", () => {
  it("is false unless FACTORY_ALLOW_LIVE_WRITES === 'true'", () => {
    delete process.env.FACTORY_ALLOW_LIVE_WRITES;
    expect(liveWritesAllowed()).toBe(false);
    process.env.FACTORY_ALLOW_LIVE_WRITES = "1";
    expect(liveWritesAllowed()).toBe(false); // only the literal "true"
    process.env.FACTORY_ALLOW_LIVE_WRITES = "TRUE";
    expect(liveWritesAllowed()).toBe(false);
    process.env.FACTORY_ALLOW_LIVE_WRITES = "true";
    expect(liveWritesAllowed()).toBe(true);
  });
});

describe("liveWriteBlocked / isLiveWriteBlocked", () => {
  it("returns the LIVE_WRITE_DISABLED payload with a hint", () => {
    const b = liveWriteBlocked("create_neuron");
    expect(b.error).toBe(true);
    expect(b.code).toBe(LIVE_WRITE_DISABLED);
    expect(b.hint).toMatch(/FACTORY_ALLOW_LIVE_WRITES=true/);
    expect(isLiveWriteBlocked(b)).toBe(true);
  });
  it("does not misclassify a normal object", () => {
    expect(isLiveWriteBlocked({ created: true })).toBe(false);
    expect(isLiveWriteBlocked(null)).toBe(false);
  });
});

describe("guardedCreateNeuron", () => {
  it("BLOCKS and writes nothing when live writes are disabled", () => {
    delete process.env.FACTORY_ALLOW_LIVE_WRITES;
    const neuronsDir = tmpNeurons();
    const res = guardedCreateNeuron(neuronsDir, "errors", "test title", "body");
    expect(isLiveWriteBlocked(res)).toBe(true);
    expect(countMd(neuronsDir)).toBe(0); // nothing written to the corpus
  });

  it("performs the legacy write when explicitly enabled (tmpdir)", () => {
    process.env.FACTORY_ALLOW_LIVE_WRITES = "true";
    const neuronsDir = tmpNeurons();
    const res = guardedCreateNeuron(neuronsDir, "errors", "test title", "body");
    expect(isLiveWriteBlocked(res)).toBe(false);
    expect(countMd(neuronsDir)).toBe(1);
    if (!isLiveWriteBlocked(res)) {
      expect(res.filename).toMatch(/^NE-\d+\.md$/);
      expect(existsSync(res.filepath)).toBe(true);
    }
  });
});

describe("guardedUpdatePatternCounter", () => {
  function withPattern(): { neuronsDir: string; file: string } {
    const neuronsDir = tmpNeurons();
    const dir = join(neuronsDir, "patterns");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "NP-001.md");
    writeFileSync(file, `---\ntype: pattern-memory\nstatus: new\nhits: 0\nmisses: 0\nsessions_seen: 0\nlast_hit: null\n---\n\n# NP-001: test\n\nbody\n`);
    return { neuronsDir, file };
  }

  it("BLOCKS and leaves the pattern unchanged when disabled", () => {
    delete process.env.FACTORY_ALLOW_LIVE_WRITES;
    const { neuronsDir, file } = withPattern();
    const before = readFileSync(file, "utf-8");
    const res = guardedUpdatePatternCounter(neuronsDir, "NP-001", "hit");
    expect(isLiveWriteBlocked(res)).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe(before); // untouched
  });

  it("performs the legacy counter update when enabled", () => {
    process.env.FACTORY_ALLOW_LIVE_WRITES = "true";
    const { neuronsDir, file } = withPattern();
    const res = guardedUpdatePatternCounter(neuronsDir, "NP-001", "hit");
    expect(isLiveWriteBlocked(res)).toBe(false);
    if (!isLiveWriteBlocked(res)) {
      expect(res.success).toBe(true);
      expect(res.hits).toBe(1);
    }
    expect(readFileSync(file, "utf-8")).toMatch(/hits: 1/);
  });
});
