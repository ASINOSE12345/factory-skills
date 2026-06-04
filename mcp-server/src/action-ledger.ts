/**
 * Action ledger — append-only record of every action the system proposed,
 * executed, or blocked. It is the audit trail for autonomy.
 *
 * In-memory by default: the entries are returned in the reflect report so every
 * decision is visible without any disk write. It is append-only by construction
 * (no update/delete methods; seq is monotonic). It stores only IDs + derived
 * strings — never raw neuron content or secrets.
 *
 * Optional durable persistence (NDJSON append to a non-sacred dir) is provided
 * but NOT used in CP2A — it is reserved for the CP3 executor.
 */

import type { LedgerEntry, PolicyDecision } from "./autonomy-types.js";

export interface LedgerSummary {
  total: number;
  executed: number;
  proposed: number;
  blocked: number;
}

export class ActionLedger {
  private entries: LedgerEntry[] = [];
  private seq = 0;

  /** Append a decision. Returns the recorded entry. Append-only — no mutation. */
  record(decision: PolicyDecision): LedgerEntry {
    const entry: LedgerEntry = {
      seq: this.seq++,
      finding_id: decision.finding.id,
      detector: decision.finding.dimension,
      ids: [...decision.finding.ids],
      evidence: [...decision.finding.evidence],
      inference: decision.finding.inference,
      recommendation: decision.finding.recommendation,
      confidence: decision.finding.confidence,
      action_type: decision.action_type,
      status: decision.status,
      reason: decision.reason,
      summary: decision.summary,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Read-only view of all entries, in insertion order. */
  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  summary(): LedgerSummary {
    let executed = 0;
    let proposed = 0;
    let blocked = 0;
    for (const e of this.entries) {
      if (e.status === "executed") executed++;
      else if (e.status === "proposed") proposed++;
      else blocked++;
    }
    return { total: this.entries.length, executed, proposed, blocked };
  }
}
