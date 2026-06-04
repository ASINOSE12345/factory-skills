/**
 * embeddings-cli — safe, incremental, auditable (re)generation of a neuron
 * embedding cache, now PROVIDER-AWARE (gemini | openai | local).
 *
 * Design (deliberate, deterministic, no silent fallbacks):
 *  - Provider abstraction (see embedding-providers.ts). Each (provider, model)
 *    has its OWN cache file; the Gemini default keeps the legacy
 *    `.neuron-embeddings.json` (the MCP server reads it, untouched). Dimensions
 *    are declared per provider — never inferred. The CLI REFUSES to load a cache
 *    whose model/dimensions disagree with the active provider, and refuses any
 *    embedding whose length differs from the provider's dimensions. That is how
 *    incompatible vector geometries can never be mixed.
 *  - `--dry-run` is EXPLICIT. We NEVER auto-switch to dry-run because credentials
 *    are missing. No creds + not dry-run ⇒ exit 1. No creds + dry-run ⇒ exit 0.
 *  - Targeted by default: `--ids` embeds exactly those; otherwise only the
 *    missing+stale set; a full rebuild requires explicit `--force-full`.
 *  - Safe writer (mirrors NP-059): backup the index, write a temp file, then
 *    atomic `rename`. A corrupt index aborts unless `--force-rebuild`. If ANY
 *    embedding fails, nothing is written and the original index is left intact.
 *  - Never touches the markdown corpus (read-only) — verified by hashing the
 *    corpus before/after. Never logs neuron content, vectors, or any API key.
 *
 * Imports only already-exported helpers; embeddings.ts is unchanged.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { listNeurons } from "./neurons.js";
import { getProvider, resolveCachePath, PROVIDER_NAMES, type EmbeddingProvider } from "./embedding-providers.js";

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
  /** Provider name (default "gemini"). */
  provider?: string;
  /** Model override (default = the provider's default model). */
  model?: string;
  /** Filenames or bare IDs (NP-059 or NP-059.md). */
  ids?: string[];
  dryRun: boolean;
  /** Embed every corpus neuron (explicit full rebuild of vectors). */
  forceFull: boolean;
  /** Start from an empty cache if the index is missing OR corrupt. */
  forceRebuild: boolean;
}

export interface EmbeddingsCliDeps {
  /** Provider override for tests (mock embedder, no network). Defaults to the
   *  real registry provider resolved from opts.provider/opts.model. */
  provider?: EmbeddingProvider;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  /** Logger — receives only counts/IDs, never content/vectors/keys. */
  log?: (line: string) => void;
}

export interface EmbeddingsCliResult {
  exitCode: number;
  mode: "dry-run" | "write" | "noop" | "error";
  provider: string;
  model: string;
  dimensions: number;
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
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? ((l: string) => console.error(l));

  // ── Resolve the provider (fail-closed on unknown provider/model) ──────────
  let provider: EmbeddingProvider;
  try {
    provider = deps.provider ?? getProvider(opts.provider ?? "gemini", opts.model);
  } catch (e) {
    return {
      exitCode: 1, mode: "error", provider: opts.provider ?? "gemini", model: opts.model ?? "?",
      dimensions: 0, cachePath: "", totalEntriesBefore: 0, totalEntriesAfter: 0, corpusCount: 0,
      present: 0, missing: [], stale: [], targets: [], embedded: [], failed: [], wrote: false,
      backupPath: null, mdHashStable: null, reason: String((e as Error).message),
    };
  }

  const cachePath = resolveCachePath(provider, opts.neuronsDir);
  const base: EmbeddingsCliResult = {
    exitCode: 0, mode: "noop", provider: provider.name, model: provider.model, dimensions: provider.dimensions,
    cachePath, totalEntriesBefore: 0, totalEntriesAfter: 0, corpusCount: 0,
    present: 0, missing: [], stale: [], targets: [], embedded: [], failed: [],
    wrote: false, backupPath: null, mdHashStable: null,
  };

  if (!opts.neuronsDir || !existsSync(opts.neuronsDir)) {
    return { ...base, mode: "error", exitCode: 1, reason: `neurons dir not found: '${opts.neuronsDir}'` };
  }

  // ── Load the corpus (filename → neuron) ──────────────────────────────────
  const neurons = listNeurons(opts.neuronsDir);
  const byFile = new Map(neurons.map((n) => [n.filename, n] as const));
  base.corpusCount = neurons.length;

