/**
 * embeddings-cli — safe, incremental, auditable (re)generation of the neuron
 * embedding cache (.neuron-embeddings.json).
 *
 * Design (deliberate, deterministic, no silent fallbacks):
 *  - `--dry-run` is EXPLICIT. We NEVER auto-switch to dry-run because a key is
 *    missing. No key + not dry-run ⇒ exit 1. No key + dry-run ⇒ exit 0, no API.
 *  - Targeted by default: `--ids` embeds exactly those; otherwise only the
 *    missing+stale set; a full rebuild requires explicit `--force-full`.
 *  - Safe writer (mirrors NP-059): backup the index, write a temp file, then
 *    atomic `rename`. A corrupt index aborts unless `--force-rebuild`. If ANY
 *    embedding fails, nothing is written and the original index is left intact.
 *  - Never touches the markdown corpus (read-only) — verified by hashing the
 *    corpus before/after. Never logs neuron content, vectors, or the API key.
 *
 * This module imports ONLY already-exported helpers (`embedText`, `listNeurons`)
 * and changes nothing in embeddings.ts — the live server path is untouched.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { embedText } from "./embeddings.js";
import { listNeurons } from "./neurons.js";

const CACHE_FILENAME = ".neuron-embeddings.json";
const DEFAULT_MODEL = "gemini-embedding-001";
const DEFAULT_DIMENSIONS = 3072;

export interface EmbeddingEntry {
  vector: number[];
  updated: string;
}
export interface EmbeddingCache {
  model: string;
  dimensions: number;
  entries: Record<string, EmbeddingEntry>;
}

export interface EmbeddingsCliOptions {
  neuronsDir: string;
  /** Filenames or bare IDs (NP-059 or NP-059.md). */
  ids?: string[];
  dryRun: boolean;
  /** Embed every corpus neuron (explicit full rebuild of vectors). */
  forceFull: boolean;
  /** Start from an empty cache if the index is missing OR corrupt. */
  forceRebuild: boolean;
}

export interface EmbeddingsCliDeps {
  /** Defaults to the real Gemini embedder. Tests inject a mock (no network). */
  embedFn?: (text: string) => Promise<number[] | null>;
  /** Defaults to reading GEMINI_API_KEY from env. */
  hasApiKey?: () => boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  /** Logger — receives only counts/IDs, never content/vectors/keys. */
  log?: (line: string) => void;
}

export interface EmbeddingsCliResult {
  exitCode: number;
  mode: "dry-run" | "write" | "noop" | "error";
  cachePath: string;
  totalEntriesBefore: number;
  totalEntriesAfter: number;
  corpusCount: number;
  present: number;
  missing: string[];
  stale: string[];
  targets: string[];
  embedded: string[];
  failed: string[];
  wrote: boolean;
  backupPath: string | null;
  mdHashStable: boolean | null;
  reason?: string;
}

function cachePathFor(neuronsDir: string): string {
  return join(dirname(neuronsDir), CACHE_FILENAME);
}

/** Normalize a bare ID or filename to a `.md` filename. */
function toFilename(idOrFile: string): string {
  const t = idOrFile.trim();
  return t.endsWith(".md") ? t : `${t}.md`;
}

/** Deterministic content-addressed digest of the corpus markdown. Returns a hex
 *  digest only — raw bytes are hashed, never emitted. */
