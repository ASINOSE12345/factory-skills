// src/verification-matcher.ts
//
// Single source of truth for "does this Bash command count as test/build
// verification, and can its exit code be trusted?"  Imported by both
// iron-gates.ts (PreToolUse gate) and auto-capture.ts (PostToolUse recorder).
//
// No external deps — string/regex only. NodeNext ESM.
//
// SCOPE / LIMITS: a pragmatic textual approximation, NOT a shell parser. It is a
// local governance hook, not an adversarial security boundary. Every documented
// gap biases toward FALSE-NEGATIVE (under-count verification ⇒ the push gate
// blocks and the operator re-runs/overrides) rather than FALSE-POSITIVE (trusting
// a non-verifier or a masked failure — the bug this module closes). See §limits.

// ─── Public types ────────────────────────────────────────────────────────────

/** Result of classifying a Bash command for verification purposes. */
export interface VerificationClassification {
  /** True if the command actually INVOKES a recognized verifier
   *  (vitest/jest/tsc/playwright/npm test|build/etc.) as a real command —
   *  not as a quoted string or argument to echo/grep/cat/git-commit. */
  isVerification: boolean;
  /** True only if isVerification AND the exit code can be trusted: no operator
   *  after the verifier can make the command exit 0 while the verifier failed
   *  (no `||`, no unguarded `|`, no `;`/newline with a later command). */
  safe: boolean;
  /** Actionable explanation, present when isVerification && !safe. */
  reason?: string;
}

// ─── Verifier vocabulary ─────────────────────────────────────────────────────

/** Binaries that ARE verifiers when invoked directly (shape A) or via exec/dlx. */
const VERIFIER_BINARIES = ["vitest", "jest", "mocha", "cypress", "playwright", "tsc"];

/** Package-manager front-ends (shape B). */
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "npx", "bun"];

/** Flags between a package manager and its subcommand that CONSUME the next token
 *  as a value, so `npm --prefix ./x test` reads `test` as the subcommand. */
const VALUE_FLAGS = new Set(["--prefix", "--filter", "-w", "--workspace", "--workspace-root", "-C", "--dir"]);

/** Any other leading-dash token is treated as a no-arg flag. */
const BOOL_FLAG = /^-/;

/** Subcommands that, under a package manager, mean "run verification".
 *  `run <script>` only counts for whitelisted scripts so `npm run dev`/`lint`
 *  do NOT register. */
const PM_RUN_SCRIPTS = new Set(["test", "build", "typecheck", "type-check", "tsc"]);

/** Git flags that consume their next token (so we can skip `-C <dir>` etc.). */
const GIT_VALUE_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "-c"]);

// ─── Quote masking ───────────────────────────────────────────────────────────

/** Replace the CONTENTS of '...' and "..." with spaces of equal length so offsets
 *  are preserved but no separator/keyword inside quotes is seen. Unbalanced quote
 *  → blank to end-of-string (fail-closed for matching: hides the rest, can only
 *  REDUCE false positives). Newlines are kept for segment counting. */
function blankOutQuotedSpans(input: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) { out += ch; quote = null; }
      else { out += ch === "\n" ? "\n" : " "; }
    } else if (ch === '"' || ch === "'") {
      quote = ch; out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

// ─── Segment splitting (retains the operator that FOLLOWS each segment) ───────

type Sep = "&&" | "||" | ";" | "|" | "\n";

interface Segment {
  /** Real (unblanked) text of the segment, trimmed. */
  text: string;
  /** The operator that follows this segment, or null for the last one. */
  sep: Sep | null;
}

/** Split a command into top-level segments on `;`, `&&`, `||`, a real `|`, and
 *  newlines. Quoted regions are blanked first so in-quote separators/keywords are
 *  ignored. The operator following each segment is retained — the safety analysis
 *  needs to know HOW segments are chained (`&&` preserves the verifier's failure;
 *  `||`/`;`/`|` can mask it). */
function splitSegmentsWithOps(rawCommand: string): Segment[] {
  const masked = blankOutQuotedSpans(rawCommand);
  const boundary = /(\|\||&&|;|\n|\|)/g; // `||` & `&&` before single `|`
  const segs: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(masked)) !== null) {
    segs.push({ text: rawCommand.slice(last, m.index).trim(), sep: m[0] as Sep });
    last = m.index + m[0].length;
  }
  segs.push({ text: rawCommand.slice(last).trim(), sep: null });
  return segs;
}

