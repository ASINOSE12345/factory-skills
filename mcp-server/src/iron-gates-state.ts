/**
 * Iron Gates state — shared, PER-SESSION + PER-WORKTREE storage.
 *
 * Single source of truth for the Gate 2 verification state, used by BOTH hooks:
 *  - auto-capture.ts (the only WRITER of verification_passed)
 *  - iron-gates.ts  (the READER that gates push/PR/merge)
 *
 * Why this exists: the state used to live in ONE global file
 * (`/tmp/iron-gates-state.json`). Two sessions clobbered each other's file. A
 * first fix keyed the path by session_id, but that still let a single session
 * inherit a verification across DIFFERENT worktrees (verify in repo A, push in
 * repo B). So the key is now (session_id, worktree): a verification in one
 * worktree never enables a push in another, even within one session.
 *
 * The override file (`iron-gates-override.json`) stays global by design — the
 * operator creates it by hand; it is not part of this isolation.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

export interface GateState {
  session_id: string;
  last_verification_at: string | null;
  last_verification_cmd: string | null;
  active_error: string | null;
  fix_attempts: Record<string, number>;
  verification_passed: boolean;
}

const PREFIX = "iron-gates-state-";
const LEGACY_BASENAME = "iron-gates-state.json";
const STALE_MS = 24 * 60 * 60 * 1000; // 24h

/** State directory. Defaults to /tmp (matching the legacy path); override in tests. */
function stateDir(): string {
  return process.env.IRON_GATES_STATE_DIR || "/tmp";
}

/** Make a session_id safe to embed in a filename. Bounded; never empty. */
export function sanitizeSessionId(sessionId: string): string {
  const s = (sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return s.length > 0 ? s : "unknown";
}

/**
 * Stable fingerprint of the WORKTREE a command runs in. Walks up from cwd to the
 * worktree root (the first ancestor containing a `.git` file or dir) and hashes
 * it; subdirectories of the same worktree map to the same fingerprint. With no
 * cwd or no `.git` ancestor it falls back to the cwd itself (or "nocwd").
 */
export function worktreeFingerprint(cwd?: string): string {
  if (!cwd) return "nocwd";
  let dir: string;
  try {
    dir = resolve(cwd);
  } catch {
    return "nocwd";
  }
  let root = dir;
  while (true) {
    if (existsSync(join(root, ".git"))) break;
    const parent = dirname(root);
    if (parent === root) {
      root = dir; // reached fs root with no .git → key by the cwd itself
      break;
    }
    root = parent;
  }
  return createHash("sha1").update(root).digest("hex").slice(0, 12);
}

/** Per-(session, worktree) state file path. */
export function statePath(sessionId: string, cwd?: string): string {
  return join(stateDir(), `${PREFIX}${sanitizeSessionId(sessionId)}-${worktreeFingerprint(cwd)}.json`);
}

/** The legacy global state file (pre-isolation). Read-only compat. */
function legacyPath(): string {
  return join(stateDir(), LEGACY_BASENAME);
}

function freshState(sessionId: string): GateState {
  return {
    session_id: sessionId,
    last_verification_at: null,
    last_verification_cmd: null,
    active_error: null,
    fix_attempts: {},
    verification_passed: false,
  };
}

/** Parse a state file and return it ONLY if it belongs to sessionId; else null. */
function readIfMatches(file: string, sessionId: string): GateState | null {
  try {
    if (!existsSync(file)) return null;
    const state = JSON.parse(readFileSync(file, "utf-8")) as GateState;
    return state.session_id === sessionId ? state : null;
  } catch {
    return null;
  }
}

/**
 * Load THIS (session, worktree)'s state. Never inherits another session's OR
 * another worktree's state.
 *
 * Legacy compat: the pre-isolation global file is read once, ONLY for the same
 * session — but its verification_passed is NOT inherited, because the global
 * file has no worktree info and trusting its pass could leak a verification
 * across worktrees. A fresh verification is required; active_error/fix_attempts
 * (Gate 5 continuity) are preserved.
 */
export function loadState(sessionId: string, cwd?: string): GateState {
  const own = readIfMatches(statePath(sessionId, cwd), sessionId);
  if (own) return own;
  const legacy = readIfMatches(legacyPath(), sessionId);
  if (legacy) {
    return {
      ...legacy,
      verification_passed: false,
      last_verification_at: null,
      last_verification_cmd: null,
    };
  }
  return freshState(sessionId);
}

/** Persist state to THIS (session, worktree)'s own file. Never the global one. */
export function saveState(state: GateState, cwd?: string): void {
  try {
    writeFileSync(statePath(state.session_id, cwd), JSON.stringify(state, null, 2), "utf-8");
  } catch {
    /* non-critical */
  }
  cleanupStale(); // opportunistic; never removes the file we just wrote
}

/** Best-effort removal of per-session/worktree state files older than STALE_MS. */
export function cleanupStale(now: number = Date.now()): void {
  let files: string[];
  try {
    files = readdirSync(stateDir());
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.startsWith(PREFIX)) continue;
    const full = join(stateDir(), f);
    try {
      if (now - statSync(full).mtimeMs > STALE_MS) unlinkSync(full);
    } catch {
      /* skip */
    }
  }
}
