/**
 * Embedding providers — a thin abstraction so the brain can use Gemini, OpenAI,
 * or a local model WITHOUT ever mixing incompatible vector geometries.
 *
 * Two invariants make mixing impossible:
 *  1. Each (provider, model) gets its OWN cache file. The current Gemini default
 *     keeps the LEGACY `.neuron-embeddings.json` (back-compat: the MCP server
 *     reads it unchanged); every other provider/model is scoped:
 *     `.neuron-embeddings.<provider>.<model>.json`.
 *  2. Dimensions are declared per (provider, model) up front — never inferred from
 *     a returned vector. The CLI refuses to load a cache whose model/dimensions
 *     disagree with the active provider, and refuses any embedding whose length
 *     differs from the provider's declared dimensions.
 *
 * Only Gemini has a live embedder (it reuses the existing, tested `embedText`).
 * OpenAI and local are interface-complete STUBS: their `embed()` throws until a
 * future PR implements them against verified docs. This file performs NO network
 * I/O of its own and is never exercised against a real API in tests (mocked).
 */

import { join, dirname } from "node:path";
import { embedText } from "./embeddings.js";

export type ProviderName = "gemini" | "openai" | "local";

export interface EmbeddingProvider {
  name: ProviderName;
  model: string;
  dimensions: number;
  /** True if this provider has the credentials it needs to embed. */
  hasCredentials(): boolean;
  /** Embed text. RESOLVES to a vector of exactly `dimensions`, or THROWS. Never
   *  returns null and never silently falls back. */
  embed(text: string): Promise<number[]>;
}

const LEGACY_CACHE = ".neuron-embeddings.json";

/** Known (provider → model → dimensions). The single source of truth for dims;
 *  an unknown model is refused (we never guess a dimension). */
const MODELS: Record<ProviderName, Record<string, number>> = {
  gemini: { "gemini-embedding-001": 3072 },
  openai: { "text-embedding-3-small": 1536, "text-embedding-3-large": 3072 },
  local: { "local-unimplemented": 0 },
};

const DEFAULT_MODEL: Record<ProviderName, string> = {
  gemini: "gemini-embedding-001",
  openai: "text-embedding-3-small",
  local: "local-unimplemented",
};

function isProviderName(s: string): s is ProviderName {
  return s === "gemini" || s === "openai" || s === "local";
}

/**
 * Resolve the cache file path for a provider+model. The Gemini default keeps the
 * legacy filename (so the MCP server, which reads it, is untouched); all other
 * provider/model combinations are scoped to their own file — that physical
 * separation is what prevents mixing.
 */
export function resolveCachePath(provider: { name: string; model: string }, neuronsDir: string): string {
  const dir = dirname(neuronsDir);
  if (provider.name === "gemini" && provider.model === "gemini-embedding-001") {
    return join(dir, LEGACY_CACHE);
  }
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dir, `.neuron-embeddings.${safe(provider.name)}.${safe(provider.model)}.json`);
}

/** Gemini embedder — reuses the existing, tested `embedText` (which targets
 *  gemini-embedding-001). Throws if it returns null (no key / API error) so the
 *  CLI treats it as a hard failure, never a silent skip. */
function geminiEmbed(): (text: string) => Promise<number[]> {
  return async (text: string): Promise<number[]> => {
    const v = await embedText(text);
    if (!v || v.length === 0) throw new Error("gemini embed failed (no GEMINI_API_KEY or API error)");
    return v;
  };
}

/**
 * Build a provider. Throws on an unknown provider name or a model with no known
 * dimensions — both are fail-closed (we refuse rather than guess).
 */
export function getProvider(name: string, modelOverride?: string): EmbeddingProvider {
  if (!isProviderName(name)) {
    throw new Error(`unknown embedding provider '${name}' — expected gemini|openai|local`);
  }
  const model = modelOverride ?? DEFAULT_MODEL[name];
  const dimensions = MODELS[name][model];
  if (dimensions === undefined) {
    throw new Error(`unknown model '${model}' for provider '${name}' (no known dimensions — refuse to guess)`);
  }

  switch (name) {
    case "gemini":
      return {
        name,
        model,
        dimensions,
        hasCredentials: () => !!process.env.GEMINI_API_KEY,
        embed: geminiEmbed(),
      };
    case "openai":
      return {
        name,
        model,
        dimensions,
        hasCredentials: () => !!process.env.OPENAI_API_KEY,
        embed: async () => {
          throw new Error(
            "openai provider not implemented — verify the current OpenAI embeddings API before enabling",
          );
        },
      };
    case "local":
      return {
        name,
        model,
        dimensions,
        hasCredentials: () => false,
        embed: async () => {
          throw new Error("local provider not implemented yet (stub)");
        },
      };
  }
}

/** The provider names this build knows about (for help/validation). */
export const PROVIDER_NAMES: readonly ProviderName[] = ["gemini", "openai", "local"];
