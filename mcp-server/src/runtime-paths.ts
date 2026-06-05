/**
 * runtime-paths — single source of truth for the hooks' operational state/temp files.
 *
 * plan-gate, iron-gates and iron-gates-state used to each hardcode `/tmp/...`.
 * They coordinate THROUGH those files, so the directory must stay shared and the
 * default must remain EXACTLY `/tmp` (NOT `os.tmpdir()`, which on macOS is
 * `/var/folders/...` and would silently break that coordination + Gate 2 state).
 *
 * This module centralizes the paths and adds ONE knob, `FACTORY_STATE_DIR`,
 * without changing default behavior. `IRON_GATES_STATE_DIR` is kept as a
 * back-compat alias for the iron-gates state dir specifically.
 *
 * Functions read the env at CALL TIME (not module load) so the value is always
 * current and tests can set the env per-case.
 */

import { join } from "node:path";

/** Deliberate literal default — see file header (do NOT use os.tmpdir()). */
const DEFAULT_STATE_DIR = "/tmp";

/** Central base directory for operational state/temp files. */
export function factoryStateDir(): string {
  return process.env.FACTORY_STATE_DIR || DEFAULT_STATE_DIR;
}

/**
 * Iron-gates state directory. Precedence (documented + tested):
 *   IRON_GATES_STATE_DIR  (legacy, specific — wins for back-compat)
 *   → FACTORY_STATE_DIR   (central knob)
 *   → "/tmp"              (default)
 */
export function ironGatesStateDir(): string {
  return process.env.IRON_GATES_STATE_DIR || process.env.FACTORY_STATE_DIR || DEFAULT_STATE_DIR;
}

export function planGateStateFile(): string {
  return join(factoryStateDir(), "plan-gate-state.json");
}

export function planGateMetricsFile(): string {
  return join(factoryStateDir(), "plan-gate-metrics.json");
}

export function ironGatesOverrideFile(): string {
  return join(factoryStateDir(), "iron-gates-override.json");
}
