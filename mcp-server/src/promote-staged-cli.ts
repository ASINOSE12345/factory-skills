/**
 * promote-staged-cli — governed promotion of staged neurons into the live corpus,
 * with MANDATORY targeted embeddings, in ONE operation. Default is DRY-RUN; writing
 * requires an explicit `--apply`.
 *
 * Flow:  staging → validate → temp build → verify → O_EXCL create in corpus →
 *        targeted embeddings (only the promoted IDs) → internal index verification → manifest
 *
 * Why this exists: promoting neurons by hand (twice) left them in the corpus but
 * WITHOUT embeddings, so semantic ranking buried the night's best knowledge. This
 * tool makes "promoted but unembedded" impossible: it refuses to promote when it
 * cannot also embed (unless `--allow-pending-embeddings`), and it always leaves a
 * PROMOTION-MANIFEST.json for traceability — including the half-state case.
 *
 * Guarantees / non-goals:
 *  - NO daemon, NO watcher, NO hooks, NO auto-promote. Human-triggered only.
 *  - NEVER uses create_neuron. Builds + verifies in a temp dir, then writes each
 *    destination with O_EXCL ('wx', create-only) — never clobbers an existing file.
 *  - NEVER calls the MCP tools (search/think). Retrieval verification is internal
 *    (vectors present in the index, correct dimension, non-zero). MCP smoke is a
 *    separate manual step.
 *  - Path containment: destinations live INSIDE neurons/<category>/; the staging
 *    dir must live OUTSIDE neurons/.
 *  - Secret scan (redactSecrets) before any write; refuses on a detected secret.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve, relative, sep, basename } from "node:path";
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

/** Resolve a path through symlinks (PHYSICAL). Uses the native resolver when available. */
function realP(p: string): string {
  const n = (realpathSync as unknown as { native?: (x: string) => string }).native;
  return n ? n(p) : realpathSync(p);
}
/** Physical containment: BOTH paths resolved through symlinks, then compared. Lexical
 *  resolve()/startsWith is NOT enough — a symlink could escape the contract (CP3 lesson
 *  NP-059/NE-618/NE-619). Both paths must exist. */
function physInside(child: string, parent: string): boolean {
  const c = realP(child), p = realP(parent);
  return c === p || c.startsWith(p + sep);
}
const isSymlink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** sha256 over the sorted (relpath:sha256(content)) of EVERY .md under neuronsDir —
 *  a RAW recursive walk (NOT listNeurons, which silently drops invalid frontmatter),
 *  so the hash never lies. Symlinked subdirs are not descended (we never follow links
 *  out of the corpus). Deterministic. */
