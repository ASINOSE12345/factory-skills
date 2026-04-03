/**
 * Neuron file operations — read, write, search, update markdown neurons
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";

export interface NeuronFrontmatter {
  id?: string;
  tags?: string[];
  type?: string;
  project?: string;
  component?: string;
  domain?: string;
  severity?: string;
  occurrences?: number;
  status?: string;
  created?: string;
  date?: string;
  hits?: number;
  misses?: number;
  sessions_seen?: number;
  last_hit?: string | null;
  [key: string]: unknown;
}

export interface Neuron {
  filename: string;
  filepath: string;
  category: "errors" | "decisions" | "patterns" | "foundations";
  frontmatter: NeuronFrontmatter;
  content: string;
  title: string;
  modified: Date;
}

export type NeuronCategory = Neuron["category"];

const CATEGORY_PREFIX: Record<NeuronCategory, string> = {
  errors: "NE",
  decisions: "ND",
  patterns: "NP",
  foundations: "NF",
};

const CATEGORY_DIRS: NeuronCategory[] = ["errors", "decisions", "patterns", "foundations"];

/**
 * Resolve the neurons directory from a project root
 */
export function resolveNeuronsDir(projectRoot: string): string | null {
  const candidates = [
    join(projectRoot, "neurons"),
    join(projectRoot, "..", "neurons"),
  ];

  const envRoot = process.env.FACTORY_ROOT;
  if (envRoot) {
    candidates.push(join(envRoot, "neurons"));
  }

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Ensure the neurons directory structure exists
 */
export function ensureNeuronsDir(neuronsDir: string): void {
  for (const cat of CATEGORY_DIRS) {
    const dir = join(neuronsDir, cat);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Parse a single neuron markdown file
 */
function parseNeuron(filepath: string, category: NeuronCategory): Neuron | null {
  try {
    const raw = readFileSync(filepath, "utf-8");
    const { data, content } = matter(raw);

    // Extract title from first heading
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1] ?? basename(filepath, ".md");

    return {
      filename: basename(filepath),
      filepath,
      category,
      frontmatter: data as NeuronFrontmatter,
      content,
      title,
      modified: statSync(filepath).mtime,
    };
  } catch {
    return null;
  }
}

/**
 * List all neurons, optionally filtered by category
 */
export function listNeurons(neuronsDir: string, category?: NeuronCategory): Neuron[] {
  const categories = category ? [category] : CATEGORY_DIRS;
  const neurons: Neuron[] = [];

  for (const cat of categories) {
    const dir = join(neuronsDir, cat);
    if (!existsSync(dir)) continue;

    const prefix = CATEGORY_PREFIX[cat];
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
      .sort();

    for (const file of files) {
      const neuron = parseNeuron(join(dir, file), cat);
      if (neuron) neurons.push(neuron);
    }
  }

  return neurons;
}

/**
 * Get the N most recent neurons per category
 */
export function getRecentNeurons(neuronsDir: string, count: number = 5): Record<NeuronCategory, Neuron[]> {
  const result: Record<NeuronCategory, Neuron[]> = {
    errors: [],
    decisions: [],
    patterns: [],
    foundations: [],
  };

  for (const cat of CATEGORY_DIRS) {
    const neurons = listNeurons(neuronsDir, cat);
    neurons.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    result[cat] = neurons.slice(0, count);
  }

  return result;
}

/**
 * Search neurons by keyword across title + content + frontmatter
 */
export function searchNeurons(neuronsDir: string, query: string, category?: NeuronCategory): Neuron[] {
  const all = listNeurons(neuronsDir, category);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (terms.length === 0) return all;

  const scored = all.map((neuron) => {
    const domainStr = String(neuron.frontmatter.domain ?? "");
    const componentStr = Array.isArray(neuron.frontmatter.component)
      ? neuron.frontmatter.component.join(" ")
      : String(neuron.frontmatter.component ?? "");

    const searchable = [
      neuron.title,
      neuron.content,
      domainStr,
      componentStr,
      ...(neuron.frontmatter.tags ?? []),
    ]
      .join(" ")
      .toLowerCase();

    let score = 0;
    for (const term of terms) {
      // Title match = 3x weight
      if (neuron.title.toLowerCase().includes(term)) score += 3;
      // Domain/component match = 2x
      if (domainStr.toLowerCase().includes(term)) score += 2;
      if (componentStr.toLowerCase().includes(term)) score += 2;
      // Content match = 1x
      if (searchable.includes(term)) score += 1;
    }

    // Boost by occurrences
    const occ = neuron.frontmatter.occurrences ?? 1;
    score *= 1 + Math.log(occ) * 0.3;

    // Boost validated/graduated
    const status = neuron.frontmatter.status ?? "new";
    if (status === "validated") score *= 1.5;
    if (status === "graduated") score *= 2.0;

    return { neuron, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.neuron);
}

/**
 * Get the next available ID for a category
 */
function getNextId(neuronsDir: string, category: NeuronCategory): string {
  const prefix = CATEGORY_PREFIX[category];
  const dir = join(neuronsDir, category);
  if (!existsSync(dir)) return `${prefix}-001`;

  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .sort();

  if (files.length === 0) return `${prefix}-001`;

  const lastFile = files[files.length - 1];
  const match = lastFile.match(new RegExp(`${prefix}-(\\d+)`));
  const lastNum = match ? parseInt(match[1], 10) : 0;
  return `${prefix}-${String(lastNum + 1).padStart(3, "0")}`;
}

/**
 * Create a new neuron
 */
export function createNeuron(
  neuronsDir: string,
  category: NeuronCategory,
  title: string,
  body: string,
  frontmatterOverrides: Partial<NeuronFrontmatter> = {}
): Neuron {
  ensureNeuronsDir(neuronsDir);

  const id = getNextId(neuronsDir, category);
  const now = new Date().toISOString().split("T")[0];

  const typeMap: Record<NeuronCategory, string> = {
    errors: "error-memory",
    decisions: "decision-memory",
    patterns: "pattern-memory",
    foundations: "foundation-memory",
  };

  const fm: NeuronFrontmatter = {
    type: typeMap[category],
    status: "new",
    created: now,
    occurrences: 1,
    ...frontmatterOverrides,
  };

  if (category === "patterns") {
    fm.hits = fm.hits ?? 0;
    fm.misses = fm.misses ?? 0;
    fm.sessions_seen = fm.sessions_seen ?? 0;
    fm.last_hit = fm.last_hit ?? null;
  }

  const content = `\n# ${id}: ${title}\n\n${body}\n`;
  const fileContent = matter.stringify(content, fm);

  const filepath = join(neuronsDir, category, `${id}.md`);
  writeFileSync(filepath, fileContent, "utf-8");

  return {
    filename: `${id}.md`,
    filepath,
    category,
    frontmatter: fm,
    content,
    title: `${id}: ${title}`,
    modified: new Date(),
  };
}

/**
 * Update a pattern's hit/miss counter
 */
export function updatePatternCounter(
  neuronsDir: string,
  patternId: string,
  action: "hit" | "miss"
): { success: boolean; hits: number; misses: number; sessions_seen: number; status: string } {
  const dir = join(neuronsDir, "patterns");
  const filepath = join(dir, `${patternId}.md`);

  if (!existsSync(filepath)) {
    throw new Error(`Pattern ${patternId} not found at ${filepath}`);
  }

  const raw = readFileSync(filepath, "utf-8");
  const { data, content } = matter(raw);
  const fm = data as NeuronFrontmatter;

  if (action === "hit") {
    fm.hits = (fm.hits ?? 0) + 1;
    fm.last_hit = new Date().toISOString().split("T")[0];
  } else {
    fm.misses = (fm.misses ?? 0) + 1;
  }
  fm.sessions_seen = (fm.sessions_seen ?? 0) + 1;

  // Lifecycle gate checks
  const hits = fm.hits ?? 0;
  const sessions = fm.sessions_seen ?? 0;
  const currentStatus = fm.status ?? "new";

  if (currentStatus === "new" && hits >= 3 && sessions >= 10) {
    fm.status = "validated";
  } else if (currentStatus === "validated" && hits >= 7 && sessions >= 20) {
    fm.status = "graduated";
  }

  writeFileSync(filepath, matter.stringify(content, fm), "utf-8");

  return {
    success: true,
    hits: fm.hits ?? 0,
    misses: fm.misses ?? 0,
    sessions_seen: fm.sessions_seen ?? 0,
    status: fm.status ?? "new",
  };
}

/**
 * Get aggregate stats
 */
export function getStats(neuronsDir: string): {
  errors: number;
  decisions: number;
  patterns: number;
  foundations: number;
  total: number;
  recent_domains: string[];
} {
  const stats = {
    errors: 0,
    decisions: 0,
    patterns: 0,
    foundations: 0,
    total: 0,
    recent_domains: [] as string[],
  };

  const domainSet = new Set<string>();

  for (const cat of CATEGORY_DIRS) {
    const neurons = listNeurons(neuronsDir, cat);
    stats[cat] = neurons.length;
    stats.total += neurons.length;

    for (const n of neurons) {
      if (n.frontmatter.domain) {
        domainSet.add(n.frontmatter.domain);
      }
    }
  }

  stats.recent_domains = [...domainSet].slice(0, 10);
  return stats;
}

/**
 * Format a neuron as a compact breadcrumb (NF-010 style)
 */
export function toBreadcrumb(neuron: Neuron): string {
  const occ = neuron.frontmatter.occurrences ?? 1;
  const status = neuron.frontmatter.status ?? "new";
  return `${neuron.filename.replace(".md", "")} | ${neuron.title} | occ:${occ} status:${status}`;
}

/**
 * Format neurons for bootstrap injection
 */
export function formatBootstrap(neuronsDir: string, count: number = 5): string {
  const recent = getRecentNeurons(neuronsDir, count);
  const lines: string[] = ["# Neuron Bootstrap — Recent Knowledge\n"];

  for (const cat of CATEGORY_DIRS) {
    const neurons = recent[cat];
    if (neurons.length === 0) continue;

    lines.push(`## ${cat.charAt(0).toUpperCase() + cat.slice(1)} (${neurons.length} most recent)`);
    for (const n of neurons) {
      lines.push(`- ${toBreadcrumb(n)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
