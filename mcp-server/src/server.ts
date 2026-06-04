#!/usr/bin/env node

/**
 * factory-neurons — MCP Server for persistent AI agent memory
 *
 * Exposes the neuron system (errors, decisions, patterns, foundations, business)
 * as MCP tools that any AI agent can query and update.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  resolveNeuronsDir,
  ensureNeuronsDir,
  searchNeurons,
  searchNeuronsScored,
  createNeuron,
  updatePatternCounter,
  getStats,
  formatBootstrap,
  listNeurons,
  getRecentNeurons,
  toBreadcrumb,
  type NeuronCategory,
} from "./neurons.js";
import { getNeuronVectors } from "./embeddings.js";
import { analyzeGaps } from "./gap-analysis.js";
import { dreamScan, formatMarkdown } from "./dream-scan.js";
import { reflect, formatReflectMarkdown } from "./reflect.js";

const VERSION = "0.1.0";

// Resolve neurons directory from args or env
const projectRoot = process.argv[2] || process.env.FACTORY_ROOT || process.cwd();
const resolvedDir = resolveNeuronsDir(projectRoot);

if (!resolvedDir) {
  console.error(
    `ERROR: No neurons/ directory found from ${projectRoot}.\n` +
    `Create it with: mkdir -p neurons/{errors,decisions,patterns,foundations,business}\n` +
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

const CATEGORIES = ["errors", "decisions", "patterns", "foundations", "business"] as const;

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
    category: z.enum(CATEGORIES).optional().describe("Filter by category: errors, decisions, patterns, foundations, business"),
    project: z.string().optional().describe("Filter by project scope (e.g. 'UrbanVistaCapital', 'PeopleSynapse'). Only returns neurons relevant to this project + cross-project neurons."),
    limit: z.number().optional().default(10).describe("Max results to return (default: 10)"),
  },
  async ({ query, category, limit, project }) => {
    try {
      const results = await searchNeurons(neuronsDir, query, category as NeuronCategory | undefined, project);
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
 * TOOL: think_neurons
 * Like search_neurons, but adds a deterministic gap-analysis layer: returns the
 * matching neurons AND an honest report of what the brain does NOT know yet
 * (superseded, stale, near-duplicate, unreliable, low-coverage). Inspired by
 * GBrain's `think` vs `search` split. Zero LLM calls.
 */
server.tool(
  "think_neurons",
  "Like search_neurons but with gap-analysis: returns the matching neurons AND an honest report of " +
  "what the brain does NOT know yet — superseded/dead neurons, stale (outdated) ones, near-duplicates " +
  "worth consolidating, unreliable patterns, and coverage confidence. Use when you need to TRUST the " +
  "answer, not just find pages. Deterministic, no LLM cost.",
  {
    query: z.string().describe("Search query (keywords, error message, domain, etc.)"),
    category: z.enum(CATEGORIES).optional().describe("Filter by category: errors, decisions, patterns, foundations, business"),
    project: z.string().optional().describe("Filter by project scope (e.g. 'UrbanVistaCapital', 'PeopleSynapse')"),
    limit: z.number().optional().default(8).describe("Max results to scrutinize/return (default: 8)"),
  },
  async ({ query, category, limit, project }) => {
    try {
      const k = limit ?? 8;
      const scored = await searchNeuronsScored(neuronsDir, query, category as NeuronCategory | undefined, project);
      const top = scored.slice(0, k);
      const usedSemantic = scored.some((s) => s.usedSemantic);

      // Cached vectors for the top results (cross-neuron duplicate detection, no API key needed)
      const vectors = getNeuronVectors(neuronsDir, top.map((s) => s.neuron.filename));

      const gaps = analyzeGaps({
        scored: top.map((s) => ({ neuron: s.neuron, score: s.score, semanticScore: s.semanticScore })),
        topK: k,
        vectors,
        hadProjectFilter: project != null,
        usedSemantic,
      });

      return wrapResult({
        query,
        total_matches: scored.length,
        showing: top.length,
        results: top.map((s) => ({
          id: s.neuron.filename.replace(".md", ""),
          category: s.neuron.category,
          title: s.neuron.title,
          status: s.neuron.frontmatter.status ?? "new",
          score: Number(s.score.toFixed(2)),
          semantic_similarity: s.usedSemantic ? Number(s.semanticScore.toFixed(3)) : null,
          created: s.neuron.frontmatter.created ?? s.neuron.frontmatter.date ?? null,
          content_preview: s.neuron.content.slice(0, 200).trim(),
        })),
        gaps,
      });
    } catch (e) {
      return neuronError("THINK_FAILED", String(e));
    }
  }
);

/**
 * TOOL: dream_scan
 * Read-only, deterministic, corpus-wide health scan of the WHOLE brain.
 * Reuses the gap-analysis detectors over the entire corpus (not query-driven).
 * Writes nothing — proposals only. The consolidation "cycle" (writes/issues, with
 * an opt-in LLM judge) is a separate, later phase.
 */
