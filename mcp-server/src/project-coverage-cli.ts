/**
 * project-coverage-cli — READ-ONLY auditor that measures, objectively and
 * BEFORE any declarative registry exists, how well the local neuron corpus
 * covers the local Factory repos.
 *
 * Design (deliberate, deterministic, NO writes, NO network):
 *  - Reads the corpus through the real frontmatter parser (`listNeurons`,
 *    gray-matter) — never grep. Reuses the single source of truth for scope
 *    resolution (`projectScopeOf`, `canonicalProject`, `isGlobalScope`) so this
 *    tool and the MCP server can never disagree about what a neuron's scope is.
 *  - Never writes anything: no markdown, no `.factory/`, no embeddings. Output
 *    is a value (returned object) rendered to stdout; progress goes to stderr.
 *  - Coverage semantics are honest and never oversell (operator contract):
 *      covered_direct    = a DIRECT, project-specific canonical match where the
 *                          canonical maps to exactly ONE local repo.
 *      ambiguous         = a STRONG candidate only (alias/prefix or a multi-repo
 *                          cluster sharing/related-to a canonical) — NEVER
 *                          counted as covered. Always carries `evidence`.
 *      uncovered         = no direct project-specific match and no strong
 *                          candidate.
 *      global_only       = a subset of uncovered: only global/factory-wide
 *                          knowledge applies (no project-specific neurons).
 *                          Reported as uncovered WITH a "global-only" note and
 *                          counted separately. Global knowledge never makes a
 *                          repo "covered".
 *  - Nested repos and bare repos are reported as a SEPARATE anomaly list — never
 *    silently merged with top-level working-tree repos.
 *  - Honest limit: this measures LOCAL coverage (repos with .git under the
 *    factory root + the local corpus). It makes NO claim about GitHub-total
 *    coverage and never calls any network/GitHub API.
 */

import { readFileSync, readdirSync, existsSync, statSync, type Dirent } from "node:fs";
import { join, basename, relative } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  listNeurons,
  projectScopeOf,
  canonicalProject,
  isGlobalScope,
  type Neuron,
  type NeuronCategory,
} from "./neurons.js";
import { loadRegistry, NON_INDEXED_ENTITY_TYPES, type LoadedRegistry, type ProjectStatus } from "./registry.js";

// ── Constants / heuristics (documented, never silent) ───────────────────────

const CATEGORY_DIRS: NeuronCategory[] = ["errors", "decisions", "patterns", "foundations", "business"];

/** Canonical neuron-id shape. The corpus uses bare numeric ids (NE-329), hex ids
 *  (NF-f409), and sub-namespaced ids (NB-F-001, NB-UV-def4). Filenames append a
 *  descriptive slug after the id (NE-329-ts-errors-introduced.md); the id is the
 *  LEADING token — which is exactly what references in prose use. */
//  number component is a 4-char hex hash (f409, 6683 — may be all-digits) OR a
//  3-digit sequential id (001–619), optionally preceded by a 1–3 letter
//  sub-namespace (NB-F, NB-UV, NB-JB, NB-PS). 4-hex is tried FIRST so an
//  all-digit hash like "6683" is not truncated to "668" by the 3-digit branch;
//  the exact lengths also stop a slug like "NB-F-pricing" from reading as "NB-F".
const NEURON_ID_CORE = "(?:NE|ND|NP|NF|NB)(?:-[A-Za-z]{1,3})?-(?:[0-9A-Fa-f]{4}|\\d{3})";
const NEURON_ID_RE = new RegExp(`\\b${NEURON_ID_CORE}\\b`, "gi");
const NEURON_ID_HEAD_RE = new RegExp(`^${NEURON_ID_CORE}`, "i");
/** Pattern-reference ids (human reference, NOT neuron files): PAT-FX-010, PAT-UV-003. */
const PATTERN_ID_RE = /\bPAT-[A-Z]{2,}-\d+\b/gi;
/** Product short-ids used in prose / issues — external, NOT neuron files. */
const PRODUCT_ID_RE = /\b(?:UV|PS|PSV|JBC|OC)-\d+\b/gi;
/** GitHub-style issue references. */
const ISSUE_RE = /#\d+\b/g;
/** Generic CODE-REF shape that is neither a neuron id nor a known legacy family. */
const GENERIC_REF_RE = /\b[A-Z]{2,5}-\d+\b/g;
/** File-path / URL mentions — counted only (not enumerated as confusable refs). */
const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const PATH_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|py|sql|sh|toml)\b/gi;

/** Substrings that mark a token as factory-wide / shared (used for global-only). */
const GLOBAL_KEYWORDS = ["softwarefactory", "factory", "crossproject", "global"];
/** Tokens that are placeholders, not real projects (data smells). */
const PLACEHOLDER_TOKENS = new Set(["project", "f", "x", "none", "na", "tbd", "todo", "scope", "type"]);
/** Min length before two tokens may be considered prefix-related (avoids noise). */
const MIN_REL_LEN = 4;
/** Directories never descended into during repo discovery. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", ".turbo", "coverage"]);
/** Cap for enumerated legacy/path/url ref entries (with an explicit truncation note). */
const REF_ENUM_CAP = 200;

// ── Report shape ────────────────────────────────────────────────────────────

export type RepoClassification = "covered" | "ambiguous" | "uncovered";

export interface RepoCandidate {
  canonical: string;
  via: "alias-prefix" | "multi-repo-sibling";
  neuron_count: number;
  sibling_repo?: string;
}

export interface RepoEntry {
  repo_id: string;
  name: string;
  rel_path: string;
  canonical: string;
  classification: RepoClassification;
  /** uncovered + only global/factory knowledge applies. */
  global_only: boolean;
  /** count of project-specific neurons resolving DIRECTLY to this repo's canonical. */
  direct_neuron_count: number;
  /** sibling repo_ids forming a multi-repo cluster (no registry to disambiguate). */
  siblings: string[];
  candidates: RepoCandidate[];
  evidence: string[];
  /** Set only in registry-projection mode (`--registry`). `classification` above
   *  stays the BASELINE (direct/heuristic) value; this is the registry's view. */
  registry_project_id?: string;
  registry_role?: string;
  registry_status?: ProjectStatus;
  registry_classification?: RegistryClassification;
}

