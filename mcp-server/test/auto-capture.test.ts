import { describe, it, expect } from "vitest";
import { deriveExitAndStderr, recordsVerificationPass } from "../src/auto-capture";

// ─── Real hook payloads (captured from Claude Code, 2026-06-04) ───────────────
//
// A SUCCESSFUL `cd … && <verifier>` arrives as a PostToolUse event with NO exit_code
// field. The command's own stdout+stderr are folded into tool_response.stdout, while
// tool_response.stderr carries ONLY the harness note "Shell cwd was reset to <dir>"
// that the Bash tool appends after any `cd`. That non-empty-but-harmless stderr is the
// exact input that used to be mis-read as exit 1.
function postToolUseSuccess(
  command: string,
  response: Record<string, unknown> = {},
) {
  return {
    session_id: "s1",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: {
      stdout: "",
      stderr: "\nShell cwd was reset to /Users/dev/project",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      ...response,
    },
  };
}

// A FAILED command arrives as PostToolUseFailure: no tool_response, an `error` string
// prefixed with "Exit code N\n".
function postToolUseFailure(command: string, error: string) {
  return {
    session_id: "s1",
    cwd: "/repo",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command },
    error,
    is_interrupt: false,
  };
}

describe("deriveExitAndStderr", () => {
  it("reads a PostToolUse event as exit 0 even when stderr holds the harness cwd-reset note", () => {
    const { exitCode } = deriveExitAndStderr(postToolUseSuccess("cd repo && npx tsc --noEmit"));
    expect(exitCode).toBe(0);
  });

  it("does not infer failure from noisy-but-harmless stderr when no exit_code is present", () => {
    const noisy = postToolUseSuccess("cd app && npm run build", {
      stdout: "vite v8 building for production...\n✓ built in 3.21s",
      stderr: "\nShell cwd was reset to /Users/dev/app",
    });
    expect(deriveExitAndStderr(noisy).exitCode).toBe(0);
  });

  it("derives exit 1 and clean stderr from a PostToolUseFailure (strips the 'Exit code N' prefix)", () => {
    const { exitCode, stderr } = deriveExitAndStderr(
      postToolUseFailure("npx tsc --noEmit", "Exit code 2\nsrc/x.ts(1,1): error TS2304: x"),
    );
    expect(exitCode).toBe(1);
    expect(stderr.startsWith("Exit code")).toBe(false);
    expect(stderr).toContain("error TS2304");
  });

  it("honors a numeric exit_code from the legacy tool_output shape (manual/E2E harness)", () => {
    const legacy = {
      session_id: "s1",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npx tsc --noEmit" },
      tool_output: { exit_code: 2, stderr: "src/x.ts(1,1): error TS1005" },
    };
    expect(deriveExitAndStderr(legacy).exitCode).toBe(2);
  });
});

describe("recordsVerificationPass — Gate 2 contract is fixed but NOT relaxed", () => {
  // ── THE FIX: a passing verifier with noisy-but-harmless stderr and no exit_code
  //    must still record a verification pass. ──────────────────────────────────
  it("records a pass for a successful `cd repo && npx tsc --noEmit` despite cwd-reset noise", () => {
    const input = postToolUseSuccess("cd repo && npx tsc --noEmit");
    const { exitCode } = deriveExitAndStderr(input);
    expect(recordsVerificationPass(input.tool_input.command, exitCode)).toBe(true);
  });

  it("records a pass for a successful `cd app && npm test`", () => {
    const input = postToolUseSuccess("cd app && npm test");
    const { exitCode } = deriveExitAndStderr(input);
    expect(recordsVerificationPass(input.tool_input.command, exitCode)).toBe(true);
  });

  // ── ANTI-MASKING: the existing contract must keep refusing these. ────────────
  it("does NOT record a pass when `|| true` could swallow a verifier failure", () => {
    expect(recordsVerificationPass("npx tsc --noEmit || true", 0)).toBe(false);
  });

  it("does NOT record a pass for an unguarded pipe without pipefail", () => {
    expect(recordsVerificationPass("npm test | tail -5", 0)).toBe(false);
  });

  it("does NOT record a pass when a verifier is mixed with a push (`;` after it)", () => {
    expect(recordsVerificationPass("npm test ; git push", 0)).toBe(false);
  });

  it("does NOT record a pass when a verifier is &&-chained with a push", () => {
    expect(recordsVerificationPass("npm test && git push", 0)).toBe(false);
  });

  it("does NOT record a pass for a bare push", () => {
    expect(recordsVerificationPass("git push origin main", 0)).toBe(false);
  });

  it("does NOT record a pass for a genuinely failed verifier (PostToolUseFailure ⇒ exit 1)", () => {
    const input = postToolUseFailure("npx tsc --noEmit", "Exit code 2\nsrc/x.ts(1,1): error TS2304: x");
    const { exitCode } = deriveExitAndStderr(input);
    expect(recordsVerificationPass("npx tsc --noEmit", exitCode)).toBe(false);
  });

  it("does NOT record a pass for a non-verifier command that exited 0", () => {
    expect(recordsVerificationPass("cd repo && echo done", 0)).toBe(false);
  });
});
