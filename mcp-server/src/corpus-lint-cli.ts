#!/usr/bin/env node
/**
 * corpus-lint-cli.ts — READ-ONLY corpus debt measurement for the neuron corpus.
 *
 * Measures the REAL debt of the neuron corpus from a RAW recursive walk of every
 * `.md` under neuronsDir — NOT from listNeurons(), which silently drops files with
 * invalid frontmatter / bad names (precisely the categories this lint exists to
 * find). ID/filename validity is derived ONLY from extractNeuronId + isValidNeuronId
 * (neuron-refs.ts) — no parallel ID regex, so the heterogeneous real corpus
 * (NB-F-001-slug, NF-5c11-slug, NE-327-slug) is never mis-flagged.
 *
 * Guarantees: read-only (no writes anywhere), no API calls, no embedding
 * generation. Exit 0 by default even with findings; exit 1 ONLY under --strict
 * when a critical finding exists. Progress → stderr, report → stdout. Never prints
 * neuron bodies — samples are ids/relpaths only.
 */
import { readFileSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import {
  type Neuron,
  type NeuronCategory,
  projectScopeOf,
} from "./neurons.js";
import {
  extractNeuronId,
  isValidNeuronId,
  classifyCorpusRefs,
  type RefEntry,
} from "./neuron-refs.js";
import { loadRegistry, normalizeToken, NON_INDEXED_ENTITY_TYPES, type LoadedRegistry } from "./registry.js";
import { toolMetadata, toolMetadataMarkdown, type ToolMetadata } from "./tool-metadata.js";

const KNOWN_CATEGORIES: NeuronCategory[] = ["errors", "decisions", "patterns", "foundations", "business"];
const KNOWN_SET = new Set<string>(KNOWN_CATEGORIES);

/** Critical issue codes that make --strict exit 1. (secret-scan deferred to v2.) */
const STRICT_CRITICAL_CODES = [
  "invalid_frontmatter",
  "invalid_filename",
  "unknown_category_file",
  "broken_neuron_refs",
  "staging_proposed_in_corpus",
  "organization_or_lineage_as_project",
] as const;

// ── Options & report shapes ────────────────────────────────────────────────
export interface LintOptions {
  neuronsDir: string;
  registryPath?: string;
  embeddingsIndexPath?: string;
  top: number;
  strictRequested: boolean;
}

export interface LintReport {
  tool: "corpus-lint";
  strict_requested: boolean;
  neurons_dir: string;
  total_files: number;
  parseable_neurons: number;
  by_category: Record<string, number>;
  files: {
    invalid_frontmatter: number;
    invalid_filename: number;
    unknown_category_file: number;
    symlink_skipped: number;
    samples: string[];
  };
  frontmatter: {
    missing_project: number;
    missing_scope: number;
    missing_both: number;
    missing_created: number;
    corrupt_created: number;
    missing_status: number;
    status_distribution: Record<string, number>;
    auto_captured: number;
    staging_proposed_in_corpus: number;
  };
  scope: {
    unknown_scope: number;
    global_or_softwarefactory: number;
    by_project: Record<string, number>;
    samples_unknown_scope: string[];
  };
  references: {
    broken_neuron_refs: number;
    legacy_or_external_refs: number;
    unknown_refs: number;
    samples: Record<string, RefEntry[]>;
  };
  registry_consistency: {
    checked: boolean;
    paperclip_project_scope: number;
    organization_or_lineage_as_project: number;
    registry_unknown_project: number;
    samples: string[];
  };
  embeddings: {
    checked: boolean;
    indexed: number;
    missing_embedding: number;
    samples_missing: string[];
  };
  auto_capture: {
    count: number;
    by_status: Record<string, number>;
    pending_fix_count: number;
    samples: string[];
  };
  candidate_duplicates: { checked: boolean; note: string };
  top_offenders: Array<{ file: string; id: string; issue_count: number; issues: string[] }>;
  summary: {
    neurons_with_any_issue: number;
    clean_parseable_neurons: number;
    strict_critical_total: number;
    strict_would_fail: boolean;
  };
  tool_version: string;
  tool_git_sha: string;
  generated_at: string;
}

// ── Pure helpers ───────────────────────────────────────────────────────────
const isSymlink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

function categoryOf(rel: string): string {
  const seg = rel.split(sep)[0] ?? "";
  return KNOWN_SET.has(seg) ? seg : "unknown";
}

/** "missing" | "ok" | "corrupt" — gray-matter parses unquoted YAML dates to Date. */
function createdState(v: unknown): "missing" | "ok" | "corrupt" {
  if (v === undefined || v === null || v === "") return "missing";
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return "corrupt";
  const y = d.getUTCFullYear();
  return y < 2000 || y > 2100 ? "corrupt" : "ok";
}

function sortedObj(rec: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k];
  return out;
}

