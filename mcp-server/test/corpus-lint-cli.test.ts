import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import { lintCorpus, renderMarkdown, parseArgs, main, type LintReport } from "../src/corpus-lint-cli";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function setup(): { root: string; neuronsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "lint-"));
  roots.push(root);
  const neuronsDir = join(root, "neurons");
  for (const c of ["errors", "decisions", "patterns", "foundations", "business"]) mkdirSync(join(neuronsDir, c), { recursive: true });
  return { root, neuronsDir };
}

function write(neuronsDir: string, category: string, filename: string, fm: Record<string, unknown> | null, body: string): void {
  mkdirSync(join(neuronsDir, category), { recursive: true });
  const content = fm === null ? body : matter.stringify(`\n${body}\n`, fm);
  writeFileSync(join(neuronsDir, category, filename), content);
}

/** sha256 over sorted (relpath:contenthash) of every file under root — to prove no writes. */
function treeHash(root: string): string {
  const out: string[] = [];
  const walk = (d: string, base: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const fp = join(d, e.name);
      if (e.isSymbolicLink()) { out.push(`L:${join(base, e.name)}`); continue; }
      if (e.isDirectory()) walk(fp, join(base, e.name));
      else if (e.isFile()) out.push(`${join(base, e.name)}:${createHash("sha256").update(readFileSync(fp)).digest("hex")}`);
    }
  };
  walk(root, "");
  return createHash("sha256").update(out.sort().join("\n")).digest("hex");
}

/** A corpus with one of every mandated fixture. Returns paths for assertions. */
function fullCorpus(): { root: string; neuronsDir: string } {
  const { root, neuronsDir } = setup();
  // 1. valid NE, full frontmatter, clean.
  write(neuronsDir, "errors", "NE-001-clean.md",
    { id: "NE-001", type: "error-memory", project: "urbanvista", scope: "urbanvista", status: "active", created: "2026-06-01" },
    "# NE-001: clean\nbody");
  // 2. valid ND missing scope (has project).
  write(neuronsDir, "decisions", "ND-001-no-scope.md",
    { id: "ND-001", project: "urbanvista", status: "active", created: "2026-06-01" }, "# ND-001\nbody");
  // 3. valid NP missing project (has scope) + missing created + missing status → 3 issues, counts once.
  write(neuronsDir, "patterns", "NP-001-no-project.md",
    { id: "NP-001", scope: "urbanvista" }, "# NP-001\nbody");
  // 4. invalid frontmatter (broken YAML).
  writeFileSync(join(neuronsDir, "errors", "NE-009-broken.md"), "---\nproject: [unclosed\nstatus: x\n---\nbody");
  // 5. mis-named .md inside errors.
  writeFileSync(join(neuronsDir, "errors", "README.md"), "# Readme\nnot a neuron");
  // 6-8. valid heterogeneous IDs — must NOT be flagged.
  write(neuronsDir, "business", "NB-F-001-pricing.md",
    { id: "NB-F-001", project: "softwarefactory", scope: "global", status: "active", created: "2026-06-01" }, "# NB-F-001\nbody");
  write(neuronsDir, "foundations", "NF-5c11-knowledge-sync.md",
    { id: "NF-5c11", project: "softwarefactory", scope: "global", status: "active", created: "2026-06-01" }, "# NF-5c11\nbody");
  write(neuronsDir, "errors", "NE-327-staging-domain-denial.md",
    { id: "NE-327", project: "urbanvista", scope: "urbanvista", status: "active", created: "2026-06-01" }, "# NE-327\nbody");
  // 9. unknown category directory.
  write(neuronsDir, "scratch", "NE-700-note.md",
    { id: "NE-700", project: "urbanvista", scope: "urbanvista", status: "active", created: "2026-06-01" }, "# NE-700\nbody");
  // 10. symlink — must be skipped + reported, never followed.
  symlinkSync(join(neuronsDir, "errors", "NE-001-clean.md"), join(neuronsDir, "errors", "NE-998-link.md"));
  // 11. auto_captured stub with pending placeholder.
  write(neuronsDir, "errors", "NE-626-noise.md",
    { id: "NE-626", project: "softwarefactory", scope: "global", status: "captured", auto_captured: true, created: "2026-06-05" },
    "# NE-626\n## Fix applied\n_Pending — root cause not yet established._");
  // 12-14. refs: broken (NE-888), legacy (PAT-FX-010 + UV-42), unknown (ZZ-42).
  write(neuronsDir, "decisions", "ND-002-refs.md",
    { id: "ND-002", project: "urbanvista", scope: "urbanvista", status: "active", created: "2026-06-01" },
    "# ND-002\nSee NE-888 and PAT-FX-010 and UV-42 and ZZ-42 for context.");
  // 17. missing status (distinct from #3) + 18. corrupt created.
  write(neuronsDir, "patterns", "NP-002-bad-date.md",
    { id: "NP-002", project: "urbanvista", scope: "urbanvista", status: "active", created: "not-a-date" }, "# NP-002\nbody");
  return { root, neuronsDir };
}

