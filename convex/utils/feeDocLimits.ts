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
 * Refuses, guided and before anything is written, a cost line whose RESULTING
 * document — the row as it will stand after the insert or patch — is past
 * `MAX_FEE_DOC_BYTES`. `userFields` names the fields the caller typed
 * (`receiptReference`, `documentStorageIds`, ...): when the line is too big
 * even without them, the text is copied from the finance company's fee template
 * (`financeCompanies.feeTemplates`, frozen onto the application's
 * `companyRuleSnapshot`) and the next step is to edit that template.
 */
export function assertFeeDocWithinBytes(
  doc: Record<string, unknown>,
  action: string,
  userFields: ReadonlyArray<string> = []
): void {
  const bytes = feeDocBytes(doc);
  if (bytes <= MAX_FEE_DOC_BYTES) return;
  if (userFields.length > 0) {
    const stripped: Record<string, unknown> = { ...doc };
    for (const field of userFields) delete stripped[field];
    if (feeDocBytes(stripped) > MAX_FEE_DOC_BYTES) {
      throw new ConvexError(
        `This cost's description (copied from the finance company's fee template) is too large to store (${bytes.toLocaleString("en-US")} of ${MAX_FEE_DOC_BYTES.toLocaleString("en-US")} bytes), so ${action} is refused. Edit the fee template in the finance company's settings to shorten it, then record the cost again. Nothing has been recorded.`
      );
    }
  }
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
