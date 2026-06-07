/**
 * no-loss-gate-cli — READ-ONLY safety contract guarding the registry as the alias
 * source of truth.
 *
 * As of PR-3C-e the live `neurons.ts` resolver IS registry-aware
 * (`canonicalProject`/`isGlobalScope` = registry → external → seed). This gate is
 * the ongoing guard for that wiring (and for the future seed reduction, PR-3C-f):
 * it proves that resolving scope via "registry alias → seed fallback" does NOT
 * lose or mis-group knowledge versus the pre-registry seed behavior.
 *
 * To keep its teeth, the gate must NOT compare the live resolver against itself.
 * So it deliberately uses the registry-INDEPENDENT legacy resolvers
 * (`canonicalProjectLegacy`/`isGlobalScopeLegacy`, seed + external, no registry)
 * for the baseline — otherwise `old` and `new` would both be registry-driven and
 * the comparison would be meaningless. It resolves each token TWO ways:
 *       old  = legacy seed behavior   (isGlobalScopeLegacy → "global", else canonicalProjectLegacy)
 *       new  = registry alias → legacy fallback   (what the wired live resolver does)
 *
 *   - PARTITION: tokens grouped together under `old` must stay together under
 *     `new` (no SPLIT), and different `old` groups must never collapse into one
 *     `new` group (no MERGE).
 *   - RELABELS: any `old !== new` transition must be on an explicit allowlist
 *     (`DEFAULT_ALLOWED_RELABELS`, overridable). Anything else is an
 *     `unexpected_relabel` → FAIL. (A relabel keeps grouping but changes the
 *     canonical label, e.g. `factoryos` → `factory-os`.)
 *   - UNKNOWN REGRESSIONS: a token that resolved to a recognized project/global
 *     under `old` must not fall back to its raw, unrecognized form under `new`.
 *   - CRITICAL: an explicit set of tokens must resolve to expected values.
 *
 * The `seedFallback` knob models the future seed-less mode (PR-3C-f): with it
 * OFF, `new` resolution does NOT consult the (legacy) seed, so the gate reveals
 * exactly which tokens would regress if the seed were removed. GLOBAL_SCOPE_TOKENS
 * resolution is registry-independent and identical in both modes.
 *
 * Zero writes. Never touches the corpus. Imports `neurons.ts` helpers READ-ONLY
 * and uses the legacy resolvers, so running this gate never changes the live MCP
 * scope resolution.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listNeurons, canonicalProjectLegacy, isGlobalScopeLegacy } from "./neurons.js";
import { toolMetadata, toolMetadataMarkdown } from "./tool-metadata.js";
import { loadRegistry, normalizeToken, type LoadedRegistry } from "./registry.js";

/** A canonical-label transition that is KNOWN and intentional. Data, not magic
 *  strings: extend this (or pass `allowedRelabels`) when the registry renames a
 *  canonical on purpose — each addition is an explicit, reviewable decision. */
export interface AllowedRelabel {
  from: string;
  to: string;
}
export const DEFAULT_ALLOWED_RELABELS: ReadonlyArray<AllowedRelabel> = [
  // The registry defines project_id `factory-os`; the seed only had the
  // self-normalized `factoryos`. Same group, intentional relabel.
  { from: "factoryos", to: "factory-os" },
];

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
  seed_fallback: boolean;
  total_tokens: number;
  allowed_relabels: TokenResolution[]; // old != new, on the allowlist (informational)
  unexpected_relabels: TokenResolution[]; // old != new, NOT on the allowlist → FAIL
  unknown_regressions: TokenResolution[]; // recognized under old, raw/unrecognized under new → FAIL
  merges: MergeFinding[]; // distinct old groups collapsing → FAIL
  splits: SplitFinding[]; // one old group fragmenting → FAIL
  critical: CriticalResult[];
  critical_failures: CriticalResult[];
  pass: boolean;
}

