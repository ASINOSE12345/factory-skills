/**
 * Governed write surface — live writes to the neuron corpus are OFF by default.
 *
 * CP3 (`reflect_neurons`) is already staging-only. But the MCP server still
 * exposes two DIRECT writers to the live corpus: `create_neuron` and
 * `update_pattern_counter`. That is a side door around governed autonomy. This
 * module gates both behind an explicit opt-in env so the default posture is
 * read-only: nothing writes to `neurons/` unless an operator turns it on.
 *
 *   FACTORY_ALLOW_LIVE_WRITES=true   → legacy behavior (manual/operator use)
 *   (unset / anything else)          → blocked with LIVE_WRITE_DISABLED
 *
 * Reads (search/think/dream/get/list) and CP3 staging writes are untouched.
 */

import { createNeuron, updatePatternCounter, type Neuron, type NeuronCategory } from "./neurons.js";

export const LIVE_WRITE_DISABLED = "LIVE_WRITE_DISABLED";

export interface LiveWriteBlocked {
  error: true;
  code: typeof LIVE_WRITE_DISABLED;
  message: string;
  hint: string;
}

/** Live writes to the live corpus are allowed ONLY with the explicit opt-in. */
export function liveWritesAllowed(): boolean {
  return process.env.FACTORY_ALLOW_LIVE_WRITES === "true";
}

/** The block payload returned when a live write is attempted while disabled. */
export function liveWriteBlocked(tool: string): LiveWriteBlocked {
  return {
    error: true,
    code: LIVE_WRITE_DISABLED,
    message: `${tool} is disabled — live writes to the neuron corpus are off by default`,
    hint: "set FACTORY_ALLOW_LIVE_WRITES=true only for manual/operator-approved maintenance",
  };
}

/** Narrowing helper for callers (and tests). */
export function isLiveWriteBlocked(x: unknown): x is LiveWriteBlocked {
  return !!x && typeof x === "object" && (x as { code?: unknown }).code === LIVE_WRITE_DISABLED;
}

export type GuardedCreateResult = Neuron | LiveWriteBlocked;

/** Gated `create_neuron`: blocks (no write) unless live writes are enabled. */
export function guardedCreateNeuron(
  neuronsDir: string,
  category: NeuronCategory,
  title: string,
  body: string,
  overrides: Record<string, unknown> = {},
): GuardedCreateResult {
  if (!liveWritesAllowed()) return liveWriteBlocked("create_neuron");
  return createNeuron(neuronsDir, category, title, body, overrides);
}

export type GuardedCounterResult = ReturnType<typeof updatePatternCounter> | LiveWriteBlocked;

/** Gated `update_pattern_counter`: blocks (no write) unless live writes are enabled. */
export function guardedUpdatePatternCounter(
  neuronsDir: string,
  patternId: string,
  action: "hit" | "miss",
): GuardedCounterResult {
  if (!liveWritesAllowed()) return liveWriteBlocked("update_pattern_counter");
  return updatePatternCounter(neuronsDir, patternId, action);
}
