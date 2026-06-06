/**
 * no-loss-gate-cli — READ-ONLY safety contract for adopting the registry as the
 * alias source of truth (future PR-3C wiring of neurons.ts).
 *
 * It proves that switching scope resolution from the seed (current `neurons.ts`)
 * to "registry alias → seed fallback" does NOT lose or mis-group knowledge:
 *
 *   - It reads every distinct `project`/`scope` token in the corpus.
 *   - It resolves each token TWO ways:
 *       old  = current seed behavior        (isGlobalScope → "global", else canonicalProject)
 *       new  = registry-primary + seed-fallback (what the wired neurons.ts would do)
 *   - It asserts the PARTITION of tokens is preserved: tokens grouped together
 *     under `old` stay together under `new` (no SPLIT), and tokens in different
 *     `old` groups never collapse into one `new` group (no MERGE). Relabels
 *     (e.g. `factoryos` → `factory-os`) are allowed and reported as `changes`.
 *   - It asserts an explicit set of CRITICAL tokens resolve to expected values.
 *
 * GLOBAL_SCOPE_TOKENS resolution is independent of the registry (handled by
 * isGlobalScope) and identical in both modes, so global classification can never
 * regress. This module performs ZERO writes and never touches the corpus.
 *
 * It imports `neurons.ts` helpers READ-ONLY (it does not modify neurons.ts); the
 * live MCP scope resolution is unchanged by this tool.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listNeurons, canonicalProject, isGlobalScope } from "./neurons.js";
import { loadRegistry, normalizeToken, type LoadedRegistry } from "./registry.js";

/** The protected tokens: their resolution must not change meaning under the registry. */
export const CRITICAL_TOKENS: ReadonlyArray<{ token: string; expect: string }> = [
  { token: "uv", expect: "urbanvistacapital" },
  { token: "urbanvista", expect: "urbanvistacapital" },
  { token: "UrbanVistaCapital", expect: "urbanvistacapital" },
  { token: "ps", expect: "peoplesynapse" },
  { token: "jbc", expect: "jbcodingiot" },
  { token: "jbcodingiotweb", expect: "jbcodingiot" },
  { token: "jbcodingiot-web", expect: "jbcodingiot" },
  { token: "factory", expect: "global" },
  { token: "sf", expect: "global" },
  { token: "softwarefactory", expect: "global" },
  { token: "factory-os", expect: "factory-os" },
  { token: "factoryos", expect: "factory-os" },
];

export interface TokenResolution {
  token: string;
  old: string;
  new: string;
}
export interface MergeFinding {
  new_canonical: string;
  old_canonicals: string[];
  tokens: string[];
}
export interface SplitFinding {
  old_canonical: string;
  new_canonicals: string[];
  tokens: string[];
}
export interface CriticalResult {
  token: string;
  expected: string;
  actual: string;
  pass: boolean;
}
export interface NoLossGateReport {
  tool: "no-loss-gate";
  neurons_dir: string;
  registry_path: string;
  total_tokens: number;
  changes: TokenResolution[]; // old !== new (relabels — informational, allowed)
  merges: MergeFinding[]; // distinct old groups collapsing → FAIL
  splits: SplitFinding[]; // one old group fragmenting → FAIL
  critical: CriticalResult[];
  critical_failures: CriticalResult[];
  pass: boolean;
}

type AliasResolver = (normToken: string) => string | undefined;

/** Effective scope of a raw token under a given alias resolver. Mirrors the
 *  precedence the wired neurons.ts would use: global tokens first (registry-
 *  independent), then the resolver, then the seed (canonicalProject) as fallback. */
function effective(token: string, resolve: AliasResolver): string {
  if (isGlobalScope(token)) return "global";
  return resolve(normalizeToken(token)) ?? canonicalProject(token);
}

/** Collect every distinct, non-empty project/scope token from the corpus. */
export function collectCorpusTokens(neuronsDir: string): string[] {
  const set = new Set<string>();
  for (const n of listNeurons(neuronsDir)) {
    for (const raw of [n.frontmatter.project, n.frontmatter.scope]) {
      const t = String(raw ?? "").trim();
      if (t) set.add(t);
    }
  }
  return [...set].sort();
}

