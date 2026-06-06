/**
 * Neuron file operations — read, write, search, update markdown neurons
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { tryLoadRegistry } from "./registry.js";

export interface NeuronFrontmatter {
  id?: string;
  tags?: string[];
  type?: string;
  project?: string;
  component?: string;
  domain?: string;
  severity?: string;
  occurrences?: number;
  status?: string;
  // gray-matter parses unquoted YAML dates (e.g. `created: 2026-01-01`) into a Date,
  // not a string — the contract reflects that runtime reality.
  created?: string | Date;
  date?: string | Date;
  hits?: number;
  misses?: number;
  sessions_seen?: number;
  last_hit?: string | null;
  [key: string]: unknown;
}

export interface Neuron {
  filename: string;
  filepath: string;
  category: "errors" | "decisions" | "patterns" | "foundations" | "business";
  frontmatter: NeuronFrontmatter;
  content: string;
  title: string;
  modified: Date;
}

export type NeuronCategory = Neuron["category"];

const CATEGORY_PREFIX: Record<NeuronCategory, string> = {
  errors: "NE",
  decisions: "ND",
  patterns: "NP",
  foundations: "NF",
  business: "NB",
};

const CATEGORY_DIRS: NeuronCategory[] = ["errors", "decisions", "patterns", "foundations", "business"];

/**
 * Resolve the neurons directory from a project root
 */
export function resolveNeuronsDir(projectRoot: string): string | null {
  // Walk up the directory tree looking for a neurons/ directory
  let current = resolve(projectRoot);
  const root = dirname(current) === current ? current : "/";
  while (current !== root) {
    const candidate = join(current, "neurons");
    if (existsSync(candidate)) return candidate;
    current = dirname(current);
  }

  // Fallback to FACTORY_ROOT env var
  const envRoot = process.env.FACTORY_ROOT;
  if (envRoot) {
    const envCandidate = join(envRoot, "neurons");
    if (existsSync(envCandidate)) return envCandidate;
  }

  return null;
}

/**
 * Ensure the neurons directory structure exists
 */
