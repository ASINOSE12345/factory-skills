// src/redact.ts
//
// Redact secrets from text BEFORE it is persisted (error neurons, iron-gates state).
// auto-capture writes commands and stderr to disk; either can contain API keys,
// tokens, or passwords. A real leak already happened (an ANTHROPIC_API_KEY landed
// in a neuron), so this is not theoretical.
//
// DESIGN: fail-safe / over-redact. Better to redact a non-secret than to leak one.
// This is a best-effort textual scrubber, NOT a cryptographic guarantee — a novel
// secret format can still slip through; pair it with not echoing secrets in the
// first place. Every rule biases toward redaction.

interface Rule {
  re: RegExp;
  replace: string;
}

// Order matters: multi-line blocks and provider-specific high-confidence tokens
// run before the broad NAME=value rule so the specific labels survive.
const RULES: Rule[] = [
  // Multi-line PEM private keys (any flavor).
  {
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replace: "«REDACTED-private-key»",
  },
  // Anthropic (must precede the generic sk- rule).
  { re: /\bsk-ant-[A-Za-z0-9_-]{12,}/g, replace: "«REDACTED-anthropic-key»" },
  // OpenAI / generic sk- keys (sk-, sk-proj-, sk-live-, …).
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: "«REDACTED-sk-key»" },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained PATs.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: "«REDACTED-gh-token»" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: "«REDACTED-gh-pat»" },
  // AWS access key id.
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "«REDACTED-aws-key»" },
  // Slack tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: "«REDACTED-slack-token»" },
  // Google API keys.
  { re: /\bAIza[A-Za-z0-9_-]{35}\b/g, replace: "«REDACTED-google-key»" },
  // Stripe live/test keys.
  { re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: "«REDACTED-stripe-key»" },
  // JWTs (header.payload.signature).
  { re: /\beyJ[A-Za-z0-9_=-]{8,}\.eyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}/g, replace: "«REDACTED-jwt»" },
  // Authorization headers.
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: "$1 «REDACTED»" },
  // Connection strings with inline credentials: scheme://user:PASS@host
  { re: /\b([a-z][a-z0-9+.\-]*:\/\/[^:@\s/]+:)([^@\s/]+)(@)/gi, replace: "$1«REDACTED»$3" },
  // NAME=value or "name": value where NAME looks secret. The (?!«) guard avoids
  // double-redacting a value already replaced by a specific rule above.
  {
    re: /\b([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PWD|AUTH|CREDENTIAL|PRIVATE)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(["']?)(?!«)([^\s"',;|&)]+)\3/gi,
    replace: "$1$2$3«REDACTED»$3",
  },
];

/**
 * Redact likely secrets from a string. Idempotent (running it twice is a no-op on
 * already-redacted text). Returns the input unchanged when empty.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, replace } of RULES) out = out.replace(re, replace);
  return out;
}
