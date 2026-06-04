import { describe, it, expect, afterEach, vi } from "vitest";
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
import type { EmbeddingProvider } from "../src/embedding-providers";

const NOW = () => "2026-06-04T12:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z"; // entry newer than file mtime → fresh

const roots: string[] = [];

interface FileSpec { cat: string; name: string; body?: string }

// Mock gemini provider, dims 3 (so 3-element test vectors are valid). Resolves to
// the legacy cache filename. Tests inject `embed` as a vi.fn when they spy.
function mkProvider(over: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    name: "gemini",
    model: "gemini-embedding-001",
    dimensions: 3,
    hasCredentials: () => true,
    embed: async () => [0.1, 0.2, 0.3],
    ...over,
  };
}

function setup(
  files: FileSpec[],
  index: Record<string, { vector: number[]; updated: string }> | "corrupt" | "none" = {},
  model = "gemini-embedding-001",
  dims = 3,
) {
  const root = mkdtempSync(join(tmpdir(), "emb-cli-"));
  roots.push(root);
  const neuronsDir = join(root, "neurons");
  for (const f of files) {
    const d = join(neuronsDir, f.cat);
    mkdirSync(d, { recursive: true });
    const id = f.name.replace(/\.md$/, "");
    writeFileSync(join(d, f.name), `---\ntype: x\ncreated: '2026-06-04'\n---\n\n# ${id}: ${f.body ?? "body"}\n\n${f.body ?? "body"}\n`);
  }
  const legacy = join(root, ".neuron-embeddings.json");
  if (index === "corrupt") writeFileSync(legacy, "{ not valid json");
  else if (index === "none") { /* no index file */ }
  else writeFileSync(legacy, JSON.stringify({ model, dimensions: dims, entries: index }));
  return { root, neuronsDir, legacy };
}

function entriesOf(p: string): string[] {
  if (!existsSync(p)) return [];
  return Object.keys(JSON.parse(readFileSync(p, "utf-8")).entries);
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
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir, legacy } = setup([...THREE, { cat: "errors", name: "NE-001.md" }], { "NE-001.md": { vector: [0.1, 0.2, 0.3], updated: FAR_FUTURE } });
    const r = await runEmbeddings({ neuronsDir, dryRun: true, forceFull: false, forceRebuild: false }, { provider: mkProvider({ embed }), now: NOW });
    expect(r.exitCode).toBe(0);
    expect(r.mode).toBe("dry-run");
    expect(r.targets.sort()).toEqual(["NE-618.md", "NE-619.md", "NP-059.md"]);
    expect(embed).toHaveBeenCalledTimes(0);
    expect(entriesOf(legacy).sort()).toEqual(["NE-001.md"]); // unchanged
  });

  it("--ids limits the target set to exactly those ids", async () => {
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir } = setup(THREE);
    const r = await runEmbeddings({ neuronsDir, ids: ["NP-059"], dryRun: true, forceFull: false, forceRebuild: false }, { provider: mkProvider({ embed }), now: NOW });
    expect(r.targets).toEqual(["NP-059.md"]);
    expect(embed).toHaveBeenCalledTimes(0);
  });
});

describe("embeddings-cli — NO SILENT FALLBACK (credential gate)", () => {
  it("no creds + NOT dry-run => exit 1, no embed, no write", async () => {
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir, legacy } = setup(THREE);
    const r = await runEmbeddings({ neuronsDir, dryRun: false, forceFull: false, forceRebuild: false }, { provider: mkProvider({ embed, hasCredentials: () => false }), now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.reason).toMatch(/no credentials/);
    expect(embed).toHaveBeenCalledTimes(0);
    expect(entriesOf(legacy)).toEqual([]);
  });

  it("no creds + dry-run => exit 0, no embed, no write", async () => {
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir, legacy } = setup(THREE);
    const r = await runEmbeddings({ neuronsDir, dryRun: true, forceFull: false, forceRebuild: false }, { provider: mkProvider({ embed, hasCredentials: () => false }), now: NOW });
    expect(r.exitCode).toBe(0);
    expect(embed).toHaveBeenCalledTimes(0);
    expect(entriesOf(legacy)).toEqual([]);
  });

  it("creds + NOT dry-run => writes the mocked embeddings", async () => {
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir, legacy } = setup(THREE);
    const r = await runEmbeddings({ neuronsDir, dryRun: false, forceFull: false, forceRebuild: false }, { provider: mkProvider({ embed }), now: NOW });
    expect(r.exitCode).toBe(0);
    expect(r.mode).toBe("write");
    expect(embed).toHaveBeenCalledTimes(3);
    expect(entriesOf(legacy).sort()).toEqual(["NE-618.md", "NE-619.md", "NP-059.md"]);
  });
});

