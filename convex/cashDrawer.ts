/**
 * GL Phase 15 — full cash-drawer sessions.
 *
 * Lifecycle: open (records a float) → movements are logged while OPEN →
 * beginCount locks the movement set → close submits the physical count and
 * computes variance → approveVariance (a different person than whoever
 * closed it) posts the counted cash to the bank.
 */
import { v, ConvexError } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { assertDifferentActors } from "./utils/financialGuards";
import { hookCashDrawerDeposited, getOrgCurrency } from "./accounting/workflowHooks";

const movementTypeValidator = v.union(
  v.literal("SALE"),
  v.literal("PAYOUT"),
  v.literal("HANDOVER"),
);

/**
 * Expected cash = float + inflows (SALE, HANDOVER-in) − outflows (PAYOUT).
 * BANK_DEPOSIT movements never exist before approval (they're only created
 * BY approval), so they never enter this sum.
 */
async function computeExpectedCashMinor(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sessionId: Id<"cashDrawerSessions">,
  openingFloatMinor: number
): Promise<number> {
  const movements = await ctx.db
    .query("cashMovements")
    .withIndex("by_org_session", (q) => q.eq("orgId", orgId).eq("sessionId", sessionId))
    .collect();

  let expected = openingFloatMinor;
  for (const m of movements) {
    if (m.type === "SALE" || m.type === "HANDOVER") expected += m.amountMinor;
    else if (m.type === "PAYOUT") expected -= m.amountMinor;
  }
  return expected;
}

export const open = mutation({
  args: {
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    openingFloatMinor: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (!Number.isSafeInteger(args.openingFloatMinor) || args.openingFloatMinor < 0) {
      throw new ConvexError("Opening float must be a non-negative integer minor-unit amount.");
    }

    const existingOpen = await ctx.db
      .query("cashDrawerSessions")
      .withIndex("by_org_branch_status", (q) => q.eq("orgId", args.orgId).eq("branchId", args.branchId))
      .filter((q) => q.or(q.eq(q.field("status"), "OPEN"), q.eq(q.field("status"), "COUNTING")))
      .first();
    if (existingOpen) {
      throw new ConvexError("A cash drawer session is already open for this branch. Close it before opening a new one.");
    }

    const currency = await getOrgCurrency(ctx, args.orgId);
    const now = Date.now();

    return await ctx.db.insert("cashDrawerSessions", {
      orgId: args.orgId,
      branchId: args.branchId,
      openingFloatMinor: args.openingFloatMinor,
      currency,
      openedBy: user._id,
      openedAt: now,
      status: "OPEN",
    });
  },
});

export const recordMovement = mutation({
  args: {
    orgId: v.id("organizations"),
    sessionId: v.id("cashDrawerSessions"),
    type: movementTypeValidator,
    amountMinor: v.number(),
    occurredAt: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const session = await ctx.db.get(args.sessionId);
    if (!session || session.orgId !== args.orgId) {
      throw new ConvexError("Cash drawer session not found in this organization.");
    }
    if (session.status !== "OPEN") {
      throw new ConvexError(`Movements can only be recorded while the session is OPEN (this one is ${session.status}).`);
    }
    if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
      throw new ConvexError("Movement amount must be a positive integer minor-unit amount.");
    }

    return await ctx.db.insert("cashMovements", {
      orgId: args.orgId,
      sessionId: args.sessionId,
      type: args.type,
      amountMinor: args.amountMinor,
      occurredAt: args.occurredAt ?? Date.now(),
      notes: args.notes,
      actorId: user._id,
      createdAt: Date.now(),
    });
  },
});

/** Locks the movement set — no more movements can be recorded once counting starts. */
export const beginCount = mutation({
  args: {
    orgId: v.id("organizations"),
    sessionId: v.id("cashDrawerSessions"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const session = await ctx.db.get(args.sessionId);
    if (!session || session.orgId !== args.orgId) {
      throw new ConvexError("Cash drawer session not found in this organization.");
    }
    if (session.status !== "OPEN") {
      throw new ConvexError(`Only an OPEN session can begin counting (this one is ${session.status}).`);
    }

    await ctx.db.patch(args.sessionId, { status: "COUNTING" });
  },
});

/** Submits the physical count and computes variance (counted − expected). */
export const close = mutation({
  args: {
    orgId: v.id("organizations"),
    sessionId: v.id("cashDrawerSessions"),
    closingCountMinor: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const session = await ctx.db.get(args.sessionId);
    if (!session || session.orgId !== args.orgId) {
      throw new ConvexError("Cash drawer session not found in this organization.");
    }
    if (session.status !== "COUNTING") {
      throw new ConvexError(`Only a session in COUNTING can be closed (this one is ${session.status}).`);
    }
    if (!Number.isSafeInteger(args.closingCountMinor) || args.closingCountMinor < 0) {
      throw new ConvexError("Closing count must be a non-negative integer minor-unit amount.");
    }

    const expectedMinor = await computeExpectedCashMinor(ctx, args.orgId, args.sessionId, session.openingFloatMinor);
    const varianceMinor = args.closingCountMinor - expectedMinor;

    await ctx.db.patch(args.sessionId, {
      status: "CLOSED",
      closingCountMinor: args.closingCountMinor,
      varianceMinor,
      closedBy: user._id,
      closedAt: Date.now(),
    });

    return { expectedMinor, varianceMinor };
  },
});

/**
 * Approves the count's variance and deposits the counted cash to the bank.
 * Must be a different person than whoever closed (counted) the session.
 */
export const approveVariance = mutation({
  args: {
    orgId: v.id("organizations"),
    sessionId: v.id("cashDrawerSessions"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);

    const session = await ctx.db.get(args.sessionId);
    if (!session || session.orgId !== args.orgId) {
      throw new ConvexError("Cash drawer session not found in this organization.");
    }
    if (session.status !== "CLOSED") {
      throw new ConvexError(`Only a CLOSED session can be approved (this one is ${session.status}).`);
    }
    if (!session.closedBy) {
      throw new ConvexError("Session has no recorded closer to compare against.");
    }
    assertDifferentActors(
      user._id,
      session.closedBy,
      "The person who counted this drawer cannot also approve its variance."
    );

    const depositMinor = session.closingCountMinor ?? 0;
    const now = Date.now();

    if (depositMinor > 0) {
      await hookCashDrawerDeposited(ctx, {
        orgId: args.orgId,
        sessionId: args.sessionId,
        amountMinor: depositMinor,
        currency: session.currency,
        actorId: user._id,
        occurredAt: now,
      });

      await ctx.db.insert("cashMovements", {
        orgId: args.orgId,
        sessionId: args.sessionId,
        type: "BANK_DEPOSIT",
        amountMinor: depositMinor,
        occurredAt: now,
        actorId: user._id,
        createdAt: now,
      });
    }

    await ctx.db.patch(args.sessionId, {
      status: "APPROVED",
      approvedBy: user._id,
      approvedAt: now,
    });
  },
});

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("cashDrawerSessions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(200);
  },
});

export const listMovements = query({
  args: { orgId: v.id("organizations"), sessionId: v.id("cashDrawerSessions") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.orgId !== args.orgId) {
      throw new ConvexError("Cash drawer session not found in this organization.");
    }
    return await ctx.db
      .query("cashMovements")
      .withIndex("by_org_session", (q) => q.eq("orgId", args.orgId).eq("sessionId", args.sessionId))
      .order("asc")
      .collect();
  },
});
