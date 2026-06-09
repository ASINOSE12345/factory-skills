import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import {
  searchNeurons,
  searchNeuronsScored,
  searchNeuronsSync,
  listNeurons,
  isSupersededNeuron,
} from "../src/neurons";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "retr-"));
  roots.push(root);
  const nd = join(root, "neurons");
  for (const c of ["errors", "decisions", "patterns", "foundations", "business"]) mkdirSync(join(nd, c), { recursive: true });
  return nd;
}
function write(nd: string, cat: string, file: string, fm: Record<string, unknown>, body: string): void {
  writeFileSync(join(nd, cat, file), matter.stringify(`\n${body}\n`, fm));
}
const ids = (ns: { filename: string }[]) => ns.map((n) => n.filename.replace(".md", ""));

describe("retrieval — superseded excluded by default", () => {
  it("1. searchNeurons excludes a superseded neuron the query would otherwise match", async () => {
    const nd = setup();
    write(nd, "errors", "NE-100-live.md", { status: "active", project: "softwarefactory" }, "# NE-100\nwidget overflow crash on resize");
    write(nd, "errors", "NE-101-old.md", { status: "superseded", superseded_by: "NE-100", superseded_on: "2026-06-09", superseded_reason: "absorbed", project: "softwarefactory" }, "# NE-101\nwidget overflow crash on resize");
    const r = await searchNeurons(nd, "widget overflow resize");
    expect(ids(r)).toContain("NE-100-live");
    expect(ids(r)).not.toContain("NE-101-old");
  });

  it("2. searchNeuronsScored excludes superseded (scored path)", async () => {
    const nd = setup();
    write(nd, "errors", "NE-100-live.md", { status: "active" }, "# NE-100\nwidget overflow crash");
    write(nd, "errors", "NE-101-old.md", { status: "superseded", superseded_by: "NE-100" }, "# NE-101\nwidget overflow crash");
    const scored = await searchNeuronsScored(nd, "widget overflow");
    expect(scored.map((s) => s.neuron.filename)).not.toContain("NE-101-old.md");
    expect(scored.map((s) => s.neuron.filename)).toContain("NE-100-live.md");
  });

  it("3. searchNeuronsSync excludes superseded (keyword path)", () => {
    const nd = setup();
    write(nd, "errors", "NE-100-live.md", { status: "active" }, "# NE-100\nwidget overflow crash");
    write(nd, "errors", "NE-101-old.md", { status: "superseded", superseded_by: "NE-100" }, "# NE-101\nwidget overflow crash");
    const r = searchNeuronsSync(nd, "widget overflow");
    expect(ids(r)).toContain("NE-100-live");
    expect(ids(r)).not.toContain("NE-101-old");
  });

  it("4. superseded_by present even with status:new is treated as superseded → excluded", () => {
    const nd = setup();
    write(nd, "errors", "NE-103-live.md", { status: "active" }, "# NE-103\ngadget glitch on boot");
    write(nd, "errors", "NE-102-old.md", { status: "new", superseded_by: "NE-103" }, "# NE-102\ngadget glitch on boot");
    const r = searchNeuronsSync(nd, "gadget glitch boot");
    expect(ids(r)).toContain("NE-103-live");
    expect(ids(r)).not.toContain("NE-102-old"); // superseded_by alone excludes
  });

  it("5. non-superseded equivalent is NOT lost", () => {
    const nd = setup();
    write(nd, "errors", "NE-103-live.md", { status: "new" }, "# NE-103\ngadget glitch on boot");
    const r = searchNeuronsSync(nd, "gadget glitch boot");
    expect(ids(r)).toContain("NE-103-live");
  });

  it("6. project filter does not reintroduce superseded", async () => {
    const nd = setup();
    write(nd, "errors", "NE-110-live.md", { status: "active", project: "urbanvistacapital" }, "# NE-110\nzeta beam misfire");
    write(nd, "errors", "NE-111-old.md", { status: "superseded", superseded_by: "NE-110", project: "urbanvistacapital" }, "# NE-111\nzeta beam misfire");
    const r = await searchNeurons(nd, "zeta beam misfire", undefined, "urbanvistacapital");
    expect(ids(r)).toContain("NE-110-live");
    expect(ids(r)).not.toContain("NE-111-old");
  });

  it("7. get_neuron path (listNeurons) STILL returns superseded — the escape hatch", () => {
    const nd = setup();
    write(nd, "errors", "NE-101-old.md", { status: "superseded", superseded_by: "NE-100" }, "# NE-101\nwidget overflow");
    const all = listNeurons(nd, "errors");
    const sup = all.find((n) => n.filename === "NE-101-old.md");
    expect(sup).toBeDefined();                       // listNeurons (get_neuron's source) is NOT filtered
    expect(isSupersededNeuron(sup!)).toBe(true);
    expect(sup!.frontmatter.superseded_by).toBe("NE-100");
  });

  it("8. real corpus smoke: NP-047 excluded from search, present in listNeurons (read-only)", () => {
    const ND = "/Users/rafamastroianni/factory/neurons";
    if (!existsSync(join(ND, "patterns", "NP-047.md"))) return; // CI-safe skip
    const r = searchNeuronsSync(ND, "Recovery Paperclip backlink loop circular", "patterns");
    const got = ids(r);
    expect(got).not.toContain("NP-047");             // superseded → excluded from operational search
    // its live successor (NP-051) should still be reachable by the same query
    const live = listNeurons(ND, "patterns");
    expect(live.some((n) => n.filename === "NP-047.md")).toBe(true);  // escape hatch / diagnostics path
    const np047 = live.find((n) => n.filename === "NP-047.md");
    expect(isSupersededNeuron(np047!)).toBe(true);
  });
});
