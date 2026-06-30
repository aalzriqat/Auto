import { v, ConvexError } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { hookPaymentLinkReceived } from "./accounting/workflowHooks";

const statusValidator = v.union(
  v.literal("PENDING"),
  v.literal("SETTLED"),
  v.literal("FAILED"),
  v.literal("EXPIRED"),
  v.literal("REFUNDED")
);

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
    expiresAt: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (args.amountMinor <= 0) throw new ConvexError("Amount must be positive.");
    const provider = args.provider.trim().toLowerCase();
    if (!provider) throw new ConvexError("Provider is required.");

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
          currency: args.currency,
          provider,
          saleId: args.saleId ?? null,
          receivableDocumentId: args.receivableDocumentId ?? null,
        }),
      },
      async () => {
        const customer = await ctx.db.get(args.customerId);
        if (!customer || customer.orgId !== args.orgId) throw new ConvexError("Customer not found.");

        const now = Date.now();
        return await ctx.db.insert("paymentIntents", {
          orgId: args.orgId,
          customerId: args.customerId,
          receivableDocumentId: args.receivableDocumentId,
          saleId: args.saleId,
          amountMinor: args.amountMinor,
          currency: args.currency,
          provider,
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

        const now = Date.now();
        await ctx.db.patch(args.intentId, {
          status: "SETTLED",
          externalId: args.externalId,
          providerPayload: args.providerPayload,
          settledAt: now,
          updatedAt: now,
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
    providerPayload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const intent = await ctx.db
      .query("paymentIntents")
      .withIndex("by_external_id", (q) =>
        q.eq("provider", args.provider).eq("externalId", args.externalId)
      )
      .unique();

    if (!intent) {
      // Unknown intent — return gracefully so webhook caller gets 200
      console.warn(`[paymentIntents] Unknown externalId for provider ${args.provider}: ${args.externalId}`);
      return null;
    }

    if (intent.status === "SETTLED") return intent._id; // already settled

    if (intent.status !== "PENDING") {
      console.warn(`[paymentIntents] Cannot settle intent ${intent._id} in status ${intent.status}`);
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(intent._id, {
      status: "SETTLED",
      providerPayload: args.providerPayload,
      settledAt: now,
      updatedAt: now,
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
