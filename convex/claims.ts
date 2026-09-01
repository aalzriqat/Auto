import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getReceivableOutstandingMinor } from "./subledger";
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
 * a session; refusing server-side closes it for every caller.
 *
 * ⚠️ NOTHING IS WRITTEN, AND THE REASON IS ROLLBACK — NOT ABSENCE OF WRITES.
 * This comment took three tries and both seats to get right, so it states the
 * mechanism rather than the conclusion. `requireTenantAuth` runs first, and
 * under an impersonation session `enforceImpersonationGrant` INSERTS an
 * `impersonated-write:` row into `adminAuditLog`. But the refusal below throws
 * uncaught, and an uncaught throw rolls the whole Convex mutation back — so
 * that row never commits either. A refused attempt therefore leaves no trace
 * in the database at all, including no audit trail of the attempt. If durable
 * failed-attempt auditing is ever wanted here it needs a different mechanism,
 * because anything written inside the transaction dies with it.
 */
function refuseRetiredClaimsWriter(door: string): never {
  throwAppError(
    AppErrorCode.CLAIMS_RETIRED,
    `Claims no longer records finance-company money (claims.${door} is retired). Finance-company receivables are opened and settled through the deal's Finance Application, which is the only authority for them. If this claim has no finance application behind it, it has no receivable either, and there is nothing here to settle or write off.`
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
 * ⚠️ ONE DEFINITION OF WHAT IS STILL COLLECTABLE, USED BY BOTH READERS.
 *
 * The first version of this file zeroed only CANCELLED in the row computation
 * while the totals separately excluded WRITTEN_OFF and REVERSED from the sum.
 * A written-off receivable therefore reported its full balance as outstanding
 * in the list and zero in the total — the exact disagreement the shared-formula
 * design was supposed to prevent. Both seats found it (SCRUM-51-F4 /
 * SCRUM51-ADV-002), and `applications.ts` already carries the same rule with a
 * comment saying why: a written-off or reversed receivable would otherwise
 * assert the finance company still owes money the dealership has given up on.
 *
 * So collectability is decided in exactly one place, and the balance itself
 * comes from `subledger.getReceivableOutstandingMinor` rather than a second
 * summation — the helper the mutation side already trusts, including its
 * CANCELLED handling.
 *
 * ⚠️ `applications.ts` reaches the same ANSWER by a different SHAPE, and an
 * earlier version of this comment wrongly called them the same rule. This is
 * an allow-list of two; that one is a block-list of three, which leaves PAID
 * on its live side. They agree only because a PAID receivable always nets to
 * zero through the shared helper — an invariant, not a structural guarantee.
 * Add a seventh status to the schema and they diverge silently, which is the
 * list-versus-total failure this file just closed, moved up a level. Worth
 * one shared predicate if either side is touched again.
 */
const COLLECTIBLE_STATUSES = new Set(["OPEN", "PARTIALLY_PAID"]);

async function collectibleBalanceMinor(
  ctx: QueryCtx,
  doc: Doc<"receivableDocuments">
): Promise<number> {
  if (!COLLECTIBLE_STATUSES.has(doc.status)) return 0;
  return await getReceivableOutstandingMinor(ctx, doc._id);
}

/**
 * A finance-company view has to fit in one read, and this one does not page.
 *
 * ⚠️ IT FAILS LOUDLY RATHER THAN TRUNCATING. A capped list is merely short; a
 * capped TOTAL is wrong, and a wrong total on a finance-company balance is the
 * kind of number someone acts on. So beyond the cap this refuses, and the
 * consuming client (237-B) has to arrive with pagination rather than inherit a
 * silently partial figure.
 *
 * ⚠️ THE CAP COUNTS LIFETIME DOCUMENTS, NOT OPEN ONES, and both seats were
 * right to call that a ratchet: a PAID receivable from three years ago counts
 * against it exactly like an open one, nothing purges these rows, and so a
 * long-lived dealer crosses the line and loses the view entirely. It is left
 * this way ON PURPOSE rather than half-fixed here — filtering the cap to open
 * statuses needs an index this schema does not have, and these queries take no
 * pagination arguments at all, so 237-B cannot simply 'arrive with pagination'
 * against this shape. Designing that is 237-B's job and it should start from
 * this sentence rather than from the optimistic one above it. Refusing beats
 * lying in the meantime, and there is no consumer yet for it to break.
 */
const MAX_FINANCE_COMPANY_ROWS = 500;

async function financeCompanyReceivableDocs(ctx: QueryCtx, orgId: Id<"organizations">) {
  const documents = await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", FINANCE_APPLICATION_SOURCE)
    )
    .take(MAX_FINANCE_COMPANY_ROWS + 1);

  if (documents.length > MAX_FINANCE_COMPANY_ROWS) {
    throwAppError(
      AppErrorCode.VALIDATION_FAILED,
      `This organization has more than ${MAX_FINANCE_COMPANY_ROWS} finance-company receivables, which is more than this view can total in one read. It is refused rather than shown partially, because a partial total reads like a complete one.`
    );
  }
  return documents;
}

/**
 * The Claims work queue, sourced from the authoritative receivable.
 *
 * `applicationId` is carried on every row deliberately: the receivable stores
 * its origin as an opaque `sourceId` string, and resolving that back to the
 * Finance Application is the server's job. A client that had to guess how to
 * reach the authority would be a second authority in waiting.
 *
 * ⚠️ `applicationId` is the receivable's RAW `sourceId` and is not proven to
 * name a live application — `sourceType` is a free-form string on the document,
 * so this reader states provenance rather than certifying it.
 */
export const listFinanceCompanyReceivables = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    // VIEW_FINANCE, matching `list` below — this replaces what the Claims tab
    // rendered, so it must not demand more than that tab already required.
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const documents = await financeCompanyReceivableDocs(ctx, args.orgId);
    documents.sort((a, b) => b.issueDate - a.issueDate);

    // Resolved together rather than one document after another. Each row needs
    // two point reads and a balance lookup, and awaiting them in sequence made
    // the handler as slow as the row count — a needless multiplier, since none
    // of the reads depends on another.
    return await Promise.all(
      documents.map(async (doc) => {
        // ⚠️ RE-CHECK THE TENANT ON EVERY RELATED READ. These ids come off the
        // document, not off the request, so a malformed or legacy row would
        // otherwise let this view print another dealership's finance company or
        // customer name. Belt and braces: the writers set them correctly today.
        const company = doc.financeCompanyId ? await ctx.db.get(doc.financeCompanyId) : null;
        const customer = doc.customerId ? await ctx.db.get(doc.customerId) : null;
        const sameOrgCompany = company && company.orgId === args.orgId ? company : null;
        const sameOrgCustomer = customer && customer.orgId === args.orgId ? customer : null;

        return {
          receivableDocumentId: doc._id,
          documentNumber: doc.documentNumber,
          applicationId: doc.sourceId,
          financeCompanyId: doc.financeCompanyId,
          financingEntity: sameOrgCompany ? sameOrgCompany.name : null,
          customerId: doc.customerId,
          buyerName: sameOrgCustomer
            ? `${sameOrgCustomer.firstName ?? ""} ${sameOrgCustomer.lastName ?? ""}`.trim()
            : null,
          originalAmountMinor: doc.originalAmountMinor,
          outstandingMinor: await collectibleBalanceMinor(ctx, doc),
          currency: doc.currency,
          scale: doc.scale,
          status: doc.status,
          issueDate: doc.issueDate,
          dueDate: doc.dueDate,
        };
      })
    );
  },
});

