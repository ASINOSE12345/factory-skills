/**
 * External source ledger — MINIMAL by design (CP2A).
 *
 * The reflection engine works on the local corpus only. When a finding's
 * recommendation would genuinely need EXTERNAL context (an upstream doc, an
 * issue, a commit), we do NOT fetch it — there is no free web access here.
 * Instead the request is REGISTERED: validated and recorded, so a human (or a
 * later, explicitly-enabled phase) can act on it. The planner can pair this with
 * a `schedule_external_review` action.
 *
 * Validation is conservative: bounded length, a tight character class, no
 * spaces. This module never performs network I/O.
 */

export type ExternalSourceKind = "doc" | "issue" | "commit" | "url" | "other";

export interface ExternalSourceRef {
  kind: ExternalSourceKind;
  /** A URL or identifier — validated, recorded, NEVER fetched. */
  ref: string;
  /** Why this external source is relevant. */
  reason: string;
}

const KINDS: readonly ExternalSourceKind[] = ["doc", "issue", "commit", "url", "other"];

// Conservative: word chars plus a small punctuation set, bounded, no spaces.
const SAFE_REF = /^[\w./:#@?=&%-]{1,300}$/;

/**
 * Validate an external-source reference. Returns the normalized ref, or null if
 * invalid. Performs NO fetching.
 */
export function validateExternalRef(
  kind: string,
  ref: string,
  reason: string,
): ExternalSourceRef | null {
  if (!KINDS.includes(kind as ExternalSourceKind)) return null;
  if (typeof ref !== "string" || !SAFE_REF.test(ref)) return null;
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 500) return null;
  return { kind: kind as ExternalSourceKind, ref, reason };
}

/** Append-only, in-memory registry of external-review requests. */
export class ExternalSourceLedger {
  private refs: ExternalSourceRef[] = [];

  /** Register a request. Returns the validated ref, or null if rejected. */
  register(kind: string, ref: string, reason: string): ExternalSourceRef | null {
    const valid = validateExternalRef(kind, ref, reason);
    if (valid) this.refs.push(valid);
    return valid;
  }

  all(): readonly ExternalSourceRef[] {
    return this.refs;
  }
}
