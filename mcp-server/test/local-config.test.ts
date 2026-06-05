import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveNodeBin,
  factoryNeuronsEntry,
  applyMcpConfig,
  rebuildHookCommand,
  applySettings,
  validateConfigText,
  runGenerate,
  runValidate,
} from "../src/local-config";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "cfg-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const O = { nodeBin: "/nb/node", runtimeRoot: "/rr", factoryRoot: "/fr" };

describe("resolveNodeBin — explicit → FACTORY_NODE_BIN → process.execPath (no pin)", () => {
  it("explicit --node-bin wins", () => {
    expect(resolveNodeBin({ nodeBin: "/y/node", env: { FACTORY_NODE_BIN: "/x/node" } as NodeJS.ProcessEnv })).toBe("/y/node");
  });
  it("FACTORY_NODE_BIN when no explicit", () => {
    expect(resolveNodeBin({ env: { FACTORY_NODE_BIN: "/x/node" } as NodeJS.ProcessEnv })).toBe("/x/node");
  });
  it("falls back to process.execPath", () => {
    expect(resolveNodeBin({ env: {} as NodeJS.ProcessEnv })).toBe(process.execPath);
  });
});

describe("pure generators", () => {
  it("factory-neurons points to the launcher (not the key)", () => {
    const e = factoryNeuronsEntry(O);
    expect(e.command).toBe("/nb/node");
    expect(e.args).toEqual(["/rr/mcp-server/bin/factory-neurons-with-gemini.mjs", "/fr"]);
  });
  it("applyMcpConfig replaces factory-neurons and PRESERVES factory-code-graph", () => {
    const existing = { mcpServers: { "factory-code-graph": { command: "X", args: ["a"] }, "factory-neurons": { command: "OLD", args: ["OLD"] } } };
    const next = applyMcpConfig(existing, O) as any;
    expect(next.mcpServers["factory-code-graph"]).toEqual({ command: "X", args: ["a"] }); // preserved
    expect(next.mcpServers["factory-neurons"].args[0]).toBe("/rr/mcp-server/bin/factory-neurons-with-gemini.mjs");
  });
  it("rebuildHookCommand rebuilds factory hooks; bootstrap keeps the root arg", () => {
    expect(rebuildHookCommand("OLDNODE /old/dist/iron-gates.js", O)).toBe("/nb/node /rr/mcp-server/dist/iron-gates.js");
    expect(rebuildHookCommand("OLDNODE /old/dist/bootstrap-hook.js /old", O)).toBe("/nb/node /rr/mcp-server/dist/bootstrap-hook.js /fr");
  });
  it("rebuildHookCommand PRESERVES foreign hooks verbatim", () => {
    const foreign = "/bin/bash /Users/x/.claude/bin/claude-snapshot-loader.sh";
    expect(rebuildHookCommand(foreign, O)).toBe(foreign);
  });
  it("applySettings rebuilds factory hooks, preserves unrelated ones", () => {
    const settings = { hooks: { PreToolUse: [
      { matcher: "Bash", hooks: [{ command: "OLDNODE /old/dist/iron-gates.js" }] },
      { matcher: "*", hooks: [{ command: "/bin/bash /x/claude-snapshot-loader.sh" }] },
    ] } };
    const next = applySettings(settings, O) as any;
    expect(next.hooks.PreToolUse[0].hooks[0].command).toBe("/nb/node /rr/mcp-server/dist/iron-gates.js");
    expect(next.hooks.PreToolUse[1].hooks[0].command).toBe("/bin/bash /x/claude-snapshot-loader.sh"); // preserved
  });
});

describe("validateConfigText — secrets / CP3 env / JSON", () => {
  it("flags secret-like tokens", () => {
    expect(validateConfigText("mcp", '{"x":"AIzaABC"}').some((e) => /secret/.test(e))).toBe(true);
    expect(validateConfigText("mcp", '{"k":"sk-ant-xxxxxxxxxxxx"}').some((e) => /secret/.test(e))).toBe(true);
  });
  it("flags CP3/live-write env in config", () => {
    expect(validateConfigText("mcp", '{"env":{"FACTORY_STAGING_DIR":"/x"}}').some((e) => /CP3/.test(e))).toBe(true);
  });
  it("flags invalid JSON", () => {
    expect(validateConfigText("mcp", "{ not json").some((e) => /invalid JSON/.test(e))).toBe(true);
  });
  it("passes clean config", () => {
    expect(validateConfigText("mcp", '{"mcpServers":{}}')).toEqual([]);
  });
});

