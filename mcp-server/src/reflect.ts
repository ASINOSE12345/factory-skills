/**
 * reflect — the orchestrator that wires the staged pipeline:
 *
 *   detectors → findings → action planner → autonomy policy → ledger
 *
 * It owns NO detection logic and NO policy logic — it only sequences them and
 * records the result. Read-only in CP2A: no execution layer exists, so any
 * decision the policy marks "executed" is DOWNGRADED here to "proposed".
 *
 * Auditability contract (hardened after PR #7 review):
 *  - Every finding gets a stable `id` (`<dimension>#<index>`).
 *  - Actions are planned ONLY over the findings that appear in the payload
 *    (the per-dimension `shown` lists), so no action ever references a hidden
 *    finding. Every action carries its `finding_id`.
 *  - The MCP payload is COMPACT by default (actions don't repeat
 *    evidence/inference/recommendation — those live on the finding). The full
 *    ledger is available behind `detail:"full"`.
 *  - Totals stay honest: `total_findings`, per-dimension `total`,
 *    `hidden_findings`, `total_planned_actions`.
 */

import { listNeurons } from "./neurons.js";
import { getNeuronVectors } from "./embeddings.js";
import { detectAll, type ReflectionOptions } from "./self-reflection.js";
import { planActions } from "./action-planner.js";
import { decideAction } from "./autonomy-policy.js";
import { ActionLedger, type LedgerSummary } from "./action-ledger.js";
import { ExternalSourceLedger, type ExternalSourceRef } from "./external-source-ledger.js";
import type {
  AutonomyOptions,
  CompactAction,
  Finding,
  FindingDimension,
  LedgerEntry,
} from "./autonomy-types.js";

const DIMENSIONS: FindingDimension[] = [
  "mirror_cluster",
  "citation_graph",
  "contradiction_candidate",
  "self_knowledge",
  "dogma_candidate",
];

export type ReflectDetail = "compact" | "full";

/** Single source of truth for the reflect_neurons default knobs — shared by the
 *  MCP tool's Zod schema AND its handler fallback, so the two can never diverge. */
export const REFLECT_DEFAULTS = {
  maxItems: 3,
  maxActions: 20,
  detail: "compact" as ReflectDetail,
} as const;

export interface ReflectOptions extends AutonomyOptions {
  /** Cap on findings shown per dimension in the report (totals stay honest). */
  maxItems: number;
  /** "compact" (default) → CompactAction payload; "full" → the whole ledger. */
  detail?: ReflectDetail;
  /** Detector tuning (thresholds, injectable now). */
  reflection?: ReflectionOptions;
}

export interface ReflectReport {
  generated_at: string;
  corpus_root: string;
  corpus_size: number;
  embeddings_covered: number;
  mode: AutonomyOptions["mode"];
  dry_run: boolean;
  detail: ReflectDetail;
  options: {
    create_issues: boolean;
    write_proposed_neurons: boolean;
    max_actions: number;
    max_items: number;
  };
  total_findings: number;
  /** Findings not shown (beyond max_items) — these do NOT generate actions. */
  hidden_findings: number;
  findings: Record<FindingDimension, { total: number; shown: Finding[] }>;
  total_planned_actions: number;
  planned_actions: CompactAction[] | LedgerEntry[];
  action_summary: LedgerSummary;
  external_reviews: ExternalSourceRef[];
  notes: string[];
}

function toCompact(e: LedgerEntry): CompactAction {
  return {
    seq: e.seq,
    finding_id: e.finding_id,
    detector: e.detector,
    action_type: e.action_type,
    status: e.status,
    reason: e.reason,
    summary: e.summary,
  };
}

/**
 * Run a full reflection pass. Read-only in CP2A. `opts.reflection.now` makes the
 * timestamp and all date-based detectors deterministic for tests.
 */
