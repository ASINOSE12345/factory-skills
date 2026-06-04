import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  linkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAction, type ExecutorContext } from "../src/executor";
import { PROPOSED_NEURONS_SUBDIR, ISSUES_SUBDIR } from "../src/staging-paths";
import type { PolicyDecision, Finding, AnyActionType } from "../src/autonomy-types";

const NOW = new Date("2026-06-04T12:00:00Z");

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "self_knowledge#1",
    dimension: "self_knowledge",
    ids: ["NE-1", "NE-2", "NE-3"],
    evidence: ["3 similar error neurons (cosine ≥ 0.9)"],
    inference: "A recurring error class with no preventive pattern.",
    recommendation: "Distill a preventive NP.",
    confidence: "high",
    ...over,
  };
}

function mkDecision(action_type: AnyActionType, finding = mkFinding()): PolicyDecision {
  return {
    action_type,
    status: "executed",
    reason: "autonomous mode + flag on + not dry-run",
    finding,
    summary: `[DREAM] ${action_type}`,
  };
}

describe("executor — staging writes", () => {
  let staging: string;
  let neuronsDir: string;
  let ctx: ExecutorContext;

  beforeEach(() => {
    staging = mkdtempSync(join(tmpdir(), "cp3-staging-"));
    neuronsDir = mkdtempSync(join(tmpdir(), "cp3-corpus-"));
    ctx = { stagingRoot: staging, neuronsDir, now: NOW };
  });
  afterEach(() => {
    rmSync(staging, { recursive: true, force: true });
    rmSync(neuronsDir, { recursive: true, force: true });
  });

  it("writes a PROPOSED neuron to proposed-neurons/ and returns executed+staging", () => {
    const out = executeAction(mkDecision("create_proposed_neuron"), ctx);
    expect(out.status).toBe("executed");
    expect(out.execution?.target).toBe("staging");
    expect(out.execution?.artifact).toBe("proposed-neurons/self-knowledge-1.md");
    const file = join(staging, out.execution!.artifact);
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf-8");
    expect(content).toMatch(/status: proposed/);
    expect(content).toMatch(/PROPOSED NP/);
  });

  it("writes an issue artifact to issues/ as JSON (no GitHub)", () => {
    const out = executeAction(
      mkDecision("create_issue", mkFinding({ id: "mirror_cluster#0", dimension: "mirror_cluster" })),
      ctx,
    );
    expect(out.status).toBe("executed");
    expect(out.execution?.artifact).toBe("issues/mirror-cluster-0.json");
    const parsed = JSON.parse(readFileSync(join(staging, out.execution!.artifact), "utf-8"));
    expect(parsed.source).toBe("reflect_neurons:cp3-executor");
    expect(parsed.labels).toContain("mirror_cluster");
  });

  it("redacts secrets before writing the artifact", () => {
    const secret = "sk-ant-api03-AAAA1111BBBB2222CCCC";
    const d = mkDecision(
      "create_proposed_neuron",
      mkFinding({ evidence: [`leaked token ${secret}`], inference: `key ${secret} appears here` }),
    );
    const out = executeAction(d, ctx);
    const content = readFileSync(join(staging, out.execution!.artifact), "utf-8");
    expect(content).not.toContain(secret);
    expect(content).toMatch(/«REDACTED-anthropic-key»/);
  });

  it("sanitizes a traversal id; the artifact stays inside staging", () => {
    const out = executeAction(
      mkDecision("create_issue", mkFinding({ id: "../../etc/passwd", dimension: "mirror_cluster" })),
      ctx,
    );
    expect(out.status).toBe("executed");
    expect(out.execution!.artifact).not.toContain("..");
    expect(existsSync(join(staging, out.execution!.artifact))).toBe(true);
    expect(existsSync("/etc/passwd.json")).toBe(false); // nothing escaped
  });

  it("blocks when the staging root is inside the live corpus (writes nothing)", () => {
    const inside = join(neuronsDir, "staging");
    const out = executeAction(mkDecision("create_proposed_neuron"), { ...ctx, stagingRoot: inside });
    expect(out.status).toBe("blocked");
    expect(out.execution).toBeUndefined();
    expect(existsSync(inside)).toBe(false); // ensureStagingDirs never ran
    expect(readdirSync(staging)).toHaveLength(0); // disjoint staging untouched too
  });

  it("blocks an unsupported action type (fail-closed) and writes nothing", () => {
    const out = executeAction(mkDecision("report"), ctx);
    expect(out.status).toBe("blocked");
    expect(out.execution).toBeUndefined();
    expect(existsSync(join(staging, PROPOSED_NEURONS_SUBDIR))).toBe(false);
    expect(readdirSync(staging)).toHaveLength(0);
  });
});

