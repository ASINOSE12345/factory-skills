import { describe, it, expect } from "vitest";
import { decideAction, DEFAULT_ALLOWED, AUTONOMOUS_ONLY, FORBIDDEN } from "../src/autonomy-policy";
import { planActions } from "../src/action-planner";
import { ActionLedger } from "../src/action-ledger";
import { ExternalSourceLedger, validateExternalRef } from "../src/external-source-ledger";
import {
  DEFAULT_AUTONOMY,
  type Finding,
  type CandidateAction,
  type AnyActionType,
  type AutonomyOptions,
  type FindingDimension,
} from "../src/autonomy-types";

// ── Builders ─────────────────────────────────────────────────────────────────

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    dimension: "mirror_cluster",
    ids: ["NX-1"],
    evidence: ["fact"],
    inference: "inferred",
    recommendation: "do something",
    confidence: "medium",
    ...over,
  };
}

function mkAction(action_type: AnyActionType, finding: Finding = mkFinding()): CandidateAction {
  return { action_type, finding, summary: "summary", reversible: true };
}

function opts(over: Partial<AutonomyOptions> = {}): AutonomyOptions {
  return { ...DEFAULT_AUTONOMY, ...over };
}

// ── Policy: the single gate every action passes through ──────────────────────

describe("decideAction — forbidden", () => {
  it("blocks every forbidden type, in any mode", () => {
    for (const t of FORBIDDEN) {
      const d = decideAction(mkAction(t as AnyActionType), opts({ mode: "autonomous", dryRun: false, createIssues: true, writeProposedNeurons: true }));
      expect(d.status).toBe("blocked");
      expect(d.reason).toMatch(/forbidden/);
    }
  });
  it("blocks an unknown type (fail-closed)", () => {
    const d = decideAction(mkAction("frobnicate" as AnyActionType), opts({ mode: "autonomous", dryRun: false }));
    expect(d.status).toBe("blocked");
    expect(d.reason).toMatch(/unknown|fail-closed/);
  });
});

describe("decideAction — default-allowed (always proposal-only)", () => {
  for (const t of DEFAULT_ALLOWED) {
    it(`'${t}' is proposed even in the most permissive run`, () => {
      const d = decideAction(mkAction(t), opts({ mode: "autonomous", dryRun: false, createIssues: true, writeProposedNeurons: true }));
      expect(d.status).toBe("proposed");
    });
  }
});

describe("decideAction — autonomous-only gating", () => {
  it("create_issue in report mode → proposed (requires autonomous)", () => {
    const d = decideAction(mkAction("create_issue"), opts({ mode: "report" }));
    expect(d.status).toBe("proposed");
    expect(d.reason).toMatch(/autonomous mode/);
  });
  it("create_issue autonomous but flag off → proposed", () => {
    const d = decideAction(mkAction("create_issue"), opts({ mode: "autonomous", dryRun: false, createIssues: false }));
    expect(d.status).toBe("proposed");
    expect(d.reason).toMatch(/create_issues flag is off/);
  });
  it("create_issue autonomous + flag on + dry-run → proposed (no write)", () => {
    const d = decideAction(mkAction("create_issue"), opts({ mode: "autonomous", dryRun: true, createIssues: true }));
    expect(d.status).toBe("proposed");
    expect(d.reason).toMatch(/dry-run/);
  });
  it("create_issue autonomous + flag on + NOT dry-run → executed", () => {
    const d = decideAction(mkAction("create_issue"), opts({ mode: "autonomous", dryRun: false, createIssues: true }));
    expect(d.status).toBe("executed");
  });
  it("create_proposed_neuron needs ITS OWN flag (write_proposed_neurons), not create_issues", () => {
    const wrongFlag = decideAction(mkAction("create_proposed_neuron"), opts({ mode: "autonomous", dryRun: false, createIssues: true, writeProposedNeurons: false }));
    expect(wrongFlag.status).toBe("proposed");
    expect(wrongFlag.reason).toMatch(/write_proposed_neurons flag is off/);
    const rightFlag = decideAction(mkAction("create_proposed_neuron"), opts({ mode: "autonomous", dryRun: false, writeProposedNeurons: true }));
    expect(rightFlag.status).toBe("executed");
  });
  it("DEFAULT_AUTONOMY is safe: report + dry-run + flags off", () => {
    expect(DEFAULT_AUTONOMY.mode).toBe("report");
    expect(DEFAULT_AUTONOMY.dryRun).toBe(true);
    expect(DEFAULT_AUTONOMY.createIssues).toBe(false);
    expect(DEFAULT_AUTONOMY.writeProposedNeurons).toBe(false);
  });
});

// ── Planner: findings → candidate actions ────────────────────────────────────

