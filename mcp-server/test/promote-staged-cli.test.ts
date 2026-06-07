import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import matter from "gray-matter";
import { runPromote, verifyVectors, type PromoteDeps } from "../src/promote-staged-cli";
import { getApiKey } from "../src/embeddings";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function setup(): { root: string; neuronsDir: string; stagingDir: string; proposedDir: string } {
  const root = mkdtempSync(join(tmpdir(), "promo-"));
  roots.push(root);
  const neuronsDir = join(root, "neurons");
  for (const c of ["errors", "decisions", "patterns", "foundations", "business"]) mkdirSync(join(neuronsDir, c), { recursive: true });
  const stagingDir = join(root, "staging-session");
  const proposedDir = join(stagingDir, "proposed-neurons");
  mkdirSync(proposedDir, { recursive: true });
  return { root, neuronsDir, stagingDir, proposedDir };
}

function writeProposed(proposedDir: string, slug: string, fm: Record<string, unknown>, body: string): void {
  const front = { id: "PROPOSED-NE-XXX", status: "staging-proposed", project: "softwarefactory", created: "2026-06-07", ...fm };
  writeFileSync(join(proposedDir, `${slug}.md`), matter.stringify(`\n# PROPOSED-XX-XXX: ${slug}\n\n${body}\n`, front));
}

/** Mock embeddings runner. When writeVecs, writes a fake index (dim 4) so verifyVectors passes. */
function mockEmbed(opts: { writeVecs: boolean; captured?: string[] }): PromoteDeps["embed"] {
  return async (ids, nd) => {
    opts.captured?.splice(0, opts.captured.length, ...ids);
    const idxPath = join(dirname(nd), ".neuron-embeddings.json");
    if (opts.writeVecs) {
      const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, "utf-8")) : { model: "mock", dimensions: 4, entries: {} };
      for (const id of ids) idx.entries[`${id}.md`] = { vector: [0.1, 0.2, 0.3, 0.4], updated: "x" };
      writeFileSync(idxPath, JSON.stringify(idx));
      return { ok: true, embedded: ids, failed: [], backupPath: `${idxPath}.bak` };
    }
    // failure: do NOT touch the index (it must stay intact)
    return { ok: false, embedded: [], failed: ids, backupPath: null };
  };
}

const errFiles = (nd: string) => readdirSync(join(nd, "errors")).filter((f) => f.endsWith(".md"));

describe("promote-staged — dry-run (default, no writes)", () => {
  it("1+17. dry-run writes nothing and corpus hash is unchanged", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-sample", { type: "error-memory", severity: "p2", domain: "tooling" }, "body");
    const { manifest, exitCode } = await runPromote({ stagingDir, neuronsDir, apply: false, allowPendingEmbeddings: false });
    expect(exitCode).toBe(0);
    expect(manifest.status).toBe("dry-run");
    expect(errFiles(neuronsDir)).toEqual([]); // no writes
    expect(existsSync(join(stagingDir, "PROMOTION-MANIFEST.json"))).toBe(false); // no manifest on dry-run
    expect(manifest.corpus_hash_before).toBe(manifest.corpus_hash_after);
  });

  it("2. apply is required to write (dry-run does not)", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-x", { type: "error-memory" }, "body");
    await runPromote({ stagingDir, neuronsDir, apply: false, allowPendingEmbeddings: false });
    expect(errFiles(neuronsDir)).toEqual([]);
  });
});

describe("promote-staged — containment & overwrite", () => {
  it("3. staging inside neurons dir is blocked", async () => {
    const { neuronsDir } = setup();
    const inside = join(neuronsDir, "staging");
    mkdirSync(join(inside, "proposed-neurons"), { recursive: true });
    writeProposed(join(inside, "proposed-neurons"), "PROPOSED-NE-x", { type: "error-memory" }, "b");
    const { manifest, exitCode } = await runPromote({ stagingDir: inside, neuronsDir, apply: true, allowPendingEmbeddings: true });
    expect(exitCode).toBe(1);
    expect(manifest.errors.join(" ")).toMatch(/INSIDE/);
  });

  it("4. destination overwrite is blocked (O_EXCL / pre-check)", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-x", { type: "error-memory" }, "b");
    writeFileSync(join(neuronsDir, "errors", "NE-009.md"), "preexisting"); // collide via injected allocator
    const deps: PromoteDeps = { nextIds: () => ["NE-009"], hasKey: () => true, embed: mockEmbed({ writeVecs: true }) };
    const { manifest, exitCode } = await runPromote({ stagingDir, neuronsDir, apply: true, allowPendingEmbeddings: false }, deps);
    expect(exitCode).toBe(1);
    expect(manifest.errors.join(" ")).toMatch(/overwrite/i);
    expect(readFileSync(join(neuronsDir, "errors", "NE-009.md"), "utf-8")).toBe("preexisting"); // untouched
  });
});

