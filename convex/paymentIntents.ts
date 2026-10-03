// ⚠️ SCRUM-302 — imported FIRST, deliberately. `utils/orgLifecycle` and
// `utils/webhookLog` are leaves: neither imports anything from this
// application. Appended at the END of an import block, the binding was
// still uninitialized when a module cycle re-entered this file mid-init
// (`Cannot access '__vite_ssr_import_9__' before initialization`, thrown
// from enqueuePendingPost under full-suite ordering only). A leaf with no
// app edges is safe to initialize before anything that can participate in
// a cycle, so it goes above every local import.
import { orgEconomicLifecycleBlock } from "./utils/orgLifecycle";
import { recordWebhookLog } from "./utils/webhookLog";
import { v } from "convex/values";
import { query, internalQuery, MutationCtx } from "./_generated/server";
import { mutation, internalMutation } from "./functions";
import { paginationOptsValidator } from "convex/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { hookPaymentLinkReceived } from "./accounting/workflowHooks";
import { allocatePaymentToReceivable, createCanonicalPayment, getReceivableOutstandingMinor } from "./subledger";
import { AppErrorCode, throwAppError } from "./utils/errors";
import { PAYMENT_LINKS_PILOT_DISABLED, refuseSaleDebt } from "./utils/saleDebtContainment";
import { fromMinorUnits, toMinorUnits, scaleForCurrency, assertValidMinorAmount } from "./utils/money";

// SCRUM-571 S1. Every refusal `create`, `markSettled` and `expire` can raise is
// coded so the dialogs render it translated. English text equals
// `ServerError_<code>` in lib/i18n/domains/common.ts.
export const PAYMENT_LINK_REFUSALS = {
  PAYMENT_LINK_TARGET_REQUIRED:
    "A payment link must be created against a specific receivable, sale or receivable document. Nothing has been changed.",
  PAYMENT_LINK_EXCEEDS_OUTSTANDING:
    "The payment link amount cannot exceed what is still owed on this debt, less payment links already sent and not yet paid. Expiring an unpaid link frees its amount. Nothing has been changed.",
  PAYMENT_LINK_NOT_FOUND: "This payment link could not be found. Nothing has been changed.",
  PAYMENT_LINK_NOT_PENDING:
    "Only a payment link that is still waiting for payment can be expired. Nothing has been changed.",
  PAYMENT_LINK_AMOUNT_NOT_POSITIVE: "The payment link amount must be greater than zero. Nothing has been changed.",
  PAYMENT_LINK_PROVIDER_REQUIRED: "Choose a payment provider for the payment link. Nothing has been changed.",
  PAYMENT_LINK_CURRENCY_REQUIRED: "The payment link needs a currency. Nothing has been changed.",
  PAYMENT_LINK_CHECKOUT_URL_INVALID:
    "The checkout URL is not a valid web address. Check it and try again. Nothing has been changed.",
  PAYMENT_LINK_CHECKOUT_URL_NOT_HTTPS: "The checkout URL must start with https://. Nothing has been changed.",
  PAYMENT_LINK_EXTERNAL_ID_REQUIRED:
    "Enter the provider reference when a checkout URL is supplied. Nothing has been changed.",
  PAYMENT_LINK_CUSTOMER_NOT_FOUND: "This customer could not be found. Nothing has been changed.",
  PAYMENT_LINK_CUSTOMER_REMOVED:
    "This customer has been removed and can no longer be sent a payment link. Nothing has been changed.",
  PAYMENT_LINK_RECEIVABLE_NOT_FOUND: "This receivable could not be found. Nothing has been changed.",
  PAYMENT_LINK_RECEIVABLE_CUSTOMER_MISMATCH:
    "This receivable belongs to a different customer. Nothing has been changed.",
  PAYMENT_LINK_RECEIVABLE_NO_DOCUMENT:
    "This receivable has no accounting document to collect against, so a payment link cannot be created for it. Nothing has been changed.",
  PAYMENT_LINK_RECEIVABLE_DOCUMENT_MISMATCH:
    "The selected receivable document does not belong to the selected receivable. Nothing has been changed.",
  PAYMENT_LINK_SALE_NOT_FOUND: "This sale could not be found. Nothing has been changed.",
  PAYMENT_LINK_SALE_CUSTOMER_MISMATCH: "This sale belongs to a different customer. Nothing has been changed.",
  PAYMENT_LINK_SALE_NO_DOCUMENT:
    "This sale has no accounting document to collect against yet. Nothing has been changed.",
  PAYMENT_LINK_SALE_DEBT_MISMATCH:
    "The selected sale does not match the selected debt. Choose a matching sale and debt. Nothing has been changed.",
  PAYMENT_LINK_DOCUMENT_NOT_FOUND: "This receivable document could not be found. Nothing has been changed.",
  PAYMENT_LINK_DOCUMENT_PAYER_MISMATCH:
    "This receivable document belongs to a different payer than the selected customer. Nothing has been changed.",
  PAYMENT_LINK_DOCUMENT_CURRENCY_MISMATCH:
    "The payment link currency must match the currency of the debt. Nothing has been changed.",
  PAYMENT_LINK_DEBT_CLOSED: "This debt can no longer accept payments. Nothing has been changed.",
  PAYMENT_LINK_EXCEEDS_RECEIVABLE:
    "The payment link amount cannot exceed what is still owed on this receivable. Nothing has been changed.",
  PAYMENT_LINK_PROVIDER_ID_IN_USE:
    "A payment link with this provider reference already exists. Use a different reference. Nothing has been changed.",
  PAYMENT_LINK_NOT_SETTLEABLE:
    "Only a payment link that is still waiting for payment can be marked settled. Nothing has been changed.",
  PAYMENT_LINK_PROVIDER_ID_MISMATCH:
    "The settlement ID does not match this payment link's provider reference. Check it and try again. Nothing has been changed.",
  PAYMENT_LINK_PROVIDER_REFERENCE_UNAVAILABLE:
    "This provider reference is unavailable. Ask finance to review it. Nothing has been changed.",
  PAYMENT_LINK_SETTLEMENT_REQUIRES_REVIEW:
    "This payment must be reviewed before the link can be marked settled. Nothing has been changed.",
  PAYMENT_LINK_CAPTURE_HELD:
    "The provider confirmed a capture for this link. It is held for review and the link cannot be expired. Ask finance to review the held payment. Nothing has been changed.",
} as const satisfies Record<string, string>;

function refusePaymentLink(code: keyof typeof PAYMENT_LINK_REFUSALS): never {
  return throwAppError(AppErrorCode[code], PAYMENT_LINK_REFUSALS[code]);
}

