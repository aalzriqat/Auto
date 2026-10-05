import { ConvexError, getDocumentSize } from "convex/values";

/**
 * The byte bound of one `financeDealFees` document, enforced at EVERY writer
 * (SCRUM-443).
 *
 * The closing proofs read a deal's cost lines and are budgeted in documents AND
 * bytes; a budget expressed in caps is only true if a document's size is itself
 * capped. Free text (description, receipt reference, void reason, reconciliation
 * notes, a template's copied description) and attachment lists are otherwise
 * unbounded, so one bloated line could push a proof past its byte budget and the
 * deal would read UNAVAILABLE although the ledger is right.
 *
 * 8 KiB. Production audit 2026-09-29: 10 rows, the largest 782 JSON characters,
 * no attachments, `voidReason` at most 46 characters, `receiptReference` at
 * most 17 — roughly a tenth of the bound, so no honest line meets it.
 *
 * Sized with `getDocumentSize` from `convex/values`: the same formula the
 * platform bills reads by (also what `custodySourceLedger.documentBytes` uses).
 */
export const MAX_FEE_DOC_BYTES = 8 * 1024;

/** How many attachments one cost line may carry (readability, and part of the byte bound). */
export const MAX_FEE_ATTACHMENTS = 10;

/** How long a direct payment's free-text reference may be, in characters. */
export const MAX_DIRECT_PAYMENT_REFERENCE_CHARS = 200;

/**
 * Field caps, in JS string length (UTF-16 units) — the input boundary of the
 * byte bound (SCRUM-443 v6). A unit is at most 3 UTF-8 bytes (Arabic is 2, a
 * surrogate pair is 2 per unit), so the worst case of the free text one line
 * can carry is 3 x (description + void reason + reconciliation notes + receipt
 * reference + direct-payment reference) = 3 x 1,700 = 5,100 bytes, leaving
 * ~3,000 of the 8,192 for the fixed fields, ten attachment ids, the custody /
 * direct-payment sub-documents and the ids at production length. The composed
 * worst-case test (`feeDocFieldCaps.test.ts`) measures it.
 *
 * The caps in the brief (1,000 / 500 / 2,000) do not fit at 3 bytes a unit:
 * 3 x 3,500 alone is 10,500 bytes.
 */
export const MAX_FEE_DESCRIPTION_CHARS = 500;
export const MAX_FEE_VOID_REASON_CHARS = 300;
export const MAX_FEE_RECONCILIATION_NOTES_CHARS = 500;
export const MAX_FEE_RECEIPT_REFERENCE_CHARS = 200;

/** The first `max` UTF-16 units of `text`, never splitting a surrogate pair. */
export function truncateFeeText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Refuses, guided and before anything is written, free text past its cap. The
 * server is the authority; the cockpit inputs only mirror it with `maxLength`.
 */
export function assertFeeTextWithinCap(text: string | undefined, max: number, label: string, action: string): void {
  if (text !== undefined && text.length > max) {
    throw new ConvexError(
      `${label} may be at most ${max} characters (this one has ${text.length}), so ${action} is refused. Shorten it and try again. Nothing has been recorded.`
    );
  }
}

/** The value with every `undefined` (a cleared field) removed, recursively — what the platform would store. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (inner !== undefined) out[key] = withoutUndefined(inner);
    }
    return out;
  }
  return value;
}

/** The exact platform size of a cost line as it would be stored. */
export function feeDocBytes(doc: Record<string, unknown>): number {
  // The stored row also carries the platform's `_id` and `_creationTime`; an
  // insert has neither yet, so stand-ins of their real shape are sized in (the
  // proof budgets are charged the STORED row, system fields included).
  const stored = { _id: "0".repeat(32), _creationTime: 1.7e12, ...doc };
  return getDocumentSize(withoutUndefined(stored) as Parameters<typeof getDocumentSize>[0]);
}

/**
 * The LAST-RESORT backstop: refuses, guided and before anything is written, a
 * cost line whose RESULTING document — the row as it will stand after the
 * insert or patch — is past `MAX_FEE_DOC_BYTES`. The field caps above make this
 * unreachable for a row a writer admits (SCRUM-443 v6); it stays at every
 * writer so a legacy or raw-edited row that is already near the bound is
 * refused rather than grown past it.
 */
export function assertFeeDocWithinBytes(doc: Record<string, unknown>, action: string): void {
  const bytes = feeDocBytes(doc);
  if (bytes <= MAX_FEE_DOC_BYTES) return;
  throw new ConvexError(
    `This cost's text and attachments are too large to store (${bytes.toLocaleString("en-US")} of ${MAX_FEE_DOC_BYTES.toLocaleString("en-US")} bytes), so ${action} is refused. Shorten the description, reference or notes, or remove attachments, and try again. Nothing has been recorded.`
  );
}
/** The cost line as it will stand after `patch` is applied (a key set to `undefined` is cleared). */
export function feeAfterPatch<T extends Record<string, unknown>>(fee: T, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...fee, ...patch };
}

/** Refuses an attachment list past `MAX_FEE_ATTACHMENTS`, guided. */
export function assertFeeAttachmentCount(ids: ReadonlyArray<unknown> | undefined, action: string): void {
  if (ids !== undefined && ids.length > MAX_FEE_ATTACHMENTS) {
    throw new ConvexError(
      `A cost line may carry at most ${MAX_FEE_ATTACHMENTS} attachments (this one has ${ids.length}), so ${action} is refused. Remove some and try again. Nothing has been recorded.`
    );
  }
}
