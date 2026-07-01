import { v, ConvexError } from "convex/values";
import { mutation, query, internalMutation, internalQuery, MutationCtx } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { hookPaymentLinkReceived } from "./accounting/workflowHooks";
import { allocatePaymentToReceivable, createCanonicalPayment } from "./subledger";

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

  const links: Partial<Pick<Doc<"paymentIntents">, "canonicalPaymentId" | "paymentAllocationId">> = {
    canonicalPaymentId,
  };

  if (intent.receivableDocumentId && !intent.paymentAllocationId) {
    links.paymentAllocationId = await allocatePaymentToReceivable(ctx, {
      orgId: intent.orgId,
      paymentId: canonicalPaymentId,
      receivableDocumentId: intent.receivableDocumentId,
      amountMinor: intent.amountMinor,
      actorId,
    });
  } else if (intent.paymentAllocationId) {
    links.paymentAllocationId = intent.paymentAllocationId;
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
          receivableDocumentId: args.receivableDocumentId ?? null,
        }),
      },
      async () => {
        const customer = await ctx.db.get(args.customerId);
        if (!customer || customer.orgId !== args.orgId) throw new ConvexError("Customer not found.");

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
          receivableDocumentId: args.receivableDocumentId,
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
