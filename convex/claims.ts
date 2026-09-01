import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { paginationOptsValidator } from "convex/server";
import type { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { throwAppError, AppErrorCode } from "./utils/errors";

const paymentMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("BANK_TRANSFER"),
  v.literal("CARD"),
  v.literal("CHEQUE"),
);

export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("claims")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .filter((q) => q.neq(q.field("isDeleted"), true)).paginate(args.paginationOpts);
  },
});

/**
 * ⚠️ CLAIMS IS RETIRED AS AN ACCOUNTING AUTHORITY — SCRUM-51, owner ruling
 * c14514 as re-scoped by c14519.
 *
 * Claims used to open a canonical `receivableDocuments` row with
 * `payerType: FINANCE_COMPANY` and no originating GL debit, while `settle`
 * and `reject` both CREDITED Finance-company AR. So the subledger could carry
 * finance-company AR the GL had never been told about, and the GL could be
 * credited for a balance nothing had ever debited. Worse, the financed-deal
 * path in `applications.ts` already creates the real receivable for the same
 * economic fact, and `add` took a free-typed financier, buyer and amount with
 * an OPTIONAL `saleId` — so one financed sale could carry two receivables,
 * with settlement landing on whichever one the operator happened to open.
 *
 * The ruling resolves the model question rather than papering over it with a
 * CLAIM_CREATED debit: **the Finance Application receivable is authoritative,
 * and Claims becomes a read-only view over it.**
 *
 * ⚠️ THE REFUSAL IS THE CONTROL, NOT THE UI. All five writers keep their
 * exported names and their argument validators, so a client deployed against
 * the old backend still resolves the function and still type-checks its call
 * — it receives a named refusal instead of silently writing a second
 * authority. Hiding the buttons would leave the door open to anything holding
 * a session; refusing server-side after authentication and before any write
 * closes it for every caller.
 */
function refuseRetiredClaimsWriter(door: string): never {
  throwAppError(
    AppErrorCode.CLAIMS_RETIRED,
    `Claims no longer records finance-company money (claims.${door} is retired). A financed deal's receivable is opened and settled by its Finance Application, which is the only authority for finance-company AR. Open the deal's Finance Application instead.`
  );
}

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    claimDate: v.number(),
    financingEntity: v.string(),
    buyerName: v.string(),
    claimAmountMinor: v.number(),
    notes: v.optional(v.string()),
    saleId: v.optional(v.id("sales")),
  },
  handler: async (ctx, args) => {
    // Authenticated first, refused second. A caller with no membership must
    // still get the ordinary tenancy error rather than a retirement notice,
    // which would confirm the org exists to someone with no access to it.
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    refuseRetiredClaimsWriter("add");
  },
});

export const settle = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
    paymentMethod: paymentMethodValidator,
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    refuseRetiredClaimsWriter("settle");
  },
});

export const reject = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    refuseRetiredClaimsWriter("reject");
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    refuseRetiredClaimsWriter("update");
  },
});

export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    claimId: v.id("claims"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    refuseRetiredClaimsWriter("remove");
  },
});

// ─── The authoritative view Claims is retired in favour of ─────────────────

// Must match `applications.ts`'s FINANCE_APP_RECEIVABLE_SOURCE. That module
// owns the writer; this one only reads what it wrote.
const FINANCE_APPLICATION_SOURCE = "finance_application";

/**
 * Every finance-company receivable an org actually has, with its live
 * outstanding balance.
 *
 * ⚠️ ONE OUTSTANDING FORMULA, USED BY BOTH READERS. The list and the totals
 * below are computed from this single function, because two implementations
 * of `outstanding` is precisely how a list and its own total come to disagree.
 * The formula is the one `subledger.getReceivableOutstandingMinor` uses —
 * CANCELLED reads as zero (its allocations are reversed, so
 * `original - allocated` would otherwise report it fully outstanding again),
 * and everything else is the original less its ACTIVE allocations, floored at
 * zero. `claimsRetirement.test.ts` asserts row-by-row equality against that
 * helper so the two cannot drift apart silently.
 *
 * Reads are index-backed and do not scale with the org's whole receivable
 * history: the documents come from the `by_org_source` prefix, which is
 * exactly the finance-application receivables, and the allocations from
 * `by_org_status` restricted to ACTIVE — one query each, rather than one
 * allocation query per document.
 */
