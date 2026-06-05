#!/usr/bin/env node
/**
 * Validate the local .mcp.json + Claude settings.json (read-only). Checks: valid
 * JSON, no secrets, no CP3/live-write env, factory-neurons → launcher (exists),
 * runtime dist hooks present, factory root exists, factory-code-graph preserved.
 * Exit 1 on any error. Never prints secrets.
 *
 *   node scripts/validate-local-config.mjs --factory-root <dir> --runtime-root <dir>
 *     [--mcp-config <path>] [--claude-settings <path>]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { runValidate } from "../dist/local-config.js";

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--factory-root") o.factoryRoot = argv[++i];
    else if (a === "--runtime-root") o.runtimeRoot = argv[++i];
    else if (a === "--mcp-config") o.mcpPath = argv[++i];
    else if (a === "--claude-settings") o.settingsPath = argv[++i];
  }
  return o;
}

const o = parse(process.argv.slice(2));
if (!o.factoryRoot || !o.runtimeRoot) {
  console.error("usage: validate-local-config --factory-root <dir> --runtime-root <dir> [--mcp-config p] [--claude-settings p]");
  process.exit(1);
}
o.mcpPath = o.mcpPath || join(o.factoryRoot, ".mcp.json");
o.settingsPath = o.settingsPath || join(homedir(), ".claude", "settings.json");

const res = runValidate(o);
for (const c of res.checks) console.error(`[validate-config] OK: ${c}`);
for (const e of res.errors) console.error(`[validate-config] ERROR: ${e}`);
console.error(`[validate-config] ${res.ok ? "PASS" : "FAIL"} (${res.errors.length} error(s))`);
process.exit(res.ok ? 0 : 1);
