/**
 * Autonomy policy — the single gate every action passes through.
 *
 * PURE and fail-closed: given a candidate action and the run options, it returns
 * executed | proposed | blocked with a reason. It performs NO side effects and
 * holds NO state — it only decides. Execution (if any) happens elsewhere, and
 * only for actions this policy marked executable.
 *
 * Contract:
 *   - forbidden type        → blocked (always, every mode)
 *   - unknown type          → blocked (fail-closed)
 *   - default-allowed type  → proposed (these are inherently side-effect-free)
 *   - autonomous-only type:
 *        mode !== autonomous → proposed ("requires autonomous mode")
 *        flag off            → proposed ("<flag> is off")
 *        dryRun              → proposed ("dry-run")
 *        otherwise           → executed
 */

import type {
  ActionType,
  AnyActionType,
  AutonomyOptions,
  CandidateAction,
  PolicyDecision,
} from "./autonomy-types.js";

/** Allowed in ANY mode — none of these has a side effect (proposals/markers). */
export const DEFAULT_ALLOWED: ReadonlySet<ActionType> = new Set<ActionType>([
  "report",
  "propose_issue",
  "propose_neuron",
  "schedule_review",
  "schedule_external_review",
]);

/** Allowed ONLY in autonomous mode, and only behind explicit flags + not dry-run. */
export const AUTONOMOUS_ONLY: ReadonlySet<ActionType> = new Set<ActionType>([
  "create_issue",
  "create_proposed_neuron",
]);

/** NEVER allowed, in any mode. Defense-in-depth guard list. */
export const FORBIDDEN: ReadonlySet<string> = new Set<string>([
  "edit_neuron",
  "delete_neuron",
  "supersede_neuron",
  "change_axiom",
  "merge_deploy",
  "touch_secret",
]);

function isDefaultAllowed(t: AnyActionType): t is ActionType {
  return DEFAULT_ALLOWED.has(t as ActionType);
}

function isAutonomousOnly(t: AnyActionType): t is ActionType {
  return AUTONOMOUS_ONLY.has(t as ActionType);
}

/** Decide the fate of a single candidate action. Pure. */
export function decideAction(action: CandidateAction, opts: AutonomyOptions): PolicyDecision {
  const base = {
    action_type: action.action_type,
    finding: action.finding,
    summary: action.summary,
  };
  const t = action.action_type;

  // 1. Forbidden — always blocked, regardless of mode/flags.
  if (FORBIDDEN.has(t)) {
    return { ...base, status: "blocked", reason: `forbidden action type '${t}' — never permitted in any mode` };
  }

  // 2. Default-allowed — inherently side-effect-free, so always "proposed".
  if (isDefaultAllowed(t)) {
    return { ...base, status: "proposed", reason: "proposal-only action (no side effect)" };
  }

  // 3. Autonomous-only — gated by mode, then explicit flag, then dry-run.
  if (isAutonomousOnly(t)) {
    if (opts.mode !== "autonomous") {
      return { ...base, status: "proposed", reason: "requires autonomous mode (mode=report)" };
    }
    const flagOff =
      (t === "create_issue" && !opts.createIssues) ||
      (t === "create_proposed_neuron" && !opts.writeProposedNeurons);
    if (flagOff) {
      const flag = t === "create_issue" ? "create_issues" : "write_proposed_neurons";
      return { ...base, status: "proposed", reason: `${flag} flag is off` };
    }
    if (opts.dryRun) {
      return { ...base, status: "proposed", reason: "dry-run (no write performed)" };
    }
    return { ...base, status: "executed", reason: "autonomous mode + flag on + not dry-run" };
  }

  // 4. Anything else — fail-closed.
  return { ...base, status: "blocked", reason: `unknown action type '${t}' — fail-closed` };
}