// SCRUM-571 D-8. Refusals of `resolveUnmatchedProviderFunds`. Kept apart from
// PAYMENT_LINK_REFUSALS, whose test asserts every key there is exercised by the
// payment-link dialogs. English text equals `ServerError_<code>` in
// lib/i18n/domains/common.ts.
export const UNMATCHED_FUNDS_REFUSALS = {
  UNMATCHED_FUNDS_NOT_FOUND: "This held payment could not be found. Nothing has been changed.",
  UNMATCHED_FUNDS_ALREADY_RESOLVED: "This held payment has already been marked as resolved. Nothing has been changed.",
  UNMATCHED_FUNDS_NOTE_REQUIRED:
    "Enter a note describing how this payment was handled. Nothing has been changed.",
  UNMATCHED_FUNDS_NOTE_TOO_LONG: "The note is too long. Shorten it to 1000 characters or fewer. Nothing has been changed.",
} as const satisfies Record<string, string>;

// SCRUM-571 S1 (D-22). Refusals of `linkHeldCaptureToIntent` (a missing or
// foreign row reuses UNMATCHED_FUNDS_NOT_FOUND). Kept apart from
// UNMATCHED_FUNDS_REFUSALS, whose test exercises every key through `resolve`.
// English text equals `ServerError_<code>` in lib/i18n/domains/common.ts.
export const HELD_CAPTURE_LINK_REFUSALS = {
  UNMATCHED_FUNDS_NO_INTENT:
    "This held payment is not linked to a payment link, so there is nothing to repair. Nothing has been changed.",
  UNMATCHED_FUNDS_INTENT_NOT_FOUND:
    "The payment link for this held payment could not be found. Nothing has been changed.",
  UNMATCHED_FUNDS_INTENT_MISMATCH:
    "This held payment does not match the payment link's provider reference. Ask support to investigate. Nothing has been changed.",
  UNMATCHED_FUNDS_INTENT_NOT_LINKABLE:
    "This payment link is not in a state that can be linked to the held payment. Nothing has been changed.",
} as const satisfies Record<string, string>;

function refuseHeldCaptureLink(code: keyof typeof HELD_CAPTURE_LINK_REFUSALS): never {
  return throwAppError(AppErrorCode[code], HELD_CAPTURE_LINK_REFUSALS[code]);
}

const UNMATCHED_FUNDS_NOTE_MAX = 1000;
// The most recent distinct provider event ids kept per held capture.
const UNMATCHED_FUNDS_EVENT_IDS_MAX = 20;
// Rows returned by `listUnmatchedProviderFunds` (OPEN first, then RESOLVED).
const HELD_LIST_LIMIT = 100;

/**
 * What `settleByExternalId` did with a verified capture. HELD carries the id of
 * the durable unmatched-funds row, so the HTTP route cannot acknowledge a
 * capture that has neither a settlement nor a held record.
 */
export type SettleOutcome =
  | { kind: "SETTLED"; intentId: Id<"paymentIntents"> }
  | { kind: "ALREADY_SETTLED"; intentId: Id<"paymentIntents"> }
  | { kind: "HELD"; heldId: Id<"unmatchedProviderFunds"> };

function refuseUnmatchedFunds(code: keyof typeof UNMATCHED_FUNDS_REFUSALS): never {
  return throwAppError(AppErrorCode[code], UNMATCHED_FUNDS_REFUSALS[code]);
}

/**
 * SCRUM-571 D-14. Once ANY `unmatchedProviderFunds` row exists for a (provider,
 * externalId), in any state, that identity is quarantined: a verified capture
 * ends in exactly one settlement OR exactly one held row, never both, and the
 * money may already have been recorded by finance through the receipt flow. No
 * door may create an intent with it or settle an intent with it.
 *
 * `provider` and `externalId` must already be normalized exactly as the webhook
 * writer does (`settleByExternalId`: provider trimmed + lower-cased, externalId
 * trimmed), which `create` and `intent.provider` also guarantee.
 */
async function heldCaptureFor(
  ctx: MutationCtx,
  provider: string,
  externalId: string
): Promise<Doc<"unmatchedProviderFunds"> | null> {
  return await ctx.db
    .query("unmatchedProviderFunds")
    .withIndex("by_provider_external", (q) => q.eq("provider", provider).eq("externalId", externalId))
    .unique();
}

/**
 * SCRUM-571 D-8: give a verified provider capture that did not settle an
 * intent its durable outcome. One row per capture, keyed (provider,
 * externalId), so a provider redelivery updates the row instead of adding one.
 *
 * Writes ONLY to `unmatchedProviderFunds`: no receivable, allocation, canonical
 * payment, posting hook or outbox event. The money is reconciled by a person
 * through the existing receipt doors.
 *
 * Reopen rule: a RESOLVED row stays RESOLVED on a plain redelivery (the
 * operator already handled this capture), but reopens when a delivery newly
 * carries a different amount or currency, because the decision they recorded
 * was made about different money. The earlier resolution fields are kept as
 * history on the reopened row.
 */
async function recordUnmatchedProviderFunds(
  ctx: MutationCtx,
  capture: {
    provider: string;
    externalId: string;
    amountMinor: number;
    currency: string;
    reason: Doc<"unmatchedProviderFunds">["reason"];
    orgId?: Id<"organizations">;
    intentId?: Id<"paymentIntents">;
    intentStatusAtReceipt?: string;
    providerAccountId?: string;
    providerEventId?: string;
  }
): Promise<Id<"unmatchedProviderFunds">> {
  const now = Date.now();
  const existing = await heldCaptureFor(ctx, capture.provider, capture.externalId);

  if (!existing) {
    return await ctx.db.insert("unmatchedProviderFunds", {
      orgId: capture.orgId,
      provider: capture.provider,
      externalId: capture.externalId,
      intentId: capture.intentId,
      reason: capture.reason,
      intentStatusAtReceipt: capture.intentStatusAtReceipt,
      amountMinor: capture.amountMinor,
      currency: capture.currency,
      providerAccountId: capture.providerAccountId,
      providerEventIds: capture.providerEventId ? [capture.providerEventId] : [],
      deliveryCount: 1,
      amountConflict: false,
      reviewStatus: "OPEN",
      firstReceivedAt: now,
      lastReceivedAt: now,
    });
  }

  const conflictNow =
    existing.amountMinor !== capture.amountMinor || existing.currency !== capture.currency;
  const amountConflict = existing.amountConflict || conflictNow;
  const reopen = conflictNow && !existing.amountConflict && existing.reviewStatus === "RESOLVED";
  const knownEventIds = existing.providerEventIds;
  const providerEventIds =
    capture.providerEventId && !knownEventIds.includes(capture.providerEventId)
      ? [...knownEventIds, capture.providerEventId].slice(-UNMATCHED_FUNDS_EVENT_IDS_MAX)
      : knownEventIds;

  await ctx.db.patch(existing._id, {
    deliveryCount: existing.deliveryCount + 1,
    lastReceivedAt: now,
    providerEventIds,
    amountConflict,
    ...(reopen ? { reviewStatus: "OPEN" as const } : {}),
  });
  return existing._id;
}

