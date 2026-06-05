#!/usr/bin/env node
/**
 * Generate the local .mcp.json (factory-neurons entry) and Claude settings.json
 * hook commands from declarative inputs. DRY-RUN by default; real write needs
 * --write (and backs up first). No absolute paths are baked in — pass them.
 *
 *   node scripts/gen-local-config.mjs \
 *     --factory-root <dir> --runtime-root <dir> \
 *     [--node-bin <path>] [--mcp-config <path>] [--claude-settings <path>] [--write]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { runGenerate } from "../dist/local-config.js";

function parse(argv) {
  const o = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--factory-root") o.factoryRoot = argv[++i];
    else if (a === "--runtime-root") o.runtimeRoot = argv[++i];
    else if (a === "--node-bin") o.nodeBin = argv[++i];
    else if (a === "--mcp-config") o.mcpPath = argv[++i];
    else if (a === "--claude-settings") o.settingsPath = argv[++i];
    else if (a === "--write") o.write = true;
  }
  return o;
}

const o = parse(process.argv.slice(2));
if (!o.factoryRoot || !o.runtimeRoot) {
  console.error("usage: gen-local-config --factory-root <dir> --runtime-root <dir> [--node-bin p] [--mcp-config p] [--claude-settings p] [--write]");
  process.exit(1);
}
o.mcpPath = o.mcpPath || join(o.factoryRoot, ".mcp.json");
o.settingsPath = o.settingsPath || join(homedir(), ".claude", "settings.json");

const res = runGenerate(o);
for (const line of res.summary) console.error(`[gen-config] ${line}`);
process.exit(0);