describe("promote-staged — transforms", () => {
  it("5+6+9. id/heading rewritten, internal cross-links rewritten, NP normalized", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-alpha", { type: "error-memory", severity: "p2" }, "see [[PROPOSED-NP-beta]]");
    writeProposed(proposedDir, "PROPOSED-NP-beta", { type: "pattern-memory", occurrence_count: 3 }, "pattern body");
    const { manifest, exitCode } = await runPromote({ stagingDir, neuronsDir, apply: true, allowPendingEmbeddings: false }, { hasKey: () => true, embed: mockEmbed({ writeVecs: true }) });
    expect(exitCode).toBe(0);
    const neId = manifest.promoted.find((p) => p.slug === "PROPOSED-NE-alpha")!.id;
    const npId = manifest.promoted.find((p) => p.slug === "PROPOSED-NP-beta")!.id;
    const ne = readFileSync(join(neuronsDir, "errors", `${neId}.md`), "utf-8");
    expect(matter(ne).data.id).toBe(neId);
    expect(ne).toMatch(new RegExp(`^# ${neId}:`, "m"));
    expect(ne).toContain(`[[${npId}]]`); // cross-link rewritten
    expect(ne).not.toContain("PROPOSED-");
    const np = matter(readFileSync(join(neuronsDir, "patterns", `${npId}.md`), "utf-8")).data;
    expect(np).toMatchObject({ status: "new", hits: 0, misses: 0, sessions_seen: 0, last_hit: null });
    expect(np.occurrences).toBe(3); // occurrence_count → occurrences
  });

  it("7. an unrewritable real [[PROPOSED-…]] cross-link is blocked", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-x", { type: "error-memory" }, "see [[PROPOSED-NE-ghost-not-in-batch]]");
    const { manifest, exitCode } = await runPromote({ stagingDir, neuronsDir, apply: false, allowPendingEmbeddings: false });
    expect(exitCode).toBe(1);
    expect(manifest.errors.join(" ")).toMatch(/PROPOSED/);
  });

  it("8. PROPOSED- in prose (not a link/id/heading) is allowed", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-x", { type: "error-memory" }, "el prefijo PROPOSED- en el slug causaba el bug; ejemplo PROPOSED-PROPOSED-foo.");
    const { exitCode, manifest } = await runPromote({ stagingDir, neuronsDir, apply: false, allowPendingEmbeddings: false });
    expect(exitCode).toBe(0);
    expect(manifest.status).toBe("dry-run");
  });

  it("10. a detected secret blocks promotion", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-x", { type: "error-memory" }, "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaked");
    const { manifest, exitCode } = await runPromote({ stagingDir, neuronsDir, apply: false, allowPendingEmbeddings: false });
    expect(exitCode).toBe(1);
    expect(manifest.errors.join(" ")).toMatch(/secret/i);
  });
});