interface RawFile { relpath: string; category: string; basename: string; content: string; }

/** RAW recursive walk: every .md under neuronsDir, plus symlinks reported (never followed). */
function rawWalk(neuronsDir: string): { files: RawFile[]; symlinks: string[] } {
  const files: RawFile[] = [];
  const symlinks: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = join(d, e.name);
      const rel = relative(neuronsDir, fp);
      if (e.isSymbolicLink() || isSymlink(fp)) { symlinks.push(rel); continue; } // never follow
      if (e.isDirectory()) { walk(fp); continue; }
      if (e.isFile() && e.name.endsWith(".md")) {
        files.push({ relpath: rel, category: categoryOf(rel), basename: e.name, content: readFileSync(fp, "utf-8") });
      }
    }
  };
  if (existsSync(neuronsDir)) walk(neuronsDir);
  files.sort((a, b) => a.relpath.localeCompare(b.relpath));
  symlinks.sort();
  return { files, symlinks };
}

// ── Core lint ──────────────────────────────────────────────────────────────
export function lintCorpus(opts: LintOptions, now: Date = new Date()): LintReport {
  const meta: ToolMetadata = toolMetadata(now);
  const { files: rawFiles, symlinks } = rawWalk(opts.neuronsDir);

  // Per-file issue accumulator (relpath → issue codes). Drives top_offenders + summary.
  const perFile = new Map<string, { relpath: string; id: string; issues: Set<string> }>();
  const addIssue = (relpath: string, id: string, code: string): void => {
    const cur = perFile.get(relpath) ?? { relpath, id, issues: new Set<string>() };
    cur.issues.add(code);
    perFile.set(relpath, cur);
  };

  const by_category: Record<string, number> = { errors: 0, decisions: 0, patterns: 0, foundations: 0, business: 0, unknown: 0 };
  const fileSamples: string[] = [];
  let invalid_frontmatter = 0, invalid_filename = 0, unknown_category_file = 0;

  let parseable = 0;
  let missing_project = 0, missing_scope = 0, missing_both = 0, missing_created = 0, corrupt_created = 0, missing_status = 0;
  const status_distribution: Record<string, number> = {};
  let auto_captured = 0, staging_proposed_in_corpus = 0;

  let unknown_scope = 0, global_or_sf = 0;
  const by_project: Record<string, number> = {};
  const samples_unknown_scope: string[] = [];

  const ac_by_status: Record<string, number> = {};
  let ac_pending = 0;
  const ac_samples: string[] = [];

  const parseableNeurons: Neuron[] = [];
  const idToRelpath = new Map<string, string>();
  const parseableRelpaths = new Set<string>();

  for (const f of rawFiles) {
    by_category[f.category] = (by_category[f.category] ?? 0) + 1;
    const id = extractNeuronId(f.basename);

    // Filename / ID validity — ONLY via neuron-refs (no parallel regex).
    if (!isValidNeuronId(id)) { invalid_filename++; addIssue(f.relpath, id, "invalid_filename"); fileSamples.push(f.relpath); }
    // Unknown category directory.
    if (f.category === "unknown") { unknown_category_file++; addIssue(f.relpath, id, "unknown_category_file"); fileSamples.push(f.relpath); }

    // Frontmatter parse — raw, may throw.
    let parsed: matter.GrayMatterFile<string>;
    try { parsed = matter(f.content); } catch { invalid_frontmatter++; addIssue(f.relpath, id, "invalid_frontmatter"); fileSamples.push(f.relpath); continue; }

    parseable++;
    const fm = parsed.data as Record<string, unknown>;
    const n: Neuron = {
      filename: f.basename,
      filepath: join(opts.neuronsDir, f.relpath),
      category: (KNOWN_SET.has(f.category) ? f.category : "errors") as NeuronCategory, // only used for refs idSet (via filename)
      frontmatter: fm,
      content: parsed.content,
      title: (parsed.content.match(/^#\s+(.+)$/m)?.[1] ?? "").trim(),
      modified: new Date(0),
    };
    parseableNeurons.push(n);
    parseableRelpaths.add(f.relpath);
    if (!idToRelpath.has(id)) idToRelpath.set(id, f.relpath);

    // Frontmatter quality.
    const project = String(fm.project ?? "").trim();
    const scope = String(fm.scope ?? "").trim();
    if (!project) { missing_project++; addIssue(f.relpath, id, "missing_project"); }
    if (!scope) { missing_scope++; addIssue(f.relpath, id, "missing_scope"); }
    if (!project && !scope) missing_both++;

    const cs = createdState(fm.created ?? fm.date);
    if (cs === "missing") { missing_created++; addIssue(f.relpath, id, "missing_created"); }
    else if (cs === "corrupt") { corrupt_created++; addIssue(f.relpath, id, "corrupt_created"); }

    const status = String(fm.status ?? "").trim();
    if (!status) { missing_status++; addIssue(f.relpath, id, "missing_status"); }
    status_distribution[status || "(none)"] = (status_distribution[status || "(none)"] ?? 0) + 1;

    const isAuto = fm.auto_captured === true;
    if (isAuto) {
      auto_captured++;
      addIssue(f.relpath, id, "auto_captured_stub");
      ac_by_status[status || "(none)"] = (ac_by_status[status || "(none)"] ?? 0) + 1;
      if (/pending/i.test(parsed.content)) ac_pending++;
      ac_samples.push(id);
    }

    const fmId = String(fm.id ?? "").trim().toUpperCase();
    if (status === "staging-proposed" || fmId.startsWith("PROPOSED")) {
      staging_proposed_in_corpus++;
      addIssue(f.relpath, id, "staging_proposed_in_corpus");
    }

    // Scope.
    const s = projectScopeOf(n);
    if (s === "unknown") { unknown_scope++; addIssue(f.relpath, id, "unknown_scope"); samples_unknown_scope.push(id); }
    else if (s === "global") global_or_sf++;
    else by_project[s] = (by_project[s] ?? 0) + 1;
  }

  // References — reuse neuron-refs over the parseable corpus (no duplicated regex).
  const refs = classifyCorpusRefs(parseableNeurons);
  // Attribute broken refs back to their container files (via sample_in) for top_offenders.
  for (const entry of refs.broken_neuron_refs) {
    for (const containerId of entry.sample_in ?? []) {
      const rel = idToRelpath.get(containerId.toUpperCase());
      if (rel) addIssue(rel, containerId.toUpperCase(), "broken_ref");
    }
  }

  // Registry consistency (optional).
  const registry_consistency: LintReport["registry_consistency"] = {
    checked: false, paperclip_project_scope: 0, organization_or_lineage_as_project: 0, registry_unknown_project: 0, samples: [],
  };
  if (opts.registryPath) {
    let reg: LoadedRegistry | null = null;
    try { reg = loadRegistry(opts.registryPath); } catch (e) {
      process.stderr.write(`[corpus-lint] registry load failed (${(e as Error).message}); registry checks skipped\n`);
    }
    if (reg) {
      registry_consistency.checked = true;
      // Tokens for non-indexed entities (organization / source_lineage) + the lineage subset.
      const nonIndexed = new Set<string>();
      const lineage = new Set<string>();
      for (const p of reg.raw.projects) {
        if (p.entity_type && NON_INDEXED_ENTITY_TYPES.has(p.entity_type)) {
          const toks = [p.project_id, ...(p.aliases ?? [])].map(normalizeToken).filter(Boolean);
          for (const t of toks) { nonIndexed.add(t); if (p.entity_type === "source_lineage") lineage.add(t); }
        }
      }
      const known = (s: string): boolean => {
        const norm = normalizeToken(s);
        return reg!.projectById.has(s) || reg!.aliasToProject.has(norm) ||
          [...reg!.projectById.values()].some((p) => normalizeToken(p.project_id) === norm);
      };
      for (const n of parseableNeurons) {
        const id = extractNeuronId(n.filename);
        const rel = idToRelpath.get(id) ?? n.filename;
        const tokens = [String(n.frontmatter.project ?? "").trim(), String(n.frontmatter.scope ?? "").trim()].filter(Boolean);
        let flaggedLineage = false;
        for (const t of tokens) {
          const norm = normalizeToken(t);
          if (nonIndexed.has(norm)) {
            registry_consistency.organization_or_lineage_as_project++;
            addIssue(rel, id, "organization_or_lineage_as_project");
            if (lineage.has(norm) && !flaggedLineage) { registry_consistency.paperclip_project_scope++; flaggedLineage = true; }
            registry_consistency.samples.push(id);
          }
        }
        const s = projectScopeOf(n);
        if (s !== "global" && s !== "unknown" && !known(s)) {
          registry_consistency.registry_unknown_project++;
          addIssue(rel, id, "registry_unknown_project");
        }
      }
    }
  }

  // Embeddings coverage (optional, read-only index read — no API, no generation).
  const embeddings: LintReport["embeddings"] = { checked: false, indexed: 0, missing_embedding: 0, samples_missing: [] };
  if (opts.embeddingsIndexPath) {
    if (!existsSync(opts.embeddingsIndexPath)) {
      process.stderr.write(`[corpus-lint] embeddings index not found at ${opts.embeddingsIndexPath}; coverage skipped\n`);
    } else {
      try {
        const idx = JSON.parse(readFileSync(opts.embeddingsIndexPath, "utf-8")) as { entries?: Record<string, unknown> };
        const entries = idx.entries ?? {};
        embeddings.checked = true;
        embeddings.indexed = Object.keys(entries).length;
        for (const n of parseableNeurons) {
          if (!(n.filename in entries)) {
            embeddings.missing_embedding++;
            const id = extractNeuronId(n.filename);
            addIssue(idToRelpath.get(id) ?? n.filename, id, "missing_embedding");
            embeddings.samples_missing.push(id);
          }
        }
      } catch (e) {
        process.stderr.write(`[corpus-lint] embeddings index parse failed (${(e as Error).message}); coverage skipped\n`);
      }
    }
  }

  // Top offenders + summary.
  const offenders = [...perFile.values()]
    .map((f) => ({ file: f.relpath, id: f.id, issue_count: f.issues.size, issues: [...f.issues].sort() }))
    .sort((a, b) => b.issue_count - a.issue_count || a.file.localeCompare(b.file));
  const neurons_with_any_issue = offenders.length;
  const issuedParseable = [...perFile.keys()].filter((rel) => parseableRelpaths.has(rel)).length;
  const clean_parseable_neurons = Math.max(0, parseable - issuedParseable);

  const broken_count = refs.broken_neuron_refs.length;
  const legacy_count = refs.legacy_or_external_refs.length;
  const unknown_ref_count = refs.unknown_refs.length;

  const strict_critical_total =
    invalid_frontmatter + invalid_filename + unknown_category_file +
    broken_count + staging_proposed_in_corpus + registry_consistency.organization_or_lineage_as_project;

  const cap = <T>(arr: T[]): T[] => arr.slice(0, opts.top);
  const dedupSorted = (arr: string[]): string[] => [...new Set(arr)].sort();

  return {
    tool: "corpus-lint",
    strict_requested: opts.strictRequested,
    neurons_dir: opts.neuronsDir,
    total_files: rawFiles.length,
    parseable_neurons: parseable,
    by_category: { ...by_category },
    files: {
      invalid_frontmatter,
      invalid_filename,
      unknown_category_file,
      symlink_skipped: symlinks.length,
      samples: cap(dedupSorted([...fileSamples, ...symlinks])),
    },
    frontmatter: {
      missing_project, missing_scope, missing_both, missing_created, corrupt_created, missing_status,
      status_distribution: sortedObj(status_distribution),
      auto_captured, staging_proposed_in_corpus,
    },
    scope: {
      unknown_scope, global_or_softwarefactory: global_or_sf,
      by_project: sortedObj(by_project),
      samples_unknown_scope: cap(dedupSorted(samples_unknown_scope)),
    },
    references: {
      broken_neuron_refs: broken_count,
      legacy_or_external_refs: legacy_count,
      unknown_refs: unknown_ref_count,
      samples: {
        broken: cap(refs.broken_neuron_refs),
        legacy_or_external: cap(refs.legacy_or_external_refs),
        unknown: cap(refs.unknown_refs),
      },
    },
    registry_consistency: {
      checked: registry_consistency.checked,
      paperclip_project_scope: registry_consistency.paperclip_project_scope,
      organization_or_lineage_as_project: registry_consistency.organization_or_lineage_as_project,
      registry_unknown_project: registry_consistency.registry_unknown_project,
      samples: cap(dedupSorted(registry_consistency.samples)),
    },
    embeddings: {
      checked: embeddings.checked,
      indexed: embeddings.indexed,
      missing_embedding: embeddings.missing_embedding,
      samples_missing: cap(dedupSorted(embeddings.samples_missing)),
    },
    auto_capture: {
      count: auto_captured,
      by_status: sortedObj(ac_by_status),
      pending_fix_count: ac_pending,
      samples: cap(dedupSorted(ac_samples)),
    },
    candidate_duplicates: { checked: false, note: "see dream-scan (mcp__factory-neurons__dream_scan)" },
    top_offenders: cap(offenders),
    summary: {
      neurons_with_any_issue,
      clean_parseable_neurons,
      strict_critical_total,
      strict_would_fail: strict_critical_total > 0,
    },
    tool_version: meta.tool_version,
    tool_git_sha: meta.tool_git_sha,
    generated_at: meta.generated_at,
  };
}

// ── Markdown rendering ─────────────────────────────────────────────────────
export function renderMarkdown(r: LintReport): string {
  const L: string[] = [];
  const kv = (rec: Record<string, number>): string =>
    Object.keys(rec).length ? Object.entries(rec).map(([k, v]) => `\`${k}\`: ${v}`).join(", ") : "_(none)_";

  L.push(`# corpus-lint`);
  L.push("");
  L.push(`## Summary`);
  L.push(`- neurons_dir: \`${r.neurons_dir}\``);
  L.push(`- total files: **${r.total_files}** · parseable: **${r.parseable_neurons}** · with issue: **${r.summary.neurons_with_any_issue}** · clean: **${r.summary.clean_parseable_neurons}**`);
  L.push(`- strict critical total: **${r.summary.strict_critical_total}** (${STRICT_CRITICAL_CODES.join(", ")})`);
  L.push(`- strict would ${r.summary.strict_would_fail ? "**FAIL** (exit 1)" : "PASS (exit 0)"}`);
  L.push("");
  L.push(`## Raw inventory`);
  L.push(`- by category: ${kv(r.by_category)}`);
  L.push(`- invalid_frontmatter: ${r.files.invalid_frontmatter} · invalid_filename: ${r.files.invalid_filename} · unknown_category_file: ${r.files.unknown_category_file} · symlink_skipped: ${r.files.symlink_skipped}`);
  if (r.files.samples.length) L.push(`- samples: ${r.files.samples.map((s) => `\`${s}\``).join(", ")}`);
  L.push("");
  L.push(`## Frontmatter quality`);
  L.push(`- missing project: ${r.frontmatter.missing_project} · scope: ${r.frontmatter.missing_scope} · both: ${r.frontmatter.missing_both}`);
  L.push(`- missing created: ${r.frontmatter.missing_created} · corrupt created: ${r.frontmatter.corrupt_created} · missing status: ${r.frontmatter.missing_status}`);
  L.push(`- status distribution: ${kv(r.frontmatter.status_distribution)}`);
  L.push(`- auto_captured: ${r.frontmatter.auto_captured} · staging_proposed_in_corpus: ${r.frontmatter.staging_proposed_in_corpus}`);
  L.push("");
  L.push(`## Scope / project coverage`);
  L.push(`- unknown scope: ${r.scope.unknown_scope} · global/softwarefactory: ${r.scope.global_or_softwarefactory}`);
  L.push(`- by project: ${kv(r.scope.by_project)}`);
  if (r.scope.samples_unknown_scope.length) L.push(`- unknown-scope samples: ${r.scope.samples_unknown_scope.map((s) => `\`${s}\``).join(", ")}`);
  L.push("");
  L.push(`## Auto-captured stubs`);
  L.push(`- count: ${r.auto_capture.count} · pending_fix: ${r.auto_capture.pending_fix_count}`);
  L.push(`- by status: ${kv(r.auto_capture.by_status)}`);
  if (r.auto_capture.samples.length) L.push(`- samples: ${r.auto_capture.samples.map((s) => `\`${s}\``).join(", ")}`);
  L.push("");
  L.push(`## References`);
  L.push(`- broken_neuron_refs: ${r.references.broken_neuron_refs} · legacy_or_external: ${r.references.legacy_or_external_refs} · unknown: ${r.references.unknown_refs}`);
  if (r.references.samples.broken?.length) L.push(`- broken samples: ${r.references.samples.broken.map((e) => `\`${e.ref}\`×${e.count}`).join(", ")}`);
  L.push("");
  L.push(`## Registry consistency`);
  if (!r.registry_consistency.checked) L.push(`- _not checked (no --registry)_`);
  else {
    L.push(`- paperclip/lineage scope: ${r.registry_consistency.paperclip_project_scope} · org_or_lineage_as_project: ${r.registry_consistency.organization_or_lineage_as_project} · registry_unknown_project: ${r.registry_consistency.registry_unknown_project}`);
    if (r.registry_consistency.samples.length) L.push(`- samples: ${r.registry_consistency.samples.map((s) => `\`${s}\``).join(", ")}`);
  }
  L.push("");
  L.push(`## Embeddings coverage`);
  if (!r.embeddings.checked) L.push(`- _not checked (no --embeddings-index)_`);
  else {
    L.push(`- indexed: ${r.embeddings.indexed} · missing_embedding: ${r.embeddings.missing_embedding}`);
    if (r.embeddings.samples_missing.length) L.push(`- missing samples: ${r.embeddings.samples_missing.map((s) => `\`${s}\``).join(", ")}`);
  }
  L.push("");
  L.push(`## Top offenders`);
  if (!r.top_offenders.length) L.push(`- _(none)_`);
  for (const o of r.top_offenders) L.push(`- \`${o.file}\` (${o.issue_count}): ${o.issues.join(", ")}`);
  L.push("");
  L.push(`## Candidate duplicates`);
  L.push(`- ${r.candidate_duplicates.note}`);
  L.push(toolMetadataMarkdown("corpus-lint", { tool_version: r.tool_version, tool_git_sha: r.tool_git_sha, generated_at: r.generated_at }));
  return L.join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────
