/**
 * Self-reflection — the COGNITIVE engine.
 *
 * Five deterministic detectors that read the whole corpus and emit `Finding`s.
 * They are PURE: no writes, no network, no LLM, no side effects of any kind.
 * They never decide what to DO about a finding — that is the action engine's job
 * (planner → policy → ledger). This separation is the whole point: cognition
 * here, autonomy there.
 *
 * Every finding keeps EVIDENCE (verifiable facts), INFERENCE (what is deduced),
 * and RECOMMENDATION (proposed next step) distinct. Output carries only IDs,
 * metrics, and short derived strings — never raw neuron content or secrets.
 *
 * Detectors:
 *   1. clusterMirrors            — near-identical clusters (redundant capture)
 *   2. reflectCitationGraph      — broken refs / orphans / hubs (internal context)
 *   3. detectContradictionCandidates — same topic, opposite polarity (needs judge)
 *   4. reflectSelfKnowledge      — recurring errors with no preventive pattern
 *   5. detectDogmaCandidates     — unchallenged patterns / axiom-as-excuse
 *
 * Axioms are the LENS that defines a healthy corpus (memory is sacred → never
 * propose deletion; the shell is mutable → superseding the old is healthy;
 * context is consciousness → orphans/dangling refs degrade it). They are never
 * used as a self-justification: detector 5 explicitly flags an axiom invoked as
 * a thought-terminator.
 */

import type { Neuron } from "./neurons.js";
import { projectScopeOf } from "./neurons.js";
import { cosineSimilarity } from "./embeddings.js";
import { knowledgeDate, daysBetween } from "./gap-analysis.js";
import type { Finding } from "./autonomy-types.js";

export interface ReflectionOptions {
  /** Injectable "now" for deterministic tests. */
  now?: Date;
  /** Cosine ≥ this AND same scope+category ⇒ a mirror (default 0.97). */
  mirrorThreshold?: number;
  /** Contradiction candidates live in [lo, hi): same topic, not identical. */
  contradictionLo?: number;
  contradictionHi?: number;
  /** Error neurons cluster as "recurring" at ≥ this similarity (default 0.90). */
  selfErrSim?: number;
  /** A pattern "covers" an error cluster at ≥ this similarity (default 0.85). */
  selfPatSim?: number;
  /** A pattern/foundation is dogma-prone at ≥ this many hits (default 7). */
  dogmaMinHits?: number;
  /** ...and at least this old in days (default 90). */
  dogmaAgeDays?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function idOf(n: Neuron): string {
  return n.filename.replace(/\.md$/, "");
}

/** Short citable form (NE-123) for ID resolution; non-numeric IDs pass through. */
function shortId(id: string): string {
  const m = id.match(/^(N[EDPFB]-\d+)/);
  return m ? m[1] : id;
}

/** Minimal union-find over an index range, for connected-component clustering. */
function makeDSU(size: number) {
  const parent = Array.from({ length: size }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    parent[find(a)] = find(b);
  }
  function components(): number[][] {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < size; i++) {
      const r = find(i);
      const g = groups.get(r);
      if (g) g.push(i);
      else groups.set(r, [i]);
    }
    return [...groups.values()];
  }
  return { find, union, components };
}

// ── Detector 1: mirror clusters ──────────────────────────────────────────────

/**
 * Group near-identical neurons (same category + scope, cosine ≥ threshold) into
 * connected components. Collapses noise like 30 pairwise "martina-que-dice"
 * captures into ONE cluster finding instead of N² pairs.
 */