export interface NoLossGateOptions {
  neuronsDir: string;
  registryPath: string;
  /** Extra tokens to check beyond the corpus (defaults include the critical set). */
  extraTokens?: string[];
}

export function runNoLossGate(opts: NoLossGateOptions): NoLossGateReport {
  const reg: LoadedRegistry = loadRegistry(opts.registryPath); // fail-closed on a bad registry
  const seedResolver: AliasResolver = () => undefined; // → falls back to canonicalProject (seed)
  const registryResolver: AliasResolver = (n) => reg.aliasToProject.get(n);

  const tokens = new Set<string>(collectCorpusTokens(opts.neuronsDir));
  for (const c of CRITICAL_TOKENS) tokens.add(c.token);
  for (const t of opts.extraTokens ?? []) tokens.add(t);

  const resolutions: TokenResolution[] = [];
  const oldToTokens = new Map<string, Set<string>>();
  const oldToNew = new Map<string, Set<string>>();
  const newToOld = new Map<string, Set<string>>();

  for (const token of [...tokens].sort()) {
    const oldS = effective(token, seedResolver);
    const newS = effective(token, registryResolver);
    resolutions.push({ token, old: oldS, new: newS });
    if (!oldToTokens.has(oldS)) oldToTokens.set(oldS, new Set());
    oldToTokens.get(oldS)!.add(token);
    if (!oldToNew.has(oldS)) oldToNew.set(oldS, new Set());
    oldToNew.get(oldS)!.add(newS);
    if (!newToOld.has(newS)) newToOld.set(newS, new Set());
    newToOld.get(newS)!.add(oldS);
  }

  // SPLIT: one old canonical maps to >1 new canonical (group fragmented).
  const splits: SplitFinding[] = [];
  for (const [oldC, news] of oldToNew) {
    if (news.size > 1) {
      splits.push({
        old_canonical: oldC,
        new_canonicals: [...news].sort(),
        tokens: [...(oldToTokens.get(oldC) ?? [])].sort(),
      });
    }
  }
  // MERGE: one new canonical receives tokens from >1 old canonical (knowledge mixed).
  const merges: MergeFinding[] = [];
  for (const [newC, olds] of newToOld) {
    if (olds.size > 1) {
      const toks = resolutions.filter((r) => r.new === newC).map((r) => r.token).sort();
      merges.push({ new_canonical: newC, old_canonicals: [...olds].sort(), tokens: toks });
    }
  }

  const changes = resolutions.filter((r) => r.old !== r.new).sort((a, b) => a.token.localeCompare(b.token));

  const critical: CriticalResult[] = CRITICAL_TOKENS.map(({ token, expect }) => {
    const actual = effective(token, registryResolver);
    return { token, expected: expect, actual, pass: actual === expect };
  });
  const critical_failures = critical.filter((c) => !c.pass);

  const pass = merges.length === 0 && splits.length === 0 && critical_failures.length === 0;

  return {
    tool: "no-loss-gate",
    neurons_dir: opts.neuronsDir,
    registry_path: reg.path,
    total_tokens: tokens.size,
    changes,
    merges,
    splits,
    critical,
    critical_failures,
    pass,
  };
}

