import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEmbeddings } from "../src/embeddings-cli";

const NOW = () => "2026-06-04T12:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z"; // entry newer than file mtime → fresh
const LONG_PAST = "2000-01-01T00:00:00.000Z"; // entry older than file mtime → stale

const roots: string[] = [];

interface FileSpec { cat: string; name: string; body?: string }

function setup(files: FileSpec[], index: Record<string, { vector: number[]; updated: string }> | "corrupt" | "none" = {}) {
  const root = mkdtempSync(join(tmpdir(), "emb-cli-"));
  roots.push(root);
  const neuronsDir = join(root, "neurons");
  for (const f of files) {
    const d = join(neuronsDir, f.cat);
    mkdirSync(d, { recursive: true });
    const id = f.name.replace(/\.md$/, "");
    writeFileSync(join(d, f.name), `---\ntype: x\ncreated: '2026-06-04'\n---\n\n# ${id}: ${f.body ?? "body"}\n\n${f.body ?? "body"}\n`);
  }
  const cachePath = join(root, ".neuron-embeddings.json");
  if (index === "corrupt") writeFileSync(cachePath, "{ not valid json");
  else if (index === "none") { /* no index file */ }
  else writeFileSync(cachePath, JSON.stringify({ model: "gemini-embedding-001", dimensions: 3, entries: index }));
  return { root, neuronsDir, cachePath };
}

function entriesOf(cachePath: string): string[] {
  if (!existsSync(cachePath)) return [];
  return Object.keys(JSON.parse(readFileSync(cachePath, "utf-8")).entries);
}

const THREE: FileSpec[] = [
  { cat: "patterns", name: "NP-059.md" },
  { cat: "errors", name: "NE-618.md" },
  { cat: "errors", name: "NE-619.md" },
];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("embeddings-cli — dry-run / audit (no API, no write)", () => {
  it("detects NP-059/NE-618/NE-619 as missing and embeds NOTHING", async () => {
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir, cachePath } = setup(
      [...THREE, { cat: "errors", name: "NE-001.md" }],
      { "NE-001.md": { vector: [0.1, 0.2, 0.3], updated: FAR_FUTURE } },
    );
    const r = await runEmbeddings(
      { neuronsDir, dryRun: true, forceFull: false, forceRebuild: false },
      { embedFn, hasApiKey: () => true, now: NOW },
    );
    expect(r.exitCode).toBe(0);
    expect(r.mode).toBe("dry-run");
    expect(r.targets.sort()).toEqual(["NE-618.md", "NE-619.md", "NP-059.md"]);
    expect(r.missing).toContain("NP-059.md");
    expect(embedFn).toHaveBeenCalledTimes(0); // no API in dry-run
    expect(entriesOf(cachePath).sort()).toEqual(["NE-001.md"]); // index unchanged
  });

  it("--ids limits the target set to exactly those ids", async () => {
    const embedFn = vi.fn(async () => [0.1]);
    const { neuronsDir } = setup(THREE, {});
    const r = await runEmbeddings(
      { neuronsDir, ids: ["NP-059"], dryRun: true, forceFull: false, forceRebuild: false },
      { embedFn, hasApiKey: () => true, now: NOW },
    );
    expect(r.targets).toEqual(["NP-059.md"]);
    expect(embedFn).toHaveBeenCalledTimes(0);
  });
});

describe("embeddings-cli — NO SILENT FALLBACK (deterministic key gate)", () => {
  it("no key + NOT dry-run => exit 1, no API, no write", async () => {
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir, cachePath } = setup(THREE, {});
    const r = await runEmbeddings(
      { neuronsDir, dryRun: false, forceFull: false, forceRebuild: false },
      { embedFn, hasApiKey: () => false, now: NOW },
    );
    expect(r.exitCode).toBe(1);
    expect(r.mode).toBe("error");
    expect(r.reason).toMatch(/GEMINI_API_KEY/);
    expect(embedFn).toHaveBeenCalledTimes(0);
    expect(r.wrote).toBe(false);
    expect(entriesOf(cachePath)).toEqual([]); // nothing written
  });

  it("no key + dry-run => exit 0, no API, no write", async () => {
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir, cachePath } = setup(THREE, {});
    const r = await runEmbeddings(
      { neuronsDir, dryRun: true, forceFull: false, forceRebuild: false },
      { embedFn, hasApiKey: () => false, now: NOW },
    );
    expect(r.exitCode).toBe(0);
    expect(r.mode).toBe("dry-run");
    expect(embedFn).toHaveBeenCalledTimes(0);
    expect(entriesOf(cachePath)).toEqual([]);
  });

  it("key + NOT dry-run => writes the mocked embeddings", async () => {
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir, cachePath } = setup(THREE, {});
    const r = await runEmbeddings(
      { neuronsDir, dryRun: false, forceFull: false, forceRebuild: false },
      { embedFn, hasApiKey: () => true, now: NOW },
    );
    expect(r.exitCode).toBe(0);
    expect(r.mode).toBe("write");
    expect(r.wrote).toBe(true);
    expect(embedFn).toHaveBeenCalledTimes(3);
    expect(entriesOf(cachePath).sort()).toEqual(["NE-618.md", "NE-619.md", "NP-059.md"]);
  });
});

