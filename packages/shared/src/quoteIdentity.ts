/**
 * SCRUM-195 — operation identity and payload fingerprinting for `saveQuote`.
 *
 * ## Two different questions, deliberately kept apart (owner ruling c14977)
 *
 * An earlier version of this module answered both with one value: it hashed the
 * quote payload and used that as the idempotency key. That conflates *content
 * identity* with *operation identity*, and the consequence is not subtle — two
 * legitimate quote intentions with identical terms, the same customer asking
 * again next week for the same car at the same price, could never both exist.
 * They collapsed onto the first quote id forever.
 *
 * Idempotency answers **"is this the same submission attempt as the one whose
 * response I lost?"** It is not a uniqueness constraint on business content,
 * and a quote is informational until evidence attaches to it — nothing is held,
 * nobody is committed, and there is no reason a customer may not be quoted the
 * same thing twice.
 *
 * So:
 *
 *   - `newQuoteOperationKey()` mints an id for ONE submission attempt. The
 *     client keeps it while retrying that attempt and rotates it once the save
 *     is acknowledged. A new user intention gets a new key.
 *   - `canonicalRequestFingerprint()` describes WHAT was asked for. The server
 *     stores it and compares it when a key comes back, so a reused key carrying
 *     different terms is a contradiction rather than a silent old answer.
 *
 * The fingerprint is still needed and still exact; it just is not the identity.
 */

/** Deterministic serialisation: sorted keys, `undefined` omitted, arrays ordered. */
function canonicalise(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(",")}}`;
}

/**
 * A fingerprint of everything that was asked for.
 *
 * ⚠️ Feed this the WHOLE material request, not a chosen subset. The first
 * server-side implementation compared seven remembered fields, so a reused key
 * carrying a changed finance company, margin, financed amount, recipient or
 * secondary vehicle line silently returned the earlier quote — a different
 * promise to the customer, answered with an older one. A list of fields is a
 * thing people forget to extend; a fingerprint over the whole object is not.
 *
 * Not `JSON.stringify`: property order is insertion order, so the same request
 * built through two code paths serialises differently, and `undefined` is
 * dropped from objects while becoming `null` inside arrays. Both would make a
 * genuine retry look like a contradiction.
 *
 * Two hashes plus length, because one 32-bit hash collides often enough to
 * matter over short, highly similar payloads — and a collision here would let a
 * changed request pass as a retry.
 */
export function canonicalRequestFingerprint(payload: unknown): string {
  const text = canonicalise(payload);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 + code, 0x85ebca6b) ^ (h2 >>> 13);
  }
  const a = (h1 >>> 0).toString(36);
  const b = (h2 >>> 0).toString(36);
  return `f_${a}${b}_${text.length.toString(36)}`;
}

/**
 * A fresh id for ONE submission attempt.
 *
 * Deliberately unrelated to the payload: two identical submissions are two
 * submissions. Keep it across retries of the same attempt so a lost response
 * can be recovered, and rotate it once the save is acknowledged so the next
 * thing the user does is a new intention.
 *
 * Built from time plus randomness rather than `crypto.randomUUID`, which is not
 * available on every React Native runtime this ships to. Uniqueness only has to
 * hold within one organisation's quote history, and the server treats a
 * duplicate as a retry — which, for two genuinely different requests, surfaces
 * as a loud conflict rather than a wrong answer.
 */
export function newQuoteOperationKey(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  const more = Math.random().toString(36).slice(2, 10);
  return `op_${time}_${rand}${more}`;
}

/** What a client remembers between a failed save and the next attempt. */
export type PendingQuoteAttempt = { key: string; fingerprint: string } | null;

/**
 * Decide whether the next submission is a RETRY of the pending attempt or a NEW
 * intention, and give it the right operation key.
 *
 * ⚠️ Keeping only the key was not enough, and the gap is a real one. Suppose the
 * server commits but the response is lost. The salesperson sees a failure,
 * changes the price, and submits again. Holding the key alone, the client sends
 * the SAME key with different terms — the server correctly refuses as a
 * contradiction, and the salesperson is blocked from doing something entirely
 * reasonable, with a message about a request id that means nothing to them.
 *
 * From the user's point of view that edit IS a new intention. So the client
 * remembers what it asked for as well as which attempt it was, and rotates the
 * key the moment those diverge. Retry the same thing → same key, and the lost
 * response is recovered. Change anything → new key, and it is a new quote.
 *
 * Shared rather than written four times: this is the kind of rule that drifts
 * apart per platform and then only misbehaves on the one nobody re-checked.
 */
export function resolveQuoteOperationKey(
  pending: PendingQuoteAttempt,
  materialRequest: unknown
): { key: string; fingerprint: string } {
  const fingerprint = canonicalRequestFingerprint(materialRequest);
  if (pending && pending.fingerprint === fingerprint) return pending;
  return { key: newQuoteOperationKey(), fingerprint };
}