export interface AnomalyEntry {
  type: "nested_repo" | "bare_repo";
  rel_path: string;
  path: string;
  note: string;
}

export interface DetectedProject {
  canonical: string;
  neuron_count: number;
  has_local_repo: boolean;
  direct_repos: string[];
  candidate_repos: string[];
  source: "both" | "neuron" | "repo";
}

export interface RefEntry {
  ref: string;
  kind?: string;
  count: number;
  sample_in?: string[];
}

export interface ProjectCoverageReport {
  factory_root: string;
  tool: string;
  scan: {
    repo_max_depth: number;
    neurons_dir: string;
    corpus_sha256: string;
    repos_scanned: number;
  };
  repos: RepoEntry[];
  anomalies: AnomalyEntry[];
  detected_projects: DetectedProject[];
  coverage: {
    covered: string[];
    uncovered: string[];
    ambiguous: string[];
  };
  // summary ALWAYS uses baseline semantics: `covered_direct` means a DIRECT
  // token/canonical match — it is NOT recomputed by the registry. Registry
  // projection lives entirely in the `registry` block below.
  summary: {
    repos_total: number;
    covered_direct: number;
    ambiguous_candidates: number;
    uncovered: number;
    global_only: number;
    anomalies: number;
    projects_with_neurons_no_repo: number;
  };
  neurons: {
    total: number;
    by_category: Record<NeuronCategory, number>;
    global: number;
    unknown_scope: Array<{ id: string; category: NeuronCategory }>;
    unknown_scope_by_category: Record<NeuronCategory, number>;
    inconsistent_scope_tokens: Array<{ token: string; count: number; sample_ids: string[] }>;
  };
  references: {
    broken_neuron_refs: RefEntry[];
    legacy_or_external_refs: RefEntry[];
    unknown_refs: RefEntry[];
    diagnostics: { path_like_mentions: number; url_mentions: number; truncated: boolean };
  };
  aliases: {
    source_file: string | null;
    collisions: Array<{ alias: string; canonicals: string[]; note: string }>;
  };
  recommendations: Array<{ priority: "high" | "medium" | "low"; kind: string; message: string }>;
  /** Present only when run with `--registry` (projection mode); null in baseline. */
  registry: RegistryProjection | null;
}

/**
 * Registry projection metrics. These are DELIBERATELY named to NOT be read as a
 * "direct match": `covered_project_specific` means "repo is bound by the registry
 * to a project that has project-specific neurons" — which is weaker than the
 * baseline `summary.covered_direct` (a direct token/canonical match). e.g. a
 * `web` component repo is covered_project_specific because the registry attributes
 * it to its product, not because neurons named that repo directly.
 */
export interface RegistryProjection {
  loaded: true;
  path: string;
  projects: number;
  repos_bound: number;
  repos_unbound: string[];
  /** Active repos bound to a non-global project that has project-specific neurons. */
  covered_project_specific: string[];
  /** Active repos bound to a project flagged is_global (global knowledge only). */
  global_only: string[];
  /** Active repos bound to a project with zero project-specific neurons. */
  uncovered: string[];
  archived: string[];
  external: string[];
  /** Repos still ambiguous after the registry (i.e. unbound + heuristically ambiguous). */
  ambiguous_after: number;
  alias_collisions: Array<{ alias: string; project_ids: string[] }>;
  repo_collisions: Array<{ repo_id: string; project_ids: string[] }>;
  project_neurons: Record<string, number>;
  // ── Registry v2 metadata report (entity_type / reuse_scope / lineage) ──────
  // Diagnostic only. NOT coverage and NOT access control: reuse_scope classifies
  // how broadly knowledge may be reused, it is not authZ. organization /
  // source_lineage entries are reported but never count as project coverage.
  entities: RegistryEntityReport[];
  entity_type_counts: Record<string, number>;
  reuse_scope_counts: Record<string, number>;
  lineage_counts: Record<string, number>;
  entries_missing_entity_type: string[];
  entries_missing_reuse_scope: string[];
  source_lineage_entries: string[];
}

/** One registry entry's v2 metadata, as reported by the auditor. */
export interface RegistryEntityReport {
  project_id: string;
  /** Declared entity_type, or "project" when absent (the default). */
  entity_type: string;
  status: string;
  is_global: boolean;
  reuse_scope: string | null;
  lineage: string[];
  repos_count: number;
  aliases_count: number;
  /** Project-specific neurons resolving here (0 for non-indexed entities). */
  project_neurons: number;
  /** false for organization / source_lineage (excluded from the alias/repo index). */
  indexed: boolean;
}

export type RegistryClassification =
  | "covered_project_specific"
  | "global_only"
  | "uncovered"
  | "archived"
  | "external"
  | "unbound";

// ── Small helpers ───────────────────────────────────────────────────────────

function neuronId(n: Neuron): string {
  return extractNeuronId(n.filename);
}

/** The canonical id = the leading id token of a filename/ref, with the
 *  descriptive slug (and `.md`) stripped. Used for BOTH the id set (from
 *  filenames) and reference resolution (from prose), so they always agree. */
function extractNeuronId(nameOrToken: string): string {
  const base = basename(nameOrToken).replace(/\.md$/i, "");
  const m = base.match(NEURON_ID_HEAD_RE);
  return (m ? m[0] : base).toUpperCase();
}

/** Prefix/equality relation between two normalized tokens (length-guarded). */
function related(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < MIN_REL_LEN) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function containsGlobalKeyword(token: string): boolean {
  return GLOBAL_KEYWORDS.some((k) => token.includes(k));
}

function isPlaceholderToken(token: string): boolean {
  return PLACEHOLDER_TOKENS.has(token) || token.length <= 2;
}