// Statuses a held capture may move an intent out of (D-22). SETTLED and REFUNDED
// carry their own economic outcome and are never overwritten; CAPTURE_HELD is
// already there.
const CAPTURE_HELD_FROM: ReadonlySet<Doc<"paymentIntents">["status"]> = new Set(["PENDING", "EXPIRED", "FAILED"]);

/**
 * SCRUM-571 S1 (D-22): move the intent a capture was held for to CAPTURE_HELD
 * and link the held row. Writes only `status`, `heldFundsId` and `updatedAt` on
 * the intent. Reads the intent fresh, so a status patched earlier in the same
 * mutation is what is judged. If the held row names another org or another
 * intent the intent is left alone for investigation (the hold itself is already
 * recorded, which D-14 requires).
 */
async function markIntentCaptureHeld(
  ctx: MutationCtx,
  intentId: Id<"paymentIntents">,
  heldId: Id<"unmatchedProviderFunds">
): Promise<void> {
  const [current, row] = await Promise.all([ctx.db.get(intentId), ctx.db.get(heldId)]);
  if (!current || !row || !CAPTURE_HELD_FROM.has(current.status)) return;
  if ((row.orgId && row.orgId !== current.orgId) || (row.intentId && row.intentId !== current._id)) {
    console.error(`[paymentIntents] Held capture ${heldId} does not belong to intent ${intentId}; not linked`);
    return;
  }
  await ctx.db.patch(intentId, { status: "CAPTURE_HELD", heldFundsId: heldId, updatedAt: Date.now() });
}

// The paymentIntents row for a (provider, externalId), if any.
async function intentByExternalId(
  ctx: MutationCtx,
  provider: string,
  externalId: string
): Promise<Doc<"paymentIntents"> | null> {
  return await ctx.db
    .query("paymentIntents")
    .withIndex("by_external_id", (q) => q.eq("provider", provider).eq("externalId", externalId))
    .unique();
}

// Outstanding on the canonical document less the amount reserved by PENDING
// intents. Links already sent and not yet paid reserve their amount: two links
// each within outstanding could otherwise settle for more than the debt in
// total. Every PENDING intent counts regardless of expiresAt (only an explicit
// expiry frees it); concurrent creates are serialized by OCC on this read set.
// The caller has proved the document's payer is `customerId`, so every intent
// for it is under (orgId, customerId).
//
// SCRUM-571 S1 (D-22): only PENDING reserves. A CAPTURE_HELD link is a verified
// capture awaiting finance, not an unpaid claim on the debt. Exported so the
// reservation rule is testable while `create` is shut (PAYMENT_LINKS_PILOT_DISABLED).
export async function getDocumentUncommittedMinor(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  customerId: Id<"customers">,
  receivableDocumentId: Id<"receivableDocuments">
): Promise<number> {
  const documentOutstandingMinor = await getReceivableOutstandingMinor(ctx, receivableDocumentId);
  const customerIntents = await ctx.db
    .query("paymentIntents")
    .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
    .collect();
  const reservedMinor = customerIntents
    .filter((i) => i.status === "PENDING" && i.receivableDocumentId === receivableDocumentId)
    .reduce((sum, i) => sum + i.amountMinor, 0);
  return documentOutstandingMinor - reservedMinor;
}

const statusValidator = v.union(
  v.literal("PENDING"),
  v.literal("SETTLED"),
  v.literal("FAILED"),
  v.literal("EXPIRED"),
  v.literal("REFUNDED"),
  v.literal("CAPTURE_HELD")
);

function optionalTrimmed(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function roundMoney(amount: number, currency: string) {
  const factor = Math.pow(10, scaleForCurrency(currency));
  return Math.round(amount * factor) / factor;
}

function nextLegacyReceivableStatus(outstandingAmount: number, dueDate: number, now: number) {
  if (outstandingAmount <= 0) return "PAID";
  if (dueDate < now) return "OVERDUE";
  return "PARTIALLY_PAID";
}

function validateCheckoutUrl(checkoutUrl: string | undefined): string | undefined {
  const trimmed = optionalTrimmed(checkoutUrl);
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    refusePaymentLink("PAYMENT_LINK_CHECKOUT_URL_INVALID");
  }

  if (parsed.protocol !== "https:") {
    refusePaymentLink("PAYMENT_LINK_CHECKOUT_URL_NOT_HTTPS");
  }
  return trimmed;
}

function providerMetadataPatch(args: {
  providerPayload?: unknown;
  providerEventId?: string;
  providerEventType?: string;
  providerSignatureVerifiedAt: number;
  providerAmountMinor: number;
  providerCurrency: string;
  providerAccountId?: string;
}): Partial<Doc<"paymentIntents">> {
  return {
    ...(args.providerPayload !== undefined ? { providerPayload: args.providerPayload } : {}),
    ...(args.providerEventId ? { providerEventId: args.providerEventId } : {}),
    ...(args.providerEventType ? { providerEventType: args.providerEventType } : {}),
    providerSignatureVerifiedAt: args.providerSignatureVerifiedAt,
    providerAmountMinor: args.providerAmountMinor,
    providerCurrency: args.providerCurrency,
    ...(args.providerAccountId ? { providerAccountId: args.providerAccountId } : {}),
  };
}

