#!/usr/bin/env node
/**
 * Iron Gates — PreToolUse hook that BLOCKS dangerous actions.
 *
 * Unlike plan-gate.js (which injects context), this hook returns
 * { decision: "block" } to physically prevent tool execution.
 *
 * Gates:
 *   1. No Write on memory/state files (use Edit instead)
 *   2. No push/PR without recent test verification
 *   3. No Edge Function deploy without --no-verify-jwt
 *   4. No Write that reduces file size >50%
 *   5. Cap 3 fix attempts per error before escalation
 *
 * State: /tmp/iron-gates-state.json (shared with auto-capture.ts)
 *
 * Registered in ~/.claude/settings.json as PreToolUse hook.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { isVerificationCommand, isPushCommand } from "./verification-matcher.js";
import { type GateState, loadState, saveState } from "./iron-gates-state.js";
import { ironGatesOverrideFile } from "./runtime-paths.js";

// ─── Types ──────────────────────────────────────────────────

interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

interface BlockResult {
  decision: "block";
  reason: string;
}

interface AllowResult {
  decision?: undefined;
}

type GateResult = BlockResult | AllowResult;

// ─── Constants ──────────────────────────────────────────────

// Override file path comes from runtime-paths (single source; default /tmp).

interface Override {
  gate: number;
  file?: string;
  expires: string; // ISO timestamp
}

/**
 * Check if an override exists for a specific gate.
 * Overrides are temporary (expire) and file-scoped.
 * Created by operator via: echo '{"gate":4,"file":"CLAUDE.md","expires":"..."}' > /tmp/iron-gates-override.json
 */
function hasOverride(gateNumber: number, filePath?: string): boolean {
  try {
    if (!existsSync(ironGatesOverrideFile())) return false;
    const overrides: Override[] = JSON.parse(readFileSync(ironGatesOverrideFile(), "utf-8"));
    const now = new Date();
    return overrides.some(o =>
      o.gate === gateNumber &&
      new Date(o.expires) > now &&
      (!o.file || (filePath && filePath.includes(o.file)))
    );
  } catch { return false; }
}

// Files that MUST use Edit, never Write
const PROTECTED_FILE_PATTERNS = [
  /MEMORY\.md$/,
  /PROJECT_MEMORY/,
  /\/memory\//,
  /\.factory\/outputs\//,
];

// Verification & push command classification live in verification-matcher.ts
// (isVerificationCommand / isPushCommand) — single source of truth, anti-masking,
// pipe-aware. No regex duplicated here.

// Deploy commands that need --no-verify-jwt
const DEPLOY_COMMANDS = /functions deploy|supabase functions deploy/;

// Max minutes since last verification for push to be allowed
const VERIFICATION_WINDOW_MINUTES = 10;

// Max fix attempts before escalation
const MAX_FIX_ATTEMPTS = 3;

// State storage (per-session) lives in iron-gates-state.ts (loadState/saveState),
// shared with auto-capture.ts. Each session has its OWN file, so concurrent
// sessions/worktrees can't clobber each other's verification_passed.

// ─── Gate Functions ─────────────────────────────────────────

/**
 * Gate 1: No Write on memory/state files
 */
function gateMemoryProtection(toolName: string, toolInput: Record<string, unknown>): GateResult {
  if (toolName !== "Write") return {};

  const filePath = (toolInput.file_path as string) ?? "";

  for (const pattern of PROTECTED_FILE_PATTERNS) {
    if (pattern.test(filePath) && !hasOverride(1, filePath)) {
      // Allow Write for NEW files (don't exist yet) — only block overwrites
      try {
        if (!existsSync(filePath)) continue; // New file — allow creation
      } catch { continue; }

      return {
        decision: "block",
        reason: `⛔ IRON GATE: Cannot use Write on "${filePath}".\n` +
                `This is a protected memory/state file that already exists.\n` +
                `Use Edit to modify specific sections instead.\n` +
                `Incident reference: 2026-04-02, PROJECT_MEMORY.md destroyed by Write.`,
      };
    }
  }

  return {};
}

/**
 * Gate 2: No push/PR without recent verification
 */
function gateVerificationBeforePush(
  toolName: string,
  toolInput: Record<string, unknown>,
  state: GateState,
): GateResult {
  if (toolName !== "Bash") return {};

  const command = (toolInput.command as string) ?? "";

  // Evaluate PUSH FIRST — never let a verifier substring short-circuit the gate.
  if (isPushCommand(command)) {
    // A command that BOTH verifies and pushes (e.g. `npm test && git push`) would
    // run the push before PostToolUse (auto-capture) records the test result — so
    // the gate would never see it. Require two separate commands.
    if (isVerificationCommand(command)) {
      return {
        decision: "block",
        reason: `⛔ IRON GATE: Don't combine verification and push in one command.\n` +
                `"${command.slice(0, 120)}" both verifies and pushes — the push would run\n` +
                `before the test result is recorded. Run them separately:\n` +
                `first the test/build, then the push.`,
      };
    }

    // Pure push — require a recent, passed verification.
    if (hasOverride(2)) return {};
    if (!state.last_verification_at || !state.verification_passed) {
      return {
        decision: "block",
        reason: `⛔ IRON GATE: Cannot push/create PR without running tests first.\n` +
                `Run one of: npm test, npm run build, npx vitest run, npx tsc --noEmit, npx playwright test\n` +
                `Then retry the push.`,
      };
    }

    // Check if verification is recent enough.
    const verifiedAt = new Date(state.last_verification_at).getTime();
    const minutesAgo = (Date.now() - verifiedAt) / (1000 * 60);
    if (minutesAgo > VERIFICATION_WINDOW_MINUTES) {
      return {
        decision: "block",
        reason: `⛔ IRON GATE: Last verification was ${Math.round(minutesAgo)} minutes ago (max ${VERIFICATION_WINDOW_MINUTES}).\n` +
                `Last command: ${state.last_verification_cmd}\n` +
                `Run tests again before pushing.`,
      };
    }

    return {};
  }

  // Not a push. A verifier (safe or not) is allowed to run; PostToolUse
  // (auto-capture.ts) decides whether it counts as a recorded verification.
  return {};
}