describe("runGenerate — dry-run vs --write (real temp fixtures, never real config)", () => {
  function fixtures() {
    const d = tmp();
    const mcpPath = join(d, ".mcp.json");
    const settingsPath = join(d, "settings.json");
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { "factory-code-graph": { command: "X", args: ["a"] }, "factory-neurons": { command: "OLD", args: ["OLD/server.js", "/old"] } } }));
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "OLDNODE /old/dist/iron-gates.js" }] }, { matcher: "*", hooks: [{ command: "/bin/bash /x/snap.sh" }] }] } }));
    return { mcpPath, settingsPath };
  }

  it("dry-run writes NOTHING", () => {
    const { mcpPath, settingsPath } = fixtures();
    const before = readFileSync(mcpPath, "utf-8");
    const r = runGenerate({ factoryRoot: "/fr", runtimeRoot: "/rr", nodeBin: "/nb/node", mcpPath, settingsPath, write: false });
    expect(r.wrote).toBe(false);
    expect(r.backups).toEqual([]);
    expect(readFileSync(mcpPath, "utf-8")).toBe(before); // untouched
  });

  it("--write backs up and updates ONLY expected entries", () => {
    const { mcpPath, settingsPath } = fixtures();
    const r = runGenerate({ factoryRoot: "/fr", runtimeRoot: "/rr", nodeBin: "/nb/node", mcpPath, settingsPath, write: true });
    expect(r.wrote).toBe(true);
    expect(existsSync(`${mcpPath}.bak-pre-factory-config`)).toBe(true);
    expect(existsSync(`${settingsPath}.bak-pre-factory-config`)).toBe(true);
    const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(mcp.mcpServers["factory-code-graph"]).toEqual({ command: "X", args: ["a"] }); // preserved
    expect(mcp.mcpServers["factory-neurons"].args[0]).toBe("/rr/mcp-server/bin/factory-neurons-with-gemini.mjs");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("/nb/node /rr/mcp-server/dist/iron-gates.js");
    expect(settings.hooks.PreToolUse[1].hooks[0].command).toBe("/bin/bash /x/snap.sh"); // foreign preserved
  });
});

