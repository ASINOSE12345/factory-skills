/**
 * promote-staged-cli — governed promotion of staged neurons into the live corpus,
 * with MANDATORY targeted embeddings, in ONE operation. Default is DRY-RUN; writing
 * requires an explicit `--apply`.
 *
 * Flow:  staging → validate → temp build → verify → O_EXCL move → targeted
 *        embeddings (only the promoted IDs) → internal index verification → manifest
 *
 * Why this exists: promoting neurons by hand (twice) left them in the corpus but
 * WITHOUT embeddings, so semantic ranking buried the night's best knowledge. This
 * tool makes "promoted but unembedded" impossible: it refuses to promote when it
 * cannot also embed (unless `--allow-pending-embeddings`), and it always leaves a
 * PROMOTION-MANIFEST.json for traceability — including the half-state case.
 *
 * Guarantees / non-goals:
 *  - NO daemon, NO watcher, NO hooks, NO auto-promote. Human-triggered only.
 *  - NEVER uses create_neuron. Writes via temp → O_EXCL move (create-only).
 *  - NEVER calls the MCP tools (search/think). Retrieval verification is internal
 *    (vectors present in the index, correct dimension, non-zero). MCP smoke is a
 *    separate manual step.
 *  - Path containment: destinations live INSIDE neurons/<category>/; the staging
 *    dir must live OUTSIDE neurons/.
 *  - Secret scan (redactSecrets) before any write; refuses on a detected secret.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import matter from "gray-matter";
import { redactSecrets } from "./redact.js";
import { extractNeuronId, isValidNeuronId } from "./neuron-refs.js";
import { toolMetadata } from "./tool-metadata.js";
import { getApiKey } from "./embeddings.js";
import { runEmbeddings } from "./embeddings-cli.js";
import { listNeurons, type NeuronCategory } from "./neurons.js";

// v1 supports the numeric-id categories only (NE/ND/NP). NF/NB use hex/sub-namespaced
// ids whose allocation is out of scope here.
const TYPE_TO_CAT: Record<string, NeuronCategory> = {
  "error-memory": "errors",
  "decision-memory": "decisions",
  "pattern-memory": "patterns",
};
const CAT_PREFIX: Record<string, string> = { errors: "NE", decisions: "ND", patterns: "NP" };

export interface PromotionItem {
  source_file: string;
  slug: string;
  category: NeuronCategory;
  id: string;
  dest_file: string;
  scope: string;
}

export interface PromotionManifest {
  tool: "promote-staged";
  status: "dry-run" | "success" | "embeddings_pending" | "embeddings_failed" | "error";
  generated_at: string;
  tool_version: string;
  tool_git_sha: string;
  staging_dir: string;
  neurons_dir: string;
  promoted: PromotionItem[];
  embeddings_attempted: boolean;
  embeddings_succeeded: string[];
  embeddings_missing: string[];
  index_backup_path: string | null;
  corpus_hash_before: string;
  corpus_hash_after: string;
  warnings: string[];
  errors: string[];
}

export interface PromoteOptions {
  stagingDir: string;
  neuronsDir: string;
  apply: boolean;
  allowPendingEmbeddings: boolean;
}

export interface PromoteDeps {
  /** Injectable embeddings runner (tests pass a mock; default = real runEmbeddings). */
  embed?: (ids: string[], neuronsDir: string) => Promise<{ ok: boolean; embedded: string[]; failed: string[]; backupPath: string | null }>;
  /** Injectable credential check (default = getApiKey). */
  hasKey?: () => boolean;
  /** Injectable id allocator (tests force a collision to exercise the overwrite guard). */
  nextIds?: (neuronsDir: string, cat: NeuronCategory, count: number) => string[];
  now?: () => string;
  log?: (line: string) => void;
}

const isInside = (child: string, parent: string): boolean => {
  const c = resolve(child), p = resolve(parent);
  return c === p || c.startsWith(p + sep);
};