describe("planActions", () => {
  it("always emits a report", () => {
    const a = planActions(mkFinding());
    expect(a[0].action_type).toBe("report");
  });
  it("a needs_judge finding gets ONLY report + schedule_review (nothing powerful)", () => {
    const a = planActions(mkFinding({ dimension: "contradiction_candidate", needs_judge: true }));
    expect(a.map((x) => x.action_type).sort()).toEqual(["report", "schedule_review"]);
  });
  it("a needs_human finding is deferred too", () => {
    const a = planActions(mkFinding({ needs_human: true }));
    expect(a.map((x) => x.action_type)).not.toContain("create_issue");
    expect(a.map((x) => x.action_type)).toContain("schedule_review");
  });
  it("high-confidence mirror cluster makes create_issue eligible; medium does not", () => {
    const hi = planActions(mkFinding({ dimension: "mirror_cluster", confidence: "high" })).map((x) => x.action_type);
    expect(hi).toContain("propose_issue");
    expect(hi).toContain("create_issue");
    const med = planActions(mkFinding({ dimension: "mirror_cluster", confidence: "medium" })).map((x) => x.action_type);
    expect(med).toContain("propose_issue");
    expect(med).not.toContain("create_issue");
  });
  it("high-confidence self_knowledge makes create_proposed_neuron eligible; medium does not", () => {
    const hi = planActions(mkFinding({ dimension: "self_knowledge", confidence: "high" })).map((x) => x.action_type);
    expect(hi).toContain("propose_neuron");
    expect(hi).toContain("create_proposed_neuron");
    const med = planActions(mkFinding({ dimension: "self_knowledge", confidence: "medium" })).map((x) => x.action_type);
    expect(med).not.toContain("create_proposed_neuron");
  });
  it("dogma → schedule_review; citation_graph → propose_issue", () => {
    expect(planActions(mkFinding({ dimension: "dogma_candidate" })).map((x) => x.action_type)).toContain("schedule_review");
    expect(planActions(mkFinding({ dimension: "citation_graph" })).map((x) => x.action_type)).toContain("propose_issue");
  });
  it("the planner never emits a forbidden or create_* action for a low/medium finding by itself", () => {
    const a = planActions(mkFinding({ dimension: "citation_graph", confidence: "low" })).map((x) => x.action_type);
    for (const t of a) expect(FORBIDDEN.has(t)).toBe(false);
    expect(a).not.toContain("create_issue");
    expect(a).not.toContain("create_proposed_neuron");
  });
});

// ── Ledger: append-only audit trail ──────────────────────────────────────────

describe("ActionLedger", () => {
  const dims: FindingDimension[] = ["mirror_cluster", "self_knowledge"];
  it("is append-only with a monotonic seq and an honest summary", () => {
    const ledger = new ActionLedger();
    ledger.record({ action_type: "report", status: "proposed", reason: "r", finding: mkFinding({ dimension: dims[0] }), summary: "s" });
    ledger.record({ action_type: "create_issue", status: "executed", reason: "r", finding: mkFinding({ dimension: dims[1] }), summary: "s" });
    ledger.record({ action_type: "edit_neuron", status: "blocked", reason: "r", finding: mkFinding(), summary: "s" });
    const all = ledger.all();
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(ledger.summary()).toEqual({ total: 3, executed: 1, proposed: 1, blocked: 1 });
  });
  it("copies finding arrays (entry is not aliased to the finding)", () => {
    const ledger = new ActionLedger();
    const f = mkFinding({ ids: ["NX-1"] });
    const entry = ledger.record({ action_type: "report", status: "proposed", reason: "r", finding: f, summary: "s" });
    f.ids.push("NX-2");
    expect(entry.ids).toEqual(["NX-1"]); // not mutated by later changes to the finding
  });
});

// ── External source ledger: validate, never fetch ────────────────────────────

describe("validateExternalRef", () => {
  it("accepts a well-formed ref", () => {
    expect(validateExternalRef("url", "https://example.com/doc#x", "needed for context")).toEqual({
      kind: "url",
      ref: "https://example.com/doc#x",
      reason: "needed for context",
    });
  });
  it("rejects an unknown kind", () => {
    expect(validateExternalRef("magic", "https://x", "y")).toBeNull();
  });
  it("rejects a ref with spaces or over length", () => {
    expect(validateExternalRef("url", "has spaces here", "y")).toBeNull();
    expect(validateExternalRef("url", "x".repeat(400), "y")).toBeNull();
  });
  it("rejects an empty or over-long reason", () => {
    expect(validateExternalRef("doc", "x", "")).toBeNull();
    expect(validateExternalRef("doc", "x", "y".repeat(600))).toBeNull();
  });
});

describe("ExternalSourceLedger", () => {
  it("registers only valid refs", () => {
    const l = new ExternalSourceLedger();
    expect(l.register("issue", "ORG/repo#12", "tracks this")).not.toBeNull();
    expect(l.register("bogus", "x", "y")).toBeNull();
    expect(l.all()).toHaveLength(1);
  });
});
