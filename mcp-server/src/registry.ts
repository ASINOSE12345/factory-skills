/**
 * registry.ts — read-only loader + validator for the declarative project registry
 * (`config/projects.json`).
 *
 * PR-3B scope: the registry EXISTS and can be MEASURED against (via the
 * project-coverage auditor's `--registry` flag), but is NOT wired into the live
 * MCP scope resolution — that adoption is PR-3C. This module performs zero writes.
 *
 * Fail-closed: structural errors throw with a clear message (no silent fallback).
 * Semantic data issues the operator should fix (alias / repo collisions) are
 * RECORDED on the result for the auditor to report, rather than crashing.
 */

import { readFileSync, existsSync } from "node:fs";

export type ProjectStatus = "active" | "archived" | "external" | "legacy";

/** What a registry entry represents (registry v2 — additive/optional). */
export type EntityType =
  | "organization"
  | "platform"
  | "memory"
  | "toolkit"
  | "operating_system"
  | "client"
  | "project"
  | "repo"
  | "source_lineage";

/**
 * Reuse classification of a body of knowledge. This is NOT access control / authZ —
 * the runtime must never treat it as a permission. It only describes how broadly a
 * lesson may be *reused* (e.g. a redacted global pattern vs tenant-only memory).
 */
export type ReuseScope =
  | "global"
  | "tenant_private"
  | "project_private"
  | "internal"
  | "public_pattern";

export interface RegistryRepo {
  /** Local repo directory name (matched against discovered repos). */
  repo_id: string;
  /** e.g. "app", "core", "web", "docs", "backup", "platform". */
  role?: string;
  /** Defaults to the owning project's status. */
  status?: ProjectStatus;
  note?: string;
}

export interface RegistryProject {
  /** Canonical, stable project id. */
  project_id: string;
  status: ProjectStatus;
  /** Platform/factory-wide knowledge (not project-specific coverage). */
  is_global?: boolean;
  /** project/scope frontmatter tokens that resolve to this project. */
  aliases?: string[];
  /** Local repos that belong to this project. */
  repos?: RegistryRepo[];
  // ── Registry v2 — all OPTIONAL and additive; v1 files omit these ───────────
  /** What this entry represents. Omitted → treated as a project. */
  entity_type?: EntityType;
  /** Owning organization id. */
  owner_id?: string;
  /** Parent entity id (hierarchy: project → client/platform → organization). */
  parent_id?: string;
  /** Tenant/client this entry belongs to. */
  tenant_id?: string;
  /** Reuse classification — NOT access control (see ReuseScope). */
  reuse_scope?: ReuseScope;
  /** Source tools/spikes this knowledge derives from (e.g. ["paperclip"]).
   *  Lineage only — a lineage entry is NEVER a neuron's owning project. */
  lineage?: string[];
  note?: string;
}

export interface ProjectsRegistry {
  version: number;
  projects: RegistryProject[];
}

export interface RepoBinding {
  project_id: string;
  repo_status: ProjectStatus;
  role?: string;
}

export interface LoadedRegistry {
  path: string;
  raw: ProjectsRegistry;
  projectById: Map<string, RegistryProject>;
  /** normalized repo-dir-name → binding */
  repoToProject: Map<string, RepoBinding>;
  /** normalized alias/canonical token → project_id */
  aliasToProject: Map<string, string>;
  /** soft issues — recorded, not thrown, so the auditor can surface them. */
  aliasCollisions: Array<{ alias: string; project_ids: string[] }>;
  repoCollisions: Array<{ repo_id: string; project_ids: string[] }>;
}

const STATUSES: ReadonlySet<string> = new Set(["active", "archived", "external", "legacy"]);
const ENTITY_TYPES: ReadonlySet<string> = new Set([
  "organization", "platform", "memory", "toolkit", "operating_system", "client", "project", "repo", "source_lineage",
]);
const REUSE_SCOPES: ReadonlySet<string> = new Set([
  "global", "tenant_private", "project_private", "internal", "public_pattern",
]);
/** Entity types that do NOT own neurons/repos. Excluded from the alias & repo
 *  indexes so a lineage/organization entry can never become a project that a
 *  neuron resolves to (enforces the ADR-0001 Paperclip rule structurally). */
export const NON_INDEXED_ENTITY_TYPES: ReadonlySet<string> = new Set(["source_lineage", "organization"]);

/** Same normalization the neuron scope model uses (lowercase, strip separators). */
export function normalizeToken(s: string): string {
  return (s ?? "").toLowerCase().replace(/[\s_-]/g, "");
}

function fail(msg: string): never {
  throw new Error(`invalid registry: ${msg}`);
}