async function createCanonicalIntentSettlement(
  ctx: MutationCtx,
  intent: Doc<"paymentIntents">,
  actorId: Id<"users">,
  occurredAt: number,
  externalId?: string
) {
  const canonicalPaymentId = intent.canonicalPaymentId ?? await createCanonicalPayment(ctx, {
    orgId: intent.orgId,
    direction: "IN",
    payerType: "CUSTOMER",
    customerId: intent.customerId,
    method: "PAYMENT_LINK",
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    idempotencyKey: `payment_intent_${intent._id}`,
    actorId,
    status: "SETTLED",
    externalReference: externalId ?? intent.externalId ?? `Payment intent ${intent._id}`,
    provider: intent.provider,
    providerTransactionId: externalId ?? intent.externalId,
    receivedAt: occurredAt,
  });

  const links: Partial<Pick<Doc<"paymentIntents">, "collectionPaymentId" | "canonicalPaymentId" | "paymentAllocationId">> = {
    canonicalPaymentId,
  };

  if (intent.receivableDocumentId && !intent.paymentAllocationId) {
    // Clamp to what is still owed, exactly as the legacy mirror below already
    // does. allocatePaymentToReceivable THROWS when the amount exceeds the
    // outstanding balance, and a Convex mutation is atomic — so if the
    // receivable was partly settled through another channel after this intent
    // was created, the throw rolled back the entire settlement including the
    // canonical payment row. The provider has already confirmed the money, and
    // its retries would hit the same throw, so the payment was lost outright.
    // Any excess correctly stays on the payment as an unapplied balance.
    const outstandingMinor = await getReceivableOutstandingMinor(ctx, intent.receivableDocumentId);
    const allocatableMinor = Math.min(intent.amountMinor, outstandingMinor);
    if (allocatableMinor > 0) {
      links.paymentAllocationId = await allocatePaymentToReceivable(ctx, {
        orgId: intent.orgId,
        paymentId: canonicalPaymentId,
        receivableDocumentId: intent.receivableDocumentId,
        amountMinor: allocatableMinor,
        actorId,
      });
    }
  } else if (intent.paymentAllocationId) {
    links.paymentAllocationId = intent.paymentAllocationId;
  }

  if (intent.receivableId && !intent.collectionPaymentId) {
    const receivable = await ctx.db.get(intent.receivableId);
    if (receivable && receivable.orgId === intent.orgId) {
      const amount = roundMoney(fromMinorUnits(intent.amountMinor, intent.currency), intent.currency);
      // The receivable may have been partially paid through another channel
      // since this intent was created, so the full intent amount can now
      // exceed what's actually still owed. Clamp what's recorded as applied
      // to this receivable to its current outstanding balance rather than
      // posting more than it was ever owed.
      const appliedAmount = Math.min(amount, receivable.outstandingAmount);
      const collectionPaymentId = await ctx.db.insert("collectionPayments", {
        orgId: intent.orgId,
        receivableId: receivable._id,
        customerId: intent.customerId,
        vehicleId: receivable.vehicleId,
        saleId: receivable.saleId,
        direction: "IN",
        method: "PAYMENT_LINK",
        amount: appliedAmount,
        paymentDate: occurredAt,
        status: "POSTED",
        idempotencyKey: `payment_intent_${intent._id}`,
        reference: externalId ?? intent.externalId ?? `Payment intent ${intent._id}`,
        cashierId: actorId,
        canonicalPaymentId,
        paymentAllocationId: links.paymentAllocationId,
        createdAt: occurredAt,
      });
      // SCRUM-121A-PRE §6 — do not resurrect a cancelled debt.
      //
      // A CANCELLED receivable carries outstandingAmount 0 (cancellation zeroes
      // it in the same patch that sets the status), so appliedAmount is 0, the
      // recomputed outstanding is 0, and nextLegacyReceivableStatus(0, ...)
      // returns PAID — turning a debt that was deliberately closed into one
      // that reads as fully collected, on the strength of a receipt that
      // applied nothing to it.
      //
      // The receipt itself is kept: the zero-applied collectionPayments row
      // above is the lineage an operator needs to see that money arrived, and
      // the two timestamps below stay truthful for the same reason. Only the
      // operational status and balance are left exactly as cancellation set
      // them.
      //
      // CANCELLED ONLY, deliberately. REFUNDED also reads as terminal, but a
      // refund REOPENS the debt with a real outstanding balance, so a later
      // settlement legitimately applies real money and must still update both
      // fields. Suppressing them there would leave this row claiming a balance
      // the canonical document disagrees with — a new divergence, not a fix.
      // That case belongs to SCRUM-218's received/applied/unapplied model.
      const receivableWasCancelled = receivable.status === "CANCELLED";
      const outstandingAmount = roundMoney(Math.max(0, receivable.outstandingAmount - appliedAmount), intent.currency);
      await ctx.db.patch(receivable._id, {
        ...(receivableWasCancelled
          ? {}
          : {
              outstandingAmount,
              status: nextLegacyReceivableStatus(outstandingAmount, receivable.dueDate, occurredAt),
            }),
        lastPaymentAt: occurredAt,
        updatedAt: occurredAt,
      });
      links.collectionPaymentId = collectionPaymentId;
    }
  }

  return links;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(statusValidator),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const q = ctx.db
      .query("paymentIntents")
      .withIndex("by_org_status", (q) =>
        args.status
          ? q.eq("orgId", args.orgId).eq("status", args.status)
          : q.eq("orgId", args.orgId)
      );

    const page = await q.paginate(args.paginationOpts);

    const enriched = await Promise.all(
      page.page.map(async (intent) => {
        const customer = await ctx.db.get(intent.customerId);
        const customerName = customer
          ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || null
          : null;
        return { ...intent, customerName };
      })
    );

    return { ...page, page: enriched };
  },
});

/**
 * Internal-only lookup by provider + externalId. This intentionally has NO
 * tenant auth because it exposes a full payment-intent record (amounts,
 * customer, provider payload); it must never be a public `query`. The webhook
 * settlement path (settleByExternalId) is the only caller-shape that needs it,
 * and it runs in a trusted internal context.
 */