describe("promote-staged — embeddings & credentials", () => {
  it("11. embeddings target ONLY the promoted ids", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-a", { type: "error-memory" }, "b");
    writeProposed(proposedDir, "PROPOSED-ND-b", { type: "decision-memory" }, "b");
    const captured: string[] = [];
    const { manifest, exitCode } = await runPromote({ stagingDir, neuronsDir, apply: true, allowPendingEmbeddings: false }, { hasKey: () => true, embed: mockEmbed({ writeVecs: true, captured }) });
    expect(exitCode).toBe(0);
    expect(captured.sort()).toEqual(manifest.promoted.map((p) => p.id).sort());
  });

  it("12. no key + no --allow-pending-embeddings => fails BEFORE promoting (no writes)", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-x", { type: "error-memory" }, "b");
    const { manifest, exitCode } = await runPromote({ stagingDir, neuronsDir, apply: true, allowPendingEmbeddings: false }, { hasKey: () => false });
    expect(exitCode).toBe(1);
    expect(manifest.status).toBe("error");
    expect(errFiles(neuronsDir)).toEqual([]); // nothing written
  });

  it("14. --allow-pending-embeddings promotes with manifest embeddings_pending", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-x", { type: "error-memory" }, "b");
    const { manifest, exitCode } = await runPromote({ stagingDir, neuronsDir, apply: true, allowPendingEmbeddings: true }, { hasKey: () => false });
    expect(manifest.status).toBe("embeddings_pending");
    expect(exitCode).toBe(1);
    expect(errFiles(neuronsDir).length).toBe(1); // promoted
    expect(JSON.parse(readFileSync(join(stagingDir, "PROMOTION-MANIFEST.json"), "utf-8")).status).toBe("embeddings_pending");
  });

  it("15. embeddings failure after move => manifest embeddings_failed, index intact", async () => {
    const { root, neuronsDir, stagingDir, proposedDir } = setup();
    writeFileSync(join(root, ".neuron-embeddings.json"), JSON.stringify({ model: "m", dimensions: 4, entries: { "NE-500.md": { vector: [1, 1, 1, 1] } } }));
    const before = readFileSync(join(root, ".neuron-embeddings.json"), "utf-8");
    writeProposed(proposedDir, "PROPOSED-NE-x", { type: "error-memory" }, "b");
    const { manifest, exitCode } = await runPromote({ stagingDir, neuronsDir, apply: true, allowPendingEmbeddings: false }, { hasKey: () => true, embed: mockEmbed({ writeVecs: false }) });
    expect(manifest.status).toBe("embeddings_failed");
    expect(exitCode).toBe(1);
    expect(errFiles(neuronsDir).length).toBe(1); // file WAS promoted
    expect(readFileSync(join(root, ".neuron-embeddings.json"), "utf-8")).toBe(before); // index NOT corrupted
    expect(manifest.embeddings_missing.length).toBe(1);
  });

  it("16. success => manifest success written + vectors verified", async () => {
    const { stagingDir, neuronsDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-x", { type: "error-memory" }, "b");
    const { manifest, exitCode } = await runPromote({ stagingDir, neuronsDir, apply: true, allowPendingEmbeddings: false }, { hasKey: () => true, embed: mockEmbed({ writeVecs: true }) });
    expect(exitCode).toBe(0);
    expect(manifest.status).toBe("success");
    const written = JSON.parse(readFileSync(join(stagingDir, "PROMOTION-MANIFEST.json"), "utf-8"));
    expect(written.status).toBe("success");
    expect(written.embeddings_attempted).toBe(true);
    expect(verifyVectors(neuronsDir, manifest.promoted.map((p) => p.id)).size).toBe(1);
  });

  it("13. getApiKey falls back to the keyfile (perm-checked) when env is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "key-")); roots.push(dir);
    const kf = join(dir, "gemini.key");
    writeFileSync(kf, "AIzaTESTKEY1234567890");
    chmodSync(kf, 0o600);
    const savedEnv = process.env.GEMINI_API_KEY, savedFile = process.env.FACTORY_GEMINI_KEY_FILE;
    delete process.env.GEMINI_API_KEY;
    process.env.FACTORY_GEMINI_KEY_FILE = kf;
    try {
      expect(getApiKey()).toBe("AIzaTESTKEY1234567890");
    } finally {
      if (savedEnv === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedEnv;
      if (savedFile === undefined) delete process.env.FACTORY_GEMINI_KEY_FILE; else process.env.FACTORY_GEMINI_KEY_FILE = savedFile;
    }
  });
});

describe("promote-staged — path containment & no forbidden deps", () => {
  it("18. destinations are inside neurons/<category>/", async () => {
    const { neuronsDir, stagingDir, proposedDir } = setup();
    writeProposed(proposedDir, "PROPOSED-NE-x", { type: "error-memory" }, "b");
    const { manifest } = await runPromote({ stagingDir, neuronsDir, apply: false, allowPendingEmbeddings: false });
    for (const it of manifest.promoted) expect(resolve(it.dest_file).startsWith(resolve(neuronsDir) + "/")).toBe(true);
  });

  it("19+20. CLI uses neither create_neuron nor MCP search/think", () => {
    const src = readFileSync(resolve("src/promote-staged-cli.ts"), "utf-8");
    expect(src).not.toMatch(/createNeuron/);
    expect(src).not.toMatch(/search_neurons|think_neurons|mcp__factory-neurons/);
  });
});