/** Strict structural validation. Throws on the first malformed field. */
export function validateRegistry(data: unknown): ProjectsRegistry {
  if (!data || typeof data !== "object") fail("root must be an object");
  const d = data as Record<string, unknown>;
  if (typeof d.version !== "number") fail("`version` must be a number");
  if (!Array.isArray(d.projects)) fail("`projects` must be an array");

  const seen = new Set<string>();
  d.projects.forEach((p, i) => {
    if (!p || typeof p !== "object") fail(`projects[${i}] must be an object`);
    const pr = p as Record<string, unknown>;
    if (typeof pr.project_id !== "string" || pr.project_id.trim() === "") fail(`projects[${i}].project_id must be a non-empty string`);
    const pid = pr.project_id;
    const norm = normalizeToken(pid);
    if (seen.has(norm)) fail(`duplicate project_id '${pid}'`);
    seen.add(norm);
    if (typeof pr.status !== "string" || !STATUSES.has(pr.status)) fail(`projects[${i}] (${pid}).status must be one of active|archived|external|legacy`);
    if (pr.is_global !== undefined && typeof pr.is_global !== "boolean") fail(`projects[${i}] (${pid}).is_global must be a boolean`);
    // ── Registry v2 optional fields (additive) ───────────────────────────────
    if (pr.entity_type !== undefined && (typeof pr.entity_type !== "string" || !ENTITY_TYPES.has(pr.entity_type))) fail(`projects[${i}] (${pid}).entity_type must be one of ${[...ENTITY_TYPES].join("|")}`);
    if (pr.reuse_scope !== undefined && (typeof pr.reuse_scope !== "string" || !REUSE_SCOPES.has(pr.reuse_scope))) fail(`projects[${i}] (${pid}).reuse_scope must be one of ${[...REUSE_SCOPES].join("|")}`);
    for (const k of ["owner_id", "parent_id", "tenant_id"] as const) {
      if (pr[k] !== undefined && (typeof pr[k] !== "string" || (pr[k] as string).trim() === "")) fail(`projects[${i}] (${pid}).${k} must be a non-empty string`);
    }
    if (pr.lineage !== undefined && (!Array.isArray(pr.lineage) || pr.lineage.some((x) => typeof x !== "string"))) fail(`projects[${i}] (${pid}).lineage must be a string[]`);
    if (pr.aliases !== undefined) {
      if (!Array.isArray(pr.aliases) || pr.aliases.some((a) => typeof a !== "string")) fail(`projects[${i}] (${pid}).aliases must be a string[]`);
    }
    if (pr.repos !== undefined) {
      if (!Array.isArray(pr.repos)) fail(`projects[${i}] (${pid}).repos must be an array`);
      pr.repos.forEach((r, j) => {
        if (!r || typeof r !== "object") fail(`projects[${i}].repos[${j}] must be an object`);
        const rr = r as Record<string, unknown>;
        if (typeof rr.repo_id !== "string" || rr.repo_id.trim() === "") fail(`projects[${i}].repos[${j}].repo_id must be a non-empty string`);
        if (rr.status !== undefined && (typeof rr.status !== "string" || !STATUSES.has(rr.status))) fail(`projects[${i}].repos[${j}] (${rr.repo_id}).status must be one of active|archived|external`);
        if (rr.role !== undefined && typeof rr.role !== "string") fail(`projects[${i}].repos[${j}] (${rr.repo_id}).role must be a string`);
      });
    }
  });

  return data as ProjectsRegistry;
}

/** Build lookup indexes + record alias/repo collisions (does not throw). */
export function indexRegistry(raw: ProjectsRegistry, path: string): LoadedRegistry {
  const projectById = new Map<string, RegistryProject>();
  const repoToProject = new Map<string, RepoBinding>();
  const aliasToProject = new Map<string, string>();
  const aliasOwners = new Map<string, Set<string>>();
  const repoOwners = new Map<string, Set<string>>();

  for (const p of raw.projects) {
    projectById.set(p.project_id, p); // every entry is addressable for reporting/hierarchy
    // Lineage/organization entries are NOT neuron/repo owners → keep them out of
    // the resolution indexes (so Paperclip-as-lineage never becomes a project alias).
    const indexed = !p.entity_type || !NON_INDEXED_ENTITY_TYPES.has(p.entity_type);
    if (!indexed) continue;
    for (const t of [p.project_id, ...(p.aliases ?? [])]) {
      const n = normalizeToken(t);
      if (!n) continue;
      if (!aliasOwners.has(n)) aliasOwners.set(n, new Set());
      aliasOwners.get(n)!.add(p.project_id);
      if (!aliasToProject.has(n)) aliasToProject.set(n, p.project_id);
    }
    for (const r of p.repos ?? []) {
      const n = normalizeToken(r.repo_id);
      if (!n) continue;
      if (!repoOwners.has(n)) repoOwners.set(n, new Set());
      repoOwners.get(n)!.add(p.project_id);
      if (!repoToProject.has(n)) repoToProject.set(n, { project_id: p.project_id, repo_status: r.status ?? p.status, role: r.role });
    }
  }

  const aliasCollisions = [...aliasOwners.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([alias, ids]) => ({ alias, project_ids: [...ids].sort() }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
  const repoCollisions = [...repoOwners.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([repo_id, ids]) => ({ repo_id, project_ids: [...ids].sort() }))
    .sort((a, b) => a.repo_id.localeCompare(b.repo_id));

  return { path, raw, projectById, repoToProject, aliasToProject, aliasCollisions, repoCollisions };
}

/** Load + validate + index a registry file. Throws on missing/unreadable/malformed. */
export function loadRegistry(path: string): LoadedRegistry {
  if (!path || !existsSync(path)) fail(`file not found: '${path}'`);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    fail(`cannot read file '${path}' (${(e as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    fail(`not valid JSON (${(e as Error).message})`);
  }
  const raw = validateRegistry(parsed);
  return indexRegistry(raw, path);
}

/**
 * Non-throwing variant of {@link loadRegistry}: returns the loaded registry, or
 * `null` if the file is missing / unreadable / malformed. Used by the live scope
 * resolver (`neurons.ts`) so a bad or absent registry degrades cleanly to the
 * seed/external fallback instead of crashing the MCP server. Errors are surfaced
 * via the `onError` callback (callers warn once); they are never thrown.
 */
export function tryLoadRegistry(path: string, onError?: (message: string) => void): LoadedRegistry | null {
  try {
    return loadRegistry(path);
  } catch (e) {
    onError?.((e as Error).message);
    return null;
  }
}