export const getByExternalId = internalQuery({
  args: {
    provider: v.string(),
    externalId: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("paymentIntents")
      .withIndex("by_external_id", (q) =>
        q.eq("provider", args.provider).eq("externalId", args.externalId)
      )
      .unique();
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    receivableId: v.optional(v.id("receivables")),
    receivableDocumentId: v.optional(v.id("receivableDocuments")),
    saleId: v.optional(v.id("sales")),
    amountMinor: v.number(),
    currency: v.string(),
    provider: v.string(),
    externalId: v.optional(v.string()),
    checkoutUrl: v.optional(v.string()),
    providerAccountId: v.optional(v.string()),
    providerPayload: v.optional(v.any()),
    expiresAt: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    // SCRUM-571 S1 (D-20) P1: the payment-link pilot is shut. First statement
    // after authentication, before validation, before runWithIdempotency, so
    // nothing is written and even a replayed key is refused.
    if (PAYMENT_LINKS_PILOT_DISABLED) refuseSaleDebt("PAYMENT_LINKS_DISABLED");

    // Before the range check, not after: NaN fails `<= 0` and would otherwise
    // be stored as the intent's amount and stranded there.
    assertValidMinorAmount(args.amountMinor, "payment amount");
    if (args.amountMinor <= 0) refusePaymentLink("PAYMENT_LINK_AMOUNT_NOT_POSITIVE");
    const provider = args.provider.trim().toLowerCase();
    if (!provider) refusePaymentLink("PAYMENT_LINK_PROVIDER_REQUIRED");
    const currency = normalizeCurrency(args.currency);
    if (!currency) refusePaymentLink("PAYMENT_LINK_CURRENCY_REQUIRED");
    const externalId = optionalTrimmed(args.externalId);
    const checkoutUrl = validateCheckoutUrl(args.checkoutUrl);
    const providerAccountId = optionalTrimmed(args.providerAccountId);
    if (checkoutUrl && !externalId) {
      refusePaymentLink("PAYMENT_LINK_EXTERNAL_ID_REQUIRED");
    }

    // SCRUM-571 S1 (c21732) — an intent with no target has no document to
    // allocate to, so settlement would post its GROSS amount to customer AR
    // while allocating nothing. Refused BEFORE the idempotency wrapper, like
    // the manual-receipt guards, so a refusal never consumes the key.
    //
    // Creation only: an intent already issued without a target must still
    // settle (the provider may hold the money), so no settle path changes.
    if (!args.receivableId && !args.saleId && !args.receivableDocumentId) {
      refusePaymentLink("PAYMENT_LINK_TARGET_REQUIRED");
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "paymentIntents.create",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          customerId: args.customerId,
          amountMinor: args.amountMinor,
          currency,
          provider,
          externalId: externalId ?? null,
          checkoutUrl: checkoutUrl ?? null,
          providerAccountId: providerAccountId ?? null,
          saleId: args.saleId ?? null,
          receivableId: args.receivableId ?? null,
          receivableDocumentId: args.receivableDocumentId ?? null,
        }),
      },
      async () => {
        const customer = await ctx.db.get(args.customerId);
        if (!customer || customer.orgId !== args.orgId) refusePaymentLink("PAYMENT_LINK_CUSTOMER_NOT_FOUND");
        // SCRUM-121A-PRE §3.3 — a withdrawn payer cannot be sent a NEW request
        // to pay. `customers.softDelete` refuses a customer who has leads or
        // sales and says nothing about money owed, so a payer carrying an open
        // receivable can be withdrawn and still be billed from the panel that
        // keeps listing the debt.
        //
        // Creation only. An intent that ALREADY exists must still settle: the
        // provider may have taken the money before the payer was withdrawn, and
        // refusing there would destroy a confirmed receipt rather than prevent
        // one. That is the funds boundary, and it is why this check lives here
        // and not in the settlement helper.
        if (customer.isDeleted) {
          refusePaymentLink("PAYMENT_LINK_CUSTOMER_REMOVED");
        }

        // SCRUM-121A-PRE §3.2 — resolve ONE authoritative canonical document
        // from EVERY supplied business identifier, and require each supplied
        // identifier to agree with it.
        //
        // Previously only `receivableId` derived a document. `saleId` was
        // accepted, stored on the intent and correlated with nothing at all, so
        // a payment link could name customer A's sale while collecting against
        // customer B's document — with both rows internally consistent and
        // neither reader able to see the contradiction.
        let receivableDocumentId = args.receivableDocumentId;
        let legacyOutstandingMinor: number | null = null;
        let legacyReceivableSaleId: Id<"sales"> | undefined;
        if (args.receivableId) {
          const receivable = await ctx.db.get(args.receivableId);
          if (!receivable || receivable.orgId !== args.orgId) refusePaymentLink("PAYMENT_LINK_RECEIVABLE_NOT_FOUND");
          if (receivable.customerId !== args.customerId) refusePaymentLink("PAYMENT_LINK_RECEIVABLE_CUSTOMER_MISMATCH");
          if (!receivable.canonicalReceivableDocumentId) {
            refusePaymentLink("PAYMENT_LINK_RECEIVABLE_NO_DOCUMENT");
          }
          if (receivableDocumentId && receivableDocumentId !== receivable.canonicalReceivableDocumentId) {
            refusePaymentLink("PAYMENT_LINK_RECEIVABLE_DOCUMENT_MISMATCH");
          }
          receivableDocumentId = receivable.canonicalReceivableDocumentId;
          legacyOutstandingMinor = toMinorUnits(receivable.outstandingAmount, currency);
          legacyReceivableSaleId = receivable.saleId;
        }

        if (args.saleId) {
          const sale = await ctx.db.get(args.saleId);
          if (!sale || sale.orgId !== args.orgId) refusePaymentLink("PAYMENT_LINK_SALE_NOT_FOUND");
          if (sale.customerId !== args.customerId) refusePaymentLink("PAYMENT_LINK_SALE_CUSTOMER_MISMATCH");
          if (sale.canonicalReceivableDocumentId) {
            if (receivableDocumentId && receivableDocumentId !== sale.canonicalReceivableDocumentId) {
              refusePaymentLink("PAYMENT_LINK_SALE_DEBT_MISMATCH");
            }
            receivableDocumentId = sale.canonicalReceivableDocumentId;
          } else if (!receivableDocumentId) {
            // A supplied sale is a target, never decorative metadata. If it
            // names no document and nothing else does either, the intent has
            // nowhere to allocate and would settle into an unattributed receipt.
            refusePaymentLink("PAYMENT_LINK_SALE_NO_DOCUMENT");
          } else if (!legacyReceivableSaleId || legacyReceivableSaleId !== args.saleId) {
            // The sale carries no document of its own — `canonicalReceivableDocumentId`
            // is written only at completion — while a document was resolved from
            // some OTHER identifier. Revision 3 of the design scoped the
            // UNPROVEN_TARGET refusal to sale-ONLY mode, which left exactly this
            // combination accepting an unverified sale: any pending deal for the
            // same customer could be stamped on an intent collecting against an
            // unrelated debt. The money still lands correctly, because settlement
            // never reads `saleId` — the damage is a permanently wrong deal
            // attribution on the payment record.
            //
            // The remaining way to prove the pair describe one debt is the
            // receivable's own `saleId`. Refusing outright instead would be
            // wrong: `createReceivable` accepts a `saleId` with no completion
            // requirement, so a receivable legitimately naming a PENDING sale is
            // an ordinary state, and that call must keep working.
            refusePaymentLink("PAYMENT_LINK_SALE_DEBT_MISMATCH");
          }
        }

        // SCRUM-121A-PRE §4 — however the target was resolved, prove it BEFORE
        // funds exist. This is deliberately not a document-only-mode rule; the
        // currency case is why. `create` capped against the legacy outstanding
        // using the CALLER's currency and never compared the document's, so a
        // JOD document plus `currency: "USD"` was accepted here and failed only
        // at settlement, inside `assertSameCurrency` — which rolls back the
        // canonical receipt, the intent metadata, the GL outbox row and the
        // idempotency record, and then fails identically on every provider
        // retry. A refusal here costs a rejected request; the same refusal after
        // funds costs a receipt the provider already took.
        if (receivableDocumentId) {
          const document = await ctx.db.get(receivableDocumentId);
          if (!document || document.orgId !== args.orgId) {
            refusePaymentLink("PAYMENT_LINK_DOCUMENT_NOT_FOUND");
          }
          if (document.payerType !== "CUSTOMER" || document.customerId !== args.customerId) {
            refusePaymentLink("PAYMENT_LINK_DOCUMENT_PAYER_MISMATCH");
          }
          if (document.currency !== currency) {
            refusePaymentLink("PAYMENT_LINK_DOCUMENT_CURRENCY_MISMATCH");
          }
          if (document.status !== "OPEN" && document.status !== "PARTIALLY_PAID") {
            refusePaymentLink("PAYMENT_LINK_DEBT_CLOSED");
          }
        }

        if (legacyOutstandingMinor !== null && args.amountMinor > legacyOutstandingMinor) {
          refusePaymentLink("PAYMENT_LINK_EXCEEDS_RECEIVABLE");
        }

        // SCRUM-571 S1 (c21732) — cap at the CANONICAL document's outstanding
        // however the document was resolved (document id, sale, or legacy
        // receivable). The legacy cap above reads the mirror row, which can
        // drift from the document, and applied only on the receivableId path;
        // the stricter of the two now holds. Integer minor units on both sides
        // (originalAmountMinor less ACTIVE allocations), so there is no float
        // drift. Settlement clamps the allocation but posts the gross amount,
        // so an over-cap intent would credit AR for money no document absorbs.
        if (receivableDocumentId) {
          const uncommittedMinor = await getDocumentUncommittedMinor(
            ctx,
            args.orgId,
            args.customerId,
            receivableDocumentId
          );
          if (args.amountMinor > uncommittedMinor) {
            refusePaymentLink("PAYMENT_LINK_EXCEEDS_OUTSTANDING");
          }
        }

        if (externalId) {
          // D-14, checked FIRST so a foreign/no-org held row is never disclosed
          // and a held identity is never reported as a plain duplicate.
          if (await heldCaptureFor(ctx, provider, externalId)) {
            refusePaymentLink("PAYMENT_LINK_PROVIDER_REFERENCE_UNAVAILABLE");
          }
          const existing = await intentByExternalId(ctx, provider, externalId);
          if (existing) refusePaymentLink("PAYMENT_LINK_PROVIDER_ID_IN_USE");
        }

        const now = Date.now();
        return await ctx.db.insert("paymentIntents", {
          orgId: args.orgId,
          customerId: args.customerId,
          receivableId: args.receivableId,
          receivableDocumentId,
          saleId: args.saleId,
          amountMinor: args.amountMinor,
          currency,
          provider,
          ...(externalId ? { externalId } : {}),
          ...(checkoutUrl ? { checkoutUrl } : {}),
          ...(providerAccountId ? { providerAccountId } : {}),
          ...(args.providerPayload !== undefined ? { providerPayload: args.providerPayload } : {}),
          status: "PENDING",
          idempotencyKey: args.idempotencyKey ?? `pi_${args.orgId}_${now}`,
          expiresAt: args.expiresAt,
          createdBy: user._id,
          createdAt: now,
          updatedAt: now,
        });
      }
    );
  },
});