server.tool(
  "dream_scan",
  "Read-only corpus-wide scan of the WHOLE neuron brain (not query-driven): near-duplicates, " +
  "superseded, stale, unreliable patterns, and unknown-scope neurons. Writes nothing — proposals " +
  "only, no LLM. Use to audit knowledge-base health and surface consolidation candidates.",
  {
    threshold: z.number().min(0.8).max(1).optional().default(0.93).describe("Cosine threshold for near-duplicates, 0.8–1 (default 0.93; 0.85 is noise on this corpus)"),
    stale_days: z.number().int().min(1).optional().default(60).describe("A perishable neuron untouched longer than this is stale (default 60)"),
    max_pairs: z.number().int().min(1).max(1000).optional().default(25).describe("Max near-duplicate pairs returned, top by similarity (default 25); total_possible_duplicates reports the full count"),
    max_items: z.number().int().min(1).max(1000).optional().default(25).describe("Max items per list (stale, unknown-scope, superseded, unreliable), top by relevance (default 25); total_* reports the full count"),
    format: z.enum(["json", "markdown"]).optional().default("json").describe("Output format"),
  },
  async ({ threshold, stale_days, max_pairs, max_items, format }) => {
    try {
      const report = dreamScan(neuronsDir, {
        threshold: threshold ?? 0.93,
        staleDays: stale_days ?? 60,
        maxPairs: max_pairs ?? 25,
        maxItems: max_items ?? 25,
      });
      return format === "markdown"
        ? wrapResult({ markdown: formatMarkdown(report) })
        : wrapResult(report);
    } catch (e) {
      return neuronError("DREAM_SCAN_FAILED", String(e));
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
        NB: "business",
      };
      const prefix = id.split("-")[0];
      const category = prefixMap[prefix];
      if (!category) {
        return neuronError("INVALID_ID", `Unknown neuron prefix: ${prefix}`, "Use NE, ND, NP, NF, or NB prefix");
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
    category: z.enum(CATEGORIES).describe("Neuron type: errors (NE), decisions (ND), patterns (NP), foundations (NF), business (NB)"),
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

/**
 * TOOL: reflect_neurons
 * Self-reflection over the WHOLE brain. Cognition (detectors → findings) is
 * separated from action (planner → autonomy policy → ledger). Read-only by
 * default: proposes, never writes. Autonomy (create_*) is gated by mode +
 * explicit flags + !dry_run, and in CP2A there is no execution layer, so even
 * then nothing is written — the policy decisions are returned for audit.
 */
server.tool(
  "reflect_neurons",
  "Self-reflection over the WHOLE neuron brain (read-only by default): mirror clusters, citation-graph " +
  "integrity, contradiction candidates, self-knowledge (recurring errors without a preventive pattern), " +
  "and dogma candidates. Separates cognition (detectors→findings, with evidence/inference/recommendation) " +
  "from action (planner→policy→ledger). Returns findings AND planned_actions with their policy status. " +
  "Defaults mode=report + dry_run=true → proposes, never writes. Deterministic, no LLM.",
  {
    mode: z.enum(["report", "autonomous"]).optional().default("report").describe("report = propose only; autonomous = create_* become eligible (still gated by flags + dry_run)"),
    dry_run: z.boolean().optional().default(true).describe("When true (default) no write/issue is performed even if otherwise eligible"),
    create_issues: z.boolean().optional().default(false).describe("Explicit gate for create_issue (needs autonomous + !dry_run)"),
    write_proposed_neurons: z.boolean().optional().default(false).describe("Explicit gate for create_proposed_neuron (needs autonomous + !dry_run)"),
    max_actions: z.number().int().min(1).max(500).optional().default(20).describe("Cap on actions planned over the VISIBLE findings (default 20)"),
    max_items: z.number().int().min(1).max(200).optional().default(3).describe("Cap on findings shown per dimension; hidden findings do NOT generate actions (default 3)"),
    detail: z.enum(["compact", "full"]).optional().default("compact").describe("compact = lean actions (default, <15KB); full = the entire ledger with evidence/inference/recommendation"),
    mirror_threshold: z.number().min(0.8).max(1).optional().default(0.97).describe("Cosine threshold for mirror clusters (default 0.97)"),
    format: z.enum(["json", "markdown"]).optional().default("json").describe("Output format"),
  },
  async ({ mode, dry_run, create_issues, write_proposed_neurons, max_actions, max_items, detail, mirror_threshold, format }) => {
    try {
      const report = reflect(neuronsDir, {
        mode: mode ?? "report",
        dryRun: dry_run ?? true,
        createIssues: create_issues ?? false,
        writeProposedNeurons: write_proposed_neurons ?? false,
        maxActions: max_actions ?? 20,
        maxItems: max_items ?? 5,
        detail: detail ?? "compact",
        reflection: { mirrorThreshold: mirror_threshold ?? 0.97 },
      });
      // Compact JSON (no pretty-print indentation) — payload size matters for an
      // interactive MCP tool; the agent parses JSON either way. Use format=markdown
      // or detail=full for a human-readable / complete view.
      return format === "markdown"
        ? wrapResult({ markdown: formatReflectMarkdown(report) })
        : { content: [{ type: "text" as const, text: JSON.stringify(report) }] };
    } catch (e) {
      return neuronError("REFLECT_FAILED", String(e));
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