async function financeCompanyReceivableRows(ctx: QueryCtx, orgId: Id<"organizations">) {
  const documents = await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", FINANCE_APPLICATION_SOURCE)
    )
    .collect();

  const activeAllocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "ACTIVE"))
    .collect();

  const allocatedByReceivable = new Map<string, number>();
  for (const a of activeAllocations) {
    const key = a.receivableDocumentId as string;
    allocatedByReceivable.set(key, (allocatedByReceivable.get(key) ?? 0) + a.amountMinor);
  }

  return documents.map((doc) => {
    const allocated = allocatedByReceivable.get(doc._id as string) ?? 0;
    const outstandingMinor =
      doc.status === "CANCELLED" ? 0 : Math.max(0, doc.originalAmountMinor - allocated);
    return { doc, allocatedMinor: allocated, outstandingMinor };
  });
}

/**
 * The Claims work queue, sourced from the authoritative receivable.
 *
 * `applicationId` is carried on every row deliberately: the receivable stores
 * its origin as an opaque `sourceId` string, and resolving that back to the
 * Finance Application is the server's job. A client that had to guess how to
 * reach the authority would be a second authority in waiting.
 */
export const listFinanceCompanyReceivables = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    // VIEW_FINANCE, matching `list` below — this replaces what the Claims tab
    // rendered, so it must not demand more than that tab already required.
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const rows = await financeCompanyReceivableRows(ctx, args.orgId);

    const financeCompanyNames = new Map<string, string>();
    const customerNames = new Map<string, string>();
    for (const { doc } of rows) {
      if (doc.financeCompanyId && !financeCompanyNames.has(doc.financeCompanyId)) {
        const company = await ctx.db.get(doc.financeCompanyId);
        if (company) financeCompanyNames.set(doc.financeCompanyId, company.name);
      }
      if (doc.customerId && !customerNames.has(doc.customerId)) {
        const customer = await ctx.db.get(doc.customerId);
        if (customer) {
          customerNames.set(
            doc.customerId,
            `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim()
          );
        }
      }
    }

    return rows
      .sort((a, b) => b.doc.issueDate - a.doc.issueDate)
      .map(({ doc, outstandingMinor }) => ({
        receivableDocumentId: doc._id,
        documentNumber: doc.documentNumber,
        applicationId: doc.sourceId,
        financeCompanyId: doc.financeCompanyId,
        financingEntity: doc.financeCompanyId
          ? financeCompanyNames.get(doc.financeCompanyId) ?? null
          : null,
        customerId: doc.customerId,
        buyerName: doc.customerId ? customerNames.get(doc.customerId) ?? null : null,
        originalAmountMinor: doc.originalAmountMinor,
        outstandingMinor,
        currency: doc.currency,
        scale: doc.scale,
        status: doc.status,
        issueDate: doc.issueDate,
        dueDate: doc.dueDate,
      }));
  },
});

/**
 * Totals for the same set, from the same rows as the list above.
 *
 * `outstandingMinor` counts only documents that can still be collected. A
 * WRITTEN_OFF receivable keeps a non-zero `original - allocated` — the write-off
 * is recorded as an expense in the GL, not as an allocation — so counting it as
 * outstanding would overstate what the financiers still owe. It stays visible
 * in `byStatus` rather than being dropped.
 */
export const financeCompanyReceivableTotals = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const rows = await financeCompanyReceivableRows(ctx, args.orgId);

    const byStatus: Record<string, { count: number; originalMinor: number }> = {};
    let originalMinor = 0;
    let outstandingMinor = 0;

    for (const { doc, outstandingMinor: rowOutstanding } of rows) {
      const bucket = byStatus[doc.status] ?? { count: 0, originalMinor: 0 };
      bucket.count += 1;
      bucket.originalMinor += doc.originalAmountMinor;
      byStatus[doc.status] = bucket;

      originalMinor += doc.originalAmountMinor;
      if (doc.status === "OPEN" || doc.status === "PARTIALLY_PAID") {
        outstandingMinor += rowOutstanding;
      }
    }

    return { count: rows.length, originalMinor, outstandingMinor, byStatus };
  },
});
