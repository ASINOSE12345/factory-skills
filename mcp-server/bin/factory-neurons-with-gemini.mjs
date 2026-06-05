#!/usr/bin/env node
/**
 * Secure MCP launcher for factory-neurons.
 *
 * Loads GEMINI_API_KEY from a local 0600 keyfile (default ~/.config/factory/gemini.key,
 * override with FACTORY_GEMINI_KEY_FILE), sets it ONLY in this process's env, then
 * starts the real MCP server. The key NEVER appears in .mcp.json, in argv, or in logs.
 *
 * Wire .mcp.json like this (key stays out of config):
 *   "factory-neurons": {
 *     "command": "<absolute node path>",
 *     "args": [".../mcp-server/bin/factory-neurons-with-gemini.mjs", "<projectRoot>"]
 *   }
 *
 * If the keyfile is absent or insecure, the server STILL starts — semantic search
 * just degrades to keyword (no crash). All diagnostics go to stderr; the server
 * speaks MCP on stdout, so we must never write to stdout here.
 */
import { loadGeminiKey, resolveKeyFile } from "../dist/gemini-key.js";

const res = loadGeminiKey(resolveKeyFile());
if (res.ok && res.key) {
  process.env.GEMINI_API_KEY = res.key;
  console.error("[launcher] GEMINI_API_KEY loaded from keyfile — semantic search enabled");
} else {
  console.error(`[launcher] no Gemini key (${res.reason}) — search/think fall back to keyword`);
}

// Hand off to the real server in THIS process so it inherits the env we just set.
// server.js reads the project root from process.argv[2], which we pass through.
await import("../dist/server.js");
