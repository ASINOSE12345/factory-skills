#!/usr/bin/env node

/**
 * factory-neurons — MCP Server for persistent AI agent memory
 *
 * Exposes the neuron system (errors, decisions, patterns, foundations)
 * as MCP tools that any AI agent can query and update.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  resolveNeuronsDir,
  ensureNeuronsDir,
  searchNeurons,
  createNeuron,
  updatePatternCounter,
  getStats,
  formatBootstrap,
  listNeurons,
  getRecentNeurons,
  toBreadcrumb,
  type NeuronCategory,
} from "./neurons.js";

const VERSION = "0.1.0";

// Resolve neurons directory from args or env
const projectRoot = process.argv[2] || process.env.FACTORY_ROOT || process.cwd();
const resolvedDir = resolveNeuronsDir(projectRoot);

if (!resolvedDir) {
  console.error(
    `ERROR: No neurons/ directory found from ${projectRoot}.\n` +
    `Create it with: mkdir -p neurons/{errors,decisions,patterns,foundations}\n` +
    `Or pass the project root as argument: factory-neurons /path/to/project`
  );
  process.exit(1);
}

const neuronsDir: string = resolvedDir;

// Ensure directory structure
ensureNeuronsDir(neuronsDir);

console.error(`[factory-neurons] v${VERSION} — neurons at: ${neuronsDir}`);

// ─── Server Setup ────────────────────────────────────────────

const server = new McpServer({
  name: "factory-neurons",
  version: VERSION,
});

// ─── Helper ──────────────────────────────────────────────────

function wrapResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function neuronError(code: string, message: string, hint?: string) {
  return wrapResult({ error: true, code, message, hint });
}

// ─── Tools ───────────────────────────────────────────────────

const CATEGORIES = ["errors", "decisions", "patterns", "foundations"] as const;

/**
 * TOOL: search_neurons
 * Search across all neurons by keyword. Returns scored results.
 */
server.tool(
  "search_neurons",
  "Search neurons by keyword across titles, content, domains, and tags. " +
  "Use this BEFORE implementing anything — check if a similar error, decision, or pattern already exists.",
  {
    query: z.string().describe("Search query (keywords, error message, domain, etc.)"),
    category: z.enum(CATEGORIES).optional().describe("Filter by category: errors, decisions, patterns, foundations"),
    limit: z.number().optional().default(10).describe("Max results to return (default: 10)"),
  },
  async ({ query, category, limit }) => {
    try {
      const results = searchNeurons(neuronsDir, query, category as NeuronCategory | undefined);
      const limited = results.slice(0, limit ?? 10);

      return wrapResult({
        total_matches: results.length,
        showing: limited.length,
        results: limited.map((n) => ({
          id: n.filename.replace(".md", ""),
          category: n.category,
          title: n.title,
          status: n.frontmatter.status ?? "new",
          occurrences: n.frontmatter.occurrences ?? 1,
          domain: n.frontmatter.domain ?? null,
          severity: n.frontmatter.severity ?? null,
          created: n.frontmatter.created ?? n.frontmatter.date ?? null,
          content_preview: n.content.slice(0, 300).trim(),
        })),
      });
    } catch (e) {
      return neuronError("SEARCH_FAILED", String(e));
    }
  }
);

/**
 * TOOL: get_neuron
 * Read the full content of a specific neuron by ID.
 */
server.tool(
  "get_neuron",
  "Read the full content of a specific neuron. Use after search_neurons to get details.",
  {
    id: z.string().describe("Neuron ID, e.g. NE-045, ND-012, NP-003, NF-010"),
  },
  async ({ id }) => {
    try {
      // Determine category from prefix
      const prefixMap: Record<string, NeuronCategory> = {
        NE: "errors",
        ND: "decisions",
        NP: "patterns",
        NF: "foundations",
      };
      const prefix = id.split("-")[0];
      const category = prefixMap[prefix];
      if (!category) {
        return neuronError("INVALID_ID", `Unknown neuron prefix: ${prefix}`, "Use NE, ND, NP, or NF prefix");
      }

      const all = listNeurons(neuronsDir, category);
      const neuron = all.find((n) => n.filename === `${id}.md`);

      if (!neuron) {
        return neuronError("NOT_FOUND", `Neuron ${id} not found in ${category}/`);
      }

      return wrapResult({
        id,
        category: neuron.category,
        title: neuron.title,
        frontmatter: neuron.frontmatter,
        content: neuron.content,
        modified: neuron.modified.toISOString(),
      });
    } catch (e) {
      return neuronError("READ_FAILED", String(e));
    }
  }
);

/**
 * TOOL: create_neuron
 * Create a new neuron (error, decision, pattern, or foundation).
 */