/**
 * Legacy (seed + external, registry-INDEPENDENT) resolution. This is the baseline
 * the gate compares against. It uses the `*Legacy` resolvers ON PURPOSE: now that
 * the live `canonicalProject`/`isGlobalScope` are registry-aware, using them here
 * would make `old` and `new` both registry-driven and the gate would lose its
 * teeth. The legacy resolvers preserve the pre-registry behavior.
 */
function resolveOld(token: string): string {
  return isGlobalScopeLegacy(token) ? "global" : canonicalProjectLegacy(token);
}
/**
 * Registry-primary resolution using the EXPLICIT `--registry` argument; falls back
 * to the legacy (seed) resolver only when enabled (`--no-seed-fallback` models the
 * future seed-less mode). Globality is decided by the registry-independent legacy
 * check, so the gate stays deterministic and never mixes two registry sources.
 */
function resolveNew(token: string, reg: LoadedRegistry, seedFallback: boolean): string {
  if (isGlobalScopeLegacy(token)) return "global";
  const a = reg.aliasToProject.get(normalizeToken(token));
  if (a) return a;
  return seedFallback ? canonicalProjectLegacy(token) : normalizeToken(token);
}
/** A scope is "recognized" if it is global or it matched an alias/canonical
 *  (i.e. it is NOT just the raw normalized token). */
function isResolved(token: string, scope: string): boolean {
  return scope === "global" || scope !== normalizeToken(token);
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
  /** Allowed canonical relabels (default DEFAULT_ALLOWED_RELABELS). */
  allowedRelabels?: ReadonlyArray<AllowedRelabel>;
  /** Whether `new` resolution may fall back to the seed (default true). Set false
   *  to model the seed-less mode and reveal regressions PR-3C-f would cause. */
  seedFallback?: boolean;
  /** Extra tokens to check beyond the corpus + critical set. */
  extraTokens?: string[];
}

