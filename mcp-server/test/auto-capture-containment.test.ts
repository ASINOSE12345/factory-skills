/**
 * PR-G6A — auto-capture is OBSERVE-ONLY by default (no live corpus writes unless
 * FACTORY_ALLOW_LIVE_WRITES=true). These tests drive the real hook as a subprocess
 * (dist/auto-capture.js) against a TEMP neurons dir, so they prove the actual
 * runtime behavior — never touching /factory/neurons.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";

const DIST = resolve("dist/auto-capture.js");
const CATS = ["errors", "decisions", "patterns", "foundations", "business"];
const roots: string[] = [];

beforeAll(() => {
  if (!existsSync(DIST)) execSync("npm run build", { cwd: process.cwd(), stdio: "ignore" });
}, 60000);

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(): { root: string; neuronsDir: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "g6a-"));
  roots.push(root);
  const neuronsDir = join(root, "neurons");
  for (const c of CATS) mkdirSync(join(neuronsDir, c), { recursive: true });
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  return { root, neuronsDir, stateDir };
}

interface RunOpts {
  cwd: string;
  command: string;
  errorText: string;
  live: boolean;
  stateDir: string;
}
function runHook(o: RunOpts): { status: number | null; context: string } {
  const input = {
    session_id: "g6a-test",
    cwd: o.cwd,
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: o.command },
    error: `Exit code 1\n${o.errorText}`,
  };
  const env: NodeJS.ProcessEnv = { ...process.env, FACTORY_STATE_DIR: o.stateDir };
  delete env.FACTORY_ROOT;
  if (o.live) env.FACTORY_ALLOW_LIVE_WRITES = "true";
  else delete env.FACTORY_ALLOW_LIVE_WRITES;
  const res = spawnSync("node", [DIST], { input: JSON.stringify(input), encoding: "utf8", env });
  let context = "";
  try {
    context = JSON.parse(res.stdout).hookSpecificOutput?.additionalContext ?? "";
  } catch {
    /* no JSON output (ignored/no classification) */
  }
  return { status: res.status, context };
}

const errFiles = (neuronsDir: string): string[] => readdirSync(join(neuronsDir, "errors")).filter((f) => f.endsWith(".md"));
const MODULE_ERR = "Cannot find module 'leftpad'";

