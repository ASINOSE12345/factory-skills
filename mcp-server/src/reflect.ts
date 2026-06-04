/**
 * reflect — the orchestrator that wires the staged pipeline:
 *
 *   detectors → findings → action planner → autonomy policy → ledger
 *
 * It owns NO detection logic and NO policy logic — it only sequences them and
 * records the result. The cognitive engine (self-reflection) and the action
 * engine (planner/policy/ledger) never touch each other directly; this function
 * is the only place they meet, and it is read-only in CP2A:
 *
 *   - No real execution layer exists yet. Any decision the policy marks
 *     "executed" (only possible with mode=autonomous + flag + !dry_run) is
 *     DOWNGRADED here to "proposed" with an explicit note. Nothing is written.
 *   - Real, side-effecting execution (to a tmp/staging dir, behind flags) is
 *     CP3 and arrives as a separate, explicitly-enabled executor.
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

export interface ReflectOptions extends AutonomyOptions {
  /** Cap on findings shown per dimension in the report (totals are honest). */
  maxItems: number;
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
  options: {
    create_issues: boolean;
    write_proposed_neurons: boolean;
    max_actions: number;
    max_items: number;
  };
  total_findings: number;
  findings: Record<FindingDimension, { total: number; shown: Finding[] }>;
  planned_actions: LedgerEntry[];
  action_summary: LedgerSummary;
  external_reviews: ExternalSourceRef[];
  notes: string[];
}

/**
 * Run a full reflection pass. Read-only in CP2A. `opts.reflection.now` makes the
 * timestamp and all date-based detectors deterministic for tests.
 */
export function reflect(neuronsDir: string, opts: ReflectOptions): ReflectReport {
  const now = opts.reflection?.now ?? new Date();
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

  // Build the per-dimension report (honest totals, capped lists) and a flat,
  // deterministically-ordered finding stream for action planning.
  const findings = {} as Record<FindingDimension, { total: number; shown: Finding[] }>;
  const ordered: Finding[] = [];
  for (const dim of DIMENSIONS) {
    const list = run[dim];
    findings[dim] = { total: list.length, shown: list.slice(0, opts.maxItems) };
    ordered.push(...list);
  }
  const totalFindings = ordered.length;

  // findings → planner → policy → ledger, capped by maxActions.
  let considered = 0;
  let capped = false;
  outer: for (const finding of ordered) {
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
    notes.push(`action planning capped at maxActions=${opts.maxActions} (${totalFindings} findings total).`);
  }

  return {
    generated_at: now.toISOString(),
    corpus_root: neuronsDir,
    corpus_size: neurons.length,
    embeddings_covered: vectors.size,
    mode: opts.mode,
    dry_run: opts.dryRun,
    options: {
      create_issues: opts.createIssues,
      write_proposed_neurons: opts.writeProposedNeurons,
      max_actions: opts.maxActions,
      max_items: opts.maxItems,
    },
    total_findings: totalFindings,
    findings,
    planned_actions: [...ledger.all()],
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
  lines.push("> Read-only by default — **proposals, not changes.** Cognition is separate from action; every action below passed through the autonomy policy.");
  lines.push("");

  for (const dim of DIMENSIONS) {
    const { total, shown } = r.findings[dim];
    lines.push(`## ${dim} (showing ${shown.length} of ${total})`);
    for (const f of shown) {
      lines.push(`- **${f.ids.join(", ")}** — _${f.confidence}_${f.needs_judge ? " · needs-judge" : ""}${f.needs_human ? " · needs-human" : ""}`);
      lines.push(`  - evidence: ${f.evidence.join("; ")}`);
      lines.push(`  - inference: ${f.inference}`);
      lines.push(`  - recommendation: ${f.recommendation}`);
    }
    lines.push("");
  }

  const s = r.action_summary;
  lines.push(`## Planned actions — ${s.total} (executed ${s.executed} · proposed ${s.proposed} · blocked ${s.blocked})`);
  for (const a of r.planned_actions) {
    lines.push(`- [${a.status}] ${a.action_type} ← ${a.detector} (${a.ids.join(", ")}) — ${a.reason}`);
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