/** Deterministic content digest of the corpus markdown (read-only integrity check). */
function corpusDigest(neurons: Neuron[]): string {
  const rows = neurons
    .map((n) => `${n.category}/${n.filename}:${createHash("sha256").update(readFileSync(n.filepath)).digest("hex")}`)
    .sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

// ── Repo discovery (.git dir or file → working tree; *.git → bare) ───────────

interface RawRepo {
  name: string;
  path: string;
  relPath: string;
  depth: number;
  gitType: "dir" | "file" | "bare";
}

export function discoverRepos(factoryRoot: string, maxDepth: number): RawRepo[] {
  const out: RawRepo[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth >= maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = e.name;
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;
      const rel = relative(factoryRoot, full);
      const thisDepth = depth + 1;

      // Bare repo: a "<name>.git" directory with a bare layout.
      if (name.endsWith(".git") && (existsSync(join(full, "HEAD")) || existsSync(join(full, "objects")))) {
        out.push({ name, path: full, relPath: rel, depth: thisDepth, gitType: "bare" });
        continue; // never descend into a bare repo
      }

      // Working-tree repo: contains a .git (dir = main checkout, file = worktree/submodule).
      const gitEntry = join(full, ".git");
      if (existsSync(gitEntry)) {
        let gitType: "dir" | "file" = "dir";
        try {
          gitType = statSync(gitEntry).isDirectory() ? "dir" : "file";
        } catch {
          gitType = "dir";
        }
        out.push({ name, path: full, relPath: rel, depth: thisDepth, gitType });
        walk(full, thisDepth); // keep scanning for NESTED repos (anomalies)
        continue;
      }

      walk(full, thisDepth);
    }
  };

  walk(factoryRoot, 0);
  return out;
}

// ── Alias-collision detection (self-contained; no neurons.ts change) ─────────

function resolveAliasesFile(factoryRoot: string): string | null {
  const envFile = process.env.FACTORY_PROJECT_ALIASES_FILE;
  if (envFile && existsSync(envFile)) return envFile;
  const candidate = join(factoryRoot, ".factory", "project-aliases.json");
  if (existsSync(candidate)) return candidate;
  return null;
}

function normalizeToken(s: string): string {
  return (s ?? "").toLowerCase().replace(/[\s_-]/g, "");
}

function detectAliasCollisions(factoryRoot: string): {
  sourceFile: string | null;
  collisions: Array<{ alias: string; canonicals: string[]; note: string }>;
} {
  const sourceFile = resolveAliasesFile(factoryRoot);
  if (!sourceFile) return { sourceFile: null, collisions: [] };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(sourceFile, "utf-8")) as Record<string, unknown>;
  } catch {
    return {
      sourceFile,
      collisions: [{ alias: "(file)", canonicals: [], note: "aliases file is invalid JSON — ignored at runtime (seed used)" }],
    };
  }
  // alias-token → set of canonicals declaring it (within the file).
  const claims = new Map<string, Set<string>>();
  for (const [canon, aliases] of Object.entries(parsed)) {
    if (!Array.isArray(aliases)) continue;
    const canonNorm = normalizeToken(canon);
    for (const a of aliases) {
      const an = normalizeToken(String(a));
      if (!an) continue;
      if (!claims.has(an)) claims.set(an, new Set());
      claims.get(an)!.add(canonNorm);
    }
  }
  const collisions: Array<{ alias: string; canonicals: string[]; note: string }> = [];
  for (const [alias, canons] of claims) {
    // Collision within the file: same alias under >1 canonical.
    if (canons.size > 1) {
      collisions.push({
        alias,
        canonicals: [...canons].sort(),
        note: "alias declared under multiple canonicals in the aliases file",
      });
      continue;
    }
    // Inconsistency vs the effective (seed+file) resolution.
    const declared = [...canons][0];
    const effective = canonicalProject(alias);
    if (effective && effective !== declared) {
      collisions.push({
        alias,
        canonicals: [declared, effective].sort(),
        note: `alias resolves to '${effective}' at runtime but the file declares it under '${declared}'`,
      });
    }
  }
  collisions.sort((a, b) => a.alias.localeCompare(b.alias));
  return { sourceFile, collisions };
}

// ── Reference scanning ──────────────────────────────────────────────────────

function scanReferences(neurons: Neuron[]): ProjectCoverageReport["references"] {
  const idSet = new Set(neurons.map(neuronId));

  const broken = new Map<string, RefEntry>();
  const legacy = new Map<string, RefEntry>();
  const unknown = new Map<string, RefEntry>();
  let pathMentions = 0;
  let urlMentions = 0;

  const bump = (map: Map<string, RefEntry>, ref: string, inId: string, kind?: string): void => {
    const cur = map.get(ref);
    if (cur) {
      cur.count += 1;
      if (cur.sample_in && cur.sample_in.length < 5 && !cur.sample_in.includes(inId)) cur.sample_in.push(inId);
    } else {
      map.set(ref, { ref, kind, count: 1, sample_in: [inId] });
    }
  };

  for (const n of neurons) {
    const self = neuronId(n);
    const haystack = `${n.content}\n${JSON.stringify(n.frontmatter)}`;

    // 1) Neuron-id shaped tokens → resolved (skip) or broken.
    for (const m of haystack.match(NEURON_ID_RE) ?? []) {
      const ref = m.toUpperCase();
      if (ref === self) continue; // self heading, harmless
      if (!idSet.has(ref)) bump(broken, ref, self);
    }
    // 2) Legacy / external ID-shaped families (the confusable ones).
    for (const m of haystack.match(PATTERN_ID_RE) ?? []) bump(legacy, m.toUpperCase(), self, "pattern-id");
    for (const m of haystack.match(PRODUCT_ID_RE) ?? []) bump(legacy, m.toUpperCase(), self, "product-id");
    for (const m of haystack.match(ISSUE_RE) ?? []) bump(legacy, m, self, "issue");
    // 3) Generic ref-shaped tokens that fit no known family → unknown.
    //    Use matchAll so we can skip sub-segments of a longer dashed id
    //    (e.g. the "FX-010" inside "PAT-FX-010"), which a preceding "-" marks.
    for (const m of haystack.matchAll(GENERIC_REF_RE)) {
      const idx = m.index ?? 0;
      if (idx > 0 && haystack[idx - 1] === "-") continue; // tail of a longer dashed id
      const ref = m[0].toUpperCase();
      if (/^(NE|ND|NP|NF|NB)-/.test(ref)) continue; // neuron family (handled above)
      if (/^(UV|PS|PSV|JBC|OC)-/.test(ref)) continue; // product family (handled above)
      if (/^PAT-/.test(ref)) continue; // pattern family
      bump(unknown, ref, self);
    }
    // 4) Paths / URLs — counted only (not confusable with neuron ids).
    pathMentions += (haystack.match(PATH_RE) ?? []).length;
    urlMentions += (haystack.match(URL_RE) ?? []).length;
  }

  const finish = (map: Map<string, RefEntry>): { list: RefEntry[]; truncated: boolean } => {
    const all = [...map.values()].sort((a, b) => b.count - a.count || a.ref.localeCompare(b.ref));
    return { list: all.slice(0, REF_ENUM_CAP), truncated: all.length > REF_ENUM_CAP };
  };
  const b = finish(broken);
  const l = finish(legacy);
  const u = finish(unknown);

  return {
    broken_neuron_refs: b.list,
    legacy_or_external_refs: l.list,
    unknown_refs: u.list,
    diagnostics: {
      path_like_mentions: pathMentions,
      url_mentions: urlMentions,
      truncated: b.truncated || l.truncated || u.truncated,
    },
  };
}

