import { v, ConvexError } from "convex/values";
import { query, internalQuery, MutationCtx } from "./_generated/server";
import { mutation, internalMutation } from "./functions";
import { paginationOptsValidator } from "convex/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { hookPaymentLinkReceived } from "./accounting/workflowHooks";
import { allocatePaymentToReceivable, createCanonicalPayment, getReceivableOutstandingMinor } from "./subledger";
import { fromMinorUnits, toMinorUnits, scaleForCurrency, assertValidMinorAmount } from "./utils/money";

const statusValidator = v.union(
  v.literal("PENDING"),
  v.literal("SETTLED"),
  v.literal("FAILED"),
  v.literal("EXPIRED"),
  v.literal("REFUNDED")
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
    throw new ConvexError("Checkout URL must be a valid URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new ConvexError("Checkout URL must use HTTPS.");
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
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    // Before the range check, not after: NaN fails `<= 0` and would otherwise
    // be stored as the intent's amount and stranded there.
    assertValidMinorAmount(args.amountMinor, "payment amount");
    if (args.amountMinor <= 0) throw new ConvexError("Amount must be positive.");
    const provider = args.provider.trim().toLowerCase();
    if (!provider) throw new ConvexError("Provider is required.");
    const currency = normalizeCurrency(args.currency);
    if (!currency) throw new ConvexError("Currency is required.");
    const externalId = optionalTrimmed(args.externalId);
    const checkoutUrl = validateCheckoutUrl(args.checkoutUrl);
    const providerAccountId = optionalTrimmed(args.providerAccountId);
    if (checkoutUrl && !externalId) {
      throw new ConvexError("Provider external ID is required when a checkout URL is stored.");
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "paymentIntents.create",
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
        if (!customer || customer.orgId !== args.orgId) throw new ConvexError("Customer not found.");
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
          throw new ConvexError("This customer has been removed and can no longer be sent a payment request.");
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
          if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");
          if (receivable.customerId !== args.customerId) throw new ConvexError("Receivable customer does not match.");
          if (!receivable.canonicalReceivableDocumentId) {
            throw new ConvexError("Receivable is missing its canonical accounting document.");
          }
          if (receivableDocumentId && receivableDocumentId !== receivable.canonicalReceivableDocumentId) {
            throw new ConvexError("Payment intent receivable document does not match the selected receivable.");
          }
          receivableDocumentId = receivable.canonicalReceivableDocumentId;
          legacyOutstandingMinor = toMinorUnits(receivable.outstandingAmount, currency);
          legacyReceivableSaleId = receivable.saleId;
        }

        if (args.saleId) {
          const sale = await ctx.db.get(args.saleId);
          if (!sale || sale.orgId !== args.orgId) throw new ConvexError("Sale not found.");
          if (sale.customerId !== args.customerId) throw new ConvexError("Sale customer does not match.");
          if (sale.canonicalReceivableDocumentId) {
            if (receivableDocumentId && receivableDocumentId !== sale.canonicalReceivableDocumentId) {
              throw new ConvexError("Payment intent sale does not match the selected debt.");
            }
            receivableDocumentId = sale.canonicalReceivableDocumentId;
          } else if (!receivableDocumentId) {
            // A supplied sale is a target, never decorative metadata. If it
            // names no document and nothing else does either, the intent has
            // nowhere to allocate and would settle into an unattributed receipt.
            throw new ConvexError("This sale has no accounting document to collect against.");
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
            throw new ConvexError("Payment intent sale does not match the selected debt.");
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
            throw new ConvexError("Receivable document not found.");
          }
          if (document.payerType !== "CUSTOMER" || document.customerId !== args.customerId) {
            throw new ConvexError("Receivable document belongs to a different payer.");
          }
          if (document.currency !== currency) {
            throw new ConvexError("Receivable document currency does not match the payment currency.");
          }
          if (document.status !== "OPEN" && document.status !== "PARTIALLY_PAID") {
            throw new ConvexError("This debt can no longer accept payments.");
          }
        }

        if (legacyOutstandingMinor !== null && args.amountMinor > legacyOutstandingMinor) {
          throw new ConvexError("Payment link amount cannot exceed the receivable outstanding amount.");
        }

        if (externalId) {
          const existing = await ctx.db
            .query("paymentIntents")
            .withIndex("by_external_id", (q) =>
              q.eq("provider", provider).eq("externalId", externalId)
            )
            .unique();
          if (existing) throw new ConvexError("Provider payment intent already exists.");
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
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "paymentIntents.markSettled",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ intentId: args.intentId, externalId: args.externalId ?? null }),
      },
      async () => {
        const intent = await ctx.db.get(args.intentId);
        if (!intent || intent.orgId !== args.orgId) throw new ConvexError("Payment intent not found.");
        if (intent.status === "SETTLED") return; // idempotent
        if (intent.status !== "PENDING") {
          throw new ConvexError(`Cannot settle a ${intent.status} payment intent.`);
        }
        const externalId = optionalTrimmed(args.externalId);
        if (externalId && intent.externalId && externalId !== intent.externalId) {
          throw new ConvexError("External provider ID does not match this payment intent.");
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
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.orgId !== args.orgId) throw new ConvexError("Payment intent not found.");
    if (intent.status !== "PENDING") {
      throw new ConvexError(`Cannot expire a ${intent.status} payment intent.`);
    }

    await ctx.db.patch(args.intentId, {
      status: "EXPIRED",
      updatedAt: Date.now(),
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
  handler: async (ctx, args) => {
    const provider = args.provider.trim().toLowerCase();
    const externalId = args.externalId.trim();
    const currency = normalizeCurrency(args.currency);
    const providerAccountId = optionalTrimmed(args.providerAccountId);
    const intent = await ctx.db
      .query("paymentIntents")
      .withIndex("by_external_id", (q) =>
        q.eq("provider", provider).eq("externalId", externalId)
      )
      .unique();

    if (!intent) {
      // Unknown intent — return gracefully so webhook caller gets 200
      console.warn(`[paymentIntents] Unknown externalId for provider ${provider}: ${externalId}`);
      return null;
    }

    if (intent.status === "SETTLED") return intent._id; // already settled

    if (intent.status !== "PENDING") {
      console.warn(`[paymentIntents] Cannot settle intent ${intent._id} in status ${intent.status}`);
      return null;
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
      return null;
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

    return intent._id;
  },
});