/** Non-empty segment texts only — for "is some segment a verifier/push?" checks. */
function splitSegments(rawCommand: string): string[] {
  return splitSegmentsWithOps(rawCommand).map((s) => s.text).filter((t) => t.length > 0);
}

// ─── Token helpers ───────────────────────────────────────────────────────────

/** Strip leading `VAR=value` env assignments (`FOO=1 vitest` → `vitest`). */
function stripLeadingEnvAssignments(segment: string): string {
  let s = segment.trimStart();
  const ENV = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
  while (ENV.test(s)) s = s.replace(ENV, "").trimStart();
  return s;
}

function tokenize(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

/** basename of a token (so `./node_modules/.bin/vitest` → `vitest`). */
function basenameTok(tok: string): string {
  return tok.split("/").pop() ?? tok;
}

// ─── Verifier detection (one segment) ────────────────────────────────────────

/** Does ONE segment invoke a verifier as its leading command? */
function segmentIsVerifier(segment: string): boolean {
  const s = stripLeadingEnvAssignments(segment);
  const tokens = tokenize(s);
  if (tokens.length === 0) return false;

  const head = basenameTok(tokens[0]);

  // Shape A: direct verifier binary (incl. `tsc --noEmit` without npx).
  if (VERIFIER_BINARIES.includes(head)) return true;

  // Shape B: package-manager front-end.
  if (PACKAGE_MANAGERS.includes(head)) {
    let i = 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (VALUE_FLAGS.has(t)) { i += 2; continue; } // skip flag + its value
      if (BOOL_FLAG.test(t)) { i += 1; continue; }  // skip a no-arg flag
      break;
    }
    if (i >= tokens.length) return false;
    const sub = tokens[i];
    const subBin = basenameTok(sub);

    // npx/bun <verifier-binary>  e.g. `npx tsc --noEmit`, `bun vitest`
    if ((head === "npx" || head === "bun") && VERIFIER_BINARIES.includes(subBin)) return true;
    // npm/pnpm/yarn/bun test
    if (sub === "test") return true;
    // npm run <whitelisted-script>
    if (sub === "run") {
      const script = tokens[i + 1];
      return !!script && PM_RUN_SCRIPTS.has(basenameTok(script));
    }
    // npm/pnpm exec|dlx <verifier>
    if (sub === "exec" || sub === "dlx") {
      const bin = tokens[i + 1];
      return !!bin && VERIFIER_BINARIES.includes(basenameTok(bin));
    }
    return false;
  }

  return false;
}

// ─── bash -c unwrapping ──────────────────────────────────────────────────────

/** Extract the inner payload of `bash/sh/zsh/dash [flags] -c '<payload>'`, reading
 *  the quoted payload from the RAW segment (before any global quote-blanking would
 *  hide it). The flag bundle may END in `c` (-c, -lc, -ic, -lic, …) so login/
 *  interactive wrappers like `bash -lc 'git push'` are unwrapped too. Returns null
 *  when there is no such wrapper. */
