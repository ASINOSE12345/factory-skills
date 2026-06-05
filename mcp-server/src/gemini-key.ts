/**
 * Secure Gemini key loading for the MCP launcher.
 *
 * The key lives ONLY in a local keyfile (default ~/.config/factory/gemini.key),
 * never in .mcp.json, never on a command line, never in logs. This module reads it
 * defensively: it refuses a group/other-accessible keyfile, never throws on a
 * missing file (callers degrade to keyword search), and NEVER returns or logs the
 * key anywhere except the `key` field of the result.
 */

import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface KeyLoadResult {
  ok: boolean;
  /** The trimmed key — present only when ok. */
  key?: string;
  /** Human-readable reason (never contains the key). */
  reason: string;
}

/** Keyfile path: FACTORY_GEMINI_KEY_FILE env, else ~/.config/factory/gemini.key. */
export function resolveKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.FACTORY_GEMINI_KEY_FILE || join(homedir(), ".config", "factory", "gemini.key");
}

/**
 * Load the key from `keyFile`. Returns ok:false (with a reason) when the file is
 * absent / not a regular file / group-or-other-accessible / unreadable / empty —
 * so the caller can start the server in keyword-only mode instead of crashing.
 * The reason includes the PATH, never the key.
 */
export function loadGeminiKey(keyFile: string): KeyLoadResult {
  let st;
  try {
    st = statSync(keyFile);
  } catch {
    return { ok: false, reason: `keyfile not found: ${keyFile}` };
  }
  if (!st.isFile()) {
    return { ok: false, reason: `keyfile is not a regular file: ${keyFile}` };
  }
  // Refuse a keyfile readable by group/other — a secret must be 0600 (or stricter).
  if ((st.mode & 0o077) !== 0) {
    return { ok: false, reason: `keyfile ${keyFile} is group/other-accessible — refusing to load; run: chmod 600 ${keyFile}` };
  }
  let raw: string;
  try {
    raw = readFileSync(keyFile, "utf-8");
  } catch (e) {
    return { ok: false, reason: `cannot read keyfile ${keyFile}: ${String((e as Error).message)}` };
  }
  const key = raw.trim();
  if (!key) {
    return { ok: false, reason: `keyfile is empty: ${keyFile}` };
  }
  return { ok: true, key, reason: "loaded" };
}