  // ── Load the index (strict) ──────────────────────────────────────────────
  const emptyCache = (): EmbeddingCache => ({ model: provider.model, dimensions: provider.dimensions, entries: {} });
  let cache: EmbeddingCache;
  if (!existsSync(cachePath)) {
    cache = emptyCache();
  } else {
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf-8")) as EmbeddingCache;
      if (!cache || typeof cache !== "object" || typeof cache.entries !== "object") {
        throw new Error("unexpected shape");
      }
    } catch (e) {
      if (!opts.forceRebuild) {
        return {
          ...base, mode: "error", exitCode: 1,
          reason: `index is corrupt/unreadable (${String((e as Error).message)}) — pass --force-rebuild to start fresh`,
        };
      }
      cache = emptyCache();
    }
  }

  // ── Provider/model/dimensions guard — NEVER mix geometries ───────────────
  if (cache.model !== provider.model || cache.dimensions !== provider.dimensions) {
    if (!opts.forceRebuild) {
      return {
        ...base, mode: "error", exitCode: 1,
        reason:
          `index belongs to ${cache.model}/${cache.dimensions}d but provider is ` +
          `${provider.model}/${provider.dimensions}d — refusing to mix. ` +
          `Use the correct --provider/--model, or --force-rebuild to start a fresh index.`,
      };
    }
    cache = emptyCache(); // explicit reset to the active provider's geometry
  }
  base.totalEntriesBefore = Object.keys(cache.entries).length;

  // ── Audit: present / missing / stale ─────────────────────────────────────
  const present: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const n of neurons) {
    const entry = cache.entries[n.filename];
    if (!entry) missing.push(n.filename);
    else if (n.modified.toISOString() > entry.updated) { stale.push(n.filename); present.push(n.filename); }
    else present.push(n.filename);
  }
  base.present = present.length;
  base.missing = missing.slice().sort();
  base.stale = stale.slice().sort();

  // ── Select targets ───────────────────────────────────────────────────────
  let targets: string[];
  if (opts.ids && opts.ids.length > 0) {
    const wanted = opts.ids.map(toFilename);
    const found = wanted.filter((f) => byFile.has(f));
    for (const f of wanted.filter((f) => !byFile.has(f))) log(`[embeddings] WARN: --ids target not in corpus: ${f}`);
    if (found.length === 0) return { ...base, mode: "error", exitCode: 1, reason: `none of the given --ids exist in corpus` };
    targets = found;
  } else if (opts.forceFull) {
    targets = neurons.map((n) => n.filename);
  } else {
    targets = [...missing, ...stale];
  }
  targets = [...new Set(targets)].sort();
  base.targets = targets;

  log(
    `[embeddings] provider=${provider.name}/${provider.model} (${provider.dimensions}d) ` +
      `corpus=${neurons.length} indexed=${base.totalEntriesBefore} ` +
      `missing=${missing.length} stale=${stale.length} targets=${targets.length}`,
  );

  // ── Dry-run: report only, no API, no write ───────────────────────────────
  if (opts.dryRun) {
    log(`[embeddings] DRY-RUN targets: ${targets.map((f) => f.replace(/\.md$/, "")).join(", ") || "(none)"}`);
    return { ...base, mode: "dry-run", exitCode: 0, totalEntriesAfter: base.totalEntriesBefore };
  }

  // ── Credential gate (explicit, no silent fallback) ───────────────────────
  if (!provider.hasCredentials()) {
    return {
      ...base, mode: "error", exitCode: 1,
      reason: `provider '${provider.name}' has no credentials — refusing to run without --dry-run (no silent fallback)`,
    };
  }

  if (targets.length === 0) {
    log(`[embeddings] nothing to embed (index already covers the corpus)`);
    return { ...base, mode: "noop", exitCode: 0, totalEntriesAfter: base.totalEntriesBefore };
  }

  // ── Embed all targets; abort wholesale on any failure or dim mismatch ─────
  const mdBefore = corpusMdDigest(opts.neuronsDir);
  const fresh = new Map<string, number[]>();
  const failed: string[] = [];
  let dimMismatch = false;
  for (const filename of targets) {
    const n = byFile.get(filename)!;
    const text = `${n.title}\n\n${n.content.slice(0, 1500)}`;
    let vector: number[] | null = null;
    try {
      vector = await provider.embed(text);
    } catch {
      vector = null;
    }
    if (vector && vector.length === provider.dimensions) {
      fresh.set(filename, vector);
    } else {
      if (vector && vector.length !== provider.dimensions) dimMismatch = true;
      failed.push(filename);
    }
  }
  if (failed.length > 0) {
    return {
      ...base, mode: "error", exitCode: 1, failed: failed.sort(),
      reason: dimMismatch
        ? `embedding returned wrong dimensions (expected ${provider.dimensions}d) — index left intact, nothing written`
        : `embedding failed for ${failed.length} target(s) — index left intact, nothing written`,
    };
  }

  // ── Merge + authoritative geometry, backup, atomic write ─────────────────
  for (const [filename, vector] of fresh) cache.entries[filename] = { vector, updated: now() };
  cache.model = provider.model;          // authoritative — never inferred from a vector
  cache.dimensions = provider.dimensions;

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
    try { if (existsSync(tmpPath)) rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    return {
      ...base, mode: "error", exitCode: 1, backupPath,
      reason: `write failed (${String((e as Error).message)}) — original index intact${backupPath ? " (backup kept)" : ""}`,
    };
  }

  const mdHashStable = mdBefore === corpusMdDigest(opts.neuronsDir);
  log(
    `[embeddings] wrote ${fresh.size} embedding(s) to ${provider.name}/${provider.model}; ` +
      `total ${Object.keys(cache.entries).length}; backup=${backupPath ? "yes" : "none"}; md_stable=${mdHashStable}`,
  );

  return {
    ...base, mode: "write", exitCode: mdHashStable ? 0 : 1,
    embedded: [...fresh.keys()].sort(), totalEntriesAfter: Object.keys(cache.entries).length,
    wrote: true, backupPath, mdHashStable,
    reason: mdHashStable ? undefined : "markdown corpus changed during run — investigate",
  };
}

// ── CLI wrapper ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): EmbeddingsCliOptions {
  const o: EmbeddingsCliOptions = { neuronsDir: "", dryRun: false, forceFull: false, forceRebuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--neurons-dir") o.neuronsDir = argv[++i] ?? "";
    else if (a === "--provider") o.provider = argv[++i] ?? "";
    else if (a === "--model") o.model = argv[++i] ?? "";
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
    console.error(
      `usage: embeddings --neurons-dir <dir> [--provider ${PROVIDER_NAMES.join("|")}] [--model M] ` +
        `[--ids A,B] [--dry-run] [--force-full] [--force-rebuild]`,
    );
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