export function ensureNeuronsDir(neuronsDir: string): void {
  for (const cat of CATEGORY_DIRS) {
    const dir = join(neuronsDir, cat);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Parse a single neuron markdown file
 */
function parseNeuron(filepath: string, category: NeuronCategory): Neuron | null {
  try {
    const raw = readFileSync(filepath, "utf-8");
    const { data, content } = matter(raw);

    // Extract title from first heading
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1] ?? basename(filepath, ".md");

    return {
      filename: basename(filepath),
      filepath,
      category,
      frontmatter: data as NeuronFrontmatter,
      content,
      title,
      modified: statSync(filepath).mtime,
    };
  } catch (err) {
    console.warn(`[factory-neurons] Failed to parse neuron: ${filepath}`, (err as Error).message);
    return null;
  }
}

/**
 * List all neurons, optionally filtered by category
 */
export function listNeurons(neuronsDir: string, category?: NeuronCategory): Neuron[] {
  const categories = category ? [category] : CATEGORY_DIRS;
  const neurons: Neuron[] = [];

  for (const cat of categories) {
    const dir = join(neuronsDir, cat);
    if (!existsSync(dir)) continue;

    const prefix = CATEGORY_PREFIX[cat];
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
      .sort();

    for (const file of files) {
      const neuron = parseNeuron(join(dir, file), cat);
      if (neuron) neurons.push(neuron);
    }
  }

  return neurons;
}

/**
 * Get the N most recent neurons per category
 */
export function getRecentNeurons(neuronsDir: string, count: number = 5): Record<NeuronCategory, Neuron[]> {
  const result: Record<NeuronCategory, Neuron[]> = {
    errors: [],
    decisions: [],
    patterns: [],
    foundations: [],
    business: [],
  };

  for (const cat of CATEGORY_DIRS) {
    const neurons = listNeurons(neuronsDir, cat);
    neurons.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    result[cat] = neurons.slice(0, count);
  }

  return result;
}

/**
 * Compute keyword-based score for a neuron against query terms.
 */
function keywordScore(neuron: Neuron, terms: string[]): number {
  const domainStr = String(neuron.frontmatter.domain ?? "");
  const componentStr = Array.isArray(neuron.frontmatter.component)
    ? neuron.frontmatter.component.join(" ")
    : String(neuron.frontmatter.component ?? "");

  const searchable = [
    neuron.title,
    neuron.content,
    domainStr,
    componentStr,
    ...(neuron.frontmatter.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (neuron.title.toLowerCase().includes(term)) score += 3;
    if (domainStr.toLowerCase().includes(term)) score += 2;
    if (componentStr.toLowerCase().includes(term)) score += 2;
    if (searchable.includes(term)) score += 1;
  }

  // Boost by occurrences
  const occ = neuron.frontmatter.occurrences ?? 1;
  score *= 1 + Math.log(occ) * 0.3;

  // Boost validated/graduated
  const status = neuron.frontmatter.status ?? "new";
  if (status === "validated") score *= 1.5;
  if (status === "graduated") score *= 2.0;

  return score;
}

/**
 * ── Project scope / alias canonicalization ──────────────────────────────
 * Single source for resolving project names/aliases to a canonical token and
 * for classifying a neuron's scope. Resolution is LAYERED, highest precedence
 * first:
 *   1. registry alias index  (mcp-server/config/projects.json, or
 *      FACTORY_PROJECT_REGISTRY_FILE) — the source of truth.
 *   2. external aliases file (FACTORY_PROJECT_ALIASES_FILE, or
 *      $FACTORY_ROOT/.factory/project-aliases.json).
 *   3. inline seed — startup fallback only.
 *
 * `canonicalProject` / `isGlobalScope` use ALL layers (the live resolver).
 * `canonicalProjectLegacy` / `isGlobalScopeLegacy` deliberately EXCLUDE the
 * registry (seed + external only) — they preserve the pre-registry behavior so
 * the no-loss gate can keep comparing "old (seed) vs new (registry)" even after
 * the live resolver became registry-aware. A missing/invalid registry degrades
 * cleanly to the legacy behavior (warn once, never crash).
 */
interface AliasMap {
  [canonical: string]: string[];
}

// Inline seed — fallback only. Real/future projects come from the registry.
const SEED_PROJECT_ALIASES: AliasMap = {
  urbanvistacapital: ["uv", "urbanvista", "urbanvistacapital"],
  peoplesynapse: ["ps", "peoplesynapse"],
  softwarefactory: ["sf", "factory", "softwarefactory"],
  olguisclass: ["oc", "olguisclass", "olguis"],
  jbcodingiot: ["jbc", "jbcodingiot", "jbcodingiotweb"],
};

// Scope tokens (normalized) meaning "shared / factory-wide" — never a concrete project.
const GLOBAL_SCOPE_TOKENS = new Set(["global", "factory", "crossproject", "softwarefactory", "sf"]);

function normalizeToken(s: string): string {
  return (s ?? "").toLowerCase().replace(/[\s_-]/g, "");
}

/** Resolve the external aliases file path, if present. */
function resolveAliasesFile(): string | null {
  const envFile = process.env.FACTORY_PROJECT_ALIASES_FILE;
  if (envFile && existsSync(envFile)) return envFile;
  const root = process.env.FACTORY_ROOT;
  if (root) {
    const candidate = join(root, ".factory", "project-aliases.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve the registry file path: env override → package-relative default. Null if absent. */
function resolveRegistryFile(): string | null {
  const envFile = process.env.FACTORY_PROJECT_REGISTRY_FILE;
  if (envFile) return existsSync(envFile) ? envFile : null;
  try {
    const def = fileURLToPath(new URL("../config/projects.json", import.meta.url));
    return existsSync(def) ? def : null;
  } catch {
    return null;
  }
}

interface AliasLayerOptions {
  useSeed: boolean;
  useExternal: boolean;
  useRegistry: boolean;
}

let _aliasLiveCache: Map<string, string> | null = null;
let _aliasLegacyCache: Map<string, string> | null = null;
let _registryWarned = false;

/** Apply an AliasMap (canonical → aliases[]) onto the index (later layers override). */
function applyAliasMap(idx: Map<string, string>, map: AliasMap): void {
  for (const [canon, aliases] of Object.entries(map)) {
    if (!Array.isArray(aliases)) continue;
    const canonNorm = normalizeToken(canon);
    if (canonNorm) idx.set(canonNorm, canonNorm);
    for (const a of aliases) {
      const n = normalizeToken(a);
      if (n) idx.set(n, canonNorm);
    }
  }
}

/**
 * Build an alias→canonical index from the requested layers. Precedence (lowest
 * to highest, each overriding the previous): seed → external file → registry.
 */
function buildAliasIndex(opts: AliasLayerOptions): Map<string, string> {
  const idx = new Map<string, string>();

  if (opts.useSeed) applyAliasMap(idx, SEED_PROJECT_ALIASES);

  if (opts.useExternal) {
    const ext = resolveAliasesFile();
    if (ext) {
      try {
        applyAliasMap(idx, JSON.parse(readFileSync(ext, "utf-8")) as AliasMap);
      } catch (err) {
        // Degrade cleanly — never crash on a bad config file.
        console.warn(`[factory-neurons] Invalid project-aliases file ${ext}: ${(err as Error).message} — ignoring`);
      }
    }
  }

  if (opts.useRegistry) {
    const regPath = resolveRegistryFile();
    if (regPath) {
      const reg = tryLoadRegistry(regPath, (msg) => {
        if (!_registryWarned) {
          _registryWarned = true;
          console.warn(`[factory-neurons] Invalid project registry ${regPath}: ${msg} — falling back to external/seed aliases`);
        }
      });
      // aliasToProject is already normalized and EXCLUDES organization /
      // source_lineage entries, so lineage/org tokens never resolve to a project.
      if (reg) for (const [norm, projectId] of reg.aliasToProject) idx.set(norm, projectId);
    }
  }

  return idx;
}

/** Live alias index (registry + external + seed), cached. */
function liveAliasIndex(): Map<string, string> {
  if (!_aliasLiveCache) _aliasLiveCache = buildAliasIndex({ useSeed: true, useExternal: true, useRegistry: true });
  return _aliasLiveCache;
}

/** Legacy alias index (external + seed, NO registry), cached. */
function legacyAliasIndex(): Map<string, string> {
  if (!_aliasLegacyCache) _aliasLegacyCache = buildAliasIndex({ useSeed: true, useExternal: true, useRegistry: false });
  return _aliasLegacyCache;
}

/** Reset all alias caches + the warn-once flag. Test-only (lets tests swap env files). */
export function resetProjectAliasCache(): void {
  _aliasLiveCache = null;
  _aliasLegacyCache = null;
  _registryWarned = false;
}

/** Canonicalize a raw project/scope string — LIVE resolver (registry → external → seed → raw). */
export function canonicalProject(raw: string): string {
  const norm = normalizeToken(raw);
  if (!norm) return "";
  return liveAliasIndex().get(norm) ?? norm;
}

/** Canonicalize WITHOUT the registry (external + seed only) — the pre-registry behavior. */
export function canonicalProjectLegacy(raw: string): string {
  const norm = normalizeToken(raw);
  if (!norm) return "";
  return legacyAliasIndex().get(norm) ?? norm;
}

/** True if a scope denotes shared/factory-wide knowledge — LIVE resolver. */
export function isGlobalScope(scope: string): boolean {
  const norm = normalizeToken(scope);
  if (!norm) return false;
  if (GLOBAL_SCOPE_TOKENS.has(norm)) return true;
  return canonicalProject(norm) === "softwarefactory";
}

/** True if a scope denotes shared/factory-wide knowledge — legacy (registry-independent). */
export function isGlobalScopeLegacy(scope: string): boolean {
  const norm = normalizeToken(scope);
  if (!norm) return false;
  if (GLOBAL_SCOPE_TOKENS.has(norm)) return true;
  return canonicalProjectLegacy(norm) === "softwarefactory";
}

// Scopes that DELIBERATELY mark knowledge as shared — these win over a `project` field.
// (Distinct from the weaker, often-automated `scope: factory`.)
const EXPLICIT_SHARED_SCOPE_TOKENS = new Set(["global", "crossproject"]);

function isExplicitSharedScope(scope: string): boolean {
  return EXPLICIT_SHARED_SCOPE_TOKENS.has(normalizeToken(scope));
}

/** A neuron's effective scope: "global", "unknown", or a canonical project token. */
export type ProjectScope = string;

/**
 * Classify a neuron's effective scope. Precedence:
 *  1. An explicit shared scope (cross-project / global) wins over everything —
 *     the author deliberately marked the knowledge as shared.
 *  2. A concrete `project` beats a generic `scope: factory` (which is often an
 *     automated default, not a real "this is factory-wide" claim).
 *  3. Otherwise classify by scope alone (factory-wide token → global, else canonical).
 */
export function projectScopeOf(neuron: Neuron): ProjectScope {
  const scopeRaw = String(neuron.frontmatter.scope ?? "").trim();
  const projRaw = String(neuron.frontmatter.project ?? "").trim();

  if (scopeRaw && isExplicitSharedScope(scopeRaw)) return "global";
  if (projRaw) return isGlobalScope(projRaw) ? "global" : canonicalProject(projRaw);
  if (scopeRaw) return isGlobalScope(scopeRaw) ? "global" : canonicalProject(scopeRaw);
  return "unknown";
}

/**
 * Filter neurons by project scope. Unscoped + global neurons are visible to all;
 * project-specific neurons match only their canonical project.
 */
function filterByProject(neurons: Neuron[], project: string): Neuron[] {
  const target = canonicalProject(project);
  return neurons.filter((n) => {
    const scope = projectScopeOf(n);
    if (scope === "global" || scope === "unknown") return true;
    return scope === target;
  });
}

/**
 * A neuron with its retrieval scores attached.
 */
export interface ScoredNeuron {
  neuron: Neuron;
  score: number; // hybrid score used for ranking
  semanticScore: number; // raw cosine similarity vs query (0 if unavailable)
  usedSemantic: boolean; // whether semantic search contributed
}

/**
 * Search neurons with hybrid scoring: semantic (Gemini embeddings) + keywords.
 * Returns ranked results WITH their scores — the single source of truth for
 * ranking. `searchNeurons` wraps this for callers that only want the neurons.
 * Falls back to keyword-only if embeddings unavailable (offline, no API key).
 * Optional project filter prevents mixing project-specific neurons.
 */
export async function searchNeuronsScored(
  neuronsDir: string,
  query: string,
  category?: NeuronCategory,
  project?: string,
): Promise<ScoredNeuron[]> {
  let all = listNeurons(neuronsDir, category);

  if (project) {
    all = filterByProject(all, project);
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return all.map((neuron) => ({ neuron, score: 0, semanticScore: 0, usedSemantic: false }));
  }

  // Try semantic search (async, may return null if offline)
  let semanticScores: Map<string, number> | null = null;
  try {
    const { semanticSearch } = await import("./embeddings.js");
    semanticScores = await semanticSearch(query, neuronsDir);
  } catch {
    // Embeddings module not available — keyword-only mode
  }

  const usedSemantic = semanticScores !== null;

  const scored = all.map((neuron) => {
    // Keyword score (always available)
    const kw = keywordScore(neuron, terms);

    // Semantic score (0 if unavailable)
    const sem = semanticScores?.get(neuron.filename) ?? 0;

    // Hybrid scoring:
    // - If keywords match well (kw > 3), trust keywords more (keywords found exact terms)
    // - If keywords match poorly (kw <= 3), trust semantics more (meaning over words)
    // - sem is 0-1 from cosine similarity, scale to comparable range
    const score = semanticScores
      ? (kw > 3
          ? kw * 0.6 + sem * 15 * 0.4   // Keywords strong: 60% keyword, 40% semantic
          : kw * 0.3 + sem * 15 * 0.7)   // Keywords weak: 30% keyword, 70% semantic
      : kw;

    return { neuron, score, semanticScore: sem, usedSemantic };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Search neurons (hybrid scoring). Thin wrapper over searchNeuronsScored for
 * callers that only need the ranked neurons (backward-compatible).
 */
export async function searchNeurons(
  neuronsDir: string,
  query: string,
  category?: NeuronCategory,
  project?: string,
): Promise<Neuron[]> {
  const scored = await searchNeuronsScored(neuronsDir, query, category, project);
  return scored.map((s) => s.neuron);
}

/**
 * Synchronous keyword-only search (for plan-gate hook where async is complex).
 */
export function searchNeuronsSync(neuronsDir: string, query: string, category?: NeuronCategory, project?: string): Neuron[] {
  let all = listNeurons(neuronsDir, category);
  if (project) all = filterByProject(all, project);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return all;

  return all
    .map((neuron) => ({ neuron, score: keywordScore(neuron, terms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.neuron);
}

/**
 * Get the next available ID for a category
 */
function getNextId(neuronsDir: string, category: NeuronCategory): string {
  const prefix = CATEGORY_PREFIX[category];
  const dir = join(neuronsDir, category);
  if (!existsSync(dir)) return `${prefix}-001`;

  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .sort();

  if (files.length === 0) return `${prefix}-001`;

  const lastFile = files[files.length - 1];
  const match = lastFile.match(new RegExp(`${prefix}-(\\d+)`));
  const lastNum = match ? parseInt(match[1], 10) : 0;
  return `${prefix}-${String(lastNum + 1).padStart(3, "0")}`;
}

/**
 * Create a new neuron
 */
export function createNeuron(
  neuronsDir: string,
  category: NeuronCategory,
  title: string,
  body: string,
  frontmatterOverrides: Partial<NeuronFrontmatter> = {}
): Neuron {
  ensureNeuronsDir(neuronsDir);

  const id = getNextId(neuronsDir, category);
  const now = new Date().toISOString().split("T")[0];

  const typeMap: Record<NeuronCategory, string> = {
    errors: "error-memory",
    decisions: "decision-memory",
    patterns: "pattern-memory",
    foundations: "foundation-memory",
    business: "business-memory",
  };

  const fm: NeuronFrontmatter = {
    type: typeMap[category],
    status: "new",
    created: now,
    occurrences: 1,
    ...frontmatterOverrides,
  };

  if (category === "patterns") {
    fm.hits = fm.hits ?? 0;
    fm.misses = fm.misses ?? 0;
    fm.sessions_seen = fm.sessions_seen ?? 0;
    fm.last_hit = fm.last_hit ?? null;
  }

  const content = `\n# ${id}: ${title}\n\n${body}\n`;
  const fileContent = matter.stringify(content, fm);

  const filepath = join(neuronsDir, category, `${id}.md`);
  writeFileSync(filepath, fileContent, "utf-8");

  const neuron: Neuron = {
    filename: `${id}.md`,
    filepath,
    category,
    frontmatter: fm,
    content,
    title: `${id}: ${title}`,
    modified: new Date(),
  };

  // Generate embedding asynchronously (fire-and-forget, don't block creation)
  import("./embeddings.js")
    .then(({ embedSingleNeuron }) => embedSingleNeuron(neuronsDir, neuron))
    .catch(() => { /* Embedding is non-critical */ });

  return neuron;
}

/**
 * Update a pattern's hit/miss counter
 */
export function updatePatternCounter(
  neuronsDir: string,
  patternId: string,
  action: "hit" | "miss"
): { success: boolean; hits: number; misses: number; sessions_seen: number; status: string } {
  const dir = join(neuronsDir, "patterns");
  const filepath = join(dir, `${patternId}.md`);

  if (!existsSync(filepath)) {
    throw new Error(`Pattern ${patternId} not found at ${filepath}`);
  }

  const raw = readFileSync(filepath, "utf-8");
  const { data, content } = matter(raw);
  const fm = data as NeuronFrontmatter;

  if (action === "hit") {
    fm.hits = (fm.hits ?? 0) + 1;
    fm.last_hit = new Date().toISOString().split("T")[0];
  } else {
    fm.misses = (fm.misses ?? 0) + 1;
  }
  fm.sessions_seen = (fm.sessions_seen ?? 0) + 1;

  // Lifecycle gate checks
  const hits = fm.hits ?? 0;
  const sessions = fm.sessions_seen ?? 0;
  const currentStatus = fm.status ?? "new";

  if (currentStatus === "new" && hits >= 3 && sessions >= 10) {
    fm.status = "validated";
  } else if (currentStatus === "validated" && hits >= 7 && sessions >= 20) {
    fm.status = "graduated";
  }

  writeFileSync(filepath, matter.stringify(content, fm), "utf-8");

  return {
    success: true,
    hits: fm.hits ?? 0,
    misses: fm.misses ?? 0,
    sessions_seen: fm.sessions_seen ?? 0,
    status: fm.status ?? "new",
  };
}

/**
 * Get aggregate stats
 */
export function getStats(neuronsDir: string): {
  errors: number;
  decisions: number;
  patterns: number;
  foundations: number;
  business: number;
  total: number;
  recent_domains: string[];
} {
  const stats = {
    errors: 0,
    decisions: 0,
    patterns: 0,
    foundations: 0,
    business: 0,
    total: 0,
    recent_domains: [] as string[],
  };

  const domainSet = new Set<string>();

  for (const cat of CATEGORY_DIRS) {
    const neurons = listNeurons(neuronsDir, cat);
    stats[cat] = neurons.length;
    stats.total += neurons.length;

    for (const n of neurons) {
      if (n.frontmatter.domain) {
        domainSet.add(n.frontmatter.domain);
      }
    }
  }

  stats.recent_domains = [...domainSet].slice(0, 10);
  return stats;
}

/**
 * Format a neuron as a compact breadcrumb (NF-010 style)
 */
export function toBreadcrumb(neuron: Neuron): string {
  const occ = neuron.frontmatter.occurrences ?? 1;
  const status = neuron.frontmatter.status ?? "new";
  return `${neuron.filename.replace(".md", "")} | ${neuron.title} | occ:${occ} status:${status}`;
}

/**
 * Format neurons for bootstrap injection
 */
export function formatBootstrap(neuronsDir: string, count: number = 5): string {
  const recent = getRecentNeurons(neuronsDir, count);
  const lines: string[] = ["# Neuron Bootstrap — Recent Knowledge\n"];

  for (const cat of CATEGORY_DIRS) {
    const neurons = recent[cat];
    if (neurons.length === 0) continue;

    lines.push(`## ${cat.charAt(0).toUpperCase() + cat.slice(1)} (${neurons.length} most recent)`);
    for (const n of neurons) {
      lines.push(`- ${toBreadcrumb(n)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