function unwrapShellC(rawSegment: string): string | null {
  const m = rawSegment.match(/\b(?:bash|sh|zsh|dash)\b[^|;&\n]*?\s-[A-Za-z]*c\s+(?:'([^']*)'|"([^"]*)")/);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

/** The command whose exit code we actually analyze: the shell -c payload when the
 *  wrapper IS the whole command, else the command itself. Unwrapping BEFORE the
 *  segment/pipe analysis lets us see an inner `vitest | tail` (which lives inside the
 *  -c quotes) instead of losing it to quote-blanking. We only unwrap a SINGLE-segment
 *  command: if the wrapper is one of several segments (`bash -c 'npm test' ; rm -rf x`),
 *  unwrapping would drop the trailing `; rm …` and hide a masking operator. */
function getEffectiveCommand(command: string): string {
  if (splitSegments(command).length === 1) {
    const inner = unwrapShellC(command);
    if (inner !== null) return inner;
  }
  return command;
}

/** Blank ONLY single-quoted spans (their contents never expand in bash). Double
 *  quotes are preserved because command substitutions inside "..." DO execute. */
function blankSingleQuotedSpans(input: string): string {
  let out = "";
  let inSingle = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inSingle) {
      if (ch === "'") { out += ch; inSingle = false; }
      else { out += ch === "\n" ? "\n" : " "; }
    } else if (ch === "'") {
      inSingle = true; out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Inner code of command substitutions in EXECUTABLE context: `$(...)` and
 *  backtick `...` that are NOT inside single quotes (inside double quotes they
 *  still run). `echo "$(git push)"` → ["git push"]; `echo '$(git push)'` → [].
 *  Positions are located on the single-quote-masked copy but sliced from the
 *  original (equal length) so the returned code is real. */
function extractCommandSubstitutions(command: string): string[] {
  const src = blankSingleQuotedSpans(command);
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "$" && src[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") { depth--; if (depth === 0) break; }
        j++;
      }
      out.push(command.slice(i + 2, j));
      i = j;
    } else if (src[i] === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== "`") j++;
      out.push(command.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

// ─── Public predicates ───────────────────────────────────────────────────────

/** True if some segment of the command invokes a recognized verifier as a real
 *  command. Recurses into a `bash -c '<payload>'` wrapper. */
export function isVerificationCommand(command: string): boolean {
  const inner = unwrapShellC(command);
  if (inner !== null && isVerificationCommand(inner)) return true;
  return splitSegments(command).some(segmentIsVerifier);
}

/** True if the command contains a REAL pipe `|` (not `||`) outside quotes. */
export function hasUnguardedPipe(command: string): boolean {
  const masked = blankOutQuotedSpans(command);
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "|") {
      const next = masked[i + 1];
      const prev = masked[i - 1];
      if (next === "|" || prev === "|") { if (next === "|") i += 1; continue; } // part of ||
      return true; // a lone |
    }
  }
  return false;
}

/** True if pipefail is active (textual, outside quotes). Detected forms:
 *    set -o pipefail / set -eo pipefail            (shares the shell with the pipe)
 *    bash -o pipefail -c '...'                      (wrapper enables it for inner)
 *    bash -c '...; set -o pipefail; ...'            (pipefail inside the payload)
 *  LIMIT: accepts pipefail appearing anywhere in the same shell; does not verify
 *  it lexically precedes the pipe in the SAME subshell. This only fails OPEN when
 *  the user EXPLICITLY typed `pipefail` (an intentional opt-in); the default
 *  (no pipefail) is always fail-closed. */
export function hasPipefail(command: string): boolean {
  const masked = blankOutQuotedSpans(command);
  if (/\bset\b[^\n;]*\bpipefail\b/.test(masked)) return true;
  if (/\b(?:bash|sh)\b[^\n]*\s-o\s+pipefail\b/.test(masked)) return true;
  const inner = unwrapShellC(command);
  if (inner !== null && /\bset\b[^\n;]*\bpipefail\b/.test(blankOutQuotedSpans(inner))) return true;
  return false;
}

/** True if any top-level segment invokes `git [flags] push`, `gh pr create`, or
 *  `gh pr merge` — tolerating flags between the binary and the subcommand
 *  (`git -C repo push`) and ignoring quoted/echoed mentions (`echo "git push"`). */
export function isPushCommand(command: string): boolean {
  // 1. Shell wrapper: `bash -lc 'git push'` — the push hides inside the -c payload.
  const inner = unwrapShellC(command);
  if (inner !== null && isPushCommand(inner)) return true;
  // 2. Command substitutions in executable context: `echo $(git push)`,
  //    `echo "$(git push)"`, backticks — the push runs even though it is not a
  //    top-level segment. (Single-quoted `'$(git push)'` does not expand.)
  for (const sub of extractCommandSubstitutions(command)) {
    if (isPushCommand(sub)) return true;
  }
  // 3. Top-level segments.
  return splitSegments(command).some(segmentIsPush);
}

function segmentIsPush(segment: string): boolean {
  const tokens = tokenize(stripLeadingEnvAssignments(segment));
  if (tokens.length === 0) return false;
  const head = basenameTok(tokens[0]);
  if (head === "git") {
    let i = 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (GIT_VALUE_FLAGS.has(t)) { i += 2; continue; }
      if (t.startsWith("-")) { i += 1; continue; }
      break;
    }
    return tokens[i] === "push";
  }
  if (head === "gh") {
    return tokens[1] === "pr" && (tokens[2] === "create" || tokens[2] === "merge");
  }
  return false;
}