export const markSettled = mutation({
  args: {
    orgId: v.id("organizations"),
    intentId: v.id("paymentIntents"),
    externalId: v.optional(v.string()),
    providerPayload: v.optional(v.any()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    // SCRUM-571 S1 (D-20) P2: staff cannot settle a link by hand while the
    // pilot is shut. Before runWithIdempotency; nothing is written.
    if (PAYMENT_LINKS_PILOT_DISABLED) refuseSaleDebt("PAYMENT_LINKS_DISABLED");

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "paymentIntents.markSettled",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ intentId: args.intentId, externalId: args.externalId ?? null }),
      },
      async () => {
        const intent = await ctx.db.get(args.intentId);
        if (!intent || intent.orgId !== args.orgId) {
          refusePaymentLink("PAYMENT_LINK_NOT_FOUND");
        }
        if (intent.status === "SETTLED") return; // idempotent
        if (intent.status !== "PENDING") {
          refusePaymentLink("PAYMENT_LINK_NOT_SETTLEABLE");
        }
        const externalId = optionalTrimmed(args.externalId);
        if (externalId && intent.externalId && externalId !== intent.externalId) {
          refusePaymentLink("PAYMENT_LINK_PROVIDER_ID_MISMATCH");
        }

        // D-14: a held provider identity is quarantined (see heldCaptureFor).
        // Throws, so no completed idempotency record is left behind.
        const effectiveExternalId = externalId ?? intent.externalId;
        if (effectiveExternalId && (await heldCaptureFor(ctx, intent.provider, effectiveExternalId))) {
          refusePaymentLink("PAYMENT_LINK_SETTLEMENT_REQUIRES_REVIEW");
        }
        // One provider identity must never belong to two intents.
        if (externalId && !intent.externalId) {
          const owner = await intentByExternalId(ctx, intent.provider, externalId);
          if (owner && owner._id !== intent._id) refusePaymentLink("PAYMENT_LINK_PROVIDER_ID_IN_USE");
        }

        const now = Date.now();
        const canonicalLinks = await createCanonicalIntentSettlement(
          ctx,
          intent,
          user._id,
          now,
          externalId
        );
        await ctx.db.patch(args.intentId, {
          status: "SETTLED",
          ...(externalId ? { externalId } : {}),
          ...(args.providerPayload !== undefined ? { providerPayload: args.providerPayload } : {}),
          settledAt: now,
          updatedAt: now,
          ...canonicalLinks,
        });

        // Post to GL
        await hookPaymentLinkReceived(ctx, {
          orgId: args.orgId,
          intentId: args.intentId,
          customerId: intent.customerId,
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          provider: intent.provider,
          actorId: user._id,
          occurredAt: now,
        });
      }
    );
  },
});

export const expire = mutation({
  args: {
    orgId: v.id("organizations"),
    intentId: v.id("paymentIntents"),
    // D-22: the operator attests they checked the provider and it shows no payment.
    providerStatusConfirmed: v.literal(true),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const intent = await ctx.db.get(args.intentId);
    // One message for a missing row and another org's row: never disclose that a
    // foreign tenant's payment link exists.
    if (!intent || intent.orgId !== args.orgId) {
      refusePaymentLink("PAYMENT_LINK_NOT_FOUND");
    }
    // SCRUM-571 S1 (D-21/D-22): a verified capture held for review means the
    // customer may have paid this link. Expiring it would show it as unpaid, so
    // it refuses, and BEFORE the generic not-pending refusal so a held link
    // gets the truthful message. A CAPTURE_HELD link, or a link whose provider
    // reference has a held row (stranded PENDING by pre-D-22 code), never expires.
    if (
      intent.status === "CAPTURE_HELD" ||
      (intent.externalId && (await heldCaptureFor(ctx, intent.provider, intent.externalId)))
    ) {
      refusePaymentLink("PAYMENT_LINK_CAPTURE_HELD");
    }
    if (intent.status !== "PENDING") {
      refusePaymentLink("PAYMENT_LINK_NOT_PENDING");
    }

    // D-20 provider-status condition, adapted in D-22: there is no provider
    // client, so the check is a recorded operator attestation (the validator
    // requires `providerStatusConfirmed: true`), stamped with who and when.
    const now = Date.now();
    await ctx.db.patch(args.intentId, {
      status: "EXPIRED",
      providerStatusCheckedAt: now,
      providerStatusCheckedBy: user._id,
      updatedAt: now,
    });
  },
});

