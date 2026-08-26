/**
 * SCRUM-195 — stable operation identity for `quotes.saveQuote`.
 *
 * ## Why a quote needs an identity at all
 *
 * A saved quote can open a commitment root, and a root is what holds a physical
 * car. So a double-submitted quote is not a cosmetic duplicate in a list: it is
 * a second claimant on the same vehicle, created by one customer intention.
 * Retries happen for ordinary reasons — a tapped button on a slow connection, a
 * dropped response on mobile data — and none of them mean the customer asked
 * for two deals.
 *
 * ## Why the key is DERIVED rather than generated
 *
 * The obvious approach is a random id minted when the form opens. It is wrong
 * in a way that only shows up in use: the server treats *same key, materially
 * different payload* as a conflict, so a salesperson who goes back, changes the
 * price and resubmits would hit a refusal for doing something completely
 * legitimate.
 *
 * Deriving the key from the payload gets both halves right without any state:
 * an identical resubmission carries the same key and returns the same quote,
 * while an edited one carries a different key and is a new revision. It also
 * makes the conflict branch genuinely unreachable from these clients, which is
 * where you want it — as a guard against a caller that reuses a key wrongly,
 * not as something users meet.
 *
 * And when two truly identical quotes collapse into one, that is the correct
 * answer rather than a lost feature: two identical live deals for one customer
 * on one car is precisely the duplicate root this design exists to prevent.
 *
 * ## Why not JSON.stringify
 *
 * Property order is insertion order, so the same quote built through two code
 * paths can serialise differently and produce two keys. `undefined` is dropped
 * from objects but becomes `null` inside arrays. Both make the key unstable in
 * exactly the situations it is meant to survive, so the canonical form below
 * sorts keys and omits `undefined` explicitly.
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
 * A stable key for one quote intention.
 *
 * Two hashes over the same text, combined with its length. A single 32-bit hash
 * collides often enough to matter at dealership volumes, and a collision here
 * does not merely mis-file something — it returns somebody else's quote id to
 * this caller.
 */
export function stableQuoteIdempotencyKey(payload: unknown): string {
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
  return `q_${a}${b}_${text.length.toString(36)}`;
}