describe("runValidate — fs + node + settings checks (temp fixtures)", () => {
  const NODE = process.execPath; // an existing node binary
  function goodRuntime() {
    const rr = tmp();
    mkdirSync(join(rr, "mcp-server", "bin"), { recursive: true });
    mkdirSync(join(rr, "mcp-server", "dist"), { recursive: true });
    writeFileSync(join(rr, "mcp-server", "bin", "factory-neurons-with-gemini.mjs"), "//launcher");
    for (const h of ["bootstrap-hook.js", "iron-gates.js", "plan-gate.js", "auto-capture.js"]) writeFileSync(join(rr, "mcp-server", "dist", h), "//hook");
    return rr;
  }
  // A fully-correct fixture; individual tests mutate one thing to make it fail.
  function fullFixture(over: { mcp?: any; settings?: any } = {}) {
    const rr = goodRuntime();
    const fr = tmp();
    const launcher = join(rr, "mcp-server/bin/factory-neurons-with-gemini.mjs");
    const dist = join(rr, "mcp-server/dist");
    const mcpPath = join(tmp(), ".mcp.json");
    const settingsPath = join(tmp(), "settings.json");
    const mcp = over.mcp ?? { mcpServers: {
      "factory-code-graph": { command: NODE, args: ["x"] },
      "factory-neurons": { command: NODE, args: [launcher, fr] },
    } };
    const settings = over.settings ?? { hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ command: `${NODE} ${join(dist, "iron-gates.js")}` }] },
        { matcher: "*", hooks: [{ command: "/bin/bash /x/claude-snapshot-loader.sh" }] }, // foreign, ignored
      ],
      SessionStart: [{ matcher: "*", hooks: [{ command: `${NODE} ${join(dist, "bootstrap-hook.js")} ${fr}` }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [
        { command: `${NODE} ${join(dist, "plan-gate.js")}` },
        { command: `${NODE} ${join(dist, "auto-capture.js")}` },
      ] }],
    } };
    writeFileSync(mcpPath, JSON.stringify(mcp));
    writeFileSync(settingsPath, JSON.stringify(settings));
    return { rr, fr, launcher, dist, mcpPath, settingsPath };
  }

  it("passes on a fully-correct fixture (and ignores foreign hooks)", () => {
    const { rr, fr, mcpPath, settingsPath } = fullFixture();
    const r = runValidate({ runtimeRoot: rr, factoryRoot: fr, mcpPath, settingsPath, nodeBin: NODE });
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual(expect.arrayContaining(["factory-neurons node exists", "factory-neurons root matches", "factory-code-graph preserved", "settings iron-gates.js → runtime dist"]));
  });

  it("FAILS when factory-neurons.command (node) does not exist", () => {
    const { rr, fr, launcher } = fullFixture();
    const mcpPath = join(tmp(), ".mcp.json");
    const settingsPath = join(tmp(), "settings.json");
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { "factory-neurons": { command: "/no/such/node", args: [launcher, fr] } } }));
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
    const r = runValidate({ runtimeRoot: rr, factoryRoot: fr, mcpPath, settingsPath });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /node binary missing/.test(e))).toBe(true);
  });

  it("FAILS when factory-neurons args[1] points to a different factoryRoot", () => {
    const { rr, fr, launcher, settingsPath } = fullFixture();
    const mcpPath = join(tmp(), ".mcp.json");
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { "factory-neurons": { command: NODE, args: [launcher, "/some/other/root"] } } }));
    const r = runValidate({ runtimeRoot: rr, factoryRoot: fr, mcpPath, settingsPath });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /project root .* != factoryRoot/.test(e))).toBe(true);
  });

  it("FAILS when the launcher is missing", () => {
    const { rr, fr, settingsPath } = fullFixture();
    const mcpPath = join(tmp(), ".mcp.json");
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { "factory-neurons": { command: NODE, args: ["/does/not/exist/factory-neurons-with-gemini.mjs", fr] } } }));
    const r = runValidate({ runtimeRoot: rr, factoryRoot: fr, mcpPath, settingsPath });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /launcher missing/.test(e))).toBe(true);
  });

  it("FAILS when a settings factory hook points to a STALE runtime", () => {
    const { rr, fr, mcpPath, dist } = fullFixture();
    const settingsPath = join(tmp(), "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ command: `${NODE} /OLD/runtime/mcp-server/dist/iron-gates.js` }] }],
      SessionStart: [{ matcher: "*", hooks: [{ command: `${NODE} ${join(dist, "bootstrap-hook.js")} ${fr}` }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [
        { command: `${NODE} ${join(dist, "plan-gate.js")}` },
        { command: `${NODE} ${join(dist, "auto-capture.js")}` },
      ] }],
    } }));
    const r = runValidate({ runtimeRoot: rr, factoryRoot: fr, mcpPath, settingsPath, nodeBin: NODE });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /iron-gates\.js hook does not point to runtime dist/.test(e))).toBe(true);
  });

  it("FAILS when a settings factory hook uses a non-existent node binary", () => {
    const { rr, fr, mcpPath, dist } = fullFixture();
    const settingsPath = join(tmp(), "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ command: `/no/such/node ${join(dist, "iron-gates.js")}` }] }],
      SessionStart: [{ matcher: "*", hooks: [{ command: `${NODE} ${join(dist, "bootstrap-hook.js")} ${fr}` }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [
        { command: `${NODE} ${join(dist, "plan-gate.js")}` },
        { command: `${NODE} ${join(dist, "auto-capture.js")}` },
      ] }],
    } }));
    const r = runValidate({ runtimeRoot: rr, factoryRoot: fr, mcpPath, settingsPath });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /iron-gates\.js node binary missing/.test(e))).toBe(true);
  });

  it("FAILS when a secret appears in a config", () => {
    const { rr, fr, launcher, settingsPath } = fullFixture();
    const mcpPath = join(tmp(), ".mcp.json");
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { "factory-neurons": { command: NODE, args: [launcher, fr], env: { GEMINI_API_KEY: "AIzaXXX" } } } }));
    const r = runValidate({ runtimeRoot: rr, factoryRoot: fr, mcpPath, settingsPath });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /secret/.test(e))).toBe(true);
  });
});