function corpusHash(neuronsDir: string): string {
  if (!existsSync(neuronsDir)) return createHash("sha256").update("").digest("hex");
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const fp = join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(`${relative(neuronsDir, fp)}:${createHash("sha256").update(readFileSync(fp)).digest("hex")}`);
    }
  };
  walk(neuronsDir);
  return createHash("sha256").update(out.sort().join("\n")).digest("hex");
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
/** Normalize a title for basic duplicate detection (strip leading id, punctuation, case). */
const normTitle = (t: string): string => t.replace(/^(?:NE|ND|NP|NF|NB)[A-Za-z0-9-]*:\s*/i, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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
  // PHYSICAL containment (realpath, not lexical) — symlinks must not escape the contract.
  if (isSymlink(proposedDir)) { errors.push(`proposed-neurons is a symlink — refusing (containment)`); return { manifest: mk("error", []), exitCode: 1 }; }
  const neuronsReal = realP(opts.neuronsDir);
  const stagingReal = realP(opts.stagingDir);
  if (stagingReal === neuronsReal || stagingReal.startsWith(neuronsReal + sep)) { errors.push(`staging dir resolves INSIDE neurons dir — refusing (containment)`); return { manifest: mk("error", []), exitCode: 1 }; }
  if (neuronsReal.startsWith(stagingReal + sep)) { errors.push(`neurons dir resolves INSIDE staging dir — refusing (containment)`); return { manifest: mk("error", []), exitCode: 1 }; }

  const corpusBefore = corpusHash(opts.neuronsDir);
  const files = readdirSync(proposedDir).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) { errors.push("no proposed-neurons/*.md to promote"); return { manifest: mk("error", []), exitCode: 1 }; }

  // ── Parse + classify + assign ids ─────────────────────────────────────────
  type Parsed = { slug: string; source: string; raw: string; cat: NeuronCategory; fm: Record<string, unknown> };
  const parsed: Parsed[] = [];
  for (const f of files) {
    const source = join(proposedDir, f);
    if (isSymlink(source)) { errors.push(`${f}: proposed file is a symlink — refusing`); continue; }
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
  const corpus = listNeurons(opts.neuronsDir);
  const corpusIds = new Set(corpus.map((n) => extractNeuronId(n.filename)));
  const existingTitles = new Set(corpus.map((n) => normTitle(n.title)));
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
    if (!resolve(it.dest_file).startsWith(resolve(opts.neuronsDir) + sep)) errors.push(`${it.id}: destination escapes neurons dir (lexical)`); // physical containment enforced at write
    // dedup (basic, warn-only): same normalized title as an existing corpus neuron
    const dupTitle = content.match(/^#\s+\S+:\s*(.+)$/m)?.[1] ?? "";
    if (dupTitle && existingTitles.has(normTitle(dupTitle))) warnings.push(`${it.id}: possible duplicate — an existing neuron shares the title "${dupTitle}"`);
    // cross-link resolvability (warn, not block): neuron-id links must resolve
    for (const m of content.matchAll(/\[\[((?:NE|ND|NP|NF|NB)[A-Za-z0-9-]*)\]\]/g)) {
      const tgt = extractNeuronId(m[1]);
      if (!corpusIds.has(tgt) && !promotedIds.has(tgt)) warnings.push(`${it.id}: cross-link [[${m[1]}]] does not resolve (yet)`);
    }
    built.set(it.id, content);
  }
  // ── DRY-RUN: plan preview (no writes, no API, NO manifest) ──────────────────
  if (!opts.apply) {
    if (errors.length) return { manifest: mk("error", items, { corpus_hash_before: corpusBefore, corpus_hash_after: corpusBefore }), exitCode: 1 };
    log(`[promote-staged] DRY-RUN: ${items.length} → ${items.map((i) => i.id).join(", ")}`);
    log(`[promote-staged] embeddings would target: ${items.map((i) => i.id).join(", ")}`);
    return { manifest: mk("dry-run", items, { corpus_hash_before: corpusBefore, corpus_hash_after: corpusBefore }), exitCode: 0 };
  }

  // ── APPLY — a PROMOTION-MANIFEST.json is ALWAYS written from here, even on a
  //    mid-way failure or thrown error: no half-state without traceability. ─────
  let status: PromotionManifest["status"] = "success";
  let embedded: string[] = [];
  let missing: string[] = [];
  let backupPath: string | null = null;
  let attempted = false;
  const written: string[] = [];

  const applyPhase = async (): Promise<void> => {
    if (errors.length) { status = "error"; return; } // validation failed → manifest only, no writes
    const hasKey = (deps.hasKey ?? (() => !!getApiKey()))();
    if (!hasKey && !opts.allowPendingEmbeddings) {
      errors.push(`no Gemini credentials (env GEMINI_API_KEY or keyfile) — refusing to promote without embeddings; pass --allow-pending-embeddings`);
      status = "error"; return;
    }
    // Build + verify in a temp dir, then CREATE each destination with O_EXCL
    // (flag 'wx', create-only) from the verified content — NOT a rename; O_EXCL
    // guarantees we never clobber an existing neuron.
    const tmp = mkdtempSync(join(tmpdir(), "promote-"));
    try {
      for (const it of items) writeFileSync(join(tmp, `${it.id}.md`), built.get(it.id)!, "utf-8");
      for (const it of items) {
        const c = readFileSync(join(tmp, `${it.id}.md`), "utf-8");
        if (REAL_PROPOSED_LINK.test(c) || PLACEHOLDER_HEAD.test(c) || redactSecrets(c) !== c) errors.push(`${it.id}: temp verification failed`);
      }
      if (errors.length) { status = "error"; return; }
      for (const it of items) if (existsSync(it.dest_file)) errors.push(`${it.id}: destination already exists — refusing overwrite`);
      if (errors.length) { status = "error"; return; }
      for (const it of items) {
        const catDir = join(opts.neuronsDir, it.category);
        mkdirSync(catDir, { recursive: true });
        if (!physInside(catDir, neuronsReal)) { errors.push(`${it.id}: category dir escapes neurons dir (symlink)`); status = "error"; return; }
        writeFileSync(join(realP(catDir), `${it.id}.md`), built.get(it.id)!, { encoding: "utf-8", flag: "wx" }); // O_EXCL
        written.push(it.id);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    log(`[promote-staged] promoted ${written.length} → ${written.join(", ")}`);

    // targeted embeddings (ONLY the promoted ids)
    if (!(deps.hasKey ?? (() => !!getApiKey()))()) {
      status = "embeddings_pending"; missing = items.map((i) => i.id);
      warnings.push(`PROMOTED WITHOUT EMBEDDINGS (--allow-pending-embeddings): ${missing.join(", ")} — run embeddings --ids before relying on semantic recall`);
      return;
    }
    attempted = true;
    const runner = deps.embed ?? (async (ids, nd) => {
      const r = await runEmbeddings({ neuronsDir: nd, ids, dryRun: false, forceFull: false, forceRebuild: false }, { log });
      return { ok: r.mode === "write" && r.exitCode === 0 && r.failed.length === 0, embedded: r.embedded, failed: r.failed, backupPath: r.backupPath };
    });
    const r = await runner(items.map((i) => i.id), opts.neuronsDir);
    embedded = r.embedded; backupPath = r.backupPath;
    const verified = verifyVectors(opts.neuronsDir, items.map((i) => i.id)); // NO MCP — read index directly
    missing = items.map((i) => i.id).filter((id) => !verified.has(id));
    if (!r.ok || missing.length > 0) { status = "embeddings_failed"; warnings.push(`embeddings incomplete — missing: ${missing.join(", ") || "(provider failure)"}`); }
  };

  try {
    await applyPhase();
  } catch (e) {
    errors.push(`apply failed: ${(e as Error).message}`);
    if (status === "success") status = attempted ? "embeddings_failed" : "error";
  }
  if (written.length > 0 && written.length < items.length) warnings.push(`PARTIAL: wrote ${written.length}/${items.length}: [${written.join(", ")}]`);

  const manifest = mk(status, items, {
    embeddings_attempted: attempted, embeddings_succeeded: embedded, embeddings_missing: missing,
    index_backup_path: backupPath, corpus_hash_before: corpusBefore, corpus_hash_after: corpusHash(opts.neuronsDir),
  });
  try {
    writeFileSync(join(opts.stagingDir, "PROMOTION-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    log(`[promote-staged] status=${status}; manifest written`);
  } catch (e) {
    log(`[promote-staged] WARN: could not write manifest: ${(e as Error).message}`);
  }
  return { manifest, exitCode: status === "success" ? 0 : 1 };
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

/** Render a manifest as a Markdown summary (for --format md). */
export function renderManifestMd(m: PromotionManifest): string {
  const L: string[] = [];
  L.push(`# Promotion — ${m.status}`, "");
  L.push(`- staging: \`${m.staging_dir}\``);
  L.push(`- neurons: \`${m.neurons_dir}\``);
  L.push(`- tool: v${m.tool_version} · sha \`${m.tool_git_sha}\` · ${m.generated_at}`);
  L.push(`- corpus hash: \`${m.corpus_hash_before.slice(0, 12)}\` → \`${m.corpus_hash_after.slice(0, 12)}\``);
  L.push(`- embeddings: attempted=${m.embeddings_attempted} succeeded=${m.embeddings_succeeded.length} missing=${m.embeddings_missing.length}`, "");
  L.push(`## Promoted (${m.promoted.length})`, `| id | category | scope | source |`, `|---|---|---|---|`);
  for (const p of m.promoted) L.push(`| ${p.id} | ${p.category} | ${p.scope} | ${basename(p.source_file)} |`);
  if (m.warnings.length) { L.push("", `## Warnings`); for (const w of m.warnings) L.push(`- ${w}`); }
  if (m.errors.length) { L.push("", `## Errors`); for (const e of m.errors) L.push(`- ${e}`); }
  return L.join("\n") + "\n";
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
  process.stdout.write(opts.format === "md" ? renderManifestMd(manifest) : JSON.stringify(manifest, null, 2) + "\n");
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[promote-staged] ${(e as Error).message}`); process.exit(1); });
}
