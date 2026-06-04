/**
 * Action planner — turns cognitive findings into candidate actions.
 *
 * The planner NEVER executes and NEVER decides whether an action is allowed
 * (that is the policy's job). It only proposes a conservative set of candidate
 * actions per finding. Powerful actions (create_*) are proposed ONLY for
 * high-confidence findings that need neither a human nor a semantic judge; the
 * policy may still downgrade them to "proposed" or "blocked".
 */

import type { CandidateAction, Finding } from "./autonomy-types.js";

function report(finding: Finding): CandidateAction {
  return {
    action_type: "report",
    finding,
    summary: `[${finding.dimension}] ${finding.inference}`,
    reversible: true,
  };
}

/**
 * Map a finding to its candidate actions. Always includes a `report`. Findings
 * flagged needs_judge/needs_human get a deferral action and nothing powerful.
 */
export function planActions(finding: Finding): CandidateAction[] {
  const actions: CandidateAction[] = [report(finding)];

  // Anything requiring semantic judgment or a human is deferred — never auto.
  if (finding.needs_judge || finding.needs_human) {
    actions.push({
      action_type: "schedule_review",
      finding,
      summary: `Deferred (${finding.needs_judge ? "needs judge" : "needs human"}): ${finding.ids.join(", ")}`,
      reversible: true,
    });
    return actions;
  }

  switch (finding.dimension) {
    case "mirror_cluster": {
      // Redundant-capture cluster → propose consolidation (a human reviews it).
      actions.push({
        action_type: "propose_issue",
        finding,
        summary: `Consolidate mirror cluster (${finding.ids.length} neurons)`,
        reversible: true,
      });
      // Only a high-confidence cluster is *eligible* to become a real issue
      // (still gated by autonomous mode + flag + !dry-run at the policy).
      if (finding.confidence === "high") {
        actions.push({
          action_type: "create_issue",
          finding,
          summary: `[DREAM] consolidate ${finding.ids.length}-neuron mirror cluster`,
          reversible: true,
        });
      }
      break;
    }

    case "self_knowledge": {
      // Recurring error without a covering pattern → propose a preventive NP.
      actions.push({
        action_type: "propose_neuron",
        finding,
        summary: `Distill preventive pattern from recurring errors: ${finding.ids.join(", ")}`,
        reversible: true,
      });
      if (finding.confidence === "high") {
        actions.push({
          action_type: "create_proposed_neuron",
          finding,
          summary: `Draft NP candidate (staging only) from recurring-error cluster`,
          reversible: true,
        });
      }
      break;
    }

    case "citation_graph": {
      // Integrity issue (dangling refs / orphans) → propose an issue, low urgency.
      actions.push({
        action_type: "propose_issue",
        finding,
        summary: `Citation-graph integrity: ${finding.inference}`,
        reversible: true,
      });
      break;
    }

    case "dogma_candidate": {
      // Unchallenged assumption → schedule a re-verification (never a write).
      actions.push({
        action_type: "schedule_review",
        finding,
        summary: `Re-verify possible dogma: ${finding.ids.join(", ")}`,
        reversible: true,
      });
      break;
    }

    case "contradiction_candidate": {
      // Contradictions always carry needs_judge (handled above); this is a guard.
      actions.push({
        action_type: "schedule_review",
        finding,
        summary: `Possible contradiction: ${finding.ids.join(", ")}`,
        reversible: true,
      });
      break;
    }
  }

  return actions;
}