// ── Core ────────────────────────────────────────────────────────────────────

export interface ProjectCoverageOptions {
  factoryRoot: string;
  neuronsDir?: string;
  repoMaxDepth?: number;
}

export function runProjectCoverage(opts: ProjectCoverageOptions): ProjectCoverageReport {
  const factoryRoot = opts.factoryRoot;
  const repoMaxDepth = opts.repoMaxDepth ?? 3;
  const neuronsDir = opts.neuronsDir ?? join(factoryRoot, "neurons");
  if (!existsSync(neuronsDir)) {
    throw new Error(`neurons dir not found: '${neuronsDir}'`);
  }

  const neurons = listNeurons(neuronsDir);

  // ── Neuron scope classification ───────────────────────────────────────────
  const byCategory: Record<NeuronCategory, number> = { errors: 0, decisions: 0, patterns: 0, foundations: 0, business: 0 };
  const unknownByCat: Record<NeuronCategory, number> = { errors: 0, decisions: 0, patterns: 0, foundations: 0, business: 0 };
  const unknownScope: Array<{ id: string; category: NeuronCategory }> = [];
  const projectCounts = new Map<string, number>(); // canonical (project-specific) → count
  const inconsistent = new Map<string, string[]>(); // placeholder token → ids
  let globalCount = 0;

  for (const n of neurons) {
    byCategory[n.category] += 1;
    const scope = projectScopeOf(n);
    if (scope === "global") {
      globalCount += 1;
    } else if (scope === "unknown") {
      unknownScope.push({ id: neuronId(n), category: n.category });
      unknownByCat[n.category] += 1;
    } else {
      projectCounts.set(scope, (projectCounts.get(scope) ?? 0) + 1);
      if (isPlaceholderToken(scope)) {
        if (!inconsistent.has(scope)) inconsistent.set(scope, []);
        const arr = inconsistent.get(scope)!;
        if (arr.length < 20) arr.push(neuronId(n));
      }
    }
  }
  // Placeholder tokens are data smells, not real projects — drop from the project map.
  for (const t of inconsistent.keys()) projectCounts.delete(t);

  // ── Repo discovery + anomaly split ────────────────────────────────────────
  const raw = discoverRepos(factoryRoot, repoMaxDepth);
  const workingTrees = raw.filter((r) => r.gitType !== "bare");
  const bare = raw.filter((r) => r.gitType === "bare");
  const isNested = (r: RawRepo): boolean =>
    workingTrees.some((o) => o.path !== r.path && r.path.startsWith(o.path + "/"));

  const anomalies: AnomalyEntry[] = [];
  for (const r of bare) {
    anomalies.push({ type: "bare_repo", rel_path: r.relPath, path: r.path, note: "bare git repository (no working tree) — likely a backup/mirror" });
  }
  for (const r of workingTrees) {
    if (isNested(r)) {
      anomalies.push({ type: "nested_repo", rel_path: r.relPath, path: r.path, note: "git repository nested inside another repo — possibly an accidental embedded checkout" });
    }
  }
  anomalies.sort((a, b) => a.rel_path.localeCompare(b.rel_path));

  const mainRepos = workingTrees.filter((r) => !isNested(r));

  // Pre-compute each main repo's canonical and direct count.
  const repoCanon = new Map<string, string>(); // name → canonical
  for (const r of mainRepos) repoCanon.set(r.name, canonicalProject(r.name));
  const directOf = (canon: string): number => projectCounts.get(canon) ?? 0;

  // ── Classify each main repo ───────────────────────────────────────────────
  const repos: RepoEntry[] = [];
  for (const r of mainRepos) {
    const canon = repoCanon.get(r.name)!;
    const directCount = directOf(canon);

    // Sibling repos (multi-repo cluster, no registry to disambiguate).
    const siblings = mainRepos.filter((o) => o.name !== r.name && related(canon, repoCanon.get(o.name)!));

    // Strong project candidates (prefix-related project canonicals with neurons),
    // only relevant when there is no direct match.
    const candidates: RepoCandidate[] = [];
    if (directCount === 0) {
      for (const [pc, cnt] of projectCounts) {
        if (related(canon, pc) && cnt > 0) candidates.push({ canonical: pc, via: "alias-prefix", neuron_count: cnt });
      }
      candidates.sort((a, b) => b.neuron_count - a.neuron_count);
    }
    for (const s of siblings) {
      const sc = repoCanon.get(s.name)!;
      candidates.push({ canonical: sc, via: "multi-repo-sibling", neuron_count: directOf(sc), sibling_repo: s.name });
    }

    let classification: RepoClassification;
    let globalOnly = false;
    const evidence: string[] = [];

    if (siblings.length > 0 && (directCount > 0 || siblings.some((s) => directOf(repoCanon.get(s.name)!) > 0) || candidates.some((c) => c.via === "alias-prefix"))) {
      classification = "ambiguous";
      const names = [r.name, ...siblings.map((s) => s.name)].sort();
      const sharedNeurons = directCount > 0 ? directCount : Math.max(0, ...siblings.map((s) => directOf(repoCanon.get(s.name)!)), 0);
      evidence.push(`multi-repo cluster ${JSON.stringify(names)} maps to related canonical '${canon}' (${sharedNeurons} project-specific neurons) — no registry to attribute neurons to a specific repo`);
    } else if (directCount > 0) {
      classification = "covered";
      evidence.push(`direct project-specific match: canonical '${canon}' has ${directCount} neuron(s); sole repo for this canonical`);
    } else if (candidates.some((c) => c.via === "alias-prefix")) {
      classification = "ambiguous";
      const top = candidates.find((c) => c.via === "alias-prefix")!;
      evidence.push(`no direct match; strong candidate '${top.canonical}' (${top.neuron_count} neurons) via alias/prefix of repo token '${canon}' — alias/registry missing`);
    } else if (containsGlobalKeyword(canon) && globalCount > 0) {
      classification = "uncovered";
      globalOnly = true;
      evidence.push(`only global/factory-wide knowledge applies (${globalCount} global neurons); no project-specific neurons for '${canon}'`);
    } else {
      classification = "uncovered";
      evidence.push(`no project-specific neurons and no strong candidate for canonical '${canon}'`);
    }

    repos.push({
      repo_id: r.name,
      name: r.name,
      rel_path: r.relPath,
      canonical: canon,
      classification,
      global_only: globalOnly,
      direct_neuron_count: directCount,
      siblings: siblings.map((s) => s.name).sort(),
      candidates,
      evidence,
    });
  }
  repos.sort((a, b) => a.repo_id.localeCompare(b.repo_id));

  // ── Detected projects (neuron tokens ∪ repo canonicals) ───────────────────
  const projCanonSet = new Set<string>([...projectCounts.keys()]);
  for (const c of repoCanon.values()) projCanonSet.add(c);
  const detectedProjects: DetectedProject[] = [];
  for (const c of projCanonSet) {
    const neuronCount = projectCounts.get(c) ?? 0;
    const directRepos = mainRepos.filter((r) => repoCanon.get(r.name) === c).map((r) => r.name).sort();
    const candidateRepos = mainRepos
      .filter((r) => repoCanon.get(r.name) !== c && directOf(repoCanon.get(r.name)!) === 0 && related(repoCanon.get(r.name)!, c))
      .map((r) => r.name)
      .sort();
    const source: DetectedProject["source"] =
      neuronCount > 0 && directRepos.length > 0 ? "both" : neuronCount > 0 ? "neuron" : "repo";
    detectedProjects.push({
      canonical: c,
      neuron_count: neuronCount,
      has_local_repo: directRepos.length > 0,
      direct_repos: directRepos,
      candidate_repos: candidateRepos,
      source,
    });
  }
  detectedProjects.sort((a, b) => b.neuron_count - a.neuron_count || a.canonical.localeCompare(b.canonical));

  // ── References + aliases ──────────────────────────────────────────────────
  const references = scanReferences(neurons);
  const aliasInfo = detectAliasCollisions(factoryRoot);

  // ── Summary counts (operator contract: never sell ambiguous as coverage) ──
  const coveredList = repos.filter((r) => r.classification === "covered");
  const ambiguousList = repos.filter((r) => r.classification === "ambiguous");
  const uncoveredAll = repos.filter((r) => r.classification === "uncovered");
  const globalOnlyList = uncoveredAll.filter((r) => r.global_only);
  const uncoveredPlain = uncoveredAll.filter((r) => !r.global_only);
  const projectsNoRepo = detectedProjects.filter((p) => p.neuron_count > 0 && !p.has_local_repo).length;

  // ── Recommendations (prioritized) ─────────────────────────────────────────
  const recommendations: ProjectCoverageReport["recommendations"] = [];
  for (const r of ambiguousList) {
    const aliasCand = r.candidates.find((c) => c.via === "alias-prefix");
    if (r.siblings.length > 0) {
      recommendations.push({
        priority: "high",
        kind: "multi-repo-registry",
        message: `Define a registry entry to disambiguate multi-repo cluster ${JSON.stringify([r.repo_id, ...r.siblings].sort())} → canonical '${r.canonical}'.`,
      });
    } else if (aliasCand) {
      recommendations.push({
        priority: "high",
        kind: "missing-alias",
        message: `Add an alias mapping repo '${r.repo_id}' → project '${aliasCand.canonical}' (${aliasCand.neuron_count} neurons) so it resolves directly.`,
      });
    }
  }
  for (const r of globalOnlyList) {
    recommendations.push({
      priority: "low",
      kind: "global-only-repo",
      message: `Repo '${r.repo_id}' is covered only by global/factory knowledge — consider project-scoped neurons if it needs its own memory.`,
    });
  }
  if (references.broken_neuron_refs.length > 0) {
    recommendations.push({
      priority: "high",
      kind: "broken-neuron-refs",
      message: `Fix ${references.broken_neuron_refs.length} broken neuron reference(s) (ids that no longer exist).`,
    });
  }
  if (aliasInfo.collisions.length > 0) {
    recommendations.push({
      priority: "high",
      kind: "alias-collision",
      message: `Resolve ${aliasInfo.collisions.length} alias collision(s) in ${aliasInfo.sourceFile}.`,
    });
  }
  if (inconsistent.size > 0) {
    recommendations.push({
      priority: "medium",
      kind: "inconsistent-scope-tokens",
      message: `Clean ${inconsistent.size} placeholder scope token(s) (${[...inconsistent.keys()].join(", ")}) — they classify neurons under non-project tokens.`,
    });
  }
  if (projectsNoRepo > 0) {
    recommendations.push({
      priority: "low",
      kind: "project-without-repo",
      message: `${projectsNoRepo} project token(s) have neurons but no local repo — confirm they are expected (external/retired projects).`,
    });
  }
  const prio: Record<string, number> = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => prio[a.priority] - prio[b.priority]);

  return {
    factory_root: factoryRoot,
    tool: "project-coverage-cli",
    scan: {
      repo_max_depth: repoMaxDepth,
      neurons_dir: neuronsDir,
      corpus_sha256: corpusDigest(neurons),
      repos_scanned: raw.length,
    },
    repos,
    anomalies,
    detected_projects: detectedProjects,
    coverage: {
      covered: coveredList.map((r) => r.repo_id),
      uncovered: uncoveredAll.map((r) => r.repo_id),
      ambiguous: ambiguousList.map((r) => r.repo_id),
    },
    summary: {
      repos_total: repos.length,
      covered_direct: coveredList.length,
      ambiguous_candidates: ambiguousList.length,
      uncovered: uncoveredPlain.length,
      global_only: globalOnlyList.length,
      anomalies: anomalies.length,
      projects_with_neurons_no_repo: projectsNoRepo,
    },
    neurons: {
      total: neurons.length,
      by_category: byCategory,
      global: globalCount,
      unknown_scope: unknownScope.sort((a, b) => a.id.localeCompare(b.id)),
      unknown_scope_by_category: unknownByCat,
      inconsistent_scope_tokens: [...inconsistent.entries()]
        .map(([token, ids]) => ({ token, count: projectCountsRaw(neurons, token), sample_ids: ids }))
        .sort((a, b) => b.count - a.count),
    },
    references,
    aliases: { source_file: aliasInfo.sourceFile, collisions: aliasInfo.collisions },
    recommendations,
    registry: null,
  };
}

