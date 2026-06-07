/**
 * neuron-refs.ts — shared, pure neuron-id + reference classification.
 *
 * Extracted (behavior-preserving) from project-coverage-cli.ts so the SAME
 * regexes and semantics back both the project-coverage auditor and the
 * corpus-lint tool — one source of truth, no drift between two copies of the
 * confusable-id heuristics. Pure functions, zero I/O, zero writes.
 */
import { basename } from "node:path";
import { type Neuron } from "./neurons.js";

/** Canonical neuron-id shape. The corpus uses bare numeric ids (NE-329), hex ids
 *  (NF-f409), and sub-namespaced ids (NB-F-001, NB-UV-def4). Filenames append a
 *  descriptive slug after the id (NE-329-ts-errors-introduced.md); the id is the
 *  LEADING token — which is exactly what references in prose use.
 *  The number component is a 4-char hex hash (f409, 6683 — may be all-digits) OR
 *  a 3-digit sequential id (001–619), optionally preceded by a 1–3 letter
 *  sub-namespace (NB-F, NB-UV, NB-JB, NB-PS). 4-hex is tried FIRST so an all-digit
 *  hash like "6683" is not truncated to "668" by the 3-digit branch; the exact
 *  lengths also stop a slug like "NB-F-pricing" from reading as "NB-F". */
const NEURON_ID_CORE = "(?:NE|ND|NP|NF|NB)(?:-[A-Za-z]{1,3})?-(?:[0-9A-Fa-f]{4}|\\d{3})";
const NEURON_ID_RE = new RegExp(`\\b${NEURON_ID_CORE}\\b`, "gi");
const NEURON_ID_HEAD_RE = new RegExp(`^${NEURON_ID_CORE}`, "i");
const NEURON_ID_FULL_RE = new RegExp(`^${NEURON_ID_CORE}$`, "i");
/** Pattern-reference ids (human reference, NOT neuron files): PAT-FX-010, PAT-UV-003. */
const PATTERN_ID_RE = /\bPAT-[A-Z]{2,}-\d+\b/gi;
/** Product short-ids used in prose / issues — external, NOT neuron files. */
const PRODUCT_ID_RE = /\b(?:UV|PS|PSV|JBC|OC)-\d+\b/gi;
/** GitHub-style issue references. */
const ISSUE_RE = /#\d+\b/g;
/** Generic CODE-REF shape that is neither a neuron id nor a known legacy family. */
const GENERIC_REF_RE = /\b[A-Z]{2,5}-\d+\b/g;
/** File-path / URL mentions — counted only (not enumerated as confusable refs). */
const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const PATH_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|py|sql|sh|toml)\b/gi;
/** Cap for enumerated legacy/path/url ref entries (with an explicit truncation note). */
const REF_ENUM_CAP = 200;

export interface RefEntry {
  ref: string;
  kind?: string;
  count: number;
  sample_in?: string[];
}

export interface CorpusReferences {
  broken_neuron_refs: RefEntry[];
  legacy_or_external_refs: RefEntry[];
  unknown_refs: RefEntry[];
  diagnostics: { path_like_mentions: number; url_mentions: number; truncated: boolean };
}

/** The canonical id = the leading id token of a filename/ref, with the descriptive
 *  slug (and `.md`) stripped. Used for BOTH the id set (from filenames) and
 *  reference resolution (from prose), so they always agree. */
export function extractNeuronId(nameOrToken: string): string {
  const base = basename(nameOrToken).replace(/\.md$/i, "");
  const m = base.match(NEURON_ID_HEAD_RE);
  return (m ? m[0] : base).toUpperCase();
}

/** True iff the whole token is a well-formed neuron id (NE-001, NF-f409, NB-UV-def4). */
export function isValidNeuronId(id: string): boolean {
  return NEURON_ID_FULL_RE.test(String(id ?? "").trim());
}