describe("embeddings-cli — provider cache separation (no mixing)", () => {
  it("gemini default writes to the LEGACY .neuron-embeddings.json", async () => {
    const { neuronsDir, root, legacy } = setup(THREE, "none");
    const r = await runEmbeddings({ neuronsDir, provider: "gemini", dryRun: false, forceFull: false, forceRebuild: false }, { provider: mkProvider(), now: NOW });
    expect(r.exitCode).toBe(0);
    expect(r.cachePath).toBe(legacy);
    expect(existsSync(legacy)).toBe(true);
    expect(readdirSync(root).some((f) => f.startsWith(".neuron-embeddings.gemini."))).toBe(false);
  });

  it("a non-gemini provider writes a SCOPED file and leaves the legacy index untouched", async () => {
    const { neuronsDir, root, legacy } = setup(THREE, "none");
    const openai = mkProvider({ name: "openai", model: "text-embedding-3-small", dimensions: 3, embed: async () => [0.5, 0.6, 0.7] });
    const r = await runEmbeddings({ neuronsDir, dryRun: false, forceFull: false, forceRebuild: false }, { provider: openai, now: NOW });
    expect(r.exitCode).toBe(0);
    const scoped = join(root, ".neuron-embeddings.openai.text-embedding-3-small.json");
    expect(r.cachePath).toBe(scoped);
    expect(existsSync(scoped)).toBe(true);
    expect(existsSync(legacy)).toBe(false); // legacy untouched/uncreated
  });

  it("refuses to load a cache whose model/dimensions disagree with the provider", async () => {
    const { neuronsDir, legacy } = setup(THREE, { "NE-001.md": { vector: [0, 0, 0, 0, 0, 0, 0, 0, 0], updated: FAR_FUTURE } }, "gemini-embedding-001", 9);
    const before = readFileSync(legacy, "utf-8");
    const r = await runEmbeddings({ neuronsDir, dryRun: false, forceFull: false, forceRebuild: false }, { provider: mkProvider(), now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.reason).toMatch(/refusing to mix/);
    expect(readFileSync(legacy, "utf-8")).toBe(before);
  });

  it("--force-rebuild resets a mismatched index to the active provider geometry", async () => {
    const { neuronsDir, legacy } = setup(THREE, { "NE-001.md": { vector: [0, 0, 0, 0, 0, 0, 0, 0, 0], updated: FAR_FUTURE } }, "gemini-embedding-001", 9);
    const r = await runEmbeddings({ neuronsDir, dryRun: false, forceFull: false, forceRebuild: true }, { provider: mkProvider(), now: NOW });
    expect(r.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(legacy, "utf-8"));
    expect(written.dimensions).toBe(3);
    expect(Object.keys(written.entries).sort()).toEqual(["NE-618.md", "NE-619.md", "NP-059.md"]);
  });
});

describe("embeddings-cli — safe writer & failure handling", () => {
  it("aborts on a corrupt index WITHOUT overwriting it", async () => {
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const { neuronsDir, legacy } = setup(THREE, "corrupt");
    const r = await runEmbeddings({ neuronsDir, dryRun: false, forceFull: false, forceRebuild: false }, { provider: mkProvider({ embed }), now: NOW });
    expect(r.exitCode).toBe(1);
    expect(embed).toHaveBeenCalledTimes(0);
    expect(readFileSync(legacy, "utf-8")).toBe("{ not valid json");
    expect(existsSync(`${legacy}.bak`)).toBe(false);
  });

  it("backs up, writes atomically (no temp leftover), keeps markdown stable", async () => {
    const original = { "NE-001.md": { vector: [0.1, 0.2, 0.3], updated: FAR_FUTURE } };
    const { root, neuronsDir, legacy } = setup([...THREE, { cat: "errors", name: "NE-001.md" }], original);
    const originalRaw = readFileSync(legacy, "utf-8");
    const r = await runEmbeddings({ neuronsDir, dryRun: false, forceFull: false, forceRebuild: false }, { provider: mkProvider(), now: NOW });
    expect(r.exitCode).toBe(0);
    expect(r.backupPath).toBe(`${legacy}.bak`);
    expect(readFileSync(`${legacy}.bak`, "utf-8")).toBe(originalRaw);
    expect(readdirSync(root).filter((f) => f.includes(".tmp."))).toHaveLength(0);
    expect(r.mdHashStable).toBe(true);
  });

  it("if embed THROWS, nothing is written and the index stays intact", async () => {
    const original = { "NE-001.md": { vector: [0.1, 0.2, 0.3], updated: FAR_FUTURE } };
    const { neuronsDir, legacy } = setup([...THREE, { cat: "errors", name: "NE-001.md" }], original);
    const originalRaw = readFileSync(legacy, "utf-8");
    const r = await runEmbeddings({ neuronsDir, dryRun: false, forceFull: false, forceRebuild: false }, { provider: mkProvider({ embed: async () => { throw new Error("api fail"); } }), now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.failed.length).toBeGreaterThan(0);
    expect(readFileSync(legacy, "utf-8")).toBe(originalRaw);
    expect(existsSync(`${legacy}.bak`)).toBe(false);
  });

  it("rejects an embedding whose dimensions differ from the provider", async () => {
    const { neuronsDir, legacy } = setup(THREE, "none");
    const r = await runEmbeddings({ neuronsDir, dryRun: false, forceFull: false, forceRebuild: false }, { provider: mkProvider({ embed: async () => [1, 2, 3, 4, 5] }), now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.reason).toMatch(/wrong dimensions/);
    expect(existsSync(legacy)).toBe(false);
  });

  it("never logs neuron content or vectors", async () => {
    const lines: string[] = [];
    const { neuronsDir } = setup([{ cat: "patterns", name: "NP-059.md", body: "ZZSENTINELBODY_secret" }], "none");
    await runEmbeddings({ neuronsDir, dryRun: false, forceFull: false, forceRebuild: false }, { provider: mkProvider({ embed: async () => [0.123456, 0.65, 0.11] }), now: NOW, log: (l) => lines.push(l) });
    const blob = lines.join("\n");
    expect(blob).not.toContain("ZZSENTINELBODY");
    expect(blob).not.toContain("0.123456");
  });
});
