/**
 * Semantic embeddings for neuron search using Gemini API.
 *
 * Cache: .neuron-embeddings.json (local, regenerated on demand)
 * Fallback: returns null if API unavailable → keyword search takes over
 * Model: gemini-embedding-001 (3072 dims, free tier: 10M tokens/min)
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import https from "node:https";
import { listNeurons, type Neuron, type NeuronCategory } from "./neurons.js";

// ─── Types ──────────────────────────────────────────────────

interface EmbeddingEntry {
  vector: number[];
  updated: string; // ISO date
}

interface EmbeddingCache {
  model: string;
  dimensions: number;
  entries: Record<string, EmbeddingEntry>; // filename → entry
}

// ─── API ────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-embedding-001";
const CACHE_FILENAME = ".neuron-embeddings.json";

function getApiKey(): string | null {
  return process.env.GEMINI_API_KEY || null;
}

/**
 * Embed a single text using Gemini API. Returns vector or null on failure.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  // Truncate to ~2000 chars to stay within token limits
  const truncated = text.slice(0, 2000);

  return new Promise((resolve) => {
    const data = JSON.stringify({
      model: `models/${GEMINI_MODEL}`,
      content: { parts: [{ text: truncated }] },
    });

    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/${GEMINI_MODEL}:embedContent?key=${apiKey}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        try {
          const result = JSON.parse(body);
          if (result.embedding?.values) {
            resolve(result.embedding.values);
          } else {
            console.warn("[EMBEDDINGS] API response missing values:", body.slice(0, 100));
            resolve(null);
          }
        } catch {
          console.warn("[EMBEDDINGS] Failed to parse API response");
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });

    req.write(data);
    req.end();
  });
}

/**
 * Embed multiple texts in batch (sequential to respect rate limits).
 */
async function embedBatch(texts: { key: string; text: string }[]): Promise<Map<string, number[]>> {
  const results = new Map<string, number[]>();
  for (const { key, text } of texts) {
    const vector = await embedText(text);
    if (vector) results.set(key, vector);
  }
  return results;
}

// ─── Cache ──────────────────────────────────────────────────

function getCachePath(neuronsDir: string): string {
  return join(dirname(neuronsDir), CACHE_FILENAME);
}

function loadCache(neuronsDir: string): EmbeddingCache {
  const cachePath = getCachePath(neuronsDir);
  if (existsSync(cachePath)) {
    try {
      return JSON.parse(readFileSync(cachePath, "utf-8"));
    } catch {
      console.warn("[EMBEDDINGS] Cache corrupted, rebuilding");
    }
  }
  return { model: GEMINI_MODEL, dimensions: 3072, entries: {} };
}

function saveCache(neuronsDir: string, cache: EmbeddingCache): void {
  try {
    writeFileSync(getCachePath(neuronsDir), JSON.stringify(cache), "utf-8");
  } catch (err) {
    console.warn("[EMBEDDINGS] Failed to save cache:", (err as Error).message);
  }
}

/**
 * Build/update the embedding cache for all neurons.
 * Only embeds neurons that are new or modified since last cache.
 */
export async function buildEmbeddingCache(neuronsDir: string): Promise<number> {
  const cache = loadCache(neuronsDir);
  const allNeurons = listNeurons(neuronsDir);
  const toEmbed: { key: string; text: string }[] = [];

  for (const neuron of allNeurons) {
    const key = neuron.filename;
    const existing = cache.entries[key];
    const neuronDate = neuron.modified.toISOString();

    // Skip if cached and not modified
    if (existing && existing.updated >= neuronDate) continue;

    // Prepare text: title + first 1500 chars of content
    const text = `${neuron.title}\n\n${neuron.content.slice(0, 1500)}`;
    toEmbed.push({ key, text });
  }

  if (toEmbed.length === 0) return 0;

  console.log(`[EMBEDDINGS] Embedding ${toEmbed.length} neurons...`);
  const newVectors = await embedBatch(toEmbed);

  for (const [key, vector] of newVectors) {
    cache.entries[key] = {
      vector,
      updated: new Date().toISOString(),
    };
  }

  // Update dimensions from actual data
  const firstEntry = Object.values(cache.entries)[0];
  if (firstEntry) cache.dimensions = firstEntry.vector.length;

  saveCache(neuronsDir, cache);
  console.log(`[EMBEDDINGS] Cached ${newVectors.size} new embeddings (total: ${Object.keys(cache.entries).length})`);
  return newVectors.size;
}

// ─── Similarity ─────────────────────────────────────────────

/**
 * Cosine similarity between two vectors. Returns 0-1.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Semantic search: embed query, compare against all cached neurons.
 * Returns sorted list of {filename, score} or null if API unavailable.
 */
export async function semanticSearch(
  query: string,
  neuronsDir: string,
): Promise<Map<string, number> | null> {
  const cache = loadCache(neuronsDir);
  const entries = Object.entries(cache.entries);

  if (entries.length === 0) return null;

  // Embed the query
  const queryVector = await embedText(query);
  if (!queryVector) return null; // API unavailable → fallback to keywords

  // Compute similarity against all cached neurons
  const scores = new Map<string, number>();
  for (const [filename, entry] of entries) {
    const sim = cosineSimilarity(queryVector, entry.vector);
    if (sim > 0.3) { // Threshold: ignore very low similarities
      scores.set(filename, sim);
    }
  }

  return scores;
}

/**
 * Get cached embedding vectors for specific neurons (by filename).
 * Used for cross-neuron similarity (duplicate / overlap detection).
 * Reads only the cache — needs no API key (vectors are already embedded).
 */
export function getNeuronVectors(
  neuronsDir: string,
  filenames: string[],
): Map<string, number[]> {
  const cache = loadCache(neuronsDir);
  const out = new Map<string, number[]>();
  for (const f of filenames) {
    const entry = cache.entries[f];
    if (entry?.vector) out.set(f, entry.vector);
  }
  return out;
}

/**
 * Embed a single neuron and add to cache (called after create_neuron).
 */
export async function embedSingleNeuron(neuronsDir: string, neuron: Neuron): Promise<void> {
  const text = `${neuron.title}\n\n${neuron.content.slice(0, 1500)}`;
  const vector = await embedText(text);
  if (!vector) return;

  const cache = loadCache(neuronsDir);
  cache.entries[neuron.filename] = {
    vector,
    updated: new Date().toISOString(),
  };
  saveCache(neuronsDir, cache);
}