/**
 * SCRUM-571 S1 (D-22) repair: link a held capture to its payment link that the
 * pre-D-22 code left PENDING. Moves the link to CAPTURE_HELD and nothing else:
 * no payment, allocation, posting, outbox event or idempotency record. Whatever
 * the row's `reviewStatus`. Naturally idempotent. Every refusal precedes any write.
 */
export const linkHeldCaptureToIntent = mutation({
  args: {
    orgId: v.id("organizations"),
    heldFundsId: v.id("unmatchedProviderFunds"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const row = await ctx.db.get(args.heldFundsId);
    // One message for missing and another org's (or no-org) rows.
    if (!row || row.orgId !== args.orgId) refuseUnmatchedFunds("UNMATCHED_FUNDS_NOT_FOUND");
    if (!row.intentId) refuseHeldCaptureLink("UNMATCHED_FUNDS_NO_INTENT");
    const intent = await ctx.db.get(row.intentId);
    if (!intent || intent.orgId !== args.orgId) refuseHeldCaptureLink("UNMATCHED_FUNDS_INTENT_NOT_FOUND");
    if (intent.provider !== row.provider || intent.externalId !== row.externalId) {
      refuseHeldCaptureLink("UNMATCHED_FUNDS_INTENT_MISMATCH");
    }
    if (intent.status === "CAPTURE_HELD" && intent.heldFundsId === row._id) return;
    if (intent.status !== "PENDING") refuseHeldCaptureLink("UNMATCHED_FUNDS_INTENT_NOT_LINKABLE");

    await ctx.db.patch(intent._id, {
      status: "CAPTURE_HELD",
      heldFundsId: row._id,
      updatedAt: Date.now(),
    });
  },
});

/**
 * SCRUM-571 D-8: payments the provider confirmed that settled nothing, for the
 * "Payments held for review" panel. Same permission as `list`. OPEN rows first,
 * then the most recent RESOLVED ones, 100 rows at most. Rows with no
 * organization (UNKNOWN_REFERENCE) belong to no tenant and are never returned.
 */
export const listUnmatchedProviderFunds = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const open = await ctx.db
      .query("unmatchedProviderFunds")
      .withIndex("by_org_review", (q) => q.eq("orgId", args.orgId).eq("reviewStatus", "OPEN"))
      .order("desc")
      .take(HELD_LIST_LIMIT);
    const room = HELD_LIST_LIMIT - open.length;
    const resolved =
      room > 0
        ? await ctx.db
            .query("unmatchedProviderFunds")
            .withIndex("by_org_review", (q) => q.eq("orgId", args.orgId).eq("reviewStatus", "RESOLVED"))
            .order("desc")
            .take(room)
        : [];
    // Only what the panel displays: provider event ids and the resolver's user
    // id stay server-side.
    return [...open, ...resolved].map((row) => ({
      _id: row._id,
      amountMinor: row.amountMinor,
      currency: row.currency,
      provider: row.provider,
      externalId: row.externalId,
      reason: row.reason,
      intentStatusAtReceipt: row.intentStatusAtReceipt,
      deliveryCount: row.deliveryCount,
      amountConflict: row.amountConflict,
      reviewStatus: row.reviewStatus,
      lastReceivedAt: row.lastReceivedAt,
      firstReceivedAt: row.firstReceivedAt,
      resolvedAt: row.resolvedAt,
      resolutionNote: row.resolutionNote,
    }));
  },
});

/**
 * SCRUM-571 D-8: record that a person has dealt with a held payment. NO
 * economic effect: the money itself is reconciled manually through the
 * existing receipt doors (collections / deposits); this only closes the review
 * item with who, when and why.
 */
export const resolveUnmatchedProviderFunds = mutation({
  args: {
    orgId: v.id("organizations"),
    id: v.id("unmatchedProviderFunds"),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const note = args.note.trim();
    if (!note) refuseUnmatchedFunds("UNMATCHED_FUNDS_NOTE_REQUIRED");
    if (note.length > UNMATCHED_FUNDS_NOTE_MAX) refuseUnmatchedFunds("UNMATCHED_FUNDS_NOTE_TOO_LONG");

    const row = await ctx.db.get(args.id);
    // One message for missing, another org's and platform-scope (no org) rows:
    // never disclose that a foreign tenant's held payment exists.
    if (!row || row.orgId !== args.orgId) refuseUnmatchedFunds("UNMATCHED_FUNDS_NOT_FOUND");
    if (row.reviewStatus === "RESOLVED") refuseUnmatchedFunds("UNMATCHED_FUNDS_ALREADY_RESOLVED");

    await ctx.db.patch(args.id, {
      reviewStatus: "RESOLVED",
      resolvedBy: user._id,
      resolvedAt: Date.now(),
      resolutionNote: note,
    });
  },
});

/**
 * Internal webhook entry-point: settle an intent by provider + externalId.
 * Called from the HTTP webhook handler; runs in a trusted (internal) context.
 */