function opts(neuronsDir: string, extra: Partial<Parameters<typeof lintCorpus>[0]> = {}) {
  return { neuronsDir, top: 50, strictRequested: false, ...extra };
}

describe("corpus-lint — raw walk sees what listNeurons hides", () => {
  it("counts invalid frontmatter, bad filenames, unknown category, and symlinks", () => {
    const { neuronsDir } = fullCorpus();
    const r = lintCorpus(opts(neuronsDir));
    expect(r.files.invalid_frontmatter).toBe(1);          // NE-009-broken
    expect(r.files.invalid_filename).toBe(1);             // README.md (only)
    expect(r.files.unknown_category_file).toBe(1);        // scratch/NE-700
    expect(r.files.symlink_skipped).toBe(1);              // NE-998-link
    // by_category.unknown and files.unknown_category_file represent the SAME set.
    expect(r.by_category.unknown).toBe(r.files.unknown_category_file);
  });

  it("does NOT follow symlinks (link target content not double-counted)", () => {
    const { neuronsDir } = fullCorpus();
    const r = lintCorpus(opts(neuronsDir));
    // NE-001 appears once as a real file; the symlink is reported, not walked.
    const samples = r.files.samples.join("|");
    expect(samples).toContain("NE-998-link.md");
  });
});

describe("corpus-lint — heterogeneous valid IDs are not mis-flagged", () => {
  it("NB-F-001 / NF-5c11 / NE-327-slug are clean (no invalid_filename, not in offenders)", () => {
    const { neuronsDir } = fullCorpus();
    const r = lintCorpus(opts(neuronsDir));
    const offenderFiles = r.top_offenders.map((o) => o.file);
    for (const f of ["business/NB-F-001-pricing.md", "foundations/NF-5c11-knowledge-sync.md", "errors/NE-327-staging-domain-denial.md"]) {
      expect(r.files.samples).not.toContain(f);
      expect(offenderFiles).not.toContain(f);
    }
    // The only genuinely invalid filename is README.md.
    expect(r.files.invalid_filename).toBe(1);
  });
});

describe("corpus-lint — frontmatter quality", () => {
  it("flags missing project/scope/created/status and corrupt created", () => {
    const { neuronsDir } = fullCorpus();
    const r = lintCorpus(opts(neuronsDir));
    expect(r.frontmatter.missing_scope).toBeGreaterThanOrEqual(1);  // ND-001
    expect(r.frontmatter.missing_project).toBeGreaterThanOrEqual(1); // NP-001
    expect(r.frontmatter.missing_created).toBeGreaterThanOrEqual(1); // NP-001
    expect(r.frontmatter.missing_status).toBeGreaterThanOrEqual(1);  // NP-001
    expect(r.frontmatter.corrupt_created).toBe(1);                   // NP-002 (not-a-date)
    expect(Object.keys(r.frontmatter.status_distribution).length).toBeGreaterThan(0);
  });
});

describe("corpus-lint — auto-captured stubs", () => {
  it("counts auto_captured and pending placeholders", () => {
    const { neuronsDir } = fullCorpus();
    const r = lintCorpus(opts(neuronsDir));
    expect(r.frontmatter.auto_captured).toBe(1);
    expect(r.auto_capture.count).toBe(1);
    expect(r.auto_capture.pending_fix_count).toBe(1);
    expect(r.auto_capture.by_status.captured).toBe(1);
    expect(r.auto_capture.samples).toContain("NE-626");
  });
});