server.tool(
  "create_neuron",
  "Create a new neuron to capture learned knowledge. " +
  "Use after encountering an error, making a decision, spotting a pattern, or defining a principle.",
  {
    category: z.enum(CATEGORIES).describe("Neuron type: errors (NE), decisions (ND), patterns (NP), foundations (NF)"),
    title: z.string().describe("Short descriptive title (e.g. 'Null value violates not-null constraint')"),
    body: z.string().describe(
      "Markdown body with sections. For errors: What happened, Root cause, Fix applied, Rule learned. " +
      "For decisions: Context, Alternatives considered, Decision, Result. " +
      "For patterns: When, Symptom, Why, Detect BEFORE, Fix, Evidence."
    ),
    domain: z.string().optional().describe("Domain/area (e.g. 'database', 'auth', 'deployment')"),
    severity: z.enum(["p0", "p1", "p2", "p3"]).optional().describe("Severity (for errors)"),
    project: z.string().optional().describe("Project name"),
    component: z.string().optional().describe("Component or module"),
  },
  async ({ category, title, body, domain, severity, project, component }) => {
    try {
      const overrides: Record<string, unknown> = {};
      if (domain) overrides.domain = domain;
      if (severity) overrides.severity = severity;
      if (project) overrides.project = project;
      if (component) overrides.component = component;

      const neuron = createNeuron(
        neuronsDir,
        category as NeuronCategory,
        title,
        body,
        overrides
      );

      return wrapResult({
        created: true,
        id: neuron.filename.replace(".md", ""),
        filepath: neuron.filepath,
        category: neuron.category,
        title: neuron.title,
      });
    } catch (e) {
      return neuronError("CREATE_FAILED", String(e));
    }
  }
);

/**
 * TOOL: update_pattern_counter
 * Record a hit or miss for a pattern neuron. Drives lifecycle gates.
 */
server.tool(
  "update_pattern_counter",
  "Record a pattern hit (the pattern was relevant and helped) or miss (it was recalled but didn't apply). " +
  "This drives automatic lifecycle: 3+ hits → validated, 7+ hits → graduated, 25 idle sessions → archived.",
  {
    pattern_id: z.string().describe("Pattern ID, e.g. NP-003"),
    action: z.enum(["hit", "miss"]).describe("hit = pattern helped, miss = pattern was recalled but didn't apply"),
  },
  async ({ pattern_id, action }) => {
    try {
      const result = updatePatternCounter(neuronsDir, pattern_id, action);
      return wrapResult({
        pattern_id,
        action,
        ...result,
        lifecycle_note:
          result.status === "validated"
            ? "Pattern promoted to VALIDATED — it has proven its value"
            : result.status === "graduated"
            ? "Pattern promoted to GRADUATED — it is now a team rule"
            : null,
      });
    } catch (e) {
      return neuronError("UPDATE_FAILED", String(e), "Verify the pattern ID exists in neurons/patterns/");
    }
  }
);

/**
 * TOOL: get_bootstrap
 * Get the bootstrap context — recent neurons formatted for session start injection.
 */
server.tool(
  "get_bootstrap",
  "Get recent neurons formatted for session bootstrap. " +
  "Call this at the START of every session to load prior knowledge. " +
  "Returns breadcrumbs (compact 1-line summaries) of the N most recent neurons per category.",
  {
    count: z.number().optional().default(5).describe("Number of recent neurons per category (default: 5)"),
  },
  async ({ count }) => {
    try {
      const bootstrap = formatBootstrap(neuronsDir, count ?? 5);
      const stats = getStats(neuronsDir);

      return wrapResult({
        bootstrap_context: bootstrap,
        stats: {
          total_neurons: stats.total,
          errors: stats.errors,
          decisions: stats.decisions,
          patterns: stats.patterns,
          foundations: stats.foundations,
        },
        instruction: "Read this context before taking any action. These neurons contain prior knowledge from previous sessions.",
      });
    } catch (e) {
      return neuronError("BOOTSTRAP_FAILED", String(e));
    }
  }
);

/**
 * TOOL: get_stats
 * Get aggregate statistics about the neuron system.
 */
server.tool(
  "get_stats",
  "Get aggregate stats: neuron counts per type, domains, total. " +
  "Use for overview of the knowledge base.",
  {},
  async () => {
    try {
      const stats = getStats(neuronsDir);
      return wrapResult(stats);
    } catch (e) {
      return neuronError("STATS_FAILED", String(e));
    }
  }
);

/**
 * TOOL: list_patterns
 * List all patterns with their lifecycle status and counters.
 */
server.tool(
  "list_patterns",
  "List all pattern neurons with hit/miss counters and lifecycle status. " +
  "Use during session close to review which patterns were relevant.",
  {},
  async () => {
    try {
      const patterns = listNeurons(neuronsDir, "patterns");
      return wrapResult({
        total: patterns.length,
        patterns: patterns.map((p) => ({
          id: p.filename.replace(".md", ""),
          title: p.title,
          status: p.frontmatter.status ?? "new",
          hits: p.frontmatter.hits ?? 0,
          misses: p.frontmatter.misses ?? 0,
          sessions_seen: p.frontmatter.sessions_seen ?? 0,
          last_hit: p.frontmatter.last_hit ?? null,
          domain: p.frontmatter.domain ?? null,
        })),
      });
    } catch (e) {
      return neuronError("LIST_FAILED", String(e));
    }
  }
);

// ─── Start ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[factory-neurons] Server running — ${getStats(neuronsDir).total} neurons loaded`);
}

main().catch((err) => {
  console.error("[factory-neurons] Fatal:", err);
  process.exit(1);
});