export function renderMarkdown(r: NoLossGateReport): string {
  const L: string[] = [];
  L.push(`# No-Loss Gate`);
  L.push("");
  L.push(`Result: **${r.pass ? "PASS ✅" : "FAIL ❌"}**`);
  L.push("");
  L.push(`- Registry: \`${r.registry_path}\``);
  L.push(`- Tokens checked: ${r.total_tokens}`);
  L.push(`- Relabels (allowed): ${r.changes.length} · Merges: ${r.merges.length} · Splits: ${r.splits.length} · Critical failures: ${r.critical_failures.length}`);
  L.push("");
  L.push(`## Relabels (old → new, informational)`);
  L.push("");
  if (r.changes.length === 0) L.push(`_None._`);
  else {
    L.push(`| token | old | new |`);
    L.push(`|---|---|---|`);
    for (const c of r.changes) L.push(`| ${c.token} | ${c.old} | ${c.new} |`);
  }
  L.push("");
  L.push(`## Merges (FAIL if any)`);
  L.push("");
  if (r.merges.length === 0) L.push(`_None._`);
  else for (const m of r.merges) L.push(`- new \`${m.new_canonical}\` ← old {${m.old_canonicals.join(", ")}} via [${m.tokens.join(", ")}]`);
  L.push("");
  L.push(`## Splits (FAIL if any)`);
  L.push("");
  if (r.splits.length === 0) L.push(`_None._`);
  else for (const s of r.splits) L.push(`- old \`${s.old_canonical}\` → new {${s.new_canonicals.join(", ")}} via [${s.tokens.join(", ")}]`);
  L.push("");
  L.push(`## Critical tokens`);
  L.push("");
  L.push(`| token | expected | actual | pass |`);
  L.push(`|---|---|---|---|`);
  for (const c of r.critical) L.push(`| ${c.token} | ${c.expected} | ${c.actual} | ${c.pass ? "✅" : "❌"} |`);
  L.push("");
  return L.join("\n");
}

// ── CLI wrapper (read-only; report → stdout, progress → stderr) ──────────────

interface CliOptions {
  factoryRoot: string;
  neuronsDir?: string;
  registryPath: string;
  format: "json" | "md";
  help?: boolean;
}

const USAGE = `usage:
  node dist/no-loss-gate-cli.js --factory-root <dir> --registry <projects.json> [--neurons-dir <dir>] [--format json|md]

Read-only. Proves registry-vs-seed scope resolution preserves the corpus token
partition (no merges/splits) and the critical tokens. Report → STDOUT, progress →
STDERR. Exit 0 = PASS, 1 = FAIL or error. Use 'node dist/...' for clean stdout.`;

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { factoryRoot: "", registryPath: "", format: "json" };
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--factory-root") o.factoryRoot = need(++i, a);
    else if (a === "--neurons-dir") o.neuronsDir = need(++i, a);
    else if (a === "--registry") o.registryPath = need(++i, a);
    else if (a === "--format") {
      const raw = need(++i, a).toLowerCase();
      if (raw !== "json" && raw !== "md" && raw !== "markdown") throw new Error(`--format must be one of json|md|markdown (got "${raw}")`);
      o.format = raw === "markdown" ? "md" : (raw as "json" | "md");
    } else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function main(): void {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[no-loss-gate] ${(e as Error).message}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }
  if (opts.help) {
    console.error(USAGE);
    process.exit(0);
    return;
  }
  if (!opts.factoryRoot && !opts.neuronsDir) {
    console.error(`[no-loss-gate] --factory-root (or --neurons-dir) is required`);
    console.error(USAGE);
    process.exit(1);
    return;
  }
  if (!opts.registryPath) {
    console.error(`[no-loss-gate] --registry <projects.json> is required`);
    console.error(USAGE);
    process.exit(1);
    return;
  }
  const neuronsDir = opts.neuronsDir ?? join(opts.factoryRoot, "neurons");
  if (!existsSync(neuronsDir)) {
    console.error(`[no-loss-gate] neurons dir not found: '${neuronsDir}'`);
    process.exit(1);
    return;
  }
  let report: NoLossGateReport;
  try {
    report = runNoLossGate({ neuronsDir, registryPath: opts.registryPath });
  } catch (e) {
    console.error(`[no-loss-gate] ${(e as Error).message}`);
    process.exit(1);
    return;
  }
  console.error(
    `[no-loss-gate] ${report.pass ? "PASS" : "FAIL"} tokens=${report.total_tokens} ` +
      `relabels=${report.changes.length} merges=${report.merges.length} splits=${report.splits.length} ` +
      `critical_failures=${report.critical_failures.length}`,
  );
  process.stdout.write(opts.format === "md" ? renderMarkdown(report) + "\n" : JSON.stringify(report, null, 2) + "\n");
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
