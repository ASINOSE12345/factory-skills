import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  statePath,
  sanitizeSessionId,
  worktreeFingerprint,
  loadState,
  saveState,
  cleanupStale,
  type GateState,
} from "../src/iron-gates-state";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "igs-"));
  process.env.IRON_GATES_STATE_DIR = dir;
});

afterEach(() => {
  delete process.env.IRON_GATES_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function mkState(sessionId: string, over: Partial<GateState> = {}): GateState {
  return {
    session_id: sessionId,
    last_verification_at: null,
    last_verification_cmd: null,
    active_error: null,
    fix_attempts: {},
    verification_passed: false,
    ...over,
  };
}

const legacyFile = () => join(dir, "iron-gates-state.json");
// Two distinct worktree cwds (need not exist on disk — fingerprint hashes the path).
const CWD_A = "/work/repoA";
const CWD_B = "/work/repoB";

// ── sanitize + fingerprint + path ────────────────────────────────────────────

describe("sanitizeSessionId", () => {
  it("keeps a UUID, replaces unsafe chars, bounds length, never empty", () => {
    expect(sanitizeSessionId("4512af14-0f4b-4820-a325-c5b92f7dbc2a")).toBe("4512af14-0f4b-4820-a325-c5b92f7dbc2a");
    expect(sanitizeSessionId("a/b c.d")).toBe("a_b_c_d");
    expect(sanitizeSessionId("")).toBe("unknown");
    expect(sanitizeSessionId(undefined as unknown as string)).toBe("unknown");
    expect(sanitizeSessionId("x".repeat(300)).length).toBe(128);
  });
});

describe("worktreeFingerprint", () => {
  it("different worktrees → different fingerprints", () => {
    expect(worktreeFingerprint(CWD_A)).not.toBe(worktreeFingerprint(CWD_B));
  });
  it("same cwd → same fingerprint; undefined → 'nocwd'", () => {
    expect(worktreeFingerprint(CWD_A)).toBe(worktreeFingerprint(CWD_A));
    expect(worktreeFingerprint(undefined)).toBe("nocwd");
  });
  it("subdirectories of the same worktree share a fingerprint (walks up to .git)", () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-"));
    mkdirSync(join(wt, ".git"));
    const sub = join(wt, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(worktreeFingerprint(sub)).toBe(worktreeFingerprint(wt));
    rmSync(wt, { recursive: true, force: true });
  });
});

describe("statePath", () => {
  it("is keyed by BOTH session and worktree", () => {
    expect(statePath("S1", CWD_A)).not.toBe(statePath("S1", CWD_B)); // same session, diff worktree
    expect(statePath("S1", CWD_A)).not.toBe(statePath("S2", CWD_A)); // diff session, same worktree
    expect(statePath("S1", CWD_A)).toContain("iron-gates-state-S1-");
    expect(statePath("S1", CWD_A)).not.toBe(legacyFile());
  });
});

// ── the contract matrix: session × worktree ──────────────────────────────────

describe("isolation matrix (session × worktree)", () => {
  it("1. same session, DIFFERENT worktree → does NOT inherit pass", () => {
    saveState(mkState("S1", { verification_passed: true }), CWD_A);
    expect(loadState("S1", CWD_B).verification_passed).toBe(false);
  });
  it("2. same session, SAME worktree → inherits its own pass", () => {
    saveState(mkState("S1", { verification_passed: true, last_verification_cmd: "npm test" }), CWD_A);
    const s = loadState("S1", CWD_A);
    expect(s.verification_passed).toBe(true);
    expect(s.last_verification_cmd).toBe("npm test");
  });
  it("3. DIFFERENT session, SAME worktree → does NOT clobber", () => {
    saveState(mkState("S1", { verification_passed: true }), CWD_A);
    saveState(mkState("S2", { verification_passed: true }), CWD_A);
    const s1 = loadState("S1", CWD_A);
    expect(s1.verification_passed).toBe(true);
    expect(s1.session_id).toBe("S1");
  });
  it("4. DIFFERENT session, DIFFERENT worktree → does NOT clobber", () => {
    saveState(mkState("S1", { verification_passed: true }), CWD_A);
    saveState(mkState("S2", { verification_passed: true }), CWD_B);
    expect(loadState("S1", CWD_A).verification_passed).toBe(true);
    expect(loadState("S2", CWD_B).verification_passed).toBe(true);
  });
  it("a brand-new (session, worktree) is fresh", () => {
    expect(loadState("NEW", CWD_A)).toEqual(mkState("NEW"));
  });
});

// ── legacy compat: safe, no cross-worktree pass inheritance ───────────────────

describe("legacy compat", () => {
  it("reads the legacy file for the same session but does NOT inherit its pass", () => {
    writeFileSync(legacyFile(), JSON.stringify(mkState("S1", { verification_passed: true, active_error: "e1", fix_attempts: { e1: 2 } })));
    const s = loadState("S1", CWD_A);
    expect(s.verification_passed).toBe(false); // pass NOT inherited (legacy has no worktree info)
    expect(s.last_verification_at).toBeNull();
    expect(s.active_error).toBe("e1"); // active_error/fix_attempts preserved (Gate 5 continuity)
    expect(s.fix_attempts).toEqual({ e1: 2 });
  });
  it("a legacy file of a DIFFERENT session is ignored", () => {
    writeFileSync(legacyFile(), JSON.stringify(mkState("S1", { verification_passed: true })));
    expect(loadState("S2", CWD_A)).toEqual(mkState("S2"));
  });
  it("the per-(session,worktree) file wins over legacy", () => {
    writeFileSync(legacyFile(), JSON.stringify(mkState("S1", { verification_passed: false })));
    saveState(mkState("S1", { verification_passed: true }), CWD_A);
    expect(loadState("S1", CWD_A).verification_passed).toBe(true);
  });
  it("a corrupt state file degrades to fresh (no throw)", () => {
    writeFileSync(statePath("S1", CWD_A), "{ not json");
    expect(loadState("S1", CWD_A)).toEqual(mkState("S1"));
  });
});

// ── cleanup ──────────────────────────────────────────────────────────────────

describe("cleanupStale", () => {
  it("removes state files older than the TTL, keeps fresh ones (deterministic now)", () => {
    const NOW = new Date("2026-06-10T00:00:00Z").getTime();
    saveState(mkState("OLD"), CWD_A);
    saveState(mkState("FRESH"), CWD_A);
    const aged = new Date(NOW - 25 * 3600 * 1000);
    const recent = new Date(NOW - 1 * 3600 * 1000);
    utimesSync(statePath("OLD", CWD_A), aged, aged);
    utimesSync(statePath("FRESH", CWD_A), recent, recent);
    cleanupStale(NOW);
    expect(existsSync(statePath("OLD", CWD_A))).toBe(false);
    expect(existsSync(statePath("FRESH", CWD_A))).toBe(true);
  });
  it("never removes the legacy global file (prefix doesn't match)", () => {
    const NOW = new Date("2026-06-10T00:00:00Z").getTime();
    writeFileSync(legacyFile(), JSON.stringify(mkState("X")));
    const aged = new Date(NOW - 100 * 3600 * 1000);
    utimesSync(legacyFile(), aged, aged);
    cleanupStale(NOW);
    expect(existsSync(legacyFile())).toBe(true);
  });
});
