import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  statePath,
  sanitizeSessionId,
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

// ── sanitize + path ──────────────────────────────────────────────────────────

describe("sanitizeSessionId", () => {
  it("keeps a UUID intact, replaces unsafe chars, bounds length, never empty", () => {
    expect(sanitizeSessionId("4512af14-0f4b-4820-a325-c5b92f7dbc2a")).toBe("4512af14-0f4b-4820-a325-c5b92f7dbc2a");
    expect(sanitizeSessionId("a/b c.d")).toBe("a_b_c_d");
    expect(sanitizeSessionId("")).toBe("unknown");
    expect(sanitizeSessionId(undefined as unknown as string)).toBe("unknown");
    expect(sanitizeSessionId("x".repeat(300)).length).toBe(128);
  });
});

describe("statePath", () => {
  it("is PER-SESSION: distinct sessions get distinct files", () => {
    expect(statePath("SESSION-A")).not.toBe(statePath("SESSION-B"));
    expect(statePath("SESSION-A")).toContain("iron-gates-state-SESSION-A.json");
    expect(statePath("SESSION-A").startsWith(dir)).toBe(true);
  });
  it("is NOT the legacy global file", () => {
    expect(statePath("SESSION-A")).not.toBe(legacyFile());
  });
});

// ── isolation: the race fix ──────────────────────────────────────────────────

describe("isolation — the race fix", () => {
  it("session B's write does NOT clobber session A's verification_passed", () => {
    saveState(mkState("SESSION-A", { verification_passed: true, last_verification_at: "2026-06-04T00:00:00Z" }));
    saveState(mkState("SESSION-B", { verification_passed: true })); // B writes its OWN file
    const a = loadState("SESSION-A");
    expect(a.verification_passed).toBe(true); // A still has its pass — not clobbered
    expect(a.session_id).toBe("SESSION-A");
    // and the two files genuinely coexist
    expect(existsSync(statePath("SESSION-A"))).toBe(true);
    expect(existsSync(statePath("SESSION-B"))).toBe(true);
  });

  it("session B with no pass does NOT inherit session A's pass", () => {
    saveState(mkState("SESSION-A", { verification_passed: true }));
    const b = loadState("SESSION-B"); // B never saved anything
    expect(b.verification_passed).toBe(false);
    expect(b.session_id).toBe("SESSION-B");
  });

  it("loadState returns a fresh state when this session has no file", () => {
    expect(loadState("BRAND-NEW")).toEqual(mkState("BRAND-NEW"));
  });

  it("a saved state round-trips for the SAME session", () => {
    saveState(mkState("SESSION-A", { verification_passed: true, last_verification_cmd: "npm test" }));
    const a = loadState("SESSION-A");
    expect(a.verification_passed).toBe(true);
    expect(a.last_verification_cmd).toBe("npm test");
  });
});

// ── legacy compatibility ─────────────────────────────────────────────────────

describe("legacy compat", () => {
  it("reads the legacy global file ONLY if it belongs to this session", () => {
    writeFileSync(legacyFile(), JSON.stringify(mkState("SESSION-A", { verification_passed: true })));
    expect(loadState("SESSION-A").verification_passed).toBe(true); // migrates/reads A's legacy
    expect(loadState("SESSION-B").verification_passed).toBe(false); // legacy is A's, not B's → fresh
  });

  it("the per-session file wins over a stale legacy file", () => {
    writeFileSync(legacyFile(), JSON.stringify(mkState("SESSION-A", { verification_passed: false })));
    saveState(mkState("SESSION-A", { verification_passed: true })); // newer per-session state
    expect(loadState("SESSION-A").verification_passed).toBe(true);
  });

  it("a corrupt state file degrades to fresh (no throw)", () => {
    writeFileSync(statePath("SESSION-A"), "{ not json");
    expect(loadState("SESSION-A")).toEqual(mkState("SESSION-A"));
  });
});

// ── cleanup ──────────────────────────────────────────────────────────────────

describe("cleanupStale", () => {
  it("removes per-session files older than the TTL, keeps fresh ones (deterministic now)", () => {
    const NOW = new Date("2026-06-10T00:00:00Z").getTime();
    saveState(mkState("OLD"));
    saveState(mkState("FRESH"));
    const aged = new Date(NOW - 25 * 3600 * 1000);
    const recent = new Date(NOW - 1 * 3600 * 1000);
    utimesSync(statePath("OLD"), aged, aged);
    utimesSync(statePath("FRESH"), recent, recent);
    cleanupStale(NOW);
    expect(existsSync(statePath("OLD"))).toBe(false);
    expect(existsSync(statePath("FRESH"))).toBe(true);
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