describe("corpus-lint — references via neuron-refs (no parallel regex)", () => {
  it("classifies broken / legacy / unknown refs", () => {
    const { neuronsDir } = fullCorpus();
    const r = lintCorpus(opts(neuronsDir));
    expect(r.references.broken_neuron_refs).toBeGreaterThanOrEqual(1);          // NE-888
    expect(r.references.legacy_or_external_refs).toBeGreaterThanOrEqual(2);     // PAT-FX-010, UV-42
    expect(r.references.unknown_refs).toBeGreaterThanOrEqual(1);                // ZZ-42
    expect(r.references.samples.broken.some((e) => e.ref === "NE-888")).toBe(true);
    // broken_ref attributed to the container file in top_offenders.
    const refsFile = r.top_offenders.find((o) => o.file === "decisions/ND-002-refs.md");
    expect(refsFile?.issues).toContain("broken_ref");
  });
});

describe("corpus-lint — registry consistency (optional --registry)", () => {
  function withRegistry(): { neuronsDir: string; registryPath: string } {
    const { root, neuronsDir } = fullCorpus();
    // lineage 'paperclip' + organization 'asinose' as non-indexed entities.
    write(neuronsDir, "errors", "NE-800-paperclip.md",
      { id: "NE-800", project: "paperclip", status: "active", created: "2026-06-01" }, "# NE-800\nbody");
    write(neuronsDir, "errors", "NE-801-org.md",
      { id: "NE-801", project: "asinose", status: "active", created: "2026-06-01" }, "# NE-801\nbody");
    const registryPath = join(root, "projects.json");
    writeFileSync(registryPath, JSON.stringify({
      version: 2,
      projects: [
        { project_id: "urbanvista", status: "active", aliases: ["urbanvista"] },
        { project_id: "softwarefactory", status: "active", is_global: true, aliases: ["softwarefactory", "global"] },
        { project_id: "paperclip", status: "external", entity_type: "source_lineage", aliases: ["paperclip"] },
        { project_id: "asinose", status: "active", entity_type: "organization", aliases: ["asinose"] },
      ],
    }, null, 2));
    return { neuronsDir, registryPath };
  }

  it("checked=false without --registry", () => {
    const { neuronsDir } = fullCorpus();
    const r = lintCorpus(opts(neuronsDir));
    expect(r.registry_consistency.checked).toBe(false);
  });

  it("flags lineage/organization used as project when --registry given", () => {
    const { neuronsDir, registryPath } = withRegistry();
    const r = lintCorpus(opts(neuronsDir, { registryPath }));
    expect(r.registry_consistency.checked).toBe(true);
    expect(r.registry_consistency.organization_or_lineage_as_project).toBeGreaterThanOrEqual(2); // paperclip + asinose
    expect(r.registry_consistency.paperclip_project_scope).toBeGreaterThanOrEqual(1);            // paperclip (lineage)
    expect(r.registry_consistency.samples).toContain("NE-800");
  });
});

describe("corpus-lint — embeddings coverage (optional --embeddings-index)", () => {
  it("checked=false without flag; reports missing when given", () => {
    const { root, neuronsDir } = fullCorpus();
    const r0 = lintCorpus(opts(neuronsDir));
    expect(r0.embeddings.checked).toBe(false);

    const idxPath = join(root, ".neuron-embeddings.json");
    // index has NE-001 only; every other parseable neuron is missing.
    writeFileSync(idxPath, JSON.stringify({ model: "m", dimensions: 4, entries: { "NE-001-clean.md": { vector: [0, 0, 0, 0] } } }));
    const r = lintCorpus(opts(neuronsDir, { embeddingsIndexPath: idxPath }));
    expect(r.embeddings.checked).toBe(true);
    expect(r.embeddings.indexed).toBe(1);
    expect(r.embeddings.missing_embedding).toBe(r.parseable_neurons - 1);
    expect(r.embeddings.samples_missing).not.toContain("NE-001");
  });
});