export function runNoLossGate(opts: NoLossGateOptions): NoLossGateReport {
  const reg: LoadedRegistry = loadRegistry(opts.registryPath); // fail-closed on a bad registry
  const seedFallback = opts.seedFallback !== false;
  const allow = opts.allowedRelabels ?? DEFAULT_ALLOWED_RELABELS;
  const isAllowed = (old: string, nw: string): boolean => allow.some((a) => a.from === old && a.to === nw);

  const tokens = new Set<string>(collectCorpusTokens(opts.neuronsDir));
  for (const c of CRITICAL_TOKENS) tokens.add(c.token);
  for (const t of opts.extraTokens ?? []) tokens.add(t);

  const resolutions: TokenResolution[] = [];
  const oldToTokens = new Map<string, Set<string>>();
  const oldToNew = new Map<string, Set<string>>();
  const newToOld = new Map<string, Set<string>>();
  const allowed_relabels: TokenResolution[] = [];
  const unexpected_relabels: TokenResolution[] = [];
  const unknown_regressions: TokenResolution[] = [];

  for (const token of [...tokens].sort()) {
    const oldS = resolveOld(token);
    const newS = resolveNew(token, reg, seedFallback);
    const res: TokenResolution = { token, old: oldS, new: newS };
    resolutions.push(res);

    if (oldS !== newS) {
      (isAllowed(oldS, newS) ? allowed_relabels : unexpected_relabels).push(res);
    }
    if (isResolved(token, oldS) && !isResolved(token, newS)) {
      unknown_regressions.push(res);
    }

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
      splits.push({ old_canonical: oldC, new_canonicals: [...news].sort(), tokens: [...(oldToTokens.get(oldC) ?? [])].sort() });
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

  const critical: CriticalResult[] = CRITICAL_TOKENS.map(({ token, expect }) => {
    const actual = resolveNew(token, reg, seedFallback);
    return { token, expected: expect, actual, pass: actual === expect };
  });
  const critical_failures = critical.filter((c) => !c.pass);

  const sortRes = (a: TokenResolution, b: TokenResolution): number => a.token.localeCompare(b.token);
  const pass =
    merges.length === 0 &&
    splits.length === 0 &&
    critical_failures.length === 0 &&
    unexpected_relabels.length === 0 &&
    unknown_regressions.length === 0;

  return {
    tool: "no-loss-gate",
    neurons_dir: opts.neuronsDir,
    registry_path: reg.path,
    seed_fallback: seedFallback,
    total_tokens: tokens.size,
    allowed_relabels: allowed_relabels.sort(sortRes),
    unexpected_relabels: unexpected_relabels.sort(sortRes),
    unknown_regressions: unknown_regressions.sort(sortRes),
    merges,
    splits,
    critical,
    critical_failures,
    pass,
  };
}

export function renderMarkdown(r: NoLossGateReport): string {
  const L: string[] = [];
  const tbl = (rows: TokenResolution[]): void => {
    L.push(`| token | old | new |`);
    L.push(`|---|---|---|`);
    for (const x of rows) L.push(`| ${x.token} | ${x.old} | ${x.new} |`);
  };
  L.push(`# No-Loss Gate`);
  L.push("");
  L.push(`Result: **${r.pass ? "PASS ✅" : "FAIL ❌"}**  (seed_fallback=${r.seed_fallback})`);
  L.push("");
  L.push(`- Registry: \`${r.registry_path}\``);
  L.push(`- Tokens: ${r.total_tokens} · allowed relabels: ${r.allowed_relabels.length} · unexpected: ${r.unexpected_relabels.length} · unknown regressions: ${r.unknown_regressions.length} · merges: ${r.merges.length} · splits: ${r.splits.length} · critical failures: ${r.critical_failures.length}`);
  L.push("");
  L.push(`## Allowed relabels (on allowlist — informational)`);
  L.push("");
  if (r.allowed_relabels.length === 0) L.push(`_None._`);
  else tbl(r.allowed_relabels);
  L.push("");
  L.push(`## Unexpected relabels (FAIL if any)`);
  L.push("");
  if (r.unexpected_relabels.length === 0) L.push(`_None._`);
  else tbl(r.unexpected_relabels);
  L.push("");
  L.push(`## Unknown regressions (FAIL if any)`);
  L.push("");
  if (r.unknown_regressions.length === 0) L.push(`_None._`);
  else tbl(r.unknown_regressions);
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
  seedFallback: boolean;
  help?: boolean;
}

const USAGE = `usage:
  node dist/no-loss-gate-cli.js --factory-root <dir> --registry <projects.json> [--neurons-dir <dir>] [--no-seed-fallback] [--format json|md]

Read-only. Proves registry-vs-seed scope resolution preserves the corpus token
partition (no merges/splits), allows only allowlisted relabels, has no unknown
regressions, and resolves the critical tokens. --no-seed-fallback models the
seed-less mode (PR-3C-f). Report → STDOUT, progress → STDERR. Exit 0 = PASS,
1 = FAIL or error. Use 'node dist/...' for clean stdout.`;

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { factoryRoot: "", registryPath: "", format: "json", seedFallback: true };
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
    else if (a === "--no-seed-fallback") o.seedFallback = false;
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
    report = runNoLossGate({ neuronsDir, registryPath: opts.registryPath, seedFallback: opts.seedFallback });
  } catch (e) {
    console.error(`[no-loss-gate] ${(e as Error).message}`);
    process.exit(1);
    return;
  }
  console.error(
    `[no-loss-gate] ${report.pass ? "PASS" : "FAIL"} (seed_fallback=${report.seed_fallback}) tokens=${report.total_tokens} ` +
      `allowed=${report.allowed_relabels.length} unexpected=${report.unexpected_relabels.length} ` +
      `unknown_reg=${report.unknown_regressions.length} merges=${report.merges.length} splits=${report.splits.length} ` +
      `critical_failures=${report.critical_failures.length}`,
  );
  // Attach run/trace metadata at the OUTPUT layer (the pure runNoLossGate report
  // is unchanged; metadata describes the run, not the analysis).
  const meta = toolMetadata();
  process.stdout.write(
    opts.format === "md"
      ? renderMarkdown(report) + toolMetadataMarkdown(report.tool, meta) + "\n"
      : JSON.stringify({ ...report, ...meta }, null, 2) + "\n",
  );
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
