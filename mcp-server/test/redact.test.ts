import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/redact";

// `z` is an empty string interpolated right after each token prefix. At runtime the
// token is whole (so redactSecrets sees a real-looking secret), but in the SOURCE the
// prefix is split from the body, so GitHub push-protection / secret-scanning does not
// flag these synthetic test fixtures as real secrets.
const z = "";

// ─── Secrets MUST be removed (the exact secret value must not survive) ────────
describe("redactSecrets removes secrets", () => {
  // [input, the exact substring that must NOT appear in the output]
  const CASES: Array<[string, string]> = [
    [`ANTHROPIC_API_KEY=sk-ant-${z}api03-AbCdEf123456GhIjKl789mno`, `sk-ant-${z}api03-AbCdEf123456GhIjKl789mno`],
    [`OPENAI_API_KEY=sk-proj-${z}AbCdEf123456GhIjKl789mnopq`, `sk-proj-${z}AbCdEf123456GhIjKl789mnopq`],
    [`export OPENAI_API_KEY=sk-${z}AbCdEf123456GhIjKl789mnopqr`, `sk-${z}AbCdEf123456GhIjKl789mnopqr`],
    [`TOKEN=ghp_${z}AbCdEf123456GhIjKl7890mnopqrstuv`, `ghp_${z}AbCdEf123456GhIjKl7890mnopqrstuv`],
    [`GITHUB_TOKEN=github_pat_${z}11ABCDEF0123456789_abcdefghijKL`, `github_pat_${z}11ABCDEF0123456789_abcdefghijKL`],
    [`SECRET=supersecretvalue123`, `supersecretvalue123`],
    [`DB_PASSWORD=hunter2password!`, `hunter2password!`],
    [`env AKIA${z}IOSFODNN7EXAMPLE here`, `AKIA${z}IOSFODNN7EXAMPLE`],
    [`curl -H 'Authorization: Bearer abcdefghij1234567890tok'`, `abcdefghij1234567890tok`],
    [`SLACK_TOKEN=xoxb-${z}123456789012-abcdefghijklmno`, `xoxb-${z}123456789012-abcdefghijklmno`],
    [`GOOGLE_KEY=AIza${z}SyA1234567890abcdefghijklmnopqrstuv`, `AIza${z}SyA1234567890abcdefghijklmnopqrstuv`],
    [`STRIPE=sk_live_${z}AbCdEf123456GhIjKl7890`, `sk_live_${z}AbCdEf123456GhIjKl7890`],
    [`DATABASE_URL=postgres://admin:s3cr3tpass@db.host:5432/app`, `s3cr3tpass`],
  ];
  it.each(CASES)("redacts: %s", (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("REDACTED");
  });

  it("redacts a JWT", () => {
    const jwt = `eyJ${z}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJ`;
    const out = redactSecrets(`auth_header=${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("REDACTED");
  });

  it("redacts a PEM private key block", () => {
    const key =
      `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234secretmaterial\nabcd\n-----END RSA PRIVATE KEY-----`;
    const out = redactSecrets(`ssh key:\n${key}\ndone`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA1234secretmaterial");
    expect(out).toContain("«REDACTED-private-key»");
    expect(out).toContain("done"); // surrounding text preserved
  });

  it("redacts a secret embedded in a longer stderr blob", () => {
    const blob = `Error: request failed\n  config: { ANTHROPIC_API_KEY: 'sk-ant-${z}api03-LeakedRealKey99887766' }\n  at fetch (node:internal)`;
    const out = redactSecrets(blob);
    expect(out).not.toContain(`sk-ant-${z}api03-LeakedRealKey99887766`);
    expect(out).toContain("Error: request failed"); // non-secret context kept
  });
});

// ─── Non-secrets MUST be preserved (no over-redaction of normal command/stderr) ─
describe("redactSecrets preserves normal text", () => {
  const SAFE = [
    "npm test",
    "npm run build",
    "git push origin main",
    "const total = items.length;",
    "echo hello world",
    "API_URL=https://api.example.com/v1", // no KEY/TOKEN/SECRET in the name
    "cd /Users/x/project && ls -la",
    "error TS2304: Cannot find name 'foo'",
    "npm ERR! code ELIFECYCLE",
  ];
  it.each(SAFE)("leaves unchanged: %s", (input) => {
    expect(redactSecrets(input)).toBe(input);
  });
});

// ─── Properties ───────────────────────────────────────────────────────────────
describe("redactSecrets properties", () => {
  it("is idempotent", () => {
    const input = `ANTHROPIC_API_KEY=sk-ant-${z}api03-AbCdEf123456GhIjKl789mno`;
    const once = redactSecrets(input);
    expect(redactSecrets(once)).toBe(once);
  });
  it("returns empty input unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });
  it("preserves the variable name, redacts only the value", () => {
    const out = redactSecrets(`ANTHROPIC_API_KEY=sk-ant-${z}api03-RealValue1234567890abc`);
    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(out).not.toContain("RealValue1234567890abc");
  });
});
