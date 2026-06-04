/**
 * Autonomy layer — shared types.
 *
 * The pipeline is deliberately staged and one-directional:
 *
 *   detectors → findings → action planner → autonomy policy → ledger / actions
 *
 * The COGNITIVE engine (detectors in self-reflection.ts) emits `Finding`s and
 * NEVER performs side effects. The ACTION engine (planner → policy → ledger)
 * decides what, if anything, may happen. Autonomy always passes through an
 * auditable policy — there is no path from a detector straight to a mutation.
 *
 * Nothing here ever carries raw neuron content or secrets — only IDs, metrics,
 * and short derived strings.
 */

export type Confidence = "low" | "medium" | "high";

/** Which cognitive detector produced a finding. */
export type FindingDimension =
  | "mirror_cluster"
  | "citation_graph"
  | "contradiction_candidate"
  | "self_knowledge"
  | "dogma_candidate";

/**
 * A single cognitive finding. The triad is mandatory and kept distinct:
 *  - evidence:       verifiable facts (counts, similarities, dates, IDs)
 *  - inference:      what is deduced from the evidence (clearly not a fact)
 *  - recommendation: the proposed next step (still just a proposal)
 */
export interface Finding {
  dimension: FindingDimension;
  ids: string[];
  evidence: string[];
  inference: string;
  recommendation: string;
  confidence: Confidence;
  /** Requires semantic/LLM judgment to resolve (Layer 3, deferred). */
  needs_judge?: boolean;
  /** Requires a human decision before any action. */
  needs_human?: boolean;
}

/**
 * Action types the planner may emit, least → most powerful.
 *  - report:                   surface the finding (never a side effect)
 *  - propose_issue:            draft an issue body (not created)
 *  - propose_neuron:           draft a neuron body (not written)
 *  - schedule_review:          record a "revisit this" marker (no side effect)
 *  - schedule_external_review: record that external context is needed (no fetch)
 *  - create_issue:             actually create a GitHub issue (autonomous-only)
 *  - create_proposed_neuron:   write a PROPOSED neuron to staging (autonomous-only)
 */
export type ActionType =
  | "report"
  | "propose_issue"
  | "propose_neuron"
  | "schedule_review"
  | "schedule_external_review"
  | "create_issue"
  | "create_proposed_neuron";

/**
 * Action types that are NEVER permitted, in any mode. The planner never emits
 * these; the policy lists them so that if one ever appears (bug, future code,
 * injection) it is blocked as defense-in-depth.
 */
export type ForbiddenActionType =
  | "edit_neuron"
  | "delete_neuron"
  | "supersede_neuron"
  | "change_axiom"
  | "merge_deploy"
  | "touch_secret";

export type AnyActionType = ActionType | ForbiddenActionType;

export type ActionStatus = "executed" | "proposed" | "blocked";

/** A proposed action with provenance back to the finding that justified it. */
export interface CandidateAction {
  action_type: AnyActionType;
  finding: Finding;
  /** Short, human-readable, no raw content. */
  summary: string;
  /** Whether the action (if executed) is reversible. */
  reversible: boolean;
}

/** The policy's verdict on a candidate action. Pure data — no side effects. */
export interface PolicyDecision {
  action_type: AnyActionType;
  status: ActionStatus;
  reason: string;
  finding: Finding;
  summary: string;
}

export type ReflectMode = "report" | "autonomous";

/** Knobs controlling how much autonomy is granted to a single run. */
export interface AutonomyOptions {
  /** "report" = propose only; "autonomous" = create_* become eligible. */
  mode: ReflectMode;
  /** When true (default), no real write/issue is performed even if eligible. */
  dryRun: boolean;
  /** Explicit gate for create_issue (autonomous + this flag + !dryRun). */
  createIssues: boolean;
  /** Explicit gate for create_proposed_neuron (autonomous + this flag + !dryRun). */
  writeProposedNeurons: boolean;
  /** Upper bound on actions considered in a single run. */
  maxActions: number;
}

/** Safe defaults: report-only, dry-run, every write gate off. */
export const DEFAULT_AUTONOMY: AutonomyOptions = {
  mode: "report",
  dryRun: true,
  createIssues: false,
  writeProposedNeurons: false,
  maxActions: 50,
};

/** An append-only ledger record. No raw content, no secrets. */
export interface LedgerEntry {
  seq: number;
  detector: FindingDimension;
  ids: string[];
  evidence: string[];
  inference: string;
  recommendation: string;
  confidence: Confidence;
  action_type: AnyActionType;
  status: ActionStatus;
  reason: string;
}