export function clusterMirrors(
  neurons: Neuron[],
  vectors: Map<string, number[]>,
  threshold = 0.97,
): Finding[] {
  const findings: Finding[] = [];

  // Bucket by category|scope — a mirror must share both.
  const buckets = new Map<string, Neuron[]>();
  for (const n of neurons) {
    if (!vectors.get(n.filename)) continue;
    const key = `${n.category}|${projectScopeOf(n)}`;
    const b = buckets.get(key);
    if (b) b.push(n);
    else buckets.set(key, [n]);
  }

  for (const [key, group] of buckets) {
    if (group.length < 2) continue;
    const dsu = makeDSU(group.length);
    const simByPair = new Map<string, number>();
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const va = vectors.get(group[i].filename);
        const vb = vectors.get(group[j].filename);
        if (!va || !vb) continue;
        const s = cosineSimilarity(va, vb);
        if (s >= threshold) {
          dsu.union(i, j);
          simByPair.set(`${i}-${j}`, s);
        }
      }
    }
    for (const comp of dsu.components()) {
      if (comp.length < 2) continue;
      const ids = comp.map((i) => idOf(group[i])).sort();
      // Min intra-cluster similarity over the edges we actually joined on.
      let minSim = 1;
      for (let a = 0; a < comp.length; a++) {
        for (let b = a + 1; b < comp.length; b++) {
          const s = simByPair.get(`${Math.min(comp[a], comp[b])}-${Math.max(comp[a], comp[b])}`);
          if (s !== undefined && s < minSim) minSim = s;
        }
      }
      const [cat, scope] = key.split("|");
      findings.push({
        dimension: "mirror_cluster",
        ids,
        evidence: [
          `${ids.length} neurons in a connected mirror component (each linked by cosine ≥ ${threshold})`,
          `min edge similarity ${minSim.toFixed(3)} — pairwise transitivity, NOT every pair`,
          `category=${cat}`,
          `scope=${scope}`,
        ],
        inference: `Connected mirror component — each neuron is near-identical to at least one other (transitively linked); likely redundant captures. Not every pair is necessarily near-identical.`,
        recommendation: `Keep one canonical neuron; propose consolidating/archiving the other ${ids.length - 1}. (Memory is sacred — consolidate, never delete blindly.)`,
        confidence: ids.length >= 4 ? "high" : "medium",
      });
    }
  }

  // Largest clusters first — most actionable.
  return findings.sort((a, b) => b.ids.length - a.ids.length || a.ids[0].localeCompare(b.ids[0]));
}

// ── Detector 2: citation graph (internal context) ────────────────────────────

const REF_RE = /\bN[EDPF]-\d+\b/g; // NE/ND/NP/NF numeric refs (NB is rarely cited by short id)

// Orphan analysis targets STRUCTURAL knowledge (patterns/foundations) — the
// connective tissue of the corpus. Errors and business captures are frequently
// atomic, so their isolation is normal, not signal.
const STRUCTURAL_FOR_ORPHANS = new Set<Neuron["category"]>(["patterns", "foundations"]);

export interface CitationGraph {
  inDegree: Map<string, number>;
  danglingRefs: Array<{ from: string; to: string }>;
  orphans: string[];
  hubs: Array<{ id: string; in_degree: number }>;
}

/** Build the citation graph by parsing inline NE/ND/NP/NF references. */
export function buildCitationGraph(neurons: Neuron[]): CitationGraph {
  const known = new Set(neurons.map((n) => shortId(idOf(n))));
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const danglingRefs: Array<{ from: string; to: string }> = [];

  for (const n of neurons) {
    const self = shortId(idOf(n));
    const refs = new Set(n.content.match(REF_RE) ?? []);
    refs.delete(self);
    let out = 0;
    for (const r of refs) {
      if (known.has(r)) {
        inDegree.set(r, (inDegree.get(r) ?? 0) + 1);
        out++;
      } else {
        danglingRefs.push({ from: self, to: r });
      }
    }
    if (out > 0) outDegree.set(self, out);
  }

  const orphans = neurons
    .filter((n) => STRUCTURAL_FOR_ORPHANS.has(n.category))
    .map((n) => shortId(idOf(n)))
    .filter((id) => !inDegree.get(id) && !outDegree.get(id))
    .sort();
  const hubs = [...inDegree.entries()]
    .filter(([, d]) => d >= 5)
    .map(([id, d]) => ({ id, in_degree: d }))
    .sort((a, b) => b.in_degree - a.in_degree || a.id.localeCompare(b.id));

  danglingRefs.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { inDegree, danglingRefs, orphans, hubs };
}

/** Turn the citation graph into integrity findings (dangling refs, orphans). */
export function reflectCitationGraph(neurons: Neuron[]): Finding[] {
  const g = buildCitationGraph(neurons);
  const findings: Finding[] = [];

  if (g.danglingRefs.length > 0) {
    const sample = g.danglingRefs.slice(0, 15);
    findings.push({
      dimension: "citation_graph",
      ids: [...new Set(sample.map((d) => d.from))],
      evidence: [
        `${g.danglingRefs.length} references to non-existent neuron IDs`,
        ...sample.map((d) => `${d.from} → ${d.to} (missing)`),
      ],
      inference: `Some neurons cite IDs that don't exist (typo, archived, or not-yet-created) — integrity gaps that weaken internal context.`,
      recommendation: `Review the broken refs: fix typos, or annotate the archived/removed targets.`,
      confidence: "medium",
      needs_human: true,
    });
  }

  if (g.orphans.length > 0) {
    findings.push({
      dimension: "citation_graph",
      ids: g.orphans.slice(0, 15),
      evidence: [
        `${g.orphans.length} disconnected pattern/foundation neurons (no inbound or outbound citations)`,
      ],
      inference: `Structural knowledge (patterns/foundations) that neither cites nor is cited — should be woven into the graph, or may be dead. (Errors/business captures are excluded: their isolation is usually normal.)`,
      recommendation: `Low urgency: spot-check the oldest; link into the graph or archive if truly dead. (Context is consciousness — isolated structural nodes erode it.)`,
      confidence: "low",
      needs_human: true,
    });
  }

  return findings;
}