export function reflect(neuronsDir: string, opts: ReflectOptions): ReflectReport {
  const now = opts.reflection?.now ?? new Date();
  const detail: ReflectDetail = opts.detail ?? "compact";
  const neurons = listNeurons(neuronsDir);
  const vectors = getNeuronVectors(neuronsDir, neurons.map((n) => n.filename));
  const run = detectAll(neurons, vectors, { ...opts.reflection, now });

  const ledger = new ActionLedger();
  const ext = new ExternalSourceLedger();
  const notes: string[] = [];

  if (vectors.size < neurons.length) {
    notes.push(
      `embeddings cover ${vectors.size}/${neurons.length} neurons — similarity-based detectors skip the rest.`,
    );
  }

  // Assign stable ids, build the per-dimension report (honest totals, capped
  // lists), and collect the VISIBLE findings — the only ones we plan over.
  const findings = {} as Record<FindingDimension, { total: number; shown: Finding[] }>;
  const visible: Finding[] = [];
  let totalFindings = 0;
  for (const dim of DIMENSIONS) {
    const list = run[dim];
    list.forEach((f, i) => {
      f.id = `${dim}#${i}`;
    });
    const shown = list.slice(0, opts.maxItems);
    findings[dim] = { total: list.length, shown };
    visible.push(...shown);
    totalFindings += list.length;
  }
  const hiddenFindings = totalFindings - visible.length;
  if (hiddenFindings > 0) {
    notes.push(
      `${hiddenFindings} finding(s) hidden by max_items=${opts.maxItems} — they do NOT generate actions; raise max_items to see and act on them.`,
    );
  }

  // findings (VISIBLE only) → planner → policy → ledger, capped by maxActions.
  let considered = 0;
  let capped = false;
  outer: for (const finding of visible) {
    for (const candidate of planActions(finding)) {
      if (considered >= opts.maxActions) {
        capped = true;
        break outer;
      }
      considered++;

      let decision = decideAction(candidate, opts);

      // CP2A safety net: no execution layer. Never let a status be "executed".
      if (decision.status === "executed") {
        decision = {
          ...decision,
          status: "proposed",
          reason: `${decision.reason}; execution layer deferred to CP3 (no write performed)`,
        };
      }

      // An external-review action registers the request (validated, never fetched).
      if (candidate.action_type === "schedule_external_review") {
        ext.register("other", finding.ids[0] ?? "n/a", finding.recommendation.slice(0, 200));
      }

      ledger.record(decision);
    }
  }
  if (capped) {
    notes.push(`action planning capped at max_actions=${opts.maxActions} over the visible findings.`);
  }

  const full = [...ledger.all()];
  return {
    generated_at: now.toISOString(),
    corpus_root: neuronsDir,
    corpus_size: neurons.length,
    embeddings_covered: vectors.size,
    mode: opts.mode,
    dry_run: opts.dryRun,
    detail,
    options: {
      create_issues: opts.createIssues,
      write_proposed_neurons: opts.writeProposedNeurons,
      max_actions: opts.maxActions,
      max_items: opts.maxItems,
    },
    total_findings: totalFindings,
    hidden_findings: hiddenFindings,
    findings,
    total_planned_actions: full.length,
    planned_actions: detail === "full" ? full : full.map(toCompact),
    action_summary: ledger.summary(),
    external_reviews: [...ext.all()],
    notes,
  };
}

/** Compact, human-readable markdown rendering. Proposals, not changes. */
export function formatReflectMarkdown(r: ReflectReport): string {
  const lines: string[] = [];
  lines.push(`# Reflect — ${r.corpus_root}`);
  lines.push("");
  lines.push(
    `Generated: ${r.generated_at} · corpus: ${r.corpus_size} (embeddings ${r.embeddings_covered}) · ` +
      `mode: ${r.mode} · dry_run: ${r.dry_run}`,
  );
  lines.push("");
  lines.push("> Read-only by default — **proposals, not changes.** Cognition is separate from action; every action below passed through the autonomy policy and references a visible finding by `finding_id`.");
  lines.push("");

  for (const dim of DIMENSIONS) {
    const { total, shown } = r.findings[dim];
    lines.push(`## ${dim} (showing ${shown.length} of ${total})`);
    for (const f of shown) {
      lines.push(`- **${f.id}** · ${f.ids.join(", ")} — _${f.confidence}_${f.needs_judge ? " · needs-judge" : ""}${f.needs_human ? " · needs-human" : ""}`);
      lines.push(`  - evidence: ${f.evidence.join("; ")}`);
      lines.push(`  - inference: ${f.inference}`);
      lines.push(`  - recommendation: ${f.recommendation}`);
    }
    lines.push("");
  }

  const s = r.action_summary;
  lines.push(`## Planned actions — ${r.total_planned_actions} (executed ${s.executed} · proposed ${s.proposed} · blocked ${s.blocked})`);
  for (const a of r.planned_actions) {
    lines.push(`- [${a.status}] ${a.action_type} ← ${a.finding_id ?? a.detector} — ${a.reason}`);
  }
  lines.push("");
  if (r.external_reviews.length > 0) {
    lines.push(`## External-review requests — ${r.external_reviews.length}`);
    for (const e of r.external_reviews) lines.push(`- [${e.kind}] ${e.ref} — ${e.reason}`);
    lines.push("");
  }
  if (r.notes.length > 0) {
    lines.push(`## Notes`);
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}