/** sha256 over the sorted (relpath:contenthash) of every .md under neuronsDir. */
function corpusHash(neuronsDir: string): string {
  const rows = listNeurons(neuronsDir)
    .map((n) => `${n.category}/${n.filename}:${createHash("sha256").update(readFileSync(n.filepath)).digest("hex")}`)
    .sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

/** Next N contiguous numeric ids for a category (e.g. NE-632, NE-633, …). */
function nextIds(neuronsDir: string, cat: NeuronCategory, count: number): string[] {
  const dir = join(neuronsDir, cat);
  const re = new RegExp(`^${CAT_PREFIX[cat]}-(\\d{3})`);
  let max = 0;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const m = f.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return Array.from({ length: count }, (_, i) => `${CAT_PREFIX[cat]}-${String(max + 1 + i).padStart(3, "0")}`);
}

const REAL_PROPOSED_LINK = /\[\[PROPOSED-(?:NE|ND|NP|NF|NB)-[A-Za-z0-9]/; // a real proposed-slug cross-link (NOT prose like [[PROPOSED-...]])
const PLACEHOLDER_HEAD = /^#\s+PROPOSED-/m;

/** Build the promoted content for one staged neuron (frontmatter + body transforms). */
function transform(raw: string, id: string, idMap: Map<string, string>): string {
  const { data, content } = matter(raw);
  // body: heading + internal cross-links (full-key replace; the keys already carry
  // the PROPOSED- prefix, so replace the WHOLE key — never `PROPOSED-${key}`).
  let body = content.replace(/^#\s+PROPOSED-[A-Za-z]+-XXX:/m, `# ${id}:`);
  for (const [slug, real] of idMap) body = body.split(slug).join(real);

  const fm: Record<string, unknown> = { ...data };
  fm.id = id;
  fm.status = "new";
  if ("recurrence" in fm) { fm.occurrences = fm.recurrence; delete fm.recurrence; }
  if (id.startsWith("NP")) {
    fm.hits = fm.hits ?? 0;
    fm.misses = fm.misses ?? 0;
    fm.sessions_seen = fm.sessions_seen ?? 0;
    fm.last_hit = fm.last_hit ?? null;
    if (!("occurrences" in fm) && "occurrence_count" in fm) { fm.occurrences = fm.occurrence_count; delete fm.occurrence_count; }
  }
  if (!fm.created) fm.created = (toolMetadata().generated_at || "").slice(0, 10);
  return matter.stringify(body, fm);
}

export async function runPromote(opts: PromoteOptions, deps: PromoteDeps = {}): Promise<{ manifest: PromotionManifest; exitCode: number }> {
  const meta = toolMetadata(deps.now ? new Date(deps.now()) : undefined);
  const log = deps.log ?? ((l: string) => console.error(l));
  const warnings: string[] = [];
  const errors: string[] = [];
  const mk = (status: PromotionManifest["status"], promoted: PromotionItem[], extra: Partial<PromotionManifest> = {}): PromotionManifest => ({
    tool: "promote-staged", status, generated_at: meta.generated_at, tool_version: meta.tool_version, tool_git_sha: meta.tool_git_sha,
    staging_dir: opts.stagingDir, neurons_dir: opts.neuronsDir, promoted,
    embeddings_attempted: false, embeddings_succeeded: [], embeddings_missing: [], index_backup_path: null,
    corpus_hash_before: "", corpus_hash_after: "", warnings, errors, ...extra,
  });

  // ── Pre-flight ────────────────────────────────────────────────────────────
  if (!existsSync(opts.neuronsDir)) { errors.push(`neurons dir not found: ${opts.neuronsDir}`); return { manifest: mk("error", []), exitCode: 1 }; }
  const proposedDir = join(opts.stagingDir, "proposed-neurons");
  if (!existsSync(proposedDir)) { errors.push(`proposed-neurons not found under staging: ${proposedDir}`); return { manifest: mk("error", []), exitCode: 1 }; }
  // Containment: staging MUST be outside the live corpus.
  if (isInside(opts.stagingDir, opts.neuronsDir)) { errors.push(`staging dir is INSIDE neurons dir — refusing (containment)`); return { manifest: mk("error", []), exitCode: 1 }; }

  const corpusBefore = corpusHash(opts.neuronsDir);
  const files = readdirSync(proposedDir).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) { errors.push("no proposed-neurons/*.md to promote"); return { manifest: mk("error", []), exitCode: 1 }; }

  // ── Parse + classify + assign ids ─────────────────────────────────────────
  type Parsed = { slug: string; source: string; raw: string; cat: NeuronCategory; fm: Record<string, unknown> };
  const parsed: Parsed[] = [];
  for (const f of files) {
    const source = join(proposedDir, f);
    const raw = readFileSync(source, "utf-8");
    const { data } = matter(raw);
    const type = String((data as Record<string, unknown>).type ?? "");
    const cat = TYPE_TO_CAT[type];
    if (!cat) { errors.push(`${f}: unsupported type '${type}' (v1 promotes error/decision/pattern only)`); continue; }
    parsed.push({ slug: basename(f, ".md"), source, raw, cat, fm: data as Record<string, unknown> });
  }
  if (errors.length) return { manifest: mk("error", []), exitCode: 1 };

  // assign contiguous ids per category (stable order = filename sort)
  const byCat = new Map<NeuronCategory, Parsed[]>();
  for (const p of parsed) (byCat.get(p.cat) ?? byCat.set(p.cat, []).get(p.cat)!).push(p);
  const idMap = new Map<string, string>(); // slug → real id
  const items: PromotionItem[] = [];
  const allocate = deps.nextIds ?? nextIds;
  for (const [cat, list] of byCat) {
    const ids = allocate(opts.neuronsDir, cat, list.length);
    list.forEach((p, i) => {
      idMap.set(p.slug, ids[i]);
      items.push({ source_file: p.source, slug: p.slug, category: cat, id: ids[i], dest_file: join(opts.neuronsDir, cat, `${ids[i]}.md`), scope: String(p.fm.project ?? p.fm.scope ?? "") });
    });
  }

  // ── Build transformed content + validate ──────────────────────────────────
  const corpusIds = new Set(listNeurons(opts.neuronsDir).map((n) => extractNeuronId(n.filename)));
  const promotedIds = new Set(items.map((it) => it.id.toUpperCase()));
  const built = new Map<string, string>(); // id → content
  for (const it of items) {
    const p = parsed.find((x) => x.slug === it.slug)!;
    const content = transform(p.raw, it.id, idMap);
    // secret scan (block if redaction would change anything)
    if (redactSecrets(content) !== content) { errors.push(`${it.slug}: secret detected — refusing to promote`); continue; }
    // residual placeholder checks (id / heading / real proposed-link) — prose is OK
    const fmId = String(matter(content).data.id ?? "");
    if (fmId.startsWith("PROPOSED")) errors.push(`${it.slug}: frontmatter id still PROPOSED`);
    if (PLACEHOLDER_HEAD.test(content)) errors.push(`${it.slug}: heading still PROPOSED`);
    if (REAL_PROPOSED_LINK.test(content)) errors.push(`${it.slug}: unrewritten [[PROPOSED-…]] cross-link`);
    if (!isValidNeuronId(it.id)) errors.push(`${it.slug}: assigned id '${it.id}' is not a valid neuron id`);
    // overwrite guard
    if (existsSync(it.dest_file)) errors.push(`${it.id}: destination already exists — refusing overwrite`);
    if (!isInside(it.dest_file, opts.neuronsDir)) errors.push(`${it.id}: destination escapes neurons dir`);
    // cross-link resolvability (warn, not block): neuron-id links must resolve
    for (const m of content.matchAll(/\[\[((?:NE|ND|NP|NF|NB)[A-Za-z0-9-]*)\]\]/g)) {
      const tgt = extractNeuronId(m[1]);
      if (!corpusIds.has(tgt) && !promotedIds.has(tgt)) warnings.push(`${it.id}: cross-link [[${m[1]}]] does not resolve (yet)`);
    }
    built.set(it.id, content);
  }
  if (errors.length) return { manifest: mk("error", items), exitCode: 1 };

  // ── DRY-RUN: plan + manifest PREVIEW (no writes, no API) ───────────────────
  if (!opts.apply) {
    log(`[promote-staged] DRY-RUN: ${items.length} to promote → ${items.map((i) => i.id).join(", ")}`);
    log(`[promote-staged] embeddings would target: ${items.map((i) => i.id).join(", ")}`);
    return { manifest: mk("dry-run", items, { corpus_hash_before: corpusBefore, corpus_hash_after: corpusBefore }), exitCode: 0 };
  }

  // ── APPLY ─────────────────────────────────────────────────────────────────
  const hasKey = (deps.hasKey ?? (() => !!getApiKey()))();
  if (!hasKey && !opts.allowPendingEmbeddings) {
    errors.push(`no Gemini credentials (env GEMINI_API_KEY or keyfile) — refusing to promote without embeddings; pass --allow-pending-embeddings to override`);
    return { manifest: mk("error", items), exitCode: 1 };
  }

  // build in temp + verify, then O_EXCL move
  const tmp = mkdtempSync(join(tmpdir(), "promote-"));
  try {
    for (const it of items) writeFileSync(join(tmp, `${it.id}.md`), built.get(it.id)!, "utf-8");
    // verify temp once more (defense in depth)
    for (const it of items) {
      const c = readFileSync(join(tmp, `${it.id}.md`), "utf-8");
      if (REAL_PROPOSED_LINK.test(c) || PLACEHOLDER_HEAD.test(c) || redactSecrets(c) !== c) {
        errors.push(`${it.id}: temp verification failed`);
      }
    }
    if (errors.length) return { manifest: mk("error", items, { corpus_hash_before: corpusBefore, corpus_hash_after: corpusBefore }), exitCode: 1 };
    // pre-check no overwrite for ALL before writing ANY
    for (const it of items) if (existsSync(it.dest_file)) { errors.push(`${it.id}: destination appeared — abort`); }
    if (errors.length) return { manifest: mk("error", items, { corpus_hash_before: corpusBefore, corpus_hash_after: corpusBefore }), exitCode: 1 };
    // move with O_EXCL (create-only)
    for (const it of items) {
      mkdirSync(join(opts.neuronsDir, it.category), { recursive: true });
      writeFileSync(it.dest_file, built.get(it.id)!, { encoding: "utf-8", flag: "wx" });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  log(`[promote-staged] promoted ${items.length} → ${items.map((i) => i.id).join(", ")}`);

  // ── Targeted embeddings (ONLY the promoted ids) ───────────────────────────
  let embStatus: PromotionManifest["status"] = "success";
  let embedded: string[] = [];
  let missing: string[] = [];
  let backupPath: string | null = null;
  let attempted = false;

  if (!hasKey) {
    embStatus = "embeddings_pending";
    missing = items.map((i) => i.id);
    warnings.push(`PROMOTED WITHOUT EMBEDDINGS (--allow-pending-embeddings): ${missing.join(", ")} — run embeddings --ids before relying on semantic recall`);
  } else {
    attempted = true;
    const runner = deps.embed ?? (async (ids, nd) => {
      const r = await runEmbeddings({ neuronsDir: nd, ids, dryRun: false, forceFull: false, forceRebuild: false }, { log });
      return { ok: r.mode === "write" && r.exitCode === 0 && r.failed.length === 0, embedded: r.embedded, failed: r.failed, backupPath: r.backupPath };
    });
    const r = await runner(items.map((i) => i.id), opts.neuronsDir);
    embedded = r.embedded; backupPath = r.backupPath;
    // internal verification (NO MCP): vectors present, right dim, non-zero
    const verified = verifyVectors(opts.neuronsDir, items.map((i) => i.id));
    missing = items.map((i) => i.id).filter((id) => !verified.has(id));
    if (!r.ok || missing.length > 0) {
      embStatus = "embeddings_failed";
      warnings.push(`embeddings incomplete — missing vectors for: ${missing.join(", ") || "(provider reported failure)"}`);
    }
  }

  const corpusAfter = corpusHash(opts.neuronsDir);
  const manifest = mk(embStatus, items, {
    embeddings_attempted: attempted, embeddings_succeeded: embedded, embeddings_missing: missing,
    index_backup_path: backupPath, corpus_hash_before: corpusBefore, corpus_hash_after: corpusAfter,
  });
  // manifest ALWAYS written on --apply (incl. the half-state)
  writeFileSync(join(opts.stagingDir, "PROMOTION-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  log(`[promote-staged] status=${embStatus}; manifest written to ${join(opts.stagingDir, "PROMOTION-MANIFEST.json")}`);
  return { manifest, exitCode: embStatus === "success" ? 0 : 1 };
}

/** Read the live index and return the set of ids whose vector is present, correctly
 *  dimensioned and non-zero. No MCP, no network. */
export function verifyVectors(neuronsDir: string, ids: string[]): Set<string> {
  const idxPath = join(resolve(neuronsDir, ".."), ".neuron-embeddings.json");
  const ok = new Set<string>();
  if (!existsSync(idxPath)) return ok;
  let idx: { dimensions?: number; entries?: Record<string, { vector?: number[] }> };
  try { idx = JSON.parse(readFileSync(idxPath, "utf-8")); } catch { return ok; }
  const dim = idx.dimensions ?? 0;
  const entries = idx.entries ?? {};
  for (const id of ids) {
    const v = entries[`${id}.md`]?.vector;
    if (Array.isArray(v) && v.length === dim && dim > 0 && v.some((x) => Math.abs(x) > 1e-9)) ok.add(id);
  }
  return ok;
}

// ── CLI wrapper ─────────────────────────────────────────────────────────────
interface CliOpts extends PromoteOptions { format: "json" | "md"; help?: boolean; }

function parseArgs(argv: string[]): CliOpts {
  const o: CliOpts = { stagingDir: "", neuronsDir: "", apply: false, allowPendingEmbeddings: false, format: "md" };
  const need = (i: number, f: string): string => { const v = argv[i]; if (v === undefined || v.startsWith("--")) throw new Error(`missing value for ${f}`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--staging-dir") o.stagingDir = need(++i, a);
    else if (a === "--neurons-dir") o.neuronsDir = need(++i, a);
    else if (a === "--apply") o.apply = true;
    else if (a === "--allow-pending-embeddings") o.allowPendingEmbeddings = true;
    else if (a === "--format") { const r = need(++i, a).toLowerCase(); if (r !== "json" && r !== "md") throw new Error(`--format must be json|md`); o.format = r as "json" | "md"; }
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

const USAGE = `usage:
  node dist/promote-staged-cli.js --staging-dir <dir> --neurons-dir <dir> [--apply] [--allow-pending-embeddings] [--format json|md]

Default is DRY-RUN (no writes, no API). --apply promotes + embeds. Report → stdout, progress → stderr.`;

async function main(): Promise<void> {
  let opts: CliOpts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`[promote-staged] ${(e as Error).message}`); console.error(USAGE); process.exit(1); return; }
  if (opts.help) { console.error(USAGE); process.exit(0); return; }
  if (!opts.stagingDir || !opts.neuronsDir) { console.error(`[promote-staged] --staging-dir and --neurons-dir are required`); console.error(USAGE); process.exit(1); return; }
  const { manifest, exitCode } = await runPromote(opts);
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[promote-staged] ${(e as Error).message}`); process.exit(1); });
}