// ── Detector 3: contradiction candidates ─────────────────────────────────────

const NEG_MARKERS = /\b(nunca|never|no\s+usar|don'?t|do not|avoid|evitar|deprecated|anti-pattern|prohibido|forbidden)\b/i;
const POS_MARKERS = /\b(siempre|always|use\b|usar|prefer|preferir|required|requerido|must\b|debe)\b/i;

/**
 * Same-topic pairs (cosine in [lo, hi)) whose polarity markers point in opposite
 * directions — one prescriptive, one prohibitive. These are CANDIDATES only:
 * deterministic heuristics can't confirm a contradiction, so every finding is
 * flagged needs_judge for Layer 3 / human review. Returning zero is a perfectly
 * honest result.
 */
export function detectContradictionCandidates(
  neurons: Neuron[],
  vectors: Map<string, number[]>,
  opts: { lo?: number; hi?: number } = {},
): Finding[] {
  const lo = opts.lo ?? 0.88;
  const hi = opts.hi ?? 0.97;
  const withVec = neurons.filter((n) => vectors.get(n.filename));

  // Precompute polarity once per neuron (not per pair).
  const pol = withVec.map((n) => {
    const t = `${n.title} ${n.content.slice(0, 400)}`;
    return { neg: NEG_MARKERS.test(t), pos: POS_MARKERS.test(t) };
  });

  const findings: Finding[] = [];
  for (let i = 0; i < withVec.length; i++) {
    for (let j = i + 1; j < withVec.length; j++) {
      // Opposite polarity: one leans prohibitive, the other prescriptive.
      const opposite =
        (pol[i].neg && pol[j].pos && !pol[i].pos) || (pol[j].neg && pol[i].pos && !pol[j].pos);
      if (!opposite) continue;
      const va = vectors.get(withVec[i].filename);
      const vb = vectors.get(withVec[j].filename);
      if (!va || !vb) continue;
      const s = cosineSimilarity(va, vb);
      if (s < lo || s >= hi) continue;
      const ids = [idOf(withVec[i]), idOf(withVec[j])].sort();
      findings.push({
        dimension: "contradiction_candidate",
        ids,
        evidence: [`cosine ${s.toFixed(3)} (same topic, not identical)`, `opposite polarity markers (one prescriptive, one prohibitive)`],
        inference: `These two cover a similar topic with possibly opposite guidance — a candidate contradiction.`,
        recommendation: `Needs semantic judgment (Layer 3) or a human to confirm and resolve. Deterministic heuristics cannot decide.`,
        confidence: "low",
        needs_judge: true,
      });
    }
  }
  return findings.sort((a, b) => a.ids[0].localeCompare(b.ids[0]) || a.ids[1].localeCompare(b.ids[1]));
}

// ── Detector 4: self-knowledge (recurring errors w/o pattern) ─────────────────

/**
 * Cluster ERROR neurons that recur (cosine ≥ selfErrSim). For each cluster with
 * no covering pattern (no NP within selfPatSim of any member), the lesson hasn't
 * been distilled into a preventive pattern — the system keeps making the same
 * class of mistake. This is the system looking at itself in its own errors.
 */
export function reflectSelfKnowledge(
  neurons: Neuron[],
  vectors: Map<string, number[]>,
  opts: { errSim?: number; patSim?: number } = {},
): Finding[] {
  const errSim = opts.errSim ?? 0.9;
  const patSim = opts.patSim ?? 0.85;
  const errors = neurons.filter((n) => n.category === "errors" && vectors.get(n.filename));
  const patterns = neurons.filter((n) => n.category === "patterns" && vectors.get(n.filename));

  if (errors.length < 2) return [];

  const dsu = makeDSU(errors.length);
  for (let i = 0; i < errors.length; i++) {
    for (let j = i + 1; j < errors.length; j++) {
      const va = vectors.get(errors[i].filename);
      const vb = vectors.get(errors[j].filename);
      if (!va || !vb) continue;
      if (cosineSimilarity(va, vb) >= errSim) dsu.union(i, j);
    }
  }

  const findings: Finding[] = [];
  for (const comp of dsu.components()) {
    if (comp.length < 2) continue;
    // Is there a pattern that already covers this cluster?
    const covered = patterns.some((p) => {
      const vp = vectors.get(p.filename);
      if (!vp) return false;
      return comp.some((i) => {
        const ve = vectors.get(errors[i].filename);
        return ve ? cosineSimilarity(ve, vp) >= patSim : false;
      });
    });
    if (covered) continue; // lesson already captured as a pattern → not a gap

    const ids = comp.map((i) => idOf(errors[i])).sort();
    findings.push({
      dimension: "self_knowledge",
      ids,
      evidence: [
        `${ids.length} similar error neurons (cosine ≥ ${errSim})`,
        `no pattern (NP) covers this cluster (max cosine < ${patSim})`,
      ],
      inference: `A recurring error class with no preventive pattern — the lesson may not be internalized.`,
      recommendation: `Distill a preventive NP from this cluster so the plan/gate layer can enforce it. (The shell is mutable — turn repeated pain into a rule.)`,
      confidence: ids.length >= 3 ? "high" : "medium",
    });
  }
  return findings.sort((a, b) => b.ids.length - a.ids.length || a.ids[0].localeCompare(b.ids[0]));
}

// ── Detector 5: dogma candidates ─────────────────────────────────────────────

// "Axiom as excuse": a rule/axiom invoked as a thought-terminator. Deliberately
// narrow (no "intentional"/"by design", which are too common to be signal).
const EXCUSE_RE = /\b(factory freeze|no\s+tocar|don'?t touch|do not touch|axiom|axioma|\bfreeze\b|sagrado|inmutable|immutable)\b/i;

/**
 * Two sub-signals of dogma:
 *  (a) a high-authority pattern/foundation (graduated or hits ≥ minHits) that has
 *      NEVER recorded a miss and is old — assumed true, never re-challenged;
 *  (b) a decision that leans on a freeze/axiom as justification — verify it's a
 *      genuine frame, not an excuse to skip analysis.
 */
export function detectDogmaCandidates(neurons: Neuron[], opts: ReflectionOptions = {}): Finding[] {
  const now = opts.now ?? new Date();
  const minHits = opts.dogmaMinHits ?? 7;
  const ageDays = opts.dogmaAgeDays ?? 90;
  const findings: Finding[] = [];

  for (const n of neurons) {
    if (n.category !== "patterns" && n.category !== "foundations") continue;
    const hits = Number(n.frontmatter.hits ?? 0);
    const misses = Number(n.frontmatter.misses ?? 0);
    const status = String(n.frontmatter.status ?? "new");
    const { date } = knowledgeDate(n);
    const age = daysBetween(now, date);
    const highAuthority = status === "graduated" || hits >= minHits;
    if (highAuthority && misses === 0 && age >= ageDays) {
      findings.push({
        dimension: "dogma_candidate",
        ids: [idOf(n)],
        evidence: [`status=${status}`, `hits=${hits}, misses=0`, `age=${age}d`],
        inference: `High-authority pattern with zero recorded misses in ${age}d — assumed true, never re-challenged.`,
        recommendation: `Schedule a re-verification: does it still hold? A 0-miss veteran is dogma-prone.`,
        confidence: "low",
      });
    }
  }

  for (const n of neurons) {
    if (n.category !== "decisions") continue;
    if (EXCUSE_RE.test(`${n.title} ${n.content.slice(0, 400)}`)) {
      findings.push({
        dimension: "dogma_candidate",
        ids: [idOf(n)],
        evidence: [`invokes a freeze/axiom/immutability justification`],
        inference: `Decision leans on a rule/axiom as justification — it may be a genuine frame, or an excuse to avoid analysis.`,
        recommendation: `Human review: confirm the axiom applies here as evidence, not as a thought-terminator.`,
        confidence: "low",
        needs_human: true,
      });
    }
  }

  return findings.sort((a, b) => a.ids[0].localeCompare(b.ids[0]));
}

// ── Aggregate ────────────────────────────────────────────────────────────────

export interface DetectorRun {
  mirror_cluster: Finding[];
  citation_graph: Finding[];
  contradiction_candidate: Finding[];
  self_knowledge: Finding[];
  dogma_candidate: Finding[];
}

/** Run all five detectors. Pure: reads only `neurons` + `vectors`. */
export function detectAll(
  neurons: Neuron[],
  vectors: Map<string, number[]>,
  opts: ReflectionOptions = {},
): DetectorRun {
  return {
    mirror_cluster: clusterMirrors(neurons, vectors, opts.mirrorThreshold ?? 0.97),
    citation_graph: reflectCitationGraph(neurons),
    contradiction_candidate: detectContradictionCandidates(neurons, vectors, {
      lo: opts.contradictionLo,
      hi: opts.contradictionHi,
    }),
    self_knowledge: reflectSelfKnowledge(neurons, vectors, {
      errSim: opts.selfErrSim,
      patSim: opts.selfPatSim,
    }),
    dogma_candidate: detectDogmaCandidates(neurons, opts),
  };
}
