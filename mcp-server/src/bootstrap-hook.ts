#!/usr/bin/env node

/**
 * Bootstrap hook for Claude Code SessionStart events.
 * Outputs neuron context as additionalContext for the session.
 *
 * Usage in hooks.json:
 *   "SessionStart": [{ "matcher": "startup|resume|compact",
 *     "hooks": [{ "type": "command", "command": "node bootstrap-hook.js /path/to/project" }]
 *   }]
 */

import { resolveNeuronsDir, formatBootstrap, getStats } from "./neurons.js";

const projectRoot = process.argv[2] || process.env.FACTORY_ROOT || process.cwd();
const neuronsDir = resolveNeuronsDir(projectRoot);

if (!neuronsDir) {
  // No neurons directory — output nothing (don't block session)
  process.exit(0);
}

const stats = getStats(neuronsDir);

if (stats.total === 0) {
  // Empty knowledge base — output a hint
  console.log(
    "Neuron system active but empty. Create your first neuron with:\n" +
    "  search_neurons → check existing knowledge\n" +
    "  create_neuron → capture errors, decisions, patterns"
  );
  process.exit(0);
}

// Output bootstrap context — Claude Code captures stdout as additionalContext
const bootstrap = formatBootstrap(neuronsDir, 5);
console.log(bootstrap);
console.log(`\n---\nKnowledge base: ${stats.total} neurons (NE:${stats.errors} ND:${stats.decisions} NP:${stats.patterns} NF:${stats.foundations})`);
console.log("Use search_neurons before implementing. Use create_neuron to capture new knowledge.");
