import { describe, it, expect } from "vitest";
import { classifyCorpusRefs, isValidNeuronId, extractNeuronId } from "../src/neuron-refs";
import type { Neuron } from "../src/neurons";

function mk(filename: string, content: string, frontmatter: Record<string, unknown> = {}): Neuron {
  return {
    filename,
    filepath: `/tmp/${filename}`,
    category: "errors",
    frontmatter,
    content,
    title: filename,
    modified: new Date(0),
  };
}

describe("isValidNeuronId", () => {
  it("accepts well-formed ids (numeric, hex, sub-namespaced)", () => {
    for (const id of ["NE-001", "ND-270", "NP-059", "NF-f409", "NB-UV-def4", "NB-F-001"]) {
      expect(isValidNeuronId(id)).toBe(true);
    }
  });
  it("rejects malformed / foreign ids", () => {
    for (const id of ["NE-1", "NE-12345", "RANDOM", "PAT-FX-010", "UV-123", "", "NEURON-001", "NE_001"]) {
      expect(isValidNeuronId(id)).toBe(false);
    }
  });
  it("extractNeuronId strips the slug + .md and yields a valid id", () => {
    expect(extractNeuronId("NE-329-ts-errors-introduced.md")).toBe("NE-329");
    expect(extractNeuronId("NB-UV-def4-urbanvista-lead.md")).toBe("NB-UV-DEF4");
    expect(isValidNeuronId(extractNeuronId("NE-080.md"))).toBe(true);
    expect(isValidNeuronId(extractNeuronId("random-note.md"))).toBe(false);
  });
});

describe("classifyCorpusRefs", () => {
  it("flags a neuron-id-shaped ref that does not exist as BROKEN; keeps an existing one resolved", () => {
    const neurons = [mk("NE-001.md", "see NE-999 and also NE-002"), mk("NE-002.md", "body")];
    const r = classifyCorpusRefs(neurons);
    expect(r.broken_neuron_refs.some((e) => e.ref === "NE-999")).toBe(true);
    expect(r.broken_neuron_refs.some((e) => e.ref === "NE-002")).toBe(false); // exists → resolved
  });

  it("ignores a self-reference (the neuron mentioning its own id)", () => {
    const neurons = [mk("NE-001.md", "this is NE-001 talking about NE-001")];
    const r = classifyCorpusRefs(neurons);
    expect(r.broken_neuron_refs.some((e) => e.ref === "NE-001")).toBe(false);
  });

  it("classifies legacy / external families (pattern, product, issue) as legacy_or_external", () => {
    const neurons = [mk("NE-001.md", "ref PAT-FX-010 and UV-123 and issue #456")];
    const r = classifyCorpusRefs(neurons);
    const refs = r.legacy_or_external_refs;
    expect(refs.find((e) => e.ref === "PAT-FX-010")?.kind).toBe("pattern-id");
    expect(refs.find((e) => e.ref === "UV-123")?.kind).toBe("product-id");
    expect(refs.find((e) => e.ref === "#456")?.kind).toBe("issue");
    // none of these are broken or unknown
    expect(r.broken_neuron_refs).toEqual([]);
    expect(r.unknown_refs).toEqual([]);
  });

  it("counts path/url mentions as diagnostics (not enumerated as refs)", () => {
    const neurons = [mk("NE-001.md", "edit src/server/foo.ts and see https://example.com/x")];
    const r = classifyCorpusRefs(neurons);
    expect(r.diagnostics.path_like_mentions).toBeGreaterThanOrEqual(1);
    expect(r.diagnostics.url_mentions).toBeGreaterThanOrEqual(1);
  });

  it("classifies a generic CODE-123 ref (no known family) as unknown", () => {
    const neurons = [mk("NE-001.md", "mysterious CODE-123 token")];
    const r = classifyCorpusRefs(neurons);
    expect(r.unknown_refs.some((e) => e.ref === "CODE-123")).toBe(true);
  });

  it("does NOT read the FX-010 tail of PAT-FX-010 as a separate unknown ref", () => {
    const neurons = [mk("NE-001.md", "PAT-FX-010 only")];
    const r = classifyCorpusRefs(neurons);
    expect(r.unknown_refs.some((e) => e.ref === "FX-010")).toBe(false);
    expect(r.legacy_or_external_refs.some((e) => e.ref === "PAT-FX-010")).toBe(true);
  });

  it("aggregates counts + sample_in and sorts deterministically (count desc, then ref asc)", () => {
    const neurons = [mk("NE-001.md", "NE-900 NE-900 NE-900 NE-800")];
    const r = classifyCorpusRefs(neurons);
    const ids = r.broken_neuron_refs.map((e) => e.ref);
    expect(ids).toEqual(["NE-900", "NE-800"]); // NE-900 (3) before NE-800 (1)
    const nine = r.broken_neuron_refs.find((e) => e.ref === "NE-900")!;
    expect(nine.count).toBe(3);
    expect(nine.sample_in).toContain("NE-001");
  });
});