describe("embeddings-cli — safe writer (backup, atomic, corrupt-abort, md-stable)", () => {
  it("aborts on a corrupt index WITHOUT overwriting it (no --force-rebuild)", async () => {
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir, cachePath } = setup(THREE, "corrupt");
    const r = await runEmbeddings(
      { neuronsDir, dryRun: false, forceFull: false, forceRebuild: false },
      { embedFn, hasApiKey: () => true, now: NOW },
    );
    expect(r.exitCode).toBe(1);
    expect(r.reason).toMatch(/corrupt|force-rebuild/);
    expect(embedFn).toHaveBeenCalledTimes(0);
    expect(readFileSync(cachePath, "utf-8")).toBe("{ not valid json"); // untouched
    expect(existsSync(`${cachePath}.bak`)).toBe(false);
  });

  it("backs up before writing, writes atomically (no temp leftover), keeps markdown stable", async () => {
    const embedFn = vi.fn(async () => [0.9, 0.8, 0.7]);
    const original = { "NE-001.md": { vector: [0.1, 0.2, 0.3], updated: FAR_FUTURE } };
    const { root, neuronsDir, cachePath } = setup([...THREE, { cat: "errors", name: "NE-001.md" }], original);
    const originalRaw = readFileSync(cachePath, "utf-8");

    const r = await runEmbeddings(
      { neuronsDir, dryRun: false, forceFull: false, forceRebuild: false },
      { embedFn, hasApiKey: () => true, now: NOW },
    );

    expect(r.exitCode).toBe(0);
    expect(r.wrote).toBe(true);
    expect(r.backupPath).toBe(`${cachePath}.bak`);
    expect(readFileSync(`${cachePath}.bak`, "utf-8")).toBe(originalRaw); // backup == pre-write
    expect(entriesOf(cachePath).sort()).toEqual(["NE-001.md", "NE-618.md", "NE-619.md", "NP-059.md"]);
    expect(readdirSync(root).filter((f) => f.includes(".tmp."))).toHaveLength(0); // no temp leftover
    expect(r.mdHashStable).toBe(true); // markdown corpus untouched
  });

  it("force-full embeds every neuron", async () => {
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir } = setup(THREE, { "NP-059.md": { vector: [0.1, 0.2, 0.3], updated: FAR_FUTURE } });
    const r = await runEmbeddings(
      { neuronsDir, dryRun: false, forceFull: true, forceRebuild: false },
      { embedFn, hasApiKey: () => true, now: NOW },
    );
    expect(r.exitCode).toBe(0);
    expect(embedFn).toHaveBeenCalledTimes(3); // all three, despite NP-059 already fresh
  });
});

describe("embeddings-cli — failure handling & no leakage", () => {
  it("if ANY embed fails, nothing is written and the index stays intact", async () => {
    const embedFn = vi.fn(async () => null); // simulate API failure
    const original = { "NE-001.md": { vector: [0.1, 0.2, 0.3], updated: FAR_FUTURE } };
    const { root, neuronsDir, cachePath } = setup([...THREE, { cat: "errors", name: "NE-001.md" }], original);
    const originalRaw = readFileSync(cachePath, "utf-8");

    const r = await runEmbeddings(
      { neuronsDir, dryRun: false, forceFull: false, forceRebuild: false },
      { embedFn, hasApiKey: () => true, now: NOW },
    );

    expect(r.exitCode).toBe(1);
    expect(r.failed.length).toBeGreaterThan(0);
    expect(r.wrote).toBe(false);
    expect(readFileSync(cachePath, "utf-8")).toBe(originalRaw); // untouched
    expect(existsSync(`${cachePath}.bak`)).toBe(false); // no backup created on failure
    expect(readdirSync(root).filter((f) => f.includes(".tmp."))).toHaveLength(0);
  });

  it("never logs neuron content, vectors, or anything beyond ids/counts", async () => {
    const embedFn = vi.fn(async () => [0.123456, 0.654321, 0.111111]);
    const lines: string[] = [];
    const { neuronsDir } = setup([{ cat: "patterns", name: "NP-059.md", body: "ZZSENTINELBODY_secret_text" }], {});
    await runEmbeddings(
      { neuronsDir, dryRun: false, forceFull: false, forceRebuild: false },
      { embedFn, hasApiKey: () => true, now: NOW, log: (l) => lines.push(l) },
    );
    const blob = lines.join("\n");
    expect(blob).not.toContain("ZZSENTINELBODY"); // no neuron body
    expect(blob).not.toContain("0.123456"); // no vector values
    expect(blob).not.toMatch(/\[\s*0\.\d/); // no vector arrays
  });

  it("rejects --ids with no corpus match (deterministic error)", async () => {
    const embedFn = vi.fn(async () => [0.1]);
    const { neuronsDir } = setup(THREE, {});
    const r = await runEmbeddings(
      { neuronsDir, ids: ["NP-999"], dryRun: true, forceFull: false, forceRebuild: false },
      { embedFn, hasApiKey: () => true, now: NOW },
    );
    expect(r.exitCode).toBe(1);
    expect(r.reason).toMatch(/none of the given --ids/);
  });
});