export const settleByExternalId = internalMutation({
  args: {
    provider: v.string(),
    externalId: v.string(),
    amountMinor: v.number(),
    currency: v.string(),
    providerSignatureVerifiedAt: v.number(),
    providerEventId: v.optional(v.string()),
    providerEventType: v.optional(v.string()),
    providerAccountId: v.optional(v.string()),
    providerPayload: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<SettleOutcome> => {
    const provider = args.provider.trim().toLowerCase();
    const externalId = args.externalId.trim();
    const currency = normalizeCurrency(args.currency);
    const providerAccountId = optionalTrimmed(args.providerAccountId);
    const intent = await intentByExternalId(ctx, provider, externalId);

    // SCRUM-571 D-8. Every non-settling exit below is answered 200 by the HTTP
    // route, so each one first leaves a durable, finance-visible outcome in THIS
    // transaction (recordUnmatchedProviderFunds, whose row id is the HELD
    // outcome), except an already-SETTLED intent, whose earlier settlement IS
    // the outcome (ALREADY_SETTLED).
    const capture = {
      provider,
      externalId,
      amountMinor: args.amountMinor,
      currency,
      providerAccountId,
      providerEventId: optionalTrimmed(args.providerEventId),
    };

    if (!intent) {
      console.warn(`[paymentIntents] Unknown externalId for provider ${provider}: ${externalId}`);
      const heldId = await recordUnmatchedProviderFunds(ctx, { ...capture, reason: "UNKNOWN_REFERENCE" });
      return { kind: "HELD", heldId };
    }

    // The intent-scoped holds share one shape. `intent.status` is read at the
    // call, so the mismatch exit (which patches the intent to FAILED on the row
    // but not on this in-memory copy) still records the PRE-patch PENDING.
    //
    // SCRUM-571 S1 (D-22): the hold is also the intent's terminal transition. In
    // the SAME transaction the link moves to CAPTURE_HELD, so it is never shown
    // as unpaid, never reserved as collectible and never a dead end.
    const holdForIntent = async (
      reason: Doc<"unmatchedProviderFunds">["reason"]
    ): Promise<SettleOutcome> => {
      const heldId = await recordUnmatchedProviderFunds(ctx, {
        ...capture,
        orgId: intent.orgId,
        intentId: intent._id,
        intentStatusAtReceipt: intent.status,
        reason,
      });
      await markIntentCaptureHeld(ctx, intent._id, heldId);
      return { kind: "HELD", heldId };
    };

    // ⚠️ SCRUM-302 — ORGANIZATION LIFECYCLE, CHECKED BEFORE ANY ECONOMIC EFFECT.
    //
    // This runs in a trusted internal context reached from the payment webhook,
    // so `requireTenantAuth`, which refuses a suspended organization at the
    // authenticated door, is never consulted. Reproduced: a suspended org whose
    // purge had already drained `canonicalPayments` to zero had a canonical
    // payment written straight back into that table by this handler, while its
    // authenticated twin `markSettled` correctly refused the identical request.
    //
    // WHY THIS RETURNS RATHER THAN THROWS. A throw would be a non-200 to the
    // provider, which buys an uncontrolled retry storm and STILL loses the fact
    // that a real, signature-verified payment arrived. Instead the refusal is
    // recorded durably and the route answers 200: the provider stops retrying,
    // nothing economic is created, and the money is visible to an operator.
    // Real settlement for such an organization can then only happen through a
    // separately reviewed recovery path, which is the point.
    //
    // The evidence is written HERE, in the same transaction as the refusal,
    // rather than by the HTTP handler — so it cannot be lost by a caller that
    // forgets to log, and cannot outlive a rollback of the thing it describes.
    //
    // `status: "error"` is deliberate and terminal. `getStuckWebhookIds`
    // selects only `status === "received"`, so this row is never swept into
    // `scanDeadLetterWebhooks`; it is a finished, refused delivery, not one
    // still in flight.
    const lifecycle = await orgEconomicLifecycleBlock(ctx, intent.orgId);
    if (lifecycle) {
      await recordWebhookLog(ctx, {
        source: "payment",
        status: "error",
        summary:
          `refused ${provider} settlement for org ${intent.orgId}: ${lifecycle.code}` +
          ` (intent ${intent._id}, ${args.amountMinor} ${currency}, externalId ${externalId})`,
        eventId: optionalTrimmed(args.providerEventId),
        error: lifecycle.message,
      });
      console.error(
        `[paymentIntents] Refused ${provider} settlement for ${intent._id}: ${lifecycle.code}`
      );
      // The webhook log above is operator telemetry; this row is the finance
      // record. A redelivery for an intent that already settled has nothing to
      // recover, so it keeps the log only.
      if (intent.status === "SETTLED") return { kind: "ALREADY_SETTLED", intentId: intent._id };
      return await holdForIntent("LIFECYCLE_REFUSED");
    }

    if (intent.status === "SETTLED") return { kind: "ALREADY_SETTLED", intentId: intent._id };

    if (intent.status !== "PENDING") {
      console.warn(`[paymentIntents] Cannot settle intent ${intent._id} in status ${intent.status}`);
      return await holdForIntent("INTENT_NOT_PENDING");
    }

    // SCRUM-571 S1 (D-20) P3: the pilot is shut, so a verified capture is HELD
    // for finance, never settled. One atomic write to unmatchedProviderFunds
    // (keyed provider + externalId, so a redelivery only bumps that row); no
    // allocation, canonical payment, posting hook or outbox event, and the
    // intent stays PENDING. The money is reconciled by a person.
    if (PAYMENT_LINKS_PILOT_DISABLED) return await holdForIntent("PAYMENT_LINKS_DISABLED");

    // D-14 (see heldCaptureFor): a held row exists, so record this redelivery on
    // it and do nothing else. `reason` is unused when the row already exists.
    if (await heldCaptureFor(ctx, provider, externalId)) {
      return await holdForIntent("INTENT_NOT_PENDING");
    }

    const now = Date.now();
    const verifiedProviderPatch = providerMetadataPatch({
      providerPayload: args.providerPayload,
      providerEventId: optionalTrimmed(args.providerEventId),
      providerEventType: optionalTrimmed(args.providerEventType),
      providerSignatureVerifiedAt: args.providerSignatureVerifiedAt,
      providerAmountMinor: args.amountMinor,
      providerCurrency: currency,
      providerAccountId,
    });

    const mismatchReasons: string[] = [];
    if (intent.amountMinor !== args.amountMinor) {
      mismatchReasons.push(`amount ${args.amountMinor} != ${intent.amountMinor}`);
    }
    if (normalizeCurrency(intent.currency) !== currency) {
      mismatchReasons.push(`currency ${currency} != ${intent.currency}`);
    }
    if (intent.providerAccountId && intent.providerAccountId !== providerAccountId) {
      mismatchReasons.push("provider account mismatch");
    }

    if (mismatchReasons.length > 0) {
      console.error(
        `[paymentIntents] Rejecting verified ${provider} settlement for ${intent._id}: ${mismatchReasons.join(", ")}`
      );
      await ctx.db.patch(intent._id, {
        status: "FAILED",
        ...verifiedProviderPatch,
        updatedAt: now,
      });
      return await holdForIntent("AMOUNT_OR_ACCOUNT_MISMATCH");
    }

    const canonicalLinks = await createCanonicalIntentSettlement(
      ctx,
      intent,
      intent.createdBy,
      now,
      externalId
    );
    await ctx.db.patch(intent._id, {
      status: "SETTLED",
      externalId,
      ...verifiedProviderPatch,
      settledAt: now,
      updatedAt: now,
      ...canonicalLinks,
    });

    // Post to the GL using the staff member who created the intent as the actor
    // (always present, deterministic — never an arbitrary "first membership").
    // The hook posts immediately when a chart + open period exist, otherwise it
    // durably enqueues the event to the accounting outbox so settlement is never
    // committed without a corresponding GL record being captured for retry.
    await hookPaymentLinkReceived(ctx, {
      orgId: intent.orgId,
      intentId: intent._id,
      customerId: intent.customerId,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      provider: intent.provider,
      actorId: intent.createdBy,
      occurredAt: now,
    });

    return { kind: "SETTLED", intentId: intent._id };
  },
});