describe("auto-capture containment — observe-only by default (PR-G6A)", () => {
  it("1. observe-only + NEW error → does NOT create a neuron; reports observe-only", () => {
    const { root, neuronsDir, stateDir } = setup();
    const r = runHook({ cwd: root, command: "node run.js", errorText: MODULE_ERR, live: false, stateDir });
    expect(r.status).toBe(0);
    expect(errFiles(neuronsDir)).toEqual([]); // NO corpus write
    expect(r.context).toContain("observe-only");
    expect(r.context).toContain("LIVE_WRITE_DISABLED");
  });

  it("2. observe-only + EXISTING error → does NOT bump occurrences (file byte-identical)", () => {
    const { root, neuronsDir, stateDir } = setup();
    // seed one neuron live, then re-send the SAME error observe-only
    runHook({ cwd: root, command: "node run.js", errorText: MODULE_ERR, live: true, stateDir });
    const files = errFiles(neuronsDir);
    expect(files.length).toBe(1);
    const path = join(neuronsDir, "errors", files[0]);
    const before = readFileSync(path, "utf8");
    const r = runHook({ cwd: root, command: "node run.js", errorText: MODULE_ERR, live: false, stateDir });
    expect(readFileSync(path, "utf8")).toBe(before); // no bump, byte-identical
    expect(errFiles(neuronsDir).length).toBe(1); // no new file
    expect(r.context).toContain("would bump");
  });

  it("3. observe-only never writes even for a promotion-threshold error (occurrences frozen)", () => {
    const { root, neuronsDir, stateDir } = setup();
    runHook({ cwd: root, command: "node run.js", errorText: MODULE_ERR, live: true, stateDir }); // occ 1
    runHook({ cwd: root, command: "node run.js", errorText: MODULE_ERR, live: true, stateDir }); // occ 2
    const path = join(neuronsDir, "errors", errFiles(neuronsDir)[0]);
    const before = readFileSync(path, "utf8");
    expect(before).toMatch(/occurrences:\s*2/);
    runHook({ cwd: root, command: "node run.js", errorText: MODULE_ERR, live: false, stateDir }); // would be #3
    expect(readFileSync(path, "utf8")).toBe(before); // frozen at 2, no promotion write
    expect(readdirSync(join(neuronsDir, "patterns")).filter((f) => f.endsWith(".md"))).toEqual([]);
  });

  it("4. live (FACTORY_ALLOW_LIVE_WRITES=true) + NEW error → creates a neuron (legacy)", () => {
    const { root, neuronsDir, stateDir } = setup();
    const r = runHook({ cwd: root, command: "node run.js", errorText: MODULE_ERR, live: true, stateDir });
    expect(r.status).toBe(0);
    expect(errFiles(neuronsDir).length).toBe(1);
    expect(r.context).toContain("New error neuron");
  });

  it("5. live + EXISTING error → bumps occurrences to 2 (legacy)", () => {
    const { root, neuronsDir, stateDir } = setup();
    runHook({ cwd: root, command: "node run.js", errorText: MODULE_ERR, live: true, stateDir });
    const r = runHook({ cwd: root, command: "node run.js", errorText: MODULE_ERR, live: true, stateDir });
    const body = readFileSync(join(neuronsDir, "errors", errFiles(neuronsDir)[0]), "utf8");
    expect(body).toMatch(/occurrences:\s*2/);
    expect(r.context).toContain("occurrence #2");
  });

  it("6. iron-gates state still updates when live writes are DISABLED (Gate 5 intact)", () => {
    const { root, stateDir } = setup();
    runHook({ cwd: root, command: "node run.js", errorText: MODULE_ERR, live: false, stateDir });
    const stateFiles = readdirSync(stateDir).filter((f) => f.endsWith(".json"));
    expect(stateFiles.length).toBeGreaterThan(0);
    const state = JSON.parse(readFileSync(join(stateDir, stateFiles[0]), "utf8"));
    expect(state.active_error).toBeTruthy(); // fingerprint recorded despite no corpus write
  });

  it("7. redaction runs before persistence — a token in the command never reaches the neuron body (live)", () => {
    const { root, neuronsDir, stateDir } = setup();
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    runHook({ cwd: root, command: `deploy --token ${secret}`, errorText: MODULE_ERR, live: true, stateDir });
    const body = readFileSync(join(neuronsDir, "errors", errFiles(neuronsDir)[0]), "utf8");
    expect(body).not.toContain(secret);
    expect(body).toContain("«REDACTED-gh-token»");
  });

  it("8. Gate 2 verification still recorded when live writes are DISABLED", () => {
    const { root, stateDir } = setup();
    // a passing verification command (PostToolUse success path is what records it,
    // but updateIronGatesState runs regardless of the write gate)
    const input = {
      session_id: "g6a-test",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "Tests 10 passed", stderr: "" },
    };
    const env: NodeJS.ProcessEnv = { ...process.env, FACTORY_STATE_DIR: stateDir };
    delete env.FACTORY_ROOT;
    delete env.FACTORY_ALLOW_LIVE_WRITES;
    spawnSync("node", [DIST], { input: JSON.stringify(input), encoding: "utf8", env });
    const stateFiles = readdirSync(stateDir).filter((f) => f.endsWith(".json"));
    expect(stateFiles.length).toBeGreaterThan(0);
    const state = JSON.parse(readFileSync(join(stateDir, stateFiles[0]), "utf8"));
    expect(state.last_verification_at).toBeTruthy();
  });
});