/**
 * Gate 3: No Edge Function deploy without --no-verify-jwt
 */
function gateDeployFlag(toolName: string, toolInput: Record<string, unknown>): GateResult {
  if (toolName !== "Bash") return {};

  const command = (toolInput.command as string) ?? "";

  if (DEPLOY_COMMANDS.test(command) && !command.includes("--no-verify-jwt") && !hasOverride(3)) {
    return {
      decision: "block",
      reason: `⛔ IRON GATE: Edge Function deploy MUST include --no-verify-jwt.\n` +
              `Without it, ALL public endpoints return 401 immediately.\n` +
              `Add --no-verify-jwt to the deploy command.\n` +
              `Incident reference: NE-303, ~40 requests 401 from Meta in 30 min.`,
    };
  }

  return {};
}

/**
 * Gate 4: No Write that reduces file >50%
 */
function gateFileShrink(toolName: string, toolInput: Record<string, unknown>): GateResult {
  if (toolName !== "Write") return {};

  const filePath = (toolInput.file_path as string) ?? "";
  const newContent = (toolInput.content as string) ?? "";

  try {
    if (existsSync(filePath)) {
      const currentSize = statSync(filePath).size;
      const newSize = newContent.length;

      // Only check files that are reasonably sized (>100 bytes)
      if (currentSize > 100 && newSize < currentSize * 0.5 && !hasOverride(4, filePath)) {
        return {
          decision: "block",
          reason: `⛔ IRON GATE: Write would reduce "${filePath}" from ${currentSize} to ${newSize} bytes (${Math.round((1 - newSize / currentSize) * 100)}% reduction).\n` +
                  `This looks like accidental content loss.\n` +
                  `Use Edit for targeted changes, or explain to operator why full rewrite is needed.`,
        };
      }
    }
  } catch {
    // File doesn't exist or can't stat — allow (it's a new file)
  }

  return {};
}

/**
 * Gate 5: Cap 3 fix attempts per error
 */
function gateFixCap(
  toolName: string,
  toolInput: Record<string, unknown>,
  state: GateState,
  cwd?: string,
): GateResult {
  if (toolName !== "Edit") return {};
  if (!state.active_error) return {};

  const filePath = (toolInput.file_path as string) ?? "";

  // Only count edits to source files (not tests, not config)
  if (!filePath.match(/\/src\/|\/app\/|\/pages\/|\/components\/|\/lib\/|\/utils\/|\/api\//)) {
    return {};
  }

  const attempts = state.fix_attempts[state.active_error] ?? 0;

  if (attempts >= MAX_FIX_ATTEMPTS && !hasOverride(5)) {
    return {
      decision: "block",
      reason: `⛔ IRON GATE: ${attempts} fix attempts for error "${state.active_error}".\n` +
              `STOP. This is likely an architecture problem, not an implementation bug.\n` +
              `Present to operator:\n` +
              `1. What each fix attempted\n` +
              `2. Why each failed\n` +
              `3. Whether the architecture/approach needs to change\n` +
              `\nOperator can say "OVERRIDE fix cap" to allow more attempts.`,
    };
  }

  // Increment counter
  state.fix_attempts[state.active_error] = attempts + 1;
  saveState(state, cwd);

  return {};
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  // Read hook input from stdin
  const inputRaw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(Buffer.concat(chunks).toString("utf-8")), 2000);
  });

  if (!inputRaw.trim()) process.exit(0);

  let input: HookInput;
  try {
    input = JSON.parse(inputRaw);
  } catch {
    process.exit(0);
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const sessionId = input.session_id ?? "unknown";

  // Only process Edit, Write, Bash
  if (!["Edit", "Write", "Bash"].includes(toolName)) {
    process.exit(0);
  }

  const state = loadState(sessionId, input.cwd);

  // Run all gates — first block wins
  const gates: GateResult[] = [
    gateMemoryProtection(toolName, toolInput),
    gateVerificationBeforePush(toolName, toolInput, state),
    gateDeployFlag(toolName, toolInput),
    gateFileShrink(toolName, toolInput),
    gateFixCap(toolName, toolInput, state, input.cwd),
  ];

  for (const result of gates) {
    if (result.decision === "block") {
      console.log(JSON.stringify(result));
      process.exit(0);
    }
  }

  // All gates passed — allow
  process.exit(0);
}

main().catch(() => {
  // Never crash the hook — exit silently (allow by default)
  process.exit(0);
});