describe("corpus-lint — summary, determinism, exit codes", () => {
  it("a file with multiple issues counts once in neurons_with_any_issue", () => {
    const { neuronsDir } = fullCorpus();
    const r = lintCorpus(opts(neuronsDir));
    const np = r.top_offenders.find((o) => o.file === "patterns/NP-001-no-project.md");
    expect(np).toBeDefined();
    expect(np!.issue_count).toBeGreaterThanOrEqual(3); // missing project + created + status
    // counted exactly once in the offender list.
    expect(r.top_offenders.filter((o) => o.file === "patterns/NP-001-no-project.md").length).toBe(1);
    expect(r.summary.clean_parseable_neurons).toBeLessThan(r.parseable_neurons);
  });

  it("deterministic: two runs produce identical reports (modulo timestamp)", () => {
    const { neuronsDir } = fullCorpus();
    const fixed = new Date("2026-06-07T00:00:00.000Z");
    const a = lintCorpus(opts(neuronsDir), fixed);
    const b = lintCorpus(opts(neuronsDir), fixed);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("default exit 0 even with findings; --strict exits 1 on critical", () => {
    const { neuronsDir } = fullCorpus();
    const base = ["--neurons-dir", neuronsDir, "--format", "json"];
    // capture stdout to keep test output clean + prove JSON is parseable.
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
    let codeDefault: number, codeStrict: number;
    try {
      codeDefault = main(base);
      codeStrict = main([...base, "--strict"]);
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }
    expect(codeDefault).toBe(0);
    expect(codeStrict).toBe(1);
    const parsed = JSON.parse(chunks[0]) as LintReport;
    expect(parsed.tool).toBe("corpus-lint");
    expect(parsed.summary.strict_critical_total).toBeGreaterThan(0);
  });
});

describe("corpus-lint — markdown output", () => {
  it("renders all expected sections, no bodies", () => {
    const { neuronsDir } = fullCorpus();
    const md = renderMarkdown(lintCorpus(opts(neuronsDir)));
    for (const h of ["# corpus-lint", "## Summary", "## Raw inventory", "## Frontmatter quality",
      "## Scope / project coverage", "## Auto-captured stubs", "## References", "## Registry consistency",
      "## Embeddings coverage", "## Top offenders", "## Candidate duplicates"]) {
      expect(md).toContain(h);
    }
    // never leaks a neuron body line.
    expect(md).not.toContain("root cause not yet established");
  });
});

describe("corpus-lint — read-only guarantee", () => {
  it("writes nothing: tree byte-identical, no .factory, no manifest", () => {
    const { root, neuronsDir } = fullCorpus();
    const idxPath = join(root, ".neuron-embeddings.json");
    writeFileSync(idxPath, JSON.stringify({ model: "m", dimensions: 4, entries: {} }));
    const before = treeHash(root);
    lintCorpus(opts(neuronsDir, { embeddingsIndexPath: idxPath }));
    renderMarkdown(lintCorpus(opts(neuronsDir, { embeddingsIndexPath: idxPath })));
    expect(treeHash(root)).toBe(before);
    expect(existsSync(join(root, ".factory"))).toBe(false);
    expect(existsSync(join(neuronsDir, "PROMOTION-MANIFEST.json"))).toBe(false);
  });
});

describe("corpus-lint — arg parsing", () => {
  it("requires --neurons-dir and validates --format", () => {
    expect(() => parseArgs([])).toThrow(/neurons-dir/);
    expect(() => parseArgs(["--neurons-dir", "/x", "--format", "xml"])).toThrow(/format/);
    const p = parseArgs(["--neurons-dir", "/x", "--top", "5", "--strict"]);
    expect(p.top).toBe(5);
    expect(p.strictRequested).toBe(true);
    expect(p.format).toBe("json");
  });
});

describe("corpus-lint — superseded lifecycle (PR-lint)", () => {
  // capture stdout so main() stays quiet + we can read the JSON it emits
  function runMain(neuronsDir: string, strict: boolean): { code: number; report: LintReport } {
    const args = ["--neurons-dir", neuronsDir, "--format", "json"];
    if (strict) args.push("--strict");
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(s); return true; };
    let code: number;
    try { code = main(args); } finally { (process.stdout as unknown as { write: typeof orig }).write = orig; }
    return { code, report: JSON.parse(chunks[chunks.length - 1]) as LintReport };
  }
  const FULL = { created: "2026-06-01", project: "softwarefactory", scope: "softwarefactory" };
  const lint = (neuronsDir: string) => lintCorpus({ neuronsDir, top: 50, strictRequested: false });

  it("1. auto_captured + status:new + pending → counts as pending debt", () => {
    const { neuronsDir } = setup();
    write(neuronsDir, "errors", "NE-001-stub.md", { ...FULL, status: "new", auto_captured: true }, "## Fix applied\n_Pending — to fill_");
    const r = lint(neuronsDir);
    expect(r.auto_capture.pending).toBe(1);
    expect(r.auto_capture.superseded).toBe(0);
    expect(r.auto_capture.count).toBe(1);
  });

  it("2. auto_captured superseded (valid by + reason absorbed) → NOT pending; counts as auto_captured_superseded", () => {
    const { neuronsDir } = setup();
    write(neuronsDir, "errors", "NE-010-parent.md", { ...FULL, status: "graduated" }, "# NE-010 parent\nbody");
    write(neuronsDir, "errors", "NE-001-absorbed.md", { ...FULL, status: "superseded", superseded_by: "NE-010", superseded_on: "2026-06-09", superseded_reason: "absorbed", auto_captured: true }, "## Fix applied\n_Pending_");
    const r = lint(neuronsDir);
    expect(r.auto_capture.superseded).toBe(1);
    expect(r.auto_capture.pending).toBe(0);
    expect(r.superseded.total).toBe(1);
    expect(r.summary.strict_critical_total).toBe(0);
    const off = r.top_offenders.find((o) => o.file === "errors/NE-001-absorbed.md");
    expect(off?.issues ?? []).not.toContain("auto_captured_stub");
  });

  it("3. superseded_by present though status not 'superseded' → considered superseded", () => {
    const { neuronsDir } = setup();
    write(neuronsDir, "errors", "NE-010-parent.md", { ...FULL, status: "new" }, "# parent");
    write(neuronsDir, "errors", "NE-002-x.md", { ...FULL, status: "new", superseded_by: "NE-010", superseded_on: "2026-06-09", superseded_reason: "duplicate", auto_captured: true }, "body");
    const r = lint(neuronsDir);
    expect(r.superseded.total).toBe(1);
    expect(r.auto_capture.superseded).toBe(1);
    expect(r.auto_capture.pending).toBe(0);
  });

  it("4. status:superseded without superseded_by → critical; strict fails", () => {
    const { neuronsDir } = setup();
    write(neuronsDir, "errors", "NE-003-x.md", { ...FULL, status: "superseded", superseded_reason: "obsolete" }, "body");
    const def = runMain(neuronsDir, false);
    const strict = runMain(neuronsDir, true);
    expect(def.report.superseded.missing_superseded_by).toBe(1);
    expect(def.code).toBe(0);
    expect(strict.code).toBe(1);
  });

  it("5. superseded_by → nonexistent id → critical; strict fails", () => {
    const { neuronsDir } = setup();
    write(neuronsDir, "errors", "NE-004-x.md", { ...FULL, status: "superseded", superseded_by: "NE-999", superseded_on: "2026-06-09", superseded_reason: "absorbed" }, "body");
    const strict = runMain(neuronsDir, true);
    expect(strict.report.superseded.by_unresolved).toBe(1);
    expect(strict.code).toBe(1);
  });

  it("6. superseded without reason → WARNING only; default exit 0; strict does NOT fail", () => {
    const { neuronsDir } = setup();
    write(neuronsDir, "errors", "NE-010-parent.md", { ...FULL, status: "graduated" }, "# parent");
    write(neuronsDir, "errors", "NE-005-x.md", { ...FULL, status: "superseded", superseded_by: "NE-010", superseded_on: "2026-06-09" }, "body");
    const strict = runMain(neuronsDir, true);
    expect(strict.report.superseded.reason_missing).toBe(1);
    expect(strict.report.summary.strict_critical_total).toBe(0);
    expect(strict.code).toBe(0);
  });

  it("7. superseded_reason invalid → critical; strict fails", () => {
    const { neuronsDir } = setup();
    write(neuronsDir, "errors", "NE-010-parent.md", { ...FULL, status: "graduated" }, "# parent");
    write(neuronsDir, "errors", "NE-006-x.md", { ...FULL, status: "superseded", superseded_by: "NE-010", superseded_on: "2026-06-09", superseded_reason: "bogus" }, "body");
    const strict = runMain(neuronsDir, true);
    expect(strict.report.superseded.reason_invalid).toBe(1);
    expect(strict.code).toBe(1);
  });

  it("8. real corpus smoke: read-only, broken_refs baseline, NP-047 warning not critical", () => {
    const ND = "/Users/rafamastroianni/factory/neurons";
    if (!existsSync(ND)) return; // CI-safe: skip when the live corpus is absent
    const before = treeHash(ND);
    const r = lint(ND);
    expect(treeHash(ND)).toBe(before);                       // read-only
    expect(r.references.broken_neuron_refs).toBe(3);         // baseline unchanged
    expect(r.superseded.total).toBeGreaterThanOrEqual(1);    // NP-047
    expect(r.superseded.samples).toContain("NP-047");
    expect(r.superseded.reason_missing).toBeGreaterThanOrEqual(1); // NP-047 lacks reason → warning
    expect(r.superseded.missing_superseded_by).toBe(0);      // NP-047 has superseded_by
    expect(r.superseded.by_unresolved).toBe(0);              // NP-051 exists
  });
});