/**
 * Totals for the same set, from the same collectability rule as the list.
 *
 * ⚠️ PER CURRENCY, NEVER ONE SCALAR. Minor units only mean something next to
 * their currency and scale: 50_000 is 500.00 USD at scale 2 and 50.000 JOD at
 * scale 3. The first version of this query added them into a single
 * `originalMinor`, which is a number with no unit — reported by the Codex seat
 * as SCRUM51-ADV-002. There is deliberately no cross-currency grand total here;
 * producing one needs exchange rates and a stated reporting currency, which is
 * `accountingReports`'s job, not this view's.
 */
export const financeCompanyReceivableTotals = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const documents = await financeCompanyReceivableDocs(ctx, args.orgId);

    const byCurrency: Record<
      string,
      { scale: number; count: number; originalMinor: number; outstandingMinor: number }
    > = {};
    const byStatus: Record<string, number> = {};

    for (const doc of documents) {
      const bucket =
        byCurrency[doc.currency] ??
        { scale: doc.scale, count: 0, originalMinor: 0, outstandingMinor: 0 };

      // ⚠️ TWO SCALES UNDER ONE CURRENCY IS CORRUPTION, NOT A ROUNDING QUESTION.
      // The bucket takes its scale from whichever document is seen first, so a
      // second document claiming the same currency at a different scale would
      // have its minor units added under the wrong one — 100 fils and 100
      // piastres silently becoming 200 of something. `ensureReceivableDocument`
      // derives scale from the currency, so this cannot happen today; it could
      // if the currency table were ever edited between writes. Refused rather
      // than averaged, because there is no honest number to report here.
      if (bucket.scale !== doc.scale) {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          `Finance-company receivables in ${doc.currency} disagree about scale (${bucket.scale} and ${doc.scale}). A total across them would be meaningless, so it is refused until the documents are corrected.`
        );
      }
      bucket.count += 1;
      bucket.originalMinor += doc.originalAmountMinor;
      bucket.outstandingMinor += await collectibleBalanceMinor(ctx, doc);
      byCurrency[doc.currency] = bucket;

      byStatus[doc.status] = (byStatus[doc.status] ?? 0) + 1;
    }

    return { count: documents.length, byCurrency, byStatus };
  },
});