// ─── Reason message ──────────────────────────────────────────────────────────

export const UNSAFE_VERIFICATION_REASON =
  "Verification ran in a command whose exit code may not reflect the verifier's " +
  "result — a failure could be silently masked. Causes: a pipe `|` without pipefail " +
  "(exit is the last stage), `||` (a fallback like `|| true` swallows a failure), or " +
  "`;`/newline followed by another command (its exit replaces the verifier's). This " +
  "run does NOT count as verification. Make the verifier's own exit surface: chain " +
  "with `&&` (e.g. `cd dir && npm test`), enable pipefail (`set -o pipefail; npm test " +
  "| tail`), or split into separate commands (verify first, then push).";

// ─── Combined classifier (primary entry point) ───────────────────────────────

/**
 * Contract relied on by the call sites:
 *   verification_passed=true  ⇔  isVerification ∧ safe ∧ exitCode===0 ∧ ¬isPushCommand
 * (the ¬isPushCommand guard is applied by the recorder, auto-capture.ts.)
 *
 * `safe` = the command's exit code can be trusted to reflect the verifier:
 *   safe = noUnsafeOr ∧ noUnsafePipe ∧ noExecutableAfterVerifierViaSequence
 *     · noUnsafeOr   : no `||` anywhere top-level (a fallback can swallow a failure)
 *     · noUnsafePipe : no top-level `|` unless pipefail is active
 *     · noExecutableAfterVerifierViaSequence : no `;`/newline-separated command
 *       AFTER the last verifier (its exit would replace the verifier's)
 *   `&&` after the verifier is SAFE (it short-circuits on failure → exit reflects it).
 */
export function classifyVerification(command: string): VerificationClassification {
  if (!isVerificationCommand(command)) {
    return { isVerification: false, safe: false };
  }

  // Analyze the EFFECTIVE command (bash -c payload, else the command itself) so an
  // inner pipe inside `bash -c '...'` is visible. pipefail is read from the OUTER
  // command (hasPipefail already understands `bash -o pipefail` and `set -o pipefail`).
  const eff = getEffectiveCommand(command);
  const pipefailActive = hasPipefail(command);
  const segs = splitSegmentsWithOps(eff);

  // Index of the LAST segment that is a verifier (operators after it are what can
  // mask its exit). Fallback to 0 if not found at this level (e.g. nested wrapper):
  // analyzing from the start is conservative (more likely to flag, never to trust).
  let lastVerifierIdx = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].text && segmentIsVerifier(segs[i].text)) lastVerifierIdx = i;
  }
  if (lastVerifierIdx === -1) lastVerifierIdx = 0;

  const hasUnsafeOr = segs.some((s) => s.sep === "||");
  const hasTopPipe = segs.some((s) => s.sep === "|");

  // Any executable (non-empty) segment AFTER the last verifier reached via `;`/newline?
  let execAfterViaSequence = false;
  for (let i = lastVerifierIdx; i < segs.length - 1; i++) {
    if (segs[i].sep === ";" || segs[i].sep === "\n") {
      if (segs.slice(i + 1).some((s) => s.text.length > 0)) {
        execAfterViaSequence = true;
        break;
      }
    }
  }

  const safe = !hasUnsafeOr && (!hasTopPipe || pipefailActive) && !execAfterViaSequence;

  return safe
    ? { isVerification: true, safe: true }
    : { isVerification: true, safe: false, reason: UNSAFE_VERIFICATION_REASON };
}