export function parseArgs(argv: string[]): LintOptions & { format: "json" | "md" } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const neuronsDir = get("--neurons-dir");
  if (!neuronsDir) throw new Error("--neurons-dir <dir> is required");
  const fmt = get("--format") ?? "json";
  if (fmt !== "json" && fmt !== "md") throw new Error(`--format must be json|md (got ${fmt})`);
  const topRaw = get("--top");
  const top = topRaw ? Math.max(1, parseInt(topRaw, 10) || 20) : 20;
  return {
    neuronsDir,
    registryPath: get("--registry"),
    embeddingsIndexPath: get("--embeddings-index"),
    top,
    strictRequested: argv.includes("--strict"),
    format: fmt,
  };
}

export function main(argv: string[]): number {
  const opts = parseArgs(argv);
  process.stderr.write(`[corpus-lint] scanning ${opts.neuronsDir} (read-only)…\n`);
  const report = lintCorpus(opts);
  process.stderr.write(`[corpus-lint] ${report.total_files} files, ${report.parseable_neurons} parseable, ${report.summary.neurons_with_any_issue} with issues\n`);
  const out = opts.format === "md" ? renderMarkdown(report) : JSON.stringify(report, null, 2);
  process.stdout.write(out + "\n");
  return opts.strictRequested && report.summary.strict_critical_total > 0 ? 1 : 0;
}

// Entry point (ESM): run only when invoked directly.
const invokedDirectly = (() => {
  try { return process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1].endsWith("corpus-lint-cli.js") : false; }
  catch { return false; }
})();
if (invokedDirectly) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) { process.stderr.write(`[corpus-lint] ERROR: ${(e as Error).message}\n`); process.exit(2); }
}