function corpusMdDigest(neuronsDir: string): string {
  const neurons = listNeurons(neuronsDir);
  const rows = neurons
    .map((n) => `${n.category}/${n.filename}:${createHash("sha256").update(readFileSync(n.filepath)).digest("hex")}`)
    .sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

/**
 * Core. Pure of process.exit (returns an exitCode) so it is fully testable.
 */
export async function runEmbeddings(
  opts: EmbeddingsCliOptions,
  deps: EmbeddingsCliDeps = {},
): Promise<EmbeddingsCliResult> {
  const embedFn = deps.embedFn ?? embedText;
  const hasApiKey = deps.hasApiKey ?? (() => !!process.env.GEMINI_API_KEY);
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? ((l: string) => console.error(l));

  const cachePath = cachePathFor(opts.neuronsDir);
  const base: EmbeddingsCliResult = {
    exitCode: 0,
    mode: "noop",
    cachePath,
    totalEntriesBefore: 0,
    totalEntriesAfter: 0,
    corpusCount: 0,
    present: 0,
    missing: [],
    stale: [],
    targets: [],
    embedded: [],
    failed: [],
    wrote: false,
    backupPath: null,
    mdHashStable: null,
  };

  if (!opts.neuronsDir || !existsSync(opts.neuronsDir)) {
    return { ...base, mode: "error", exitCode: 1, reason: `neurons dir not found: '${opts.neuronsDir}'` };
  }

  // ── Load the corpus (filename → neuron) ──────────────────────────────────
  const neurons = listNeurons(opts.neuronsDir);
  const byFile = new Map(neurons.map((n) => [n.filename, n] as const));
  base.corpusCount = neurons.length;

  // ── Load the index (strict) ──────────────────────────────────────────────
  let cache: EmbeddingCache;
  if (!existsSync(cachePath)) {
    cache = { model: DEFAULT_MODEL, dimensions: DEFAULT_DIMENSIONS, entries: {} };
  } else {
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf-8")) as EmbeddingCache;
      if (!cache || typeof cache !== "object" || typeof cache.entries !== "object") {
        throw new Error("unexpected shape");
      }
    } catch (e) {
      if (!opts.forceRebuild) {
        return {
          ...base,
          mode: "error",
          exitCode: 1,
          reason: `index is corrupt/unreadable (${String((e as Error).message)}) — pass --force-rebuild to start fresh`,
        };
      }
      cache = { model: DEFAULT_MODEL, dimensions: DEFAULT_DIMENSIONS, entries: {} };
    }
  }
  base.totalEntriesBefore = Object.keys(cache.entries).length;

  // ── Audit: present / missing / stale ─────────────────────────────────────
  const present: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const n of neurons) {
    const entry = cache.entries[n.filename];
    if (!entry) {
      missing.push(n.filename);
    } else if (n.modified.toISOString() > entry.updated) {
      stale.push(n.filename);
      present.push(n.filename);
    } else {
      present.push(n.filename);
    }
  }
  base.present = present.length;
  base.missing = missing.slice().sort();
  base.stale = stale.slice().sort();

  // ── Select targets ───────────────────────────────────────────────────────
  let targets: string[];
  if (opts.ids && opts.ids.length > 0) {
    const wanted = opts.ids.map(toFilename);
    const found = wanted.filter((f) => byFile.has(f));
    const notFound = wanted.filter((f) => !byFile.has(f));
    for (const f of notFound) log(`[embeddings] WARN: --ids target not in corpus: ${f}`);
    if (found.length === 0) {
      return { ...base, mode: "error", exitCode: 1, reason: `none of the given --ids exist in corpus` };
    }
    targets = found;
  } else if (opts.forceFull) {
    targets = neurons.map((n) => n.filename);
  } else {
    targets = [...missing, ...stale];
  }
  targets = [...new Set(targets)].sort();
  base.targets = targets;

  log(
    `[embeddings] corpus=${neurons.length} indexed=${base.totalEntriesBefore} ` +
      `missing=${missing.length} stale=${stale.length} targets=${targets.length}`,
  );

  // ── Dry-run: report only, no API, no write ───────────────────────────────
  if (opts.dryRun) {
    log(`[embeddings] DRY-RUN targets: ${targets.map((f) => f.replace(/\.md$/, "")).join(", ") || "(none)"}`);
    return { ...base, mode: "dry-run", exitCode: 0, totalEntriesAfter: base.totalEntriesBefore };
  }

  // ── Key gate (explicit, no silent fallback to dry-run) ───────────────────
  if (!hasApiKey()) {
    return {
      ...base,
      mode: "error",
      exitCode: 1,
      reason: `GEMINI_API_KEY not set — refusing to run without --dry-run (no silent fallback)`,
    };
  }

  if (targets.length === 0) {
    log(`[embeddings] nothing to embed (index already covers the corpus)`);
    return { ...base, mode: "noop", exitCode: 0, totalEntriesAfter: base.totalEntriesBefore };
  }

  // ── Embed all targets; abort wholesale on any failure ────────────────────
  const mdBefore = corpusMdDigest(opts.neuronsDir);
  const fresh = new Map<string, number[]>();
  const failed: string[] = [];
  for (const filename of targets) {
    const n = byFile.get(filename)!;
    const text = `${n.title}\n\n${n.content.slice(0, 1500)}`;
    let vector: number[] | null = null;
    try {
      vector = await embedFn(text);
    } catch {
      vector = null;
    }
    if (vector && vector.length > 0) fresh.set(filename, vector);
    else failed.push(filename);
  }
  if (failed.length > 0) {
    return {
      ...base,
      mode: "error",
      exitCode: 1,
      failed: failed.sort(),
      reason: `embedding failed for ${failed.length} target(s) — index left intact, nothing written`,
    };
  }

  // ── Merge, backup, atomic write ──────────────────────────────────────────
  for (const [filename, vector] of fresh) {
    cache.entries[filename] = { vector, updated: now() };
  }
  const first = Object.values(cache.entries)[0];
  if (first) cache.dimensions = first.vector.length;

  let backupPath: string | null = null;
  const tmpPath = `${cachePath}.tmp.${process.pid}`;
  try {
    if (existsSync(cachePath)) {
      backupPath = `${cachePath}.bak`;
      copyFileSync(cachePath, backupPath);
    }
    writeFileSync(tmpPath, JSON.stringify(cache), "utf-8");
    renameSync(tmpPath, cachePath); // atomic on the same filesystem
  } catch (e) {
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    } catch {
      /* best effort */
    }
    return {
      ...base,
      mode: "error",
      exitCode: 1,
      backupPath,
      reason: `write failed (${String((e as Error).message)}) — original index intact${backupPath ? " (backup kept)" : ""}`,
    };
  }

  const mdAfter = corpusMdDigest(opts.neuronsDir);
  const mdHashStable = mdBefore === mdAfter;

  log(
    `[embeddings] wrote ${fresh.size} embedding(s); total ${Object.keys(cache.entries).length}; ` +
      `backup=${backupPath ? "yes" : "none"}; md_stable=${mdHashStable}`,
  );

  return {
    ...base,
    mode: "write",
    exitCode: mdHashStable ? 0 : 1,
    embedded: [...fresh.keys()].sort(),
    totalEntriesAfter: Object.keys(cache.entries).length,
    wrote: true,
    backupPath,
    mdHashStable,
    reason: mdHashStable ? undefined : "markdown corpus changed during run — investigate",
  };
}

// ── CLI wrapper ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): EmbeddingsCliOptions {
  const o: EmbeddingsCliOptions = { neuronsDir: "", dryRun: false, forceFull: false, forceRebuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--neurons-dir") o.neuronsDir = argv[++i] ?? "";
    else if (a === "--ids") o.ids = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--force-full") o.forceFull = true;
    else if (a === "--force-rebuild") o.forceRebuild = true;
  }
  return o;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.neuronsDir) {
    console.error("usage: embeddings --neurons-dir <dir> [--ids A,B] [--dry-run] [--force-full] [--force-rebuild]");
    process.exit(1);
  }
  const result = await runEmbeddings(opts);
  if (result.reason) console.error(`[embeddings] ${result.reason}`);
  process.exit(result.exitCode);
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
