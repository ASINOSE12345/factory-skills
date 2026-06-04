/**
 * Iron Gates state — shared, PER-SESSION storage.
 *
 * Single source of truth for the Gate 2 verification state, used by BOTH hooks:
 *  - auto-capture.ts (the only WRITER of verification_passed)
 *  - iron-gates.ts  (the READER that gates push/PR/merge)
 *
 * Why this exists: the state used to live in ONE global file
 * (`/tmp/iron-gates-state.json`) keyed only by session_id in its *contents*. Two
 * sessions/worktrees running concurrently clobbered each other's file — session
 * B's write made session A's verification "belong to another session", so A's
 * next push was falsely blocked (reproduced race). Here the session_id is part
 * of the PATH, so each session has its own file and cannot be clobbered.
 *
 * The override file (`iron-gates-override.json`) stays global by design — the
 * operator creates it by hand; it is not part of this isolation.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

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

/** The per-session state file for a given session_id. */
export function statePath(sessionId: string): string {
  return join(stateDir(), `${PREFIX}${sanitizeSessionId(sessionId)}.json`);
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
 * Load THIS session's state from its own per-session file. Never inherits
 * another session's state. Falls back to the legacy global file only if that
 * file belongs to this same session (one-time migration on the next save).
 */
export function loadState(sessionId: string): GateState {
  const own = readIfMatches(statePath(sessionId), sessionId);
  if (own) return own;
  const legacy = readIfMatches(legacyPath(), sessionId);
  if (legacy) return legacy; // migrates to per-session on the next saveState
  return freshState(sessionId);
}

/** Persist state to THIS session's own per-session file. Never the global one. */
export function saveState(state: GateState): void {
  try {
    writeFileSync(statePath(state.session_id), JSON.stringify(state, null, 2), "utf-8");
  } catch {
    /* non-critical */
  }
  cleanupStale(); // opportunistic; never removes the file we just wrote
}

/** Best-effort removal of per-session state files older than STALE_MS. */
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