/**
 * Classify every reference-shaped token across the corpus into:
 *   - broken_neuron_refs    : neuron-id shaped but no such id exists in the corpus
 *   - legacy_or_external_refs: known non-neuron families (PAT-/UV-/PS-/PSV-/JBC-/OC-/#issues)
 *   - unknown_refs          : generic CODE-123 shapes that fit no known family
 * plus path/url mention counts. Self-references are ignored. Lists are sorted
 * deterministically (count desc, then ref asc) and capped at REF_ENUM_CAP with a
 * truncation flag. Behavior-preserving extraction of the former `scanReferences`.
 */
export function classifyCorpusRefs(neurons: Neuron[]): CorpusReferences {
  const neuronId = (n: Neuron): string => extractNeuronId(n.filename);
  const idSet = new Set(neurons.map(neuronId));

  const broken = new Map<string, RefEntry>();
  const legacy = new Map<string, RefEntry>();
  const unknown = new Map<string, RefEntry>();
  let pathMentions = 0;
  let urlMentions = 0;

  const bump = (map: Map<string, RefEntry>, ref: string, inId: string, kind?: string): void => {
    const cur = map.get(ref);
    if (cur) {
      cur.count += 1;
      if (cur.sample_in && cur.sample_in.length < 5 && !cur.sample_in.includes(inId)) cur.sample_in.push(inId);
    } else {
      map.set(ref, { ref, kind, count: 1, sample_in: [inId] });
    }
  };

  for (const n of neurons) {
    const self = neuronId(n);
    const haystack = `${n.content}\n${JSON.stringify(n.frontmatter)}`;

    // 1) Neuron-id shaped tokens → resolved (skip) or broken.
    for (const m of haystack.match(NEURON_ID_RE) ?? []) {
      const ref = m.toUpperCase();
      if (ref === self) continue; // self heading, harmless
      if (!idSet.has(ref)) bump(broken, ref, self);
    }
    // 2) Legacy / external ID-shaped families (the confusable ones).
    for (const m of haystack.match(PATTERN_ID_RE) ?? []) bump(legacy, m.toUpperCase(), self, "pattern-id");
    for (const m of haystack.match(PRODUCT_ID_RE) ?? []) bump(legacy, m.toUpperCase(), self, "product-id");
    for (const m of haystack.match(ISSUE_RE) ?? []) bump(legacy, m, self, "issue");
    // 3) Generic ref-shaped tokens that fit no known family → unknown.
    //    Use matchAll so we can skip sub-segments of a longer dashed id
    //    (e.g. the "FX-010" inside "PAT-FX-010"), which a preceding "-" marks.
    for (const m of haystack.matchAll(GENERIC_REF_RE)) {
      const idx = m.index ?? 0;
      if (idx > 0 && haystack[idx - 1] === "-") continue; // tail of a longer dashed id
      const ref = m[0].toUpperCase();
      if (/^(NE|ND|NP|NF|NB)-/.test(ref)) continue; // neuron family (handled above)
      if (/^(UV|PS|PSV|JBC|OC)-/.test(ref)) continue; // product family (handled above)
      if (/^PAT-/.test(ref)) continue; // pattern family
      bump(unknown, ref, self);
    }
    // 4) Paths / URLs — counted only (not confusable with neuron ids).
    pathMentions += (haystack.match(PATH_RE) ?? []).length;
    urlMentions += (haystack.match(URL_RE) ?? []).length;
  }

  const finish = (map: Map<string, RefEntry>): { list: RefEntry[]; truncated: boolean } => {
    const all = [...map.values()].sort((a, b) => b.count - a.count || a.ref.localeCompare(b.ref));
    return { list: all.slice(0, REF_ENUM_CAP), truncated: all.length > REF_ENUM_CAP };
  };
  const b = finish(broken);
  const l = finish(legacy);
  const u = finish(unknown);

  return {
    broken_neuron_refs: b.list,
    legacy_or_external_refs: l.list,
    unknown_refs: u.list,
    diagnostics: {
      path_like_mentions: pathMentions,
      url_mentions: urlMentions,
      truncated: b.truncated || l.truncated || u.truncated,
    },
  };
}