// The blocker the operator caught: lexical resolve() is symlink-blind, so a
// staging root (or subdir) symlinked into the corpus would write physically into
// neurons/. These prove the realpath guards close every vector — and, critically,
// that the live corpus receives NOTHING in each case.
describe("executor — symlink containment (BLOCKER regression)", () => {
  let staging: string;
  let neuronsDir: string;
  let ctx: ExecutorContext;

  beforeEach(() => {
    staging = mkdtempSync(join(tmpdir(), "cp3-staging-"));
    neuronsDir = mkdtempSync(join(tmpdir(), "cp3-corpus-"));
    ctx = { stagingRoot: staging, neuronsDir, now: NOW };
  });
  afterEach(() => {
    rmSync(staging, { recursive: true, force: true });
    rmSync(neuronsDir, { recursive: true, force: true });
  });

  it("blocks when the staging ROOT is a symlink to the corpus (corpus stays empty)", () => {
    const link = join(staging, "root-link");
    symlinkSync(neuronsDir, link); // root-link -> corpus
    const out = executeAction(mkDecision("create_proposed_neuron"), { ...ctx, stagingRoot: link });
    expect(out.status).toBe("blocked");
    expect(out.execution).toBeUndefined();
    expect(readdirSync(neuronsDir)).toHaveLength(0); // nothing written into the live corpus
  });

  it("blocks when staging/proposed-neurons is a symlink to the corpus (corpus stays empty)", () => {
    symlinkSync(neuronsDir, join(staging, PROPOSED_NEURONS_SUBDIR)); // proposed-neurons -> corpus
    const out = executeAction(mkDecision("create_proposed_neuron"), ctx);
    expect(out.status).toBe("blocked");
    expect(out.reason).toMatch(/symlink/);
    expect(readdirSync(neuronsDir)).toHaveLength(0);
  });

  it("blocks when staging/issues is a symlink to the corpus (corpus stays empty)", () => {
    symlinkSync(neuronsDir, join(staging, ISSUES_SUBDIR)); // issues -> corpus
    const out = executeAction(
      mkDecision("create_issue", mkFinding({ id: "mirror_cluster#0", dimension: "mirror_cluster" })),
      ctx,
    );
    expect(out.status).toBe("blocked");
    expect(out.reason).toMatch(/symlink/);
    expect(readdirSync(neuronsDir)).toHaveLength(0);
  });

  it("a normal (non-symlink) staging root still works alongside the guards", () => {
    const out = executeAction(mkDecision("create_proposed_neuron"), ctx);
    expect(out.status).toBe("executed");
    expect(out.execution?.target).toBe("staging");
    expect(readdirSync(neuronsDir)).toHaveLength(0); // corpus still untouched
  });
});

// Second blocker the operator caught: even with the subdir real, a PREEXISTING
// artifact (regular, symlink, or HARDLINK to a corpus file) would be truncated by
// a default "w" write. A hardlink shares the inode, so overwriting it mutates the
// live corpus — yet it is NOT a symlink, so the symlink guards don't see it. The
// fix is exclusive create (O_EXCL): we never overwrite, only ever create-new.
describe("executor — never overwrites a preexisting artifact (O_EXCL)", () => {
  let staging: string;
  let neuronsDir: string;
  let ctx: ExecutorContext;
  // Default mkFinding() ⇒ create_proposed_neuron lands here:
  const ARTIFACT = ["proposed-neurons", "self-knowledge-1.md"] as const;

  beforeEach(() => {
    staging = mkdtempSync(join(tmpdir(), "cp3-staging-"));
    neuronsDir = mkdtempSync(join(tmpdir(), "cp3-corpus-"));
    ctx = { stagingRoot: staging, neuronsDir, now: NOW };
    mkdirSync(join(staging, ARTIFACT[0]));
  });
  afterEach(() => {
    rmSync(staging, { recursive: true, force: true });
    rmSync(neuronsDir, { recursive: true, force: true });
  });

  it("blocks when the artifact already exists as a regular file (content intact)", () => {
    const file = join(staging, ...ARTIFACT);
    writeFileSync(file, "ORIGINAL", "utf-8");
    const out = executeAction(mkDecision("create_proposed_neuron"), ctx);
    expect(out.status).toBe("blocked");
    expect(out.reason).toMatch(/already exists|overwrite/);
    expect(readFileSync(file, "utf-8")).toBe("ORIGINAL"); // untouched
  });

  it("BLOCKER REGRESSION: blocks when the artifact is a HARDLINK to a corpus file (corpus intact)", () => {
    const victim = join(neuronsDir, "victim.md");
    writeFileSync(victim, "CORPUS-ORIGINAL", "utf-8");
    linkSync(victim, join(staging, ...ARTIFACT)); // hardlink: same inode as the corpus file
    const out = executeAction(mkDecision("create_proposed_neuron"), ctx);
    expect(out.status).toBe("blocked");
    expect(out.execution).toBeUndefined();
    expect(readFileSync(victim, "utf-8")).toBe("CORPUS-ORIGINAL"); // shared inode NOT overwritten
  });

  it("blocks when the artifact is a symlink to a corpus file (corpus intact)", () => {
    const victim = join(neuronsDir, "victim.md");
    writeFileSync(victim, "CORPUS-ORIGINAL", "utf-8");
    symlinkSync(victim, join(staging, ...ARTIFACT)); // artifact path is a symlink
    const out = executeAction(mkDecision("create_proposed_neuron"), ctx);
    expect(out.status).toBe("blocked");
    expect(readFileSync(victim, "utf-8")).toBe("CORPUS-ORIGINAL");
  });

  it("a fresh (non-existing) artifact path still writes and returns executed", () => {
    const out = executeAction(mkDecision("create_proposed_neuron"), ctx);
    expect(out.status).toBe("executed");
    expect(out.execution?.artifact).toBe("proposed-neurons/self-knowledge-1.md");
    expect(existsSync(join(staging, ...ARTIFACT))).toBe(true);
    expect(readdirSync(neuronsDir)).toHaveLength(0); // corpus untouched
  });
});
