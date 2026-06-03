import { describe, it, expect } from "vitest";
import {
  classifyVerification,
  isVerificationCommand,
  isPushCommand,
  hasUnguardedPipe,
  hasPipefail,
} from "../src/verification-matcher";

// ─── Req 1: valid verifiers → { isVerification: true, safe: true } ───────────
describe("valid verifiers (isVerification && safe)", () => {
  const VALID = [
    "npm test",
    "npm run test",
    "npm run build",
    "npm --prefix mcp-server test",
    "npm --prefix ./some/path run test",
    "pnpm test",
    "pnpm --filter @scope/pkg test",
    "pnpm --filter @scope/pkg exec vitest",
    "npx tsc --noEmit",
    "tsc --noEmit", // no npx
    "vitest",
    "vitest run",
    "playwright test",
    "npm exec playwright test",
    "FOO=1 vitest run", // leading env assignment
    "./node_modules/.bin/vitest run", // path basename
    "npm -w pkg test", // boolean + value flag mix
    "cd repo && npm test", // verifier in 2nd segment, && is not a pipe
  ];
  it.each(VALID)("valid: %s", (cmd) => {
    const r = classifyVerification(cmd);
    expect(r.isVerification).toBe(true);
    expect(r.safe).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});

// ─── Req 2: false positives → { isVerification: false, safe: false } ─────────
describe("false positives (not a verifier invocation)", () => {
  const FALSE_POS = [
    'git commit -m "fix vitest flakiness"',
    'echo "run npm test"',
    'grep -r "playwright" .',
    "cat npm-test-notes.md",
    "echo npm test", // head is echo, not a verifier
    "npm run dev", // non-whitelisted script
    "npm run lint", // non-whitelisted script
    "ls -la test/", // live-bug shape: substring only
  ];
  it.each(FALSE_POS)("false positive: %s", (cmd) => {
    const r = classifyVerification(cmd);
    expect(r.isVerification).toBe(false);
    expect(r.safe).toBe(false);
  });
});

// ─── Req 3: anti-masking — verifier present but exit code untrustworthy ──────
describe("unsafe (isVerification true, safe FALSE) — exit code can be masked", () => {
  const UNSAFE = [
    "vitest | tail", // pipe without pipefail
    "npm test || true", // || swallows a failure
    "npm test; true", // ; → exit is the last command
    "npm test; echo done", // ; → exit is echo
    "playwright test build-info --reporter=line 2>&1 | tail -6", // exact live-bug class
    "bash -c 'npm test | tail'", // inner pipe, no pipefail
  ];
  it.each(UNSAFE)("unsafe: %s", (cmd) => {
    const r = classifyVerification(cmd);
    expect(r.isVerification).toBe(true);
    expect(r.safe).toBe(false);
    expect(r.reason).toBeDefined();
    expect(r.reason).toContain("pipefail");
  });
});

// ─── Req 3: safe with explicit guard ─────────────────────────────────────────
describe("safe with guard (&& or pipefail)", () => {
  const SAFE_GUARDED = [
    "set -o pipefail; vitest | tail",
    "set -eo pipefail; npm test | tail",
    "bash -o pipefail -c 'vitest | tail'",
    "npm test && echo done", // && short-circuits on failure
    "cd repo && npm test",
  ];
  it.each(SAFE_GUARDED)("safe: %s", (cmd) => {
    const r = classifyVerification(cmd);
    expect(r.isVerification).toBe(true);
    expect(r.safe).toBe(true);
  });
});

// ─── Push detection (Finding 2) ──────────────────────────────────────────────
describe("isPushCommand", () => {
  it("git push", () => expect(isPushCommand("git push origin main")).toBe(true));
  it("git -C repo push (flags between git and push)", () =>
    expect(isPushCommand("git -C repo push")).toBe(true));
  it("gh pr create", () => expect(isPushCommand("gh pr create --fill")).toBe(true));
  it("gh pr merge", () => expect(isPushCommand("gh pr merge 12")).toBe(true));
  it('quoted "git push" is NOT a push', () =>
    expect(isPushCommand('echo "git push"')).toBe(false));
  it("plain verifier is NOT a push", () => expect(isPushCommand("npm test")).toBe(false));
});

// ─── Mixed verification+push (gate must block; both predicates fire) ─────────
describe("mixed verification + push (both predicates true → gate blocks)", () => {
  it("npm test && git push", () => {
    expect(isVerificationCommand("npm test && git push")).toBe(true);
    expect(isPushCommand("npm test && git push")).toBe(true);
  });
  it("git push && npm test", () => {
    expect(isVerificationCommand("git push && npm test")).toBe(true);
    expect(isPushCommand("git push && npm test")).toBe(true);
  });
});

// ─── Predicate-level units ───────────────────────────────────────────────────
describe("predicates", () => {
  it("hasUnguardedPipe: || is not a pipe", () =>
    expect(hasUnguardedPipe("npm test || true")).toBe(false));
  it("hasUnguardedPipe: lone | is a pipe", () =>
    expect(hasUnguardedPipe("vitest | tail")).toBe(true));
  it("hasUnguardedPipe: pipe inside quotes ignored", () =>
    expect(hasUnguardedPipe('echo "a | b"')).toBe(false));
  it("hasPipefail: set -o pipefail", () =>
    expect(hasPipefail("set -o pipefail; x")).toBe(true));
  it("hasPipefail: none", () => expect(hasPipefail("npm test | tail")).toBe(false));
  it("isVerificationCommand: npm --prefix x test", () =>
    expect(isVerificationCommand("npm --prefix x test")).toBe(true));
});

// ─── Contract: verification_passed ⇔ isVerification ∧ safe ∧ exit0 ∧ ¬push ───
describe("recording contract (pure-logic equivalent of updateIronGatesState)", () => {
  const shouldRecord = (cmd: string, exitCode: number): boolean => {
    const v = classifyVerification(cmd);
    return v.isVerification && v.safe && exitCode === 0 && !isPushCommand(cmd);
  };
  it("valid + exit 0 → record", () => expect(shouldRecord("npm test", 0)).toBe(true));
  it("valid + exit 1 → no record", () => expect(shouldRecord("npm test", 1)).toBe(false));
  it("unsafe pipe + exit 0 → no record", () =>
    expect(shouldRecord("vitest | tail", 0)).toBe(false));
  it("|| mask + exit 0 → no record", () =>
    expect(shouldRecord("npm test || true", 0)).toBe(false));
  it("false positive + exit 0 → no record", () =>
    expect(shouldRecord('echo "run npm test"', 0)).toBe(false));
  it("mixed verify+push + exit 0 → no record", () =>
    expect(shouldRecord("npm test && git push", 0)).toBe(false));
});
