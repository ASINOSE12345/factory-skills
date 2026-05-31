#!/usr/bin/env node

/**
 * Auto-capture engine for Claude Code PostToolUse hooks.
 *
 * Receives hook input on stdin, analyzes tool output for errors,
 * and automatically creates/updates neuron files.
 *
 * Fires after every Bash command. If exit_code ≠ 0 or error patterns
 * detected in stderr, it:
 *   1. Classifies the error type and domain
 *   2. Checks if a similar neuron already exists (dedup by error signature)
 *   3. Creates a new NE neuron or bumps occurrences on existing one
 *   4. Outputs additionalContext so Claude knows about the capture
 *
 * Usage in hooks.json:
 *   "PostToolUse": [{ "matcher": "Bash", "hooks": [{
 *     "type": "command",
 *     "command": "node /path/to/auto-capture.js"
 *   }]}]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  resolveNeuronsDir,
  ensureNeuronsDir,
  createNeuron,
  searchNeuronsSync,
  listNeurons,
  updatePatternCounter,
} from "./neurons.js";
import matter from "gray-matter";

// ─── Types ───────────────────────────────────────────────────

interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: {
    command?: string;
    file_path?: string;
    [key: string]: unknown;
  };
  // PostToolUse (success) — Claude Code format
  tool_response?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
    isImage?: boolean;
    noOutputExpected?: boolean;
    [key: string]: unknown;
  };
  // PostToolUseFailure — Claude Code format
  error?: string;
  is_interrupt?: boolean;
  // Legacy format — keep for backwards compat (manual testing)
  tool_output?: {
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    content?: string;
    [key: string]: unknown;
  };
}

interface ErrorSignature {
  type: string;
  domain: string;
  severity: "p0" | "p1" | "p2" | "p3";
  title: string;
  fingerprint: string;
  rootCause: string;
  command: string;
  stderr: string;
}

interface HookOutput {
  hookSpecificOutput?: {
    additionalContext?: string;
  };
}

// ─── Error Classification ────────────────────────────────────

const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  type: string;
  domain: string;
  severity: "p0" | "p1" | "p2" | "p3";
  extractTitle: (match: RegExpMatchArray, stderr: string) => string;
  extractCause: (match: RegExpMatchArray, stderr: string) => string;
}> = [
  // TypeScript errors
  {
    pattern: /error TS(\d+): (.+)/,
    type: "typescript-error",
    domain: "typescript",
    severity: "p2",
    extractTitle: (_m, stderr) => {
      const match = stderr.match(/error (TS\d+): (.+)/);
      return match ? `TypeScript ${match[1]}: ${match[2].slice(0, 80)}` : "TypeScript compilation error";
    },
    extractCause: (_m, stderr) => {
      const fileMatch = stderr.match(/([a-zA-Z0-9_./-]+\.tsx?)\((\d+),(\d+)\)/);
      return fileMatch ? `File: ${fileMatch[1]} at line ${fileMatch[2]}` : "Check stderr for file location";
    },
  },
  // ESLint errors
  {
    pattern: /✖ \d+ problems? \(\d+ errors?/,
    type: "eslint-error",
    domain: "linting",
    severity: "p2",
    extractTitle: (_m, stderr) => {
      const count = stderr.match(/(\d+) errors?/);
      return `ESLint: ${count?.[1] ?? "multiple"} errors`;
    },
    extractCause: () => "ESLint rule violations — check output for specific rules",
  },
  // npm/node module errors
  {
    pattern: /Cannot find module '([^']+)'/,
    type: "missing-module",
    domain: "dependencies",
    severity: "p1",
    extractTitle: (m) => `Missing module: ${m[1]}`,
    extractCause: (m) => `Module '${m[1]}' not in node_modules — run npm install or add to package.json`,
  },
  {
    pattern: /Module not found: (?:Error: )?Can't resolve '([^']+)'/,
    type: "missing-module",
    domain: "dependencies",
    severity: "p1",
    extractTitle: (m) => `Module not found: ${m[1]}`,
    extractCause: (m) => `Module '${m[1]}' not installed or path incorrect`,
  },
  // Database errors
  {
    pattern: /(?:null value in column|violates not-null constraint).*"([^"]+)"/,
    type: "db-null-constraint",
    domain: "database",
    severity: "p1",
    extractTitle: (m) => `NOT NULL violation: column "${m[1]}"`,
    extractCause: (m) => `INSERT/UPDATE sent null for column "${m[1]}" which has NOT NULL constraint`,
  },
  {
    pattern: /duplicate key value violates unique constraint "([^"]+)"/,
    type: "db-unique-violation",
    domain: "database",
    severity: "p2",
    extractTitle: (m) => `Unique constraint violation: ${m[1]}`,
    extractCause: (m) => `Attempted to insert duplicate value for constraint "${m[1]}"`,
  },
  {
    pattern: /relation "([^"]+)" does not exist/,
    type: "db-missing-relation",
    domain: "database",
    severity: "p1",
    extractTitle: (m) => `Missing table/view: ${m[1]}`,
    extractCause: (m) => `Table or view "${m[1]}" not found — check migration status`,
  },
  // Auth errors
  {
    pattern: /(?:Invalid JWT|JWT expired|jwt malformed|401 Unauthorized)/i,
    type: "auth-jwt-error",
    domain: "auth",
    severity: "p1",
    extractTitle: () => "JWT authentication failure",
    extractCause: (_m, stderr) => {
      if (/expired/i.test(stderr)) return "JWT token has expired — refresh or re-authenticate";
      if (/malformed/i.test(stderr)) return "JWT token format is invalid";
      return "Authentication failed — check token and auth configuration";
    },
  },
  // Network/connection errors
  {
    pattern: /(?:ECONNREFUSED|Connection refused)/,
    type: "connection-refused",
    domain: "network",
    severity: "p1",
    extractTitle: (_m, stderr) => {
      const port = stderr.match(/:(\d+)/);
      return `Connection refused${port ? ` on port ${port[1]}` : ""}`;
    },
    extractCause: () => "Service not running or wrong port — verify the target service is up",
  },
  {
    pattern: /(?:ENOTFOUND|getaddrinfo|ERR_NAME_NOT_RESOLVED)/,
    type: "dns-resolution-failed",
    domain: "network",
    severity: "p2",
    extractTitle: (_m, stderr) => {
      const host = stderr.match(/(?:ENOTFOUND|getaddrinfo)[^']*'([^']+)'/);
      return `DNS resolution failed${host ? `: ${host[1]}` : ""}`;
    },
    extractCause: () => "Hostname cannot be resolved — check URL, DNS, or VPN/firewall",
  },
  // Permission errors
  {
    pattern: /(?:EACCES|Permission denied)/,
    type: "permission-denied",
    domain: "filesystem",
    severity: "p2",
    extractTitle: (_m, stderr) => {
      const path = stderr.match(/(?:EACCES|Permission denied)[^']*'([^']+)'/);
      return `Permission denied${path ? `: ${path[1]}` : ""}`;
    },
    extractCause: () => "Insufficient permissions — check file ownership and mode",
  },
  // Build/bundler errors
  {
    pattern: /(?:Build failed|Failed to compile|build error)/i,
    type: "build-failure",
    domain: "build",
    severity: "p1",
    extractTitle: () => "Build failed",
    extractCause: (_m, stderr) => {
      const first = stderr.split("\n").find((l) => /error/i.test(l));
      return first?.slice(0, 120) ?? "Check build output for details";
    },
  },
  // Test failures
  {
    pattern: /(?:FAIL|Tests?:.*\d+ failed|✗.*failing)/i,
    type: "test-failure",
    domain: "testing",
    severity: "p2",
    extractTitle: (_m, stderr) => {
      const count = stderr.match(/(\d+) failed/);
      return `Test failure: ${count?.[1] ?? "tests"} failed`;
    },
    extractCause: (_m, stderr) => {
      const firstFail = stderr.split("\n").find((l) => /FAIL|✗|✕/.test(l));
      return firstFail?.trim().slice(0, 120) ?? "Check test output for details";
    },
  },
  // Git errors
  {
    pattern: /fatal: (.+)/,
    type: "git-error",
    domain: "git",
    severity: "p2",
    extractTitle: (m) => `Git: ${m[1].slice(0, 80)}`,
    extractCause: (m) => m[1],
  },
  // Python errors
  {
    pattern: /(\w+Error): (.+)/,
    type: "python-error",
    domain: "python",
    severity: "p2",
    extractTitle: (m) => `${m[1]}: ${m[2].slice(0, 80)}`,
    extractCause: (m) => `${m[1]}: ${m[2]}`,
  },
];

// Commands to IGNORE — never capture neurons for these
const IGNORE_COMMANDS = [
  /^(ls|pwd|echo|cat|head|tail|wc|date|whoami|which|type|file)\b/,
  /^git\s+(status|log|diff|branch|remote|show|stash list)/,
  /^(cd|pushd|popd)\b/,
  /^(true|false|:)\b/,
  /^\s*#/,    // Comments
  /^mkdir\b/, // Directory creation
];

// Stderr patterns to IGNORE — noise, not real errors
const IGNORE_STDERR = [
  /^npm warn/,
  /^npm WARN/,
  /^warning:/i,
  /^Debugger attached/,
  /^Waiting for the debugger/,
  /^\(node:\d+\) ExperimentalWarning/,
  /^Cloning into/,
  /^\s*$/,
];

// ─── Core Logic ──────────────────────────────────────────────

function classifyError(command: string, stderr: string, exitCode: number): ErrorSignature | null {
  const combined = `${stderr}\n${command}`;

  for (const pattern of ERROR_PATTERNS) {
    const match = combined.match(pattern.pattern);
    if (match) {
      const title = pattern.extractTitle(match, stderr);
      const fingerprint = createHash("md5")
        .update(`${pattern.type}:${title}`)
        .digest("hex")
        .slice(0, 12);

      return {
        type: pattern.type,
        domain: pattern.domain,
        severity: pattern.severity,
        title,
        fingerprint,
        rootCause: pattern.extractCause(match, stderr),
        command,
        stderr: stderr.slice(0, 1000), // Cap at 1000 chars
      };
    }
  }

  // Generic error — only if exit code ≠ 0 and there's meaningful stderr
  if (exitCode !== 0 && stderr.trim().length > 10) {
    // Find the most informative line (skip stack trace, blank lines, code pointers)
    const lines = stderr.trim().split("\n");
    const infoLine = lines.find((l) =>
      l.trim().length > 5 &&
      !/^\s+at\s/.test(l) &&       // skip stack traces
      !/^\s*\^+\s*$/.test(l) &&    // skip error pointers (^^^)
      !/^\s*\d+\s*\|/.test(l) &&   // skip source code lines
      !/^Node\.js v/.test(l)        // skip Node version
    ) ?? lines[0];
    const firstLine = infoLine.trim().slice(0, 100);
    const fingerprint = createHash("md5")
      .update(`generic:${firstLine}`)
      .digest("hex")
      .slice(0, 12);

    return {
      type: "generic-error",
      domain: "unknown",
      severity: "p3",
      title: firstLine,
      fingerprint,
      rootCause: "Check stderr output",
      command,
      stderr: stderr.slice(0, 1000),
    };
  }

  return null;
}

function shouldIgnore(command: string, stderr: string, exitCode: number): boolean {
  // For compound commands (cd && ..., cd ; ...), check the LAST segment
  const cmdToCheck = command.includes("&&")
    ? command.split("&&").pop()!.trim()
    : command.includes(";")
      ? command.split(";").pop()!.trim()
      : command.trim();

  // Ignore whitelisted commands
  for (const pattern of IGNORE_COMMANDS) {
    if (pattern.test(cmdToCheck)) return true;
  }

  // Ignore if exit code is 0 (success)
  if (exitCode === 0) return true;

  // Ignore if stderr is just warnings/noise
  const stderrLines = stderr.split("\n").filter((l) => l.trim().length > 0);
  const meaningfulLines = stderrLines.filter((line) => {
    return !IGNORE_STDERR.some((pattern) => pattern.test(line));
  });

  if (meaningfulLines.length === 0) return true;

  return false;
}

function findExistingNeuron(neuronsDir: string, fingerprint: string): string | null {
  const errorsDir = join(neuronsDir, "errors");
  if (!existsSync(errorsDir)) return null;

  const files = readdirSync(errorsDir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    try {
      const content = readFileSync(join(errorsDir, file), "utf-8");
      if (content.includes(`fingerprint: ${fingerprint}`)) {
        return file.replace(".md", "");
      }
    } catch {
      // Skip unreadable files
    }
  }

  return null;
}

function bumpOccurrences(neuronsDir: string, neuronId: string): number {
  const filepath = join(neuronsDir, "errors", `${neuronId}.md`);
  const raw = readFileSync(filepath, "utf-8");
  const { data, content } = matter(raw);

  const newOcc = (data.occurrences ?? 1) + 1;
  data.occurrences = newOcc;
  data.last_seen = new Date().toISOString().split("T")[0];

  writeFileSync(filepath, matter.stringify(content, data), "utf-8");
  return newOcc;
}

function checkPatternPromotion(neuronsDir: string, neuronId: string, occurrences: number): string | null {
  // If an error has 3+ occurrences, check if a pattern should be created
  if (occurrences >= 3) {
    // Search for existing patterns that reference this error
    const patterns = listNeurons(neuronsDir, "patterns");
    const alreadyHasPattern = patterns.some((p) =>
      p.content.includes(neuronId)
    );

    if (!alreadyHasPattern) {
      return `Error ${neuronId} has ${occurrences} occurrences — consider creating a pattern neuron (NP) to capture the recurring fix.`;
    }
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  // Read hook input from stdin
  const inputRaw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", () => resolve(""));
    // Timeout after 2s — don't block the hook
    setTimeout(() => resolve(Buffer.concat(chunks).toString("utf-8")), 2000);
  });

  if (!inputRaw.trim()) {
    process.exit(0);
  }

  let input: HookInput;
  try {
    input = JSON.parse(inputRaw);
  } catch {
    // Not valid JSON — exit silently
    process.exit(0);
  }

  // Only process Bash tool calls
  if (input.tool_name !== "Bash") {
    process.exit(0);
  }

  const command = input.tool_input?.command ?? "";
  const isFailure = input.hook_event_name === "PostToolUseFailure";

  // Build stderr from the right source depending on hook type
  let stderr: string;
  let exitCode: number;

  if (isFailure) {
    // PostToolUseFailure: error is a string, no tool_response
    // Strip "Exit code N\n" prefix — Claude Code prepends it
    stderr = (input.error ?? "").replace(/^Exit code \d+\n/, "");
    exitCode = 1;
  } else {
    // PostToolUse (success) or legacy format
    const response = input.tool_response ?? input.tool_output ?? {};
    stderr = response.stderr ?? (response as Record<string, unknown>).content as string ?? "";
    exitCode = (response as Record<string, unknown>).exit_code as number
      ?? (stderr.trim().length > 0 ? 1 : 0);
  }

  // Check if we should ignore this command
  if (shouldIgnore(command, stderr, exitCode)) {
    process.exit(0);
  }

  // Resolve neurons directory
  const neuronsDir = resolveNeuronsDir(input.cwd);
  if (!neuronsDir) {
    process.exit(0); // No neurons dir — can't capture
  }

  ensureNeuronsDir(neuronsDir);

  // Classify the error
  // For PostToolUse success events, also check stdout for error patterns
  const stdout = input.tool_response?.stdout ?? input.tool_output?.stdout ?? "";
  const errorSig = classifyError(command, stderr || stdout, exitCode);
  if (!errorSig) {
    process.exit(0);
  }

  // Check for dedup — does this error already exist?
  const existingId = findExistingNeuron(neuronsDir, errorSig.fingerprint);

  let outputMessage: string;

  if (existingId) {
    // Bump occurrences on existing neuron
    const newOcc = bumpOccurrences(neuronsDir, existingId);
    outputMessage = `[auto-capture] Known error ${existingId} (occurrence #${newOcc}) — ${errorSig.title}`;

    // Check if it should be promoted to a pattern
    const promotion = checkPatternPromotion(neuronsDir, existingId, newOcc);
    if (promotion) {
      outputMessage += `\n${promotion}`;
    }
  } else {
    // Create new neuron
    const body = `## What happened
Command: \`${command.slice(0, 200)}\`
Exit code: ${exitCode}

## Error output
\`\`\`
${errorSig.stderr.slice(0, 500)}
\`\`\`

## Root cause
${errorSig.rootCause}

## Fix applied
_Pending — to be filled when the error is resolved_

## Rule learned
_Pending — to be filled after fix is verified_

## Auto-capture metadata
- fingerprint: ${errorSig.fingerprint}
- classified_as: ${errorSig.type}
- auto_captured: true`;

    const neuron = createNeuron(neuronsDir, "errors", errorSig.title, body, {
      domain: errorSig.domain,
      severity: errorSig.severity,
      status: "new",
      fingerprint: errorSig.fingerprint,
      auto_captured: true,
    } as Record<string, unknown>);

    const neuronId = neuron.filename.replace(".md", "");
    outputMessage = `[auto-capture] New error neuron ${neuronId}: ${errorSig.title}`;

    // Search for similar existing neurons to suggest connections
    const similar = searchNeuronsSync(neuronsDir, errorSig.title, "errors");
    if (similar.length > 1) {
      const related = similar
        .filter((n) => n.filename !== neuron.filename)
        .slice(0, 3)
        .map((n) => n.filename.replace(".md", ""))
        .join(", ");
      if (related) {
        outputMessage += `\nRelated neurons: ${related}`;
      }
    }
  }

  // Output context for Claude
  const hookOutput: HookOutput = {
    hookSpecificOutput: {
      additionalContext: outputMessage,
    },
  };

  console.log(JSON.stringify(hookOutput));
  process.exit(0);
}

main().catch(() => {
  // Never crash the hook — exit silently
  process.exit(0);
});
