import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import {
  factoryStateDir,
  ironGatesStateDir,
  planGateStateFile,
  planGateMetricsFile,
  ironGatesOverrideFile,
} from "../src/runtime-paths";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });
function clearEnv() {
  delete process.env.FACTORY_STATE_DIR;
  delete process.env.IRON_GATES_STATE_DIR;
}

describe("runtime-paths — default is EXACTLY /tmp (no behavior change)", () => {
  it("every path defaults to /tmp/...", () => {
    clearEnv();
    expect(factoryStateDir()).toBe("/tmp");
    expect(planGateStateFile()).toBe("/tmp/plan-gate-state.json");
    expect(planGateMetricsFile()).toBe("/tmp/plan-gate-metrics.json");
    expect(ironGatesOverrideFile()).toBe("/tmp/iron-gates-override.json");
    expect(ironGatesStateDir()).toBe("/tmp");
  });
});

describe("FACTORY_STATE_DIR — central knob", () => {
  it("all paths derive from FACTORY_STATE_DIR", () => {
    clearEnv();
    process.env.FACTORY_STATE_DIR = "/x/state";
    expect(factoryStateDir()).toBe("/x/state");
    expect(planGateStateFile()).toBe(join("/x/state", "plan-gate-state.json"));
    expect(planGateMetricsFile()).toBe(join("/x/state", "plan-gate-metrics.json"));
    expect(ironGatesOverrideFile()).toBe(join("/x/state", "iron-gates-override.json"));
    expect(ironGatesStateDir()).toBe("/x/state"); // no IRON_GATES_STATE_DIR → uses central
  });
});

describe("IRON_GATES_STATE_DIR — back-compat alias (iron-gates state only)", () => {
  it("controls ONLY the iron-gates state dir when FACTORY_STATE_DIR is unset", () => {
    clearEnv();
    process.env.IRON_GATES_STATE_DIR = "/x/legacy";
    expect(ironGatesStateDir()).toBe("/x/legacy");
    // central + plan-gate/override remain at the /tmp default
    expect(factoryStateDir()).toBe("/tmp");
    expect(planGateStateFile()).toBe("/tmp/plan-gate-state.json");
    expect(ironGatesOverrideFile()).toBe("/tmp/iron-gates-override.json");
  });

  it("PRECEDENCE when BOTH set: IRON_GATES_STATE_DIR wins for iron-gates state; everything else uses FACTORY_STATE_DIR", () => {
    clearEnv();
    process.env.FACTORY_STATE_DIR = "/x/state";
    process.env.IRON_GATES_STATE_DIR = "/x/legacy";
    expect(ironGatesStateDir()).toBe("/x/legacy"); // legacy-specific wins (documented)
    expect(planGateStateFile()).toBe(join("/x/state", "plan-gate-state.json"));
    expect(planGateMetricsFile()).toBe(join("/x/state", "plan-gate-metrics.json"));
    expect(ironGatesOverrideFile()).toBe(join("/x/state", "iron-gates-override.json"));
  });
});