/**
 * Registry-projection (PURE, read-only). Re-binds each repo to its declared
 * project via the registry and recomputes coverage — WITHOUT touching the live
 * MCP scope resolution. This is the "what coverage would be, with the registry"
 * measurement for PR-3B; live adoption is PR-3C. Repos not present in the
 * registry keep their baseline (heuristic) classification.
 */
export function applyRegistryProjection(base: ProjectCoverageReport, reg: LoadedRegistry): ProjectCoverageReport {
  // Neuron count per registry project_id (map each canonical via the alias index).
  const projNeurons = new Map<string, number>();
  for (const dp of base.detected_projects) {
    if (dp.neuron_count <= 0) continue;
    const pid = reg.aliasToProject.get(normalizeToken(dp.canonical));
    if (pid) projNeurons.set(pid, (projNeurons.get(pid) ?? 0) + dp.neuron_count);
  }

  // Annotate each repo with the registry's view. IMPORTANT: the baseline
  // `classification`/`global_only` fields are LEFT UNTOUCHED — only the
  // `registry_*` fields are added — so `summary` keeps its direct-match meaning.
  const repos: RepoEntry[] = base.repos.map((r) => {
    const b = reg.repoToProject.get(normalizeToken(r.repo_id));
    if (!b) return { ...r, registry_classification: "unbound" as RegistryClassification };
    const proj = reg.projectById.get(b.project_id);
    const n = projNeurons.get(b.project_id) ?? 0;
    let rc: RegistryClassification;
    if (b.repo_status === "archived") rc = "archived";
    else if (b.repo_status === "external") rc = "external";
    else if (proj?.is_global) rc = "global_only";
    else if (n > 0) rc = "covered_project_specific";
    else rc = "uncovered";
    return {
      ...r,
      registry_project_id: b.project_id,
      registry_role: b.role,
      registry_status: b.repo_status,
      registry_classification: rc,
    };
  });

  const ids = (rc: RegistryClassification): string[] =>
    repos.filter((r) => r.registry_classification === rc).map((r) => r.repo_id).sort();
  const bound = repos.filter((r) => r.registry_project_id);
  const unbound = repos.filter((r) => !r.registry_project_id);
  // "ambiguous_after" = what the registry did NOT resolve and that is still
  // ambiguous by the baseline heuristic.
  const ambiguousAfter = unbound.filter((r) => r.classification === "ambiguous").length;

  // ── Registry v2 metadata report (entity_type / reuse_scope / lineage) ───────
  // Diagnostic only — NOT coverage, NOT authZ. organization & source_lineage
  // entries are reported but never count as project coverage (indexed=false).
  const entities: RegistryEntityReport[] = reg.raw.projects
    .map((p) => {
      const entity_type = p.entity_type ?? "project";
      return {
        project_id: p.project_id,
        entity_type,
        status: p.status,
        is_global: p.is_global === true,
        reuse_scope: p.reuse_scope ?? null,
        lineage: p.lineage ?? [],
        repos_count: (p.repos ?? []).length,
        aliases_count: (p.aliases ?? []).length,
        project_neurons: projNeurons.get(p.project_id) ?? 0,
        indexed: !NON_INDEXED_ENTITY_TYPES.has(entity_type),
      };
    })
    .sort((a, b) => a.project_id.localeCompare(b.project_id));

  const countBy = (vals: string[]): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const v of vals) m[v] = (m[v] ?? 0) + 1;
    return m;
  };
  const entity_type_counts = countBy(entities.map((e) => e.entity_type));
  const reuse_scope_counts = countBy(entities.map((e) => e.reuse_scope ?? "unknown"));
  const lineage_counts = countBy(entities.flatMap((e) => e.lineage));
  const entries_missing_entity_type = reg.raw.projects.filter((p) => p.entity_type === undefined).map((p) => p.project_id).sort();
  const entries_missing_reuse_scope = reg.raw.projects.filter((p) => p.reuse_scope === undefined).map((p) => p.project_id).sort();
  const source_lineage_entries = entities.filter((e) => e.entity_type === "source_lineage").map((e) => e.project_id).sort();

  return {
    // summary + coverage are intentionally the BASELINE values (no registry recompute).
    ...base,
    repos,
    registry: {
      loaded: true,
      path: reg.path,
      projects: reg.raw.projects.length,
      repos_bound: bound.length,
      repos_unbound: unbound.map((r) => r.repo_id).sort(),
      covered_project_specific: ids("covered_project_specific"),
      global_only: ids("global_only"),
      uncovered: ids("uncovered"),
      archived: ids("archived"),
      external: ids("external"),
      ambiguous_after: ambiguousAfter,
      alias_collisions: reg.aliasCollisions,
      repo_collisions: reg.repoCollisions,
      project_neurons: Object.fromEntries([...projNeurons.entries()].sort((a, b) => b[1] - a[1])),
      entities,
      entity_type_counts,
      reuse_scope_counts,
      lineage_counts,
      entries_missing_entity_type,
      entries_missing_reuse_scope,
      source_lineage_entries,
    },
  };
}

