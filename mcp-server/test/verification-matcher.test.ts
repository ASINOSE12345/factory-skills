import { describe, it, expect } from "vitest";
import {
  classifyVerification,
  isVerificationCommand,
  isPushCommand,
  hasUnguardedPipe,
  hasPipefail,
  satisfiesPushVerificationPolicy,
} from "../src/verification-matcher";

// ─── Req 1: valid verifiers → { isVerification: true, safe: true } ───────────
describe("valid verifiers (isVerification && safe)", () => {
  const VALID = [
    "npm test",
    "npm run test",
    "npm run build",
    "npm run lint",              // lint is whitelisted (no-eslint-disable policy)
    "npm --prefix mcp-server test",
    "npm --prefix ./some/path run test",
    "pnpm test",
    "pnpm build",               // direct shorthand, no "run" prefix
    "pnpm typecheck",
    "pnpm lint",
    "pnpm --filter @scope/pkg test",
    "pnpm --filter @scope/pkg build",        // was false-negative before fix
    "pnpm --filter @scope/pkg typecheck",    // was false-negative before fix
    "pnpm --filter @scope/pkg lint",         // was false-negative before fix
    "pnpm --filter @scope/pkg exec vitest",
    "pnpm -r typecheck",        // recursive flag treated as BOOL_FLAG, sub="typecheck"
    "pnpm --recursive typecheck",
    "pnpm web:verify",          // workspace shorthand in DIRECT_VERIFIER_SCRIPTS
    "pnpm test:contracts",      // test:* pattern
    "pnpm run web:verify",      // same via "run" prefix
    "pnpm run test:contracts",
    // factory-os real commands from history
    "pnpm --filter @factory-os/claude-code-cli-adapter test",
    "pnpm --filter @factory-os/contracts test -- company-cost-overview.test.ts",
    "pnpm --filter @factory-os/contracts exec vitest run engine-real-invocation.test.ts",
    "pnpm --filter @factory-os/web lint",
    "pnpm --filter @factory-os/web build",
    "RUN_1A_PRIME=1 pnpm --filter @factory-os/contracts test -- x.test.ts",
    "cd /workspace && pnpm --filter @factory-os/web build",
    "npm --prefix mcp-server test",
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
    'git commit -m "fix vitest"',         // from prompt B list
    'echo "run npm test"',
    'echo "npm test"',
    'grep -r "playwright" .',
    "rg vitest",                           // from prompt B list
    "cat npm-test-notes.md",
    "echo npm test", // head is echo, not a verifier
    "npm run dev", // non-whitelisted script
    "ls -la test/", // live-bug shape: substring only
    "node -e \"console.log('vitest')\"",   // from prompt B list — string argument, not invocation
    "grep 'npm test' README.md",
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
    // from prompt B list — combined verify+push (isVerification=true but safeToCount=false via push guard)
    // NOTE: these are also push commands; the gate blocks them via combined-command check
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

// ─── Contract: verification_passed ⇔ satisfiesPushVerificationPolicy ∧ exit0 ∧ ¬push ───
describe("recording contract (pure-logic equivalent of updateIronGatesState)", () => {
  // Mirrors the actual recordsVerificationPass implementation in auto-capture.ts:
  //   satisfiesPushVerificationPolicy(verdict) && exitCode===0 && !isPushCommand
  const shouldRecord = (cmd: string, exitCode: number): boolean => {
    const v = classifyVerification(cmd);
    return satisfiesPushVerificationPolicy(v) && exitCode === 0 && !isPushCommand(cmd);
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
  it("lint + exit 0 → no record (lint is verification but not push-gate kind)", () =>
    expect(shouldRecord("npm run lint", 0)).toBe(false));
});

// ─── Shell-wrapper unwrapping — push must not hide inside a -c payload ────────
describe("shell-wrapper bypass prevention (bash -c / -lc / sh -c)", () => {
  it("bash -c 'git push' → push", () =>
    expect(isPushCommand("bash -c 'git push'")).toBe(true));
  it("bash -lc 'git push' → push", () =>
    expect(isPushCommand("bash -lc 'git push'")).toBe(true));
  it("sh -c 'gh pr create --fill' → push", () =>
    expect(isPushCommand("sh -c 'gh pr create --fill'")).toBe(true));
  it("/bin/bash -lc 'git push' → push", () =>
    expect(isPushCommand("/bin/bash -lc 'git push'")).toBe(true));
  it(`bash -c 'echo "git push"' → NOT push`, () =>
    expect(isPushCommand(`bash -c 'echo "git push"'`)).toBe(false));
  it("npm test && bash -c 'git push' → mixed (both predicates true)", () => {
    const cmd = "npm test && bash -c 'git push'";
    expect(isVerificationCommand(cmd)).toBe(true);
    expect(isPushCommand(cmd)).toBe(true);
  });
  it("npm test && bash -c 'git push' → NOT recorded (push guard fires)", () => {
    const cmd = "npm test && bash -c 'git push'";
    const v = classifyVerification(cmd);
    expect(v.isVerification && v.safe && !isPushCommand(cmd)).toBe(false);
  });
  it("bash -lc 'npm test' → verification (unwrap generalizes)", () => {
    const v = classifyVerification("bash -lc 'npm test'");
    expect(v.isVerification).toBe(true);
    expect(v.safe).toBe(true);
  });
  it("bash -c 'npm test' ; rm -rf x → unsafe (wrapper not unwrapped past ;)", () => {
    const v = classifyVerification("bash -c 'npm test' ; rm -rf x");
    expect(v.isVerification).toBe(true);
    expect(v.safe).toBe(false);
  });
});

// ─── Command-substitution unwrapping — push must not hide in $(...) / backticks ──
describe("command-substitution bypass prevention ($(...) / backticks)", () => {
  it("echo $(git push) → push", () =>
    expect(isPushCommand("echo $(git push)")).toBe(true));
  it(`echo "$(git push)" → push (executes inside double quotes)`, () =>
    expect(isPushCommand(`echo "$(git push)"`)).toBe(true));
  it("echo `git push` (backticks) → push", () =>
    expect(isPushCommand("echo `git push`")).toBe(true));
  it("echo $(gh pr create --fill) → push", () =>
    expect(isPushCommand("echo $(gh pr create --fill)")).toBe(true));
  it("npm test && echo $(git push) → mixed (both predicates true)", () => {
    const cmd = "npm test && echo $(git push)";
    expect(isVerificationCommand(cmd)).toBe(true);
    expect(isPushCommand(cmd)).toBe(true);
  });
  it(`echo '$(git push)' → NOT push (single quotes do not expand)`, () =>
    expect(isPushCommand("echo '$(git push)'")).toBe(false));
});

// ─── Indirect-execution bypass prevention (eval / grouping / exec-prefixes) ───
describe("indirect-execution bypass prevention", () => {
  const PUSHES = [
    `eval "git push"`, `eval git push`, `eval 'git push'`,
    `(git push)`, `{ git push; }`,
    `sudo git push`, `env git push`, `nohup git push`, `time git push`,
    `nice git push`, `command git push`, `exec git push`, `xargs git push`,
    `sudo -u user git push`, `nice -n 10 git push`, `env FOO=bar git push`,
  ];
  it.each(PUSHES)("push detected: %s", (cmd) => expect(isPushCommand(cmd)).toBe(true));

  const NOT_PUSH = [`echo git push`, `sudo echo hi`, `git status`, `echo "git push to prod"`];
  it.each(NOT_PUSH)("not a push: %s", (cmd) => expect(isPushCommand(cmd)).toBe(false));

  it(`npm test && eval "git push" → mixed (both predicates fire)`, () => {
    const cmd = `npm test && eval "git push"`;
    expect(isVerificationCommand(cmd)).toBe(true);
    expect(isPushCommand(cmd)).toBe(true);
  });

  const VERIFS = [`sudo npm test`, `(npm test)`, `nice -n 10 vitest`, `time npx tsc --noEmit`];
  it.each(VERIFS)("verification through prefix/grouping: %s", (cmd) =>
    expect(isVerificationCommand(cmd)).toBe(true));
});

// ─── Combined verify+push from prompt B list ─────────────────────────────────
describe("combined verify+push (both predicates fire — gate must block)", () => {
  it("pnpm test && git push → both predicates true", () => {
    const cmd = "pnpm test && git push";
    expect(isVerificationCommand(cmd)).toBe(true);
    expect(isPushCommand(cmd)).toBe(true);
  });
  it("npx tsc --noEmit && gh pr create → both predicates true", () => {
    const cmd = "npx tsc --noEmit && gh pr create";
    expect(isVerificationCommand(cmd)).toBe(true);
    expect(isPushCommand(cmd)).toBe(true);
  });
  it("pnpm --filter @factory-os/web lint && git push → both predicates true", () => {
    const cmd = "pnpm --filter @factory-os/web lint && git push";
    expect(isVerificationCommand(cmd)).toBe(true);
    expect(isPushCommand(cmd)).toBe(true);
  });
});

// ─── Kind classification ──────────────────────────────────────────────────────
describe("kind classification (mechanism layer)", () => {
  it("pnpm --filter X test → kind=test", () => {
    const r = classifyVerification("pnpm --filter @factory-os/claude-code-cli-adapter test");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("test");
    expect(r.safe).toBe(true);
  });
  it("pnpm --filter X build → kind=build", () => {
    const r = classifyVerification("pnpm --filter @factory-os/web build");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("build");
    expect(r.safe).toBe(true);
  });
  it("pnpm --filter X typecheck → kind=typecheck", () => {
    const r = classifyVerification("pnpm --filter @factory-os/contracts typecheck");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("typecheck");
    expect(r.safe).toBe(true);
  });
  it("pnpm --filter X lint → kind=lint, isVerification=true, safe=true", () => {
    const r = classifyVerification("pnpm --filter @factory-os/web lint");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("lint");
    expect(r.safe).toBe(true);
  });
  it("npm run lint → kind=lint", () => {
    const r = classifyVerification("npm run lint");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("lint");
    expect(r.safe).toBe(true);
  });
  it("npx tsc --noEmit → kind=typecheck", () => {
    const r = classifyVerification("npx tsc --noEmit");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("typecheck");
  });
  it("tsc --noEmit (no npx) → kind=typecheck", () => {
    const r = classifyVerification("tsc --noEmit");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("typecheck");
  });
  it("vitest run → kind=test", () => {
    const r = classifyVerification("vitest run");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("test");
  });
  it("playwright test → kind=e2e", () => {
    const r = classifyVerification("playwright test");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("e2e");
  });
  it("npm exec playwright test → kind=e2e", () => {
    const r = classifyVerification("npm exec playwright test");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("e2e");
  });
  it("pnpm --filter X exec vitest run → kind=test", () => {
    const r = classifyVerification("pnpm --filter @factory-os/contracts exec vitest run engine.test.ts");
    expect(r.isVerification).toBe(true);
    expect(r.kind).toBe("test");
  });
  it("non-verifier → kind=undefined", () => {
    const r = classifyVerification('git commit -m "fix vitest"');
    expect(r.isVerification).toBe(false);
    expect(r.kind).toBeUndefined();
  });
});

// ─── Push-gate policy (satisfiesPushVerificationPolicy) ──────────────────────
describe("satisfiesPushVerificationPolicy (policy layer)", () => {
  it("test kind → satisfies", () =>
    expect(satisfiesPushVerificationPolicy(
      classifyVerification("pnpm --filter @factory-os/claude-code-cli-adapter test")
    )).toBe(true));
  it("build kind → satisfies", () =>
    expect(satisfiesPushVerificationPolicy(
      classifyVerification("pnpm --filter @factory-os/web build")
    )).toBe(true));
  it("typecheck kind → satisfies", () =>
    expect(satisfiesPushVerificationPolicy(
      classifyVerification("npx tsc --noEmit")
    )).toBe(true));
  it("e2e kind → satisfies", () =>
    expect(satisfiesPushVerificationPolicy(
      classifyVerification("playwright test")
    )).toBe(true));
  it("lint kind → DOES NOT satisfy (lint is verification but not push-gate)", () =>
    expect(satisfiesPushVerificationPolicy(
      classifyVerification("pnpm --filter @factory-os/web lint")
    )).toBe(false));
  it("npm run lint → DOES NOT satisfy", () =>
    expect(satisfiesPushVerificationPolicy(classifyVerification("npm run lint"))).toBe(false));
  it("unsafe pipe → DOES NOT satisfy (safe=false)", () =>
    expect(satisfiesPushVerificationPolicy(classifyVerification("vitest | tail"))).toBe(false));
  it("non-verifier → DOES NOT satisfy", () =>
    expect(satisfiesPushVerificationPolicy(classifyVerification('git commit -m "fix vitest"'))).toBe(false));
});

// ─── Recording contract — pnpm scoped real commands ──────────────────────────
describe("recording contract — factory-os pnpm scoped commands", () => {
  // Mirrors recordsVerificationPass(cmd, exitCode) from auto-capture.ts.
  // Uses satisfiesPushVerificationPolicy so lint is correctly excluded.
  const shouldRecord = (cmd: string, exitCode: number): boolean => {
    const v = classifyVerification(cmd);
    return satisfiesPushVerificationPolicy(v) && exitCode === 0 && !isPushCommand(cmd);
  };

  // Positivos: deben registrar verification_passed=true
  it("pnpm --filter @factory-os/claude-code-cli-adapter test exit 0 → record", () =>
    expect(shouldRecord("pnpm --filter @factory-os/claude-code-cli-adapter test", 0)).toBe(true));

  it("pnpm --filter @factory-os/contracts test -- company-cost-overview.test.ts exit 0 → record", () =>
    expect(shouldRecord("pnpm --filter @factory-os/contracts test -- company-cost-overview.test.ts", 0)).toBe(true));

  it("pnpm --filter @factory-os/contracts exec vitest run engine-real-invocation.test.ts exit 0 → record", () =>
    expect(shouldRecord("pnpm --filter @factory-os/contracts exec vitest run engine-real-invocation.test.ts", 0)).toBe(true));

  it("pnpm --filter @factory-os/web build exit 0 → record", () =>
    expect(shouldRecord("pnpm --filter @factory-os/web build", 0)).toBe(true));

  it("RUN_1A_PRIME=1 pnpm --filter @factory-os/contracts test -- x.test.ts exit 0 → record", () =>
    expect(shouldRecord("RUN_1A_PRIME=1 pnpm --filter @factory-os/contracts test -- x.test.ts", 0)).toBe(true));

  // Lint: reconocida como verificación, NO registra push gate
  it("pnpm --filter @factory-os/web lint exit 0 → DOES NOT record (lint ≠ push gate)", () =>
    expect(shouldRecord("pnpm --filter @factory-os/web lint", 0)).toBe(false));

  it("npm run lint exit 0 → DOES NOT record", () =>
    expect(shouldRecord("npm run lint", 0)).toBe(false));

  // Negativos generales
  it("pnpm --filter @factory-os/web build exit 1 → no record (failed build)", () =>
    expect(shouldRecord("pnpm --filter @factory-os/web build", 1)).toBe(false));

  it("git commit -m 'fix vitest' exit 0 → no record (not a verifier)", () =>
    expect(shouldRecord("git commit -m 'fix vitest'", 0)).toBe(false));

  it("echo 'npm test' exit 0 → no record (not a verifier)", () =>
    expect(shouldRecord("echo 'npm test'", 0)).toBe(false));

  it("vitest | tail exit 0 → no record (unsafe pipe)", () =>
    expect(shouldRecord("vitest | tail", 0)).toBe(false));

  // Combined verify+push: no debe registrar (push guard en auto-capture)
  it("pnpm test && git push exit 0 → no record (contains push)", () =>
    expect(shouldRecord("pnpm test && git push", 0)).toBe(false));

  it("npx tsc --noEmit && gh pr create exit 0 → no record (contains push)", () =>
    expect(shouldRecord("npx tsc --noEmit && gh pr create", 0)).toBe(false));
});

// ─── Regression D: package-scoped test verde → push permitido ────────────────
describe("regression: package-scoped test pass → push allowed", () => {
  it("step 1: pnpm --filter X test exits 0 → shouldRecord=true (sets verification_passed)", () => {
    const cmd = "pnpm --filter @factory-os/claude-code-cli-adapter test";
    const v = classifyVerification(cmd);
    expect(v.isVerification).toBe(true);
    expect(v.safe).toBe(true);
    expect(isPushCommand(cmd)).toBe(false);
    // With exit 0, auto-capture would set verification_passed=true
  });
  it("step 2: git push -u origin feat/example → isPushCommand=true, NOT a verifier → gate checks state", () => {
    const pushCmd = "git push -u origin feat/example";
    expect(isPushCommand(pushCmd)).toBe(true);
    expect(isVerificationCommand(pushCmd)).toBe(false);
    // Iron Gate: if state.verification_passed=true (set by step 1), push is ALLOWED
  });
});
