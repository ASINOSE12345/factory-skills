import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dreamScan, formatMarkdown, mainCli, validateScanParams } from "../src/dream-scan";
import { detectUnknownScope } from "../src/gap-analysis";
import type { Neuron, NeuronCategory } from "../src/neurons";
import { resetProjectAliasCache } from "../src/neurons";

let root: string;
let neuronsDir: string;
const NOW = new Date("2026-05-31");

function writeNeuron(dir: string, category: string, name: string, frontmatter: string, body: string) {
  const d = join(dir, category);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), `---\n${frontmatter}\n---\n\n# ${name.replace(".md", "")}: ${body}\n\n${body}\n`);
}

function snapshot(dir: string): string {
  return (readdirSync(dir, { recursive: true }) as string[])
    .sort()
    .map((f) => {
      const s = statSync(join(dir, f));
      return `${f}:${s.isFile() ? `${s.size}:${s.mtimeMs}` : "dir"}`;
    })
    .join("|");
}

beforeAll(() => {
  delete process.env.FACTORY_PROJECT_ALIASES_FILE;
  delete process.env.FACTORY_ROOT;
  resetProjectAliasCache();
  root = mkdtempSync(join(tmpdir(), "dreamscan-"));
  neuronsDir = join(root, "neurons");
  writeNeuron(neuronsDir, "errors", "NE-900.md", "project: UrbanVistaCapital\ncreated: 2026-01-01\ndomain: deploy", "edge function deploy needs no-verify-jwt");
  writeNeuron(neuronsDir, "errors", "NE-901.md", "project: UrbanVistaCapital\ncreated: 2026-01-02\ndomain: deploy", "edge function deploy requires the jwt flag");
  writeNeuron(neuronsDir, "errors", "NE-902.md", "domain: misc", "a neuron with no project and no scope");
  writeNeuron(neuronsDir, "patterns", "NP-900.md", "scope: cross-project\nstatus: superseded\nsuperseded_by: NP-999\ncreated: 2026-03-01", "old pattern");
  writeNeuron(neuronsDir, "patterns", "NP-901.md", "scope: cross-project\nhits: 1\nmisses: 4\ncreated: 2026-03-01", "flaky pattern");
  writeFileSync(
    join(root, ".neuron-embeddings.json"),
    JSON.stringify({
      model: "test",
      dimensions: 3,
      entries: {
        "NE-900.md": { vector: [1, 0, 0], updated: "2026-01-01" },
        "NE-901.md": { vector: [0.99, 0.01, 0], updated: "2026-01-02" },
      },
    }),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  resetProjectAliasCache();
});

describe("dreamScan (core, real fixtures)", () => {
  it("scans the whole corpus", () => {
    const r = dreamScan(neuronsDir, { now: NOW, staleDays: 60 });
    expect(r.corpus_size).toBe(5);
    expect(r.corpus_root).toBe(neuronsDir);
  });
  it("default threshold is the calibrated 0.93 and still finds the near-duplicate", () => {
    const r = dreamScan(neuronsDir, { now: NOW });
    expect(r.threshold).toBe(0.93);
    const pair = r.possible_duplicates.find((d) => `${d.a} ${d.b}`.includes("NE-900") && `${d.a} ${d.b}`.includes("NE-901"));
    expect(pair).toBeTruthy();
    expect(pair!.similarity).toBeGreaterThanOrEqual(0.93);
  });
  it("reports total_possible_duplicates (full count) alongside the capped list", () => {
    const r = dreamScan(neuronsDir, { now: NOW });
    expect(r.total_possible_duplicates).toBe(r.possible_duplicates.length); // only 1 dup here, not capped
  });
  it("detects superseded / unreliable / stale / unknown-scope", () => {
    const r = dreamScan(neuronsDir, { now: NOW, staleDays: 60 });
    expect(r.superseded.map((s) => s.id)).toContain("NP-900");
    expect(r.unreliable_patterns.map((p) => p.id)).toContain("NP-901");
    expect(r.stale.map((s) => s.id)).toContain("NE-900");
    expect(r.stale.map((s) => s.id)).not.toContain("NP-901"); // pattern = durable
    expect(r.unknown_scope.map((u) => u.id)).toContain("NE-902");
    expect(r.unknown_scope.map((u) => u.id)).not.toContain("NE-900");
  });
  it("is READ-ONLY: does not modify the corpus dir", () => {
    const before = snapshot(neuronsDir);
    dreamScan(neuronsDir, { now: NOW });
    expect(snapshot(neuronsDir)).toBe(before);
  });
  it("throws on out-of-range params (defense in depth)", () => {
    expect(() => dreamScan(neuronsDir, { threshold: 0.5, now: NOW })).toThrow();
  });
});

describe("validateScanParams", () => {
  it("accepts in-range params", () => {
    expect(validateScanParams(0.93, 60, 100)).toBeNull();
  });
  it("rejects threshold below 0.8 or above 1", () => {
    expect(validateScanParams(0.5, 60, 100)).toBeTruthy();
    expect(validateScanParams(1.5, 60, 100)).toBeTruthy();
  });
  it("rejects non-positive stale-days and max-pairs", () => {
    expect(validateScanParams(0.93, 0, 100)).toBeTruthy();
    expect(validateScanParams(0.93, 60, 0)).toBeTruthy();
  });
  it("rejects max-pairs over the 1000 cap", () => {
    expect(validateScanParams(0.93, 60, 999999)).toBeTruthy();
  });
});

describe("detectUnknownScope", () => {
  const mk = (file: string, fm: Record<string, unknown>): Neuron => ({
    filename: file,
    filepath: `/tmp/${file}`,
    category: "errors" as NeuronCategory,
    frontmatter: fm,
    content: "x",
    title: "x",
    modified: new Date(),
  });
  it("flags neurons with no project and no scope", () => {
    expect(detectUnknownScope([mk("NE-1.md", {})]).map((u) => u.id)).toEqual(["NE-1"]);
  });
  it("does not flag a scoped neuron", () => {
    expect(detectUnknownScope([mk("NE-2.md", { project: "uv" })])).toHaveLength(0);
  });
});

describe("formatMarkdown", () => {
  it("renders sections, the showing/total count, and the read-only disclaimer", () => {
    const md = formatMarkdown(dreamScan(neuronsDir, { now: NOW }));
    expect(md).toContain("propuestas, no cambios aplicados");
    expect(md).toContain("## Near-duplicates (showing");
    expect(md).toContain("## Unknown scope");
  });
});

describe("mainCli (in-process exit codes)", () => {
  it("returns 1 with no args", () => expect(mainCli([])).toBe(1));
  it("returns 0 with --help", () => expect(mainCli(["--help"])).toBe(0));
  it("returns 1 for an unresolvable neuronsRoot", () => expect(mainCli(["/nonexistent/path/xyz-not-here"])).toBe(1));
  it("returns 1 for an out-of-range threshold", () => expect(mainCli([neuronsDir, "--threshold", "0.5"])).toBe(1));
  it("returns 1 for a non-positive stale-days", () => expect(mainCli([neuronsDir, "--stale-days", "0"])).toBe(1));
  it("returns 1 for a non-numeric threshold (no silent default)", () => expect(mainCli([neuronsDir, "--threshold", "abc"])).toBe(1));
  it("returns 1 for an invalid format", () => expect(mainCli([neuronsDir, "--format", "yaml"])).toBe(1));
  it("returns 1 for max-pairs over the cap", () => expect(mainCli([neuronsDir, "--max-pairs", "999999"])).toBe(1));
});

describe("dream-scan CLI (subprocess on dist — P1 pipe + resolution)", () => {
  const DIST = resolve("dist/dream-scan.js");
  let bigRoot: string;
  let bigNeurons: string;
  const N = 60;

  beforeAll(() => {
    if (!existsSync(DIST)) execSync("npm run build", { cwd: process.cwd(), stdio: "ignore" });
    bigRoot = mkdtempSync(join(tmpdir(), "dreambig-"));
    bigNeurons = join(bigRoot, "neurons");
    mkdirSync(join(bigNeurons, "errors"), { recursive: true });
    const entries: Record<string, { vector: number[]; updated: string }> = {};
    for (let i = 0; i < N; i++) {
      const fn = `NE-${800 + i}.md`;
      writeFileSync(join(bigNeurons, "errors", fn), `---\nproject: ProjectAlpha\ncreated: 2026-01-01\n---\n\n# ${fn}\n\nbody ${i}\n`);
      entries[fn] = { vector: [1, 0, 0], updated: "2026-01-01" }; // identical → all pairs are duplicates
    }
    writeFileSync(join(bigRoot, ".neuron-embeddings.json"), JSON.stringify({ model: "t", dimensions: 3, entries }));
  });
  afterAll(() => rmSync(bigRoot, { recursive: true, force: true }));

  it("emits COMPLETE parseable JSON over a pipe (>64KB, no truncation — P1)", () => {
    const out = execSync(`node ${DIST} ${bigNeurons} --threshold 0.9 --max-pairs 1000`, {
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
    expect(out.length).toBeGreaterThan(64 * 1024);
    const parsed = JSON.parse(out); // must not throw
    expect(parsed.corpus_size).toBe(N);
    expect(parsed.possible_duplicates.length).toBe(1000);
    expect(parsed.total_possible_duplicates).toBe((N * (N - 1)) / 2);
  });
  it("resolves a project root to its neurons/ dir (accepts the parent)", () => {
    const out = execSync(`node ${DIST} ${bigRoot}`, { maxBuffer: 64 * 1024 * 1024 }).toString();
    expect(JSON.parse(out).corpus_size).toBe(N);
  });
  it("caps possible_duplicates to --max-pairs but keeps the honest total", () => {
    const out = execSync(`node ${DIST} ${bigNeurons} --threshold 0.9 --max-pairs 5`, { maxBuffer: 64 * 1024 * 1024 }).toString();
    const p = JSON.parse(out);
    expect(p.possible_duplicates.length).toBe(5);
    expect(p.total_possible_duplicates).toBe((N * (N - 1)) / 2);
  });
  it("exits 1 on an out-of-range threshold", () => {
    let code = 0;
    try {
      execSync(`node ${DIST} ${bigNeurons} --threshold 0.5`, { stdio: "ignore" });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).toBe(1);
  });
  it("exits 1 on non-numeric threshold / invalid format / over-cap max-pairs", () => {
    const fails = (args: string): number => {
      try {
        execSync(`node ${DIST} ${bigNeurons} ${args}`, { stdio: "ignore" });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? -1;
      }
    };
    expect(fails("--threshold abc")).toBe(1);
    expect(fails("--format yaml")).toBe(1);
    expect(fails("--max-pairs 999999")).toBe(1);
  });
});