/** Exact count of neurons whose effective scope equals `token` (placeholder tokens). */
function projectCountsRaw(neurons: Neuron[], token: string): number {
  let c = 0;
  for (const n of neurons) if (projectScopeOf(n) === token) c += 1;
  return c;
}

// ── Markdown renderer ───────────────────────────────────────────────────────

export function renderMarkdown(r: ProjectCoverageReport): string {
  const L: string[] = [];
  const s = r.summary;
  L.push(`# Project Coverage Audit`);
  L.push("");
  L.push(`## Executive Summary`);
  L.push("");
  L.push(`- Factory root: \`${r.factory_root}\``);
  L.push(`- Corpus: ${r.neurons.total} neurons (global: ${r.neurons.global}, unknown-scope: ${r.neurons.unknown_scope.length})`);
  L.push(`- Local repos: ${s.repos_total} (anomalies separate: ${s.anomalies})`);
  L.push(`- **covered_direct: ${s.covered_direct}** · **ambiguous_candidates: ${s.ambiguous_candidates}** · **uncovered: ${s.uncovered}** · **global_only: ${s.global_only}**`);
  L.push(`- Projects with neurons but no local repo: ${s.projects_with_neurons_no_repo}`);
  L.push(`- _Limit: LOCAL coverage only (repos with .git + local corpus). No GitHub-total claim._`);
  if (r.registry) {
    L.push(`- Registry projection (inert): **${r.registry.repos_bound}/${s.repos_total}** repos bound · covered_project_specific: ${r.registry.covered_project_specific.length} · ambiguous_after: ${r.registry.ambiguous_after} — projected, NOT direct coverage (see Registry Projection)`);
  }
  L.push("");

  L.push(`## Local Repositories`);
  L.push("");
  L.push(`| repo_id | canonical | classification | global_only | direct_neurons | evidence |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const repo of r.repos) {
    L.push(`| ${repo.repo_id} | ${repo.canonical} | ${repo.classification} | ${repo.global_only ? "yes" : ""} | ${repo.direct_neuron_count} | ${(repo.evidence[0] ?? "").replace(/\|/g, "\\|")} |`);
  }
  L.push("");

  L.push(`## Coverage`);
  L.push("");
  L.push(`| bucket | count | repos |`);
  L.push(`|---|---|---|`);
  L.push(`| covered_direct | ${s.covered_direct} | ${r.repos.filter((x) => x.classification === "covered").map((x) => x.repo_id).join(", ")} |`);
  L.push(`| ambiguous_candidates | ${s.ambiguous_candidates} | ${r.repos.filter((x) => x.classification === "ambiguous").map((x) => x.repo_id).join(", ")} |`);
  L.push(`| uncovered | ${s.uncovered} | ${r.repos.filter((x) => x.classification === "uncovered" && !x.global_only).map((x) => x.repo_id).join(", ")} |`);
  L.push(`| global_only | ${s.global_only} | ${r.repos.filter((x) => x.global_only).map((x) => x.repo_id).join(", ")} |`);
  L.push("");

  if (r.registry) {
    const rg = r.registry;
    L.push(`## Registry Projection (inert — NOT a direct match)`);
    L.push("");
    L.push(`Source: \`${rg.path}\` · projects: ${rg.projects} · repos bound: ${rg.repos_bound} · unbound: ${rg.repos_unbound.length}`);
    L.push(`_What-if projection. \`covered_project_specific\` means a repo is **bound by the registry** to a project that has project-specific neurons — this is WEAKER than the baseline \`covered_direct\` (a direct token/canonical match) and must not be read as one. The live MCP scope resolution is unchanged (adoption is PR-3C)._`);
    L.push("");
    L.push(`| registry bucket | count | repos |`);
    L.push(`|---|---|---|`);
    L.push(`| covered_project_specific | ${rg.covered_project_specific.length} | ${rg.covered_project_specific.join(", ")} |`);
    L.push(`| global_only | ${rg.global_only.length} | ${rg.global_only.join(", ")} |`);
    L.push(`| uncovered | ${rg.uncovered.length} | ${rg.uncovered.join(", ")} |`);
    L.push(`| archived | ${rg.archived.length} | ${rg.archived.join(", ")} |`);
    L.push(`| external | ${rg.external.length} | ${rg.external.join(", ")} |`);
    L.push(`| unbound (kept heuristic) | ${rg.repos_unbound.length} | ${rg.repos_unbound.join(", ")} |`);
    L.push("");
    L.push(`Ambiguous after registry: **${rg.ambiguous_after}** (baseline ambiguous_candidates: ${s.ambiguous_candidates}; baseline covered_direct: ${s.covered_direct}).`);
    if (rg.alias_collisions.length > 0) L.push(`- ⚠ alias collisions: ${rg.alias_collisions.map((c) => `${c.alias}→{${c.project_ids.join("|")}}`).join(", ")}`);
    if (rg.repo_collisions.length > 0) L.push(`- ⚠ repo collisions: ${rg.repo_collisions.map((c) => `${c.repo_id}→{${c.project_ids.join("|")}}`).join(", ")}`);
    L.push("");
    L.push(`### Registry v2 metadata (entity_type / reuse_scope / lineage)`);
    L.push(`_Diagnostic only. \`reuse_scope\` classifies how broadly knowledge may be REUSED — it is NOT access control / authZ. organization & source_lineage entries are reported but never count as project coverage._`);
    L.push("");
    L.push(`| project_id | entity_type | status | reuse_scope | lineage | indexed | neurons |`);
    L.push(`|---|---|---|---|---|---|---|`);
    for (const e of rg.entities) L.push(`| ${e.project_id} | ${e.entity_type} | ${e.status} | ${e.reuse_scope ?? "—"} | ${e.lineage.join(", ") || "—"} | ${e.indexed ? "yes" : "no"} | ${e.project_neurons} |`);
    L.push("");
    L.push(`- entity_type counts: ${Object.entries(rg.entity_type_counts).map(([k, v]) => `${k}:${v}`).join(" · ") || "—"}`);
    L.push(`- reuse_scope counts: ${Object.entries(rg.reuse_scope_counts).map(([k, v]) => `${k}:${v}`).join(" · ") || "—"}`);
    L.push(`- lineage counts: ${Object.entries(rg.lineage_counts).map(([k, v]) => `${k}:${v}`).join(" · ") || "—"}`);
    if (rg.source_lineage_entries.length > 0) L.push(`- source_lineage (NOT project coverage): ${rg.source_lineage_entries.join(", ")}`);
    if (rg.entries_missing_entity_type.length > 0) L.push(`- missing entity_type (default → project): ${rg.entries_missing_entity_type.join(", ")}`);
    if (rg.entries_missing_reuse_scope.length > 0) L.push(`- missing reuse_scope: ${rg.entries_missing_reuse_scope.join(", ")}`);
    L.push("");
  }

  L.push(`## Unknown-scope Neurons (by category)`);
  L.push("");
  L.push(`| category | count |`);
  L.push(`|---|---|`);
  for (const cat of CATEGORY_DIRS) L.push(`| ${cat} | ${r.neurons.unknown_scope_by_category[cat]} |`);
  L.push(`| **total** | **${r.neurons.unknown_scope.length}** |`);
  L.push("");

  L.push(`## Broken Neuron References`);
  L.push("");
  if (r.references.broken_neuron_refs.length === 0) {
    L.push(`_None._`);
  } else {
    L.push(`| ref | count | sample_in |`);
    L.push(`|---|---|---|`);
    for (const x of r.references.broken_neuron_refs) L.push(`| ${x.ref} | ${x.count} | ${(x.sample_in ?? []).join(", ")} |`);
  }
  L.push("");

  L.push(`## Legacy / External References`);
  L.push("");
  L.push(`_path-like mentions: ${r.references.diagnostics.path_like_mentions} · url mentions: ${r.references.diagnostics.url_mentions} (counted, not enumerated)_`);
  L.push("");
  if (r.references.legacy_or_external_refs.length === 0) {
    L.push(`_None._`);
  } else {
    L.push(`| ref | kind | count |`);
    L.push(`|---|---|---|`);
    for (const x of r.references.legacy_or_external_refs) L.push(`| ${x.ref} | ${x.kind ?? ""} | ${x.count} |`);
  }
  L.push("");

  if (r.anomalies.length > 0) {
    L.push(`## Anomalies (not counted as repos)`);
    L.push("");
    L.push(`| type | rel_path | note |`);
    L.push(`|---|---|---|`);
    for (const a of r.anomalies) L.push(`| ${a.type} | ${a.rel_path} | ${a.note} |`);
    L.push("");
  }

  if (r.aliases.collisions.length > 0) {
    L.push(`## Alias Collisions`);
    L.push("");
    L.push(`Source: \`${r.aliases.source_file}\``);
    L.push("");
    L.push(`| alias | canonicals | note |`);
    L.push(`|---|---|---|`);
    for (const c of r.aliases.collisions) L.push(`| ${c.alias} | ${c.canonicals.join(", ")} | ${c.note} |`);
    L.push("");
  }

  L.push(`## Recommendations`);
  L.push("");
  if (r.recommendations.length === 0) {
    L.push(`_None._`);
  } else {
    for (const rec of r.recommendations) L.push(`- **[${rec.priority}]** (${rec.kind}) ${rec.message}`);
  }
  L.push("");
  return L.join("\n");
}

// ── CLI wrapper ─────────────────────────────────────────────────────────────

export interface CliOptions extends ProjectCoverageOptions {
  format: "json" | "md";
  help?: boolean;
  /** Optional path to a projects.json registry → inert projection mode. */
  registryPath?: string;
}

const USAGE = `usage:
  node dist/project-coverage-cli.js --factory-root <dir> [--neurons-dir <dir>] [--repo-max-depth N] [--registry <projects.json>] [--format json|md]
  npm --silent run project-coverage -- --factory-root <dir> --format json

--registry <projects.json> runs an INERT projection: it re-binds repos to their
declared projects to MEASURE coverage, without changing the live MCP scope
resolution (adoption is PR-3C). The JSON/Markdown report is written to STDOUT;
progress and errors go to STDERR. For machine-readable output use 'node dist/...'
or 'npm --silent run' — a plain 'npm run' prepends its banner to STDOUT.`;

/**
 * Strict argument parser — NO silent fallbacks. An unknown flag, a missing value,
 * a bad --format, or a non-positive-integer --repo-max-depth each throw an Error
 * with a clear message (the CLI turns that into exit 1).
 */
export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { factoryRoot: "", format: "json" };
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--factory-root") o.factoryRoot = need(++i, a);
    else if (a === "--neurons-dir") o.neuronsDir = need(++i, a);
    else if (a === "--repo-max-depth") {
      const raw = need(++i, a);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--repo-max-depth must be a positive integer (got "${raw}")`);
      o.repoMaxDepth = n;
    } else if (a === "--registry") {
      o.registryPath = need(++i, a);
    } else if (a === "--format") {
      const raw = need(++i, a).toLowerCase();
      if (raw !== "json" && raw !== "md" && raw !== "markdown") {
        throw new Error(`--format must be one of json|md|markdown (got "${raw}")`);
      }
      o.format = raw === "markdown" ? "md" : (raw as "json" | "md");
    } else if (a === "--help" || a === "-h") {
      o.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return o;
}

function main(): void {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[project-coverage] ${(e as Error).message}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }
  if (opts.help) {
    console.error(USAGE);
    process.exit(0);
    return;
  }
  if (!opts.factoryRoot) {
    console.error(`[project-coverage] --factory-root is required`);
    console.error(USAGE);
    process.exit(1);
    return;
  }
  let report: ProjectCoverageReport;
  try {
    report = runProjectCoverage(opts);
    if (opts.registryPath) {
      const reg = loadRegistry(opts.registryPath);
      report = applyRegistryProjection(report, reg);
    }
  } catch (e) {
    console.error(`[project-coverage] ${(e as Error).message}`);
    process.exit(1);
    return;
  }
  // Report → STDOUT; progress/logs → STDERR (keeps STDOUT machine-clean).
  console.error(
    `[project-coverage] baseline(direct): repos=${report.summary.repos_total} covered_direct=${report.summary.covered_direct} ` +
      `ambiguous=${report.summary.ambiguous_candidates} uncovered=${report.summary.uncovered} ` +
      `global_only=${report.summary.global_only} anomalies=${report.summary.anomalies}`,
  );
  if (report.registry) {
    console.error(
      `[project-coverage] registry(projection): bound=${report.registry.repos_bound} ` +
        `covered_project_specific=${report.registry.covered_project_specific.length} ` +
        `global_only=${report.registry.global_only.length} archived=${report.registry.archived.length} ` +
        `external=${report.registry.external.length} ambiguous_after=${report.registry.ambiguous_after} ` +
        `unbound=${report.registry.repos_unbound.length}`,
    );
  }
  process.stdout.write(opts.format === "md" ? renderMarkdown(report) + "\n" : JSON.stringify(report, null, 2) + "\n");
  process.exit(0);
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
