import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isInside,
  safeSlug,
  validateStagingRoot,
  prepareStagingSubdir,
  PROPOSED_NEURONS_SUBDIR,
  ISSUES_SUBDIR,
} from "../src/staging-paths";

describe("isInside (lexical)", () => {
  it("treats an identical path as inside", () => {
    expect(isInside("/tmp/a", "/tmp/a")).toBe(true);
  });
  it("recognizes a nested path", () => {
    expect(isInside("/tmp/a", "/tmp/a/b/c")).toBe(true);
  });
  it("rejects a sibling (prefix but not a path-segment child)", () => {
    expect(isInside("/tmp/a", "/tmp/ab")).toBe(false);
    expect(isInside("/tmp/a", "/tmp/b")).toBe(false);
  });
  it("rejects a parent", () => {
    expect(isInside("/tmp/a/b", "/tmp/a")).toBe(false);
  });
});

describe("safeSlug — traversal-proof", () => {
  it("normalizes a finding id", () => {
    expect(safeSlug("mirror_cluster#0")).toBe("mirror-cluster-0");
    expect(safeSlug("NE-123")).toBe("ne-123");
  });
  it("neutralizes path traversal entirely (no dots, no slashes survive)", () => {
    const s = safeSlug("../../etc/passwd");
    expect(s).toBe("etc-passwd");
    expect(s).not.toContain("/");
    expect(s).not.toContain("..");
  });
  it("collapses a pure-traversal/dots string to empty", () => {
    expect(safeSlug("../..")).toBe("");
    expect(safeSlug("///")).toBe("");
    expect(safeSlug("")).toBe("");
  });
  it("bounds length", () => {
    expect(safeSlug("a".repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

// ── Physical (realpath/symlink) containment ──────────────────────────────────

describe("validateStagingRoot — PHYSICAL containment (symlink-safe)", () => {
  let corpus: string;
  let staging: string;

  beforeEach(() => {
    corpus = realpathSync.native(mkdtempSync(join(tmpdir(), "sp-corpus-")));
    staging = realpathSync.native(mkdtempSync(join(tmpdir(), "sp-staging-")));
  });
  afterEach(() => {
    rmSync(corpus, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  });

  it("accepts a staging root disjoint from the corpus", () => {
    const r = validateStagingRoot(staging, corpus);
    expect(r.ok).toBe(true);
    expect(r.root).toBe(staging);
    expect(r.corpus).toBe(corpus);
  });

  it("rejects a (not-yet-existing) staging root lexically inside the corpus", () => {
    const r = validateStagingRoot(join(corpus, "staging"), corpus);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/inside the live corpus/);
  });

  it("rejects a staging root that CONTAINS the corpus", () => {
    const nested = join(staging, "neurons");
    mkdirSync(nested);
    const r = validateStagingRoot(staging, nested);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/contains the live corpus/);
  });

  it("rejects staging root == corpus", () => {
    const r = validateStagingRoot(corpus, corpus);
    expect(r.ok).toBe(false);
  });

  it("BLOCKER REGRESSION: rejects a staging root that is a SYMLINK to the corpus", () => {
    const link = join(staging, "link-to-corpus");
    symlinkSync(corpus, link);
    const r = validateStagingRoot(link, corpus);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/resolves to the live corpus|inside the live corpus/);
  });

  it("rejects an empty staging root", () => {
    expect(validateStagingRoot("", corpus).ok).toBe(false);
    // @ts-expect-error — guarding the runtime contract against a non-string
    expect(validateStagingRoot(undefined, corpus).ok).toBe(false);
  });
});

describe("prepareStagingSubdir — refuses symlinked subdirs (no corpus write)", () => {
  let corpus: string;
  let staging: string;

  beforeEach(() => {
    corpus = realpathSync.native(mkdtempSync(join(tmpdir(), "sp-corpus-")));
    staging = realpathSync.native(mkdtempSync(join(tmpdir(), "sp-staging-")));
  });
  afterEach(() => {
    rmSync(corpus, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  });

  it("creates and resolves a normal subdir inside the real root", () => {
    const r = prepareStagingSubdir(staging, corpus, PROPOSED_NEURONS_SUBDIR);
    expect(r.ok).toBe(true);
    expect(r.dir).toBe(join(staging, PROPOSED_NEURONS_SUBDIR));
    expect(existsSync(r.dir!)).toBe(true);
  });

  it("BLOCKER REGRESSION: refuses a subdir that is a symlink into the corpus", () => {
    symlinkSync(corpus, join(staging, ISSUES_SUBDIR)); // staging/issues -> corpus
    const r = prepareStagingSubdir(staging, corpus, ISSUES_SUBDIR);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/symlink/);
    expect(readdirSync(corpus)).toHaveLength(0); // nothing leaked into the corpus
  });
});
