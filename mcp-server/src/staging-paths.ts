/**
 * Staging path resolution & validation — the CP3 executor's containment layer.
 *
 * The executor may write ONLY under an explicit staging root, and NEVER inside
 * the live neuron corpus, never to GitHub, never anywhere else.
 *
 * Containment is checked PHYSICALLY, not lexically. A lexical `resolve()` compare
 * is symlink-blind: a `stagingRoot` (or a `proposed-neurons`/`issues` subdir)
 * that is a symlink into the corpus passes a textual check yet writes physically
 * inside `neurons/`. So every containment decision here goes through `realpath`
 * (which follows symlinks) and we additionally REFUSE a subdir that is itself a
 * symlink before creating or writing through it. Every rule fails closed.
 */

import { resolve, sep, join, dirname, basename } from "node:path";
import { mkdirSync, realpathSync, lstatSync } from "node:fs";

/** Sub-directories under the staging root, one per artifact kind. */
export const PROPOSED_NEURONS_SUBDIR = "proposed-neurons";
export const ISSUES_SUBDIR = "issues";

/** True if `child` is the same path as `parent`, or nested under it. Lexical —
 *  callers MUST pass realpaths when a containment decision must be symlink-safe. */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (c === p) return true;
  return c.startsWith(p + sep);
}

/** Physical realpath (follows symlinks), or null if the path cannot be resolved. */
export function realpathOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/** True if a directory entry exists at `p` at all (symlink included). */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** True if `p` exists AND is a symlink. `lstat` does not follow the final link. */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Project the PHYSICAL staging root: realpath of the nearest existing ancestor,
 * joined with the not-yet-existing remainder. This unmasks a symlink anywhere in
 * the existing portion of the chain (so a `stagingRoot` — or any ancestor — that
 * links into the corpus is resolved to its real target), while tolerating a root
 * that will be created later (`mkdir` only ever makes real dirs, never symlinks).
 * Returns null if even the nearest existing ancestor can't be realpath'd.
 */
function physicalProjectedRoot(rawStagingRoot: string): string | null {
  let cur = resolve(rawStagingRoot);
  const rest: string[] = [];
  for (;;) {
    if (lexists(cur)) break; // present as a dir entry (symlink or real)
    const parent = dirname(cur);
    if (parent === cur) return null; // walked to fs root, nothing existed
    rest.unshift(basename(cur));
    cur = parent;
  }
  const real = realpathOrNull(cur);
  if (real == null) return null; // e.g. a dangling symlink — fail closed
  return rest.length ? join(real, ...rest) : real;
}

export interface StagingRootResult {
  ok: boolean;
  /** Physically-resolved absolute root (only when ok). */
  root?: string;
  /** Physically-resolved corpus path (only when ok) — for downstream re-checks. */
  corpus?: string;
  /** Why it was rejected (only when !ok). */
  reason?: string;
}

/**
 * Validate a candidate staging root against the live corpus — PHYSICALLY. Returns
 * the realpath-resolved root and corpus, or a reason it was rejected. Pure (no
 * mkdir). Rejects when staging overlaps the corpus in EITHER direction after
 * symlinks are resolved: this is the guard that makes "never write to the live
 * corpus" structural, not hopeful, even under an adversarial symlink.
 */
export function validateStagingRoot(rawStagingRoot: string, neuronsDir: string): StagingRootResult {
  if (!rawStagingRoot || typeof rawStagingRoot !== "string") {
    return { ok: false, reason: "staging root is empty" };
  }
  const corpus = realpathOrNull(neuronsDir);
  if (corpus == null) {
    return { ok: false, reason: `cannot resolve live corpus path '${neuronsDir}'` };
  }
  const root = physicalProjectedRoot(rawStagingRoot);
  if (root == null) {
    return { ok: false, reason: `cannot resolve staging root '${rawStagingRoot}'` };
  }
  if (root === corpus) {
    return { ok: false, reason: `staging root resolves to the live corpus '${corpus}' — refused` };
  }
  if (isInside(corpus, root)) {
    return { ok: false, reason: `staging root '${root}' is inside the live corpus '${corpus}' — refused` };
  }
  if (isInside(root, corpus)) {
    return { ok: false, reason: `staging root '${root}' contains the live corpus '${corpus}' — refused` };
  }
  return { ok: true, root, corpus };
}

/**
 * Sanitize an arbitrary id/string into a safe, traversal-proof slug. Any run of
 * non-`[a-z0-9]` characters collapses to a single dash, so `../../etc/passwd`,
 * `mirror_cluster#0`, and `NE-123` all reduce to bounded `[a-z0-9-]`. A string
 * that sanitizes to empty (e.g. `../..`) yields `""` — callers MUST reject it.
 */
export function safeSlug(raw: string): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export interface StagingDirResult {
  ok: boolean;
  /** Physically-resolved subdir (only when ok). */
  dir?: string;
  reason?: string;
}

/**
 * Prepare and PHYSICALLY verify a staging subdir under an already-validated real
 * root. Order matters and is the whole point:
 *  (1) REFUSE a pre-existing subdir that is a symlink — BEFORE any mkdir/write,
 *      so we never create or write through a link into the corpus.
 *  (2) Create the subdir (real dir).
 *  (3) Re-realpath it: it must still be inside the real root AND outside the real
 *      corpus. Any drift → refused.
 */
export function prepareStagingSubdir(realRoot: string, corpusReal: string, subdir: string): StagingDirResult {
  const dir = join(realRoot, subdir);
  if (isSymlink(dir)) {
    return { ok: false, reason: `staging subdir '${subdir}' is a symlink — refused` };
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `cannot create staging subdir '${subdir}': ${String(e)}` };
  }
  const dirReal = realpathOrNull(dir);
  if (dirReal == null) {
    return { ok: false, reason: `staging subdir '${subdir}' could not be resolved after creation` };
  }
  if (dirReal !== dir && !isInside(realRoot, dirReal)) {
    return { ok: false, reason: `staging subdir '${subdir}' realpath '${dirReal}' escapes staging root — refused` };
  }
  if (dirReal === corpusReal || isInside(corpusReal, dirReal)) {
    return { ok: false, reason: `staging subdir '${subdir}' realpath '${dirReal}' is inside the live corpus — refused` };
  }
  return { ok: true, dir: dirReal };
}
