/**
 * local-config — generate/validate the LOCAL deployment config (.mcp.json and the
 * Claude settings.json hook commands) from declarative inputs, so those files
 * become reproducible artifacts instead of hand-maintained source-of-truth.
 *
 * Principles:
 *  - No absolute paths are baked into this source; everything comes from opts/env.
 *  - Node binary is resolved dynamically (never a pinned nvm version): explicit
 *    --node-bin → FACTORY_NODE_BIN → process.execPath.
 *  - Foreign entries are preserved verbatim (factory-code-graph in .mcp.json,
 *    unrelated hooks like claude-snapshot-loader in settings.json).
 *  - Default is DRY-RUN; a real write requires the explicit flag and backs up first.
 *  - Validation never prints secrets; it only reports counts/flags.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface GenOpts {
  nodeBin: string;
  runtimeRoot: string;
  factoryRoot: string;
}

/** Node binary resolution — never a pinned version in source. */
export function resolveNodeBin(opts: { nodeBin?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env;
  return opts.nodeBin || env.FACTORY_NODE_BIN || process.execPath;
}

/** The factory-neurons MCP entry — points at the secure launcher, never the key. */
export function factoryNeuronsEntry(o: GenOpts): { command: string; args: string[] } {
  return {
    command: o.nodeBin,
    args: [join(o.runtimeRoot, "mcp-server", "bin", "factory-neurons-with-gemini.mjs"), o.factoryRoot],
  };
}

/** Replace ONLY mcpServers["factory-neurons"]; everything else (factory-code-graph…) preserved. */
export function applyMcpConfig(existing: unknown, o: GenOpts): Record<string, unknown> {
  const base = existing && typeof existing === "object" ? structuredClone(existing as Record<string, unknown>) : {};
  const servers = (base.mcpServers && typeof base.mcpServers === "object" ? base.mcpServers : {}) as Record<string, unknown>;
  servers["factory-neurons"] = factoryNeuronsEntry(o);
  base.mcpServers = servers;
  return base;
}

/** Hook scripts this tool owns. bootstrap takes the factory root; the rest take none. */
const FACTORY_HOOKS: Record<string, boolean> = {
  "bootstrap-hook.js": true, // needs factoryRoot arg
  "iron-gates.js": false,
  "plan-gate.js": false,
  "auto-capture.js": false,
};

/** Rebuild a hook command IF it is one of our factory hooks; otherwise return it
 *  unchanged (foreign hooks like claude-snapshot-loader are preserved verbatim). */
export function rebuildHookCommand(command: string, o: GenOpts): string {
  for (const [base, needsRoot] of Object.entries(FACTORY_HOOKS)) {
    if (command.includes(base)) {
      const script = join(o.runtimeRoot, "mcp-server", "dist", base);
      return needsRoot ? `${o.nodeBin} ${script} ${o.factoryRoot}` : `${o.nodeBin} ${script}`;
    }
  }
  return command;
}

/** Walk settings.hooks.<event>[].hooks[].command, rebuilding only our factory hooks. */
export function applySettings(existing: unknown, o: GenOpts): Record<string, unknown> {
  const base = existing && typeof existing === "object" ? structuredClone(existing as Record<string, unknown>) : {};
  const hooks = base.hooks as Record<string, unknown> | undefined;
  if (hooks && typeof hooks === "object") {
    for (const event of Object.keys(hooks)) {
      const arr = hooks[event];
      if (!Array.isArray(arr)) continue;
      for (const matcher of arr) {
        const hookList = (matcher as { hooks?: unknown }).hooks;
        if (!Array.isArray(hookList)) continue;
        for (const h of hookList) {
          const entry = h as { command?: unknown };
          if (typeof entry.command === "string") entry.command = rebuildHookCommand(entry.command, o);
        }
      }
    }
  }
  return base;
}

/** Collect every hook command string from a Claude settings object (any event). */
export function collectHookCommands(settings: unknown): string[] {
  const out: string[] = [];
  const hooks = (settings as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (hooks && typeof hooks === "object") {
    for (const event of Object.keys(hooks)) {
      const arr = hooks[event];
      if (!Array.isArray(arr)) continue;
      for (const matcher of arr) {
        const hookList = (matcher as { hooks?: unknown }).hooks;
        if (!Array.isArray(hookList)) continue;
        for (const h of hookList) {
          const cmd = (h as { command?: unknown }).command;
          if (typeof cmd === "string") out.push(cmd);
        }
      }
    }
  }
  return out;
}

// ── Validation (never prints secrets) ────────────────────────────────────────

const SECRET_RE = /AIza|GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|sk-ant-|sk-[A-Za-z0-9]{16}|gh[pousr]_|xox[baprs]-/;
const FORBIDDEN_ENV_RE = /FACTORY_STAGING_DIR|FACTORY_ALLOW_LIVE_WRITES/;

/** Pure text checks on raw config: no secrets, no CP3/live-write env, valid JSON. */
export function validateConfigText(label: string, raw: string): string[] {
  const errs: string[] = [];
  if (SECRET_RE.test(raw)) errs.push(`${label}: contains a secret-like token (keys belong in the keyfile, never in config)`);
  if (FORBIDDEN_ENV_RE.test(raw)) errs.push(`${label}: sets FACTORY_STAGING_DIR / FACTORY_ALLOW_LIVE_WRITES (CP3 must stay inert)`);
  try { JSON.parse(raw); } catch (e) { errs.push(`${label}: invalid JSON (${String((e as Error).message)})`); }
  return errs;
}

export interface GenResult {
  wrote: boolean;
  mcpPath: string;
  settingsPath: string;
  backups: string[];
  summary: string[];
}

/** Orchestrate generation. DRY-RUN unless opts.write. Operates on the GIVEN paths
 *  (tests pass temp fixtures; the real configs are only ever touched with --write). */
export function runGenerate(opts: {
  factoryRoot: string;
  runtimeRoot: string;
  mcpPath: string;
  settingsPath: string;
  nodeBin?: string;
  write?: boolean;
  env?: NodeJS.ProcessEnv;
}): GenResult {
  const nodeBin = resolveNodeBin({ nodeBin: opts.nodeBin, env: opts.env });
  const o: GenOpts = { nodeBin, runtimeRoot: opts.runtimeRoot, factoryRoot: opts.factoryRoot };
  const summary: string[] = [];
  const backups: string[] = [];

  const readJson = (p: string): unknown => (existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {});
  const nextMcp = applyMcpConfig(readJson(opts.mcpPath), o);
  const nextSettings = applySettings(readJson(opts.settingsPath), o);

  summary.push(`node-bin: ${nodeBin}`);
  summary.push(`factory-neurons → ${join(opts.runtimeRoot, "mcp-server/bin/factory-neurons-with-gemini.mjs")} ${opts.factoryRoot}`);
  summary.push(`hooks → ${join(opts.runtimeRoot, "mcp-server/dist")}/<hook>.js`);

  if (!opts.write) {
    summary.push("DRY-RUN: no files written (pass --write to apply, with backup)");
    return { wrote: false, mcpPath: opts.mcpPath, settingsPath: opts.settingsPath, backups, summary };
  }

  for (const p of [opts.mcpPath, opts.settingsPath]) {
    if (existsSync(p)) {
      const bak = `${p}.bak-pre-factory-config`;
      copyFileSync(p, bak);
      backups.push(bak);
    }
  }
  writeFileSync(opts.mcpPath, JSON.stringify(nextMcp, null, 2) + "\n", "utf-8");
  writeFileSync(opts.settingsPath, JSON.stringify(nextSettings, null, 2) + "\n", "utf-8");
  summary.push(`wrote ${opts.mcpPath} + ${opts.settingsPath}; backups: ${backups.length}`);
  return { wrote: true, mcpPath: opts.mcpPath, settingsPath: opts.settingsPath, backups, summary };
}

export interface ValidateResult { ok: boolean; errors: string[]; checks: string[]; }

/** Validate the local config files (read-only). Returns ok + errors + passed checks. */
export function runValidate(opts: {
  runtimeRoot: string;
  factoryRoot: string;
  mcpPath: string;
  settingsPath: string;
  /** Expected node binary; if set, factory hook commands must use exactly this. */
  nodeBin?: string;
}): ValidateResult {
  const errors: string[] = [];
  const checks: string[] = [];

  for (const [label, p] of [["mcp", opts.mcpPath], ["settings", opts.settingsPath]] as const) {
    if (!existsSync(p)) { errors.push(`${label}: file not found at ${p}`); continue; }
    const raw = readFileSync(p, "utf-8");
    errors.push(...validateConfigText(label, raw));
  }

  // Structural + path-existence checks (only if mcp parses).
  if (existsSync(opts.mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(opts.mcpPath, "utf-8")) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
      const fn = mcp.mcpServers?.["factory-neurons"];
      // command (the node binary) must be present AND exist on disk
      const cmd = fn?.command;
      if (!cmd) errors.push("mcp: factory-neurons has no command (node binary)");
      else if (opts.nodeBin && cmd !== opts.nodeBin) errors.push(`mcp: factory-neurons node '${cmd}' != expected '${opts.nodeBin}'`);
      else if (!existsSync(cmd)) errors.push(`mcp: factory-neurons node binary missing at ${cmd}`);
      else checks.push("factory-neurons node exists");
      // args[0] must be the launcher and exist
      const launcher = fn?.args?.[0];
      if (!launcher || !launcher.endsWith("factory-neurons-with-gemini.mjs")) {
        errors.push("mcp: factory-neurons does not point to the launcher");
      } else {
        checks.push("factory-neurons → launcher");
        if (!existsSync(launcher)) errors.push(`mcp: launcher missing at ${launcher}`);
        else checks.push("launcher exists");
      }
      // args[1] must be the factory root (resolved equality)
      const root = fn?.args?.[1];
      if (!root || resolve(root) !== resolve(opts.factoryRoot)) {
        errors.push(`mcp: factory-neurons project root '${root ?? "(none)"}' != factoryRoot '${opts.factoryRoot}'`);
      } else checks.push("factory-neurons root matches");
      if (mcp.mcpServers?.["factory-code-graph"]) checks.push("factory-code-graph preserved");
    } catch { /* JSON error already reported */ }
  }

  const dist = join(opts.runtimeRoot, "mcp-server", "dist");
  for (const h of ["bootstrap-hook.js", "iron-gates.js", "plan-gate.js", "auto-capture.js"]) {
    if (existsSync(join(dist, h))) checks.push(`dist/${h} exists`);
    else errors.push(`runtime dist missing ${h}`);
  }
  if (existsSync(opts.factoryRoot)) checks.push("factory root exists");
  else errors.push(`factory root missing: ${opts.factoryRoot}`);

  // settings.json: each factory hook must reference the EXPECTED runtime dist script
  // with an existing (or expected) node binary. Foreign hooks are ignored, not validated.
  if (existsSync(opts.settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(opts.settingsPath, "utf-8"));
      const cmds = collectHookCommands(settings);
      for (const base of ["bootstrap-hook.js", "iron-gates.js", "plan-gate.js", "auto-capture.js"]) {
        const expectedScript = join(dist, base);
        const refs = cmds.filter((c) => c.includes(base));
        if (refs.length === 0) { errors.push(`settings: no hook references ${base}`); continue; }
        const right = refs.filter((c) => c.includes(expectedScript));
        if (right.length === 0) { errors.push(`settings: ${base} hook does not point to runtime dist (${expectedScript}) — stale runtime?`); continue; }
        checks.push(`settings ${base} → runtime dist`);
        for (const c of right) {
          const nodeTok = c.trim().split(/\s+/)[0];
          if (opts.nodeBin && nodeTok !== opts.nodeBin) errors.push(`settings: ${base} node '${nodeTok}' != expected '${opts.nodeBin}'`);
          else if (!existsSync(nodeTok)) errors.push(`settings: ${base} node binary missing at ${nodeTok}`);
        }
      }
    } catch { /* JSON error already reported by validateConfigText */ }
  }

  return { ok: errors.length === 0, errors, checks };
}
