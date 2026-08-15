/**
 * Finance-company claims — a READ-ONLY work queue (SCRUM-51).
 *
 * This module used to be a second finance-company AR authority. `add` opened a
 * canonical `receivableDocuments` row with `payerType: FINANCE_COMPANY` while no
 * `CLAIM_CREATED` accounting event ever existed, so the subledger carried a
 * balance the GL had never debited. `settle` and `reject` then *credited*
 * `ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES`, discharging a receivable that was
 * never originated, and the free-text creation form could open a second
 * receivable for a financed sale that Finance Applications had already booked.
 *
 * Finance Applications own that receivable: `applications.ts`
 * (`ensureFinanceCompanyReceivable`) creates it and `ruleFinanceDisbursed` posts
 * the real Dr AR-Finance / Cr AR-Customers transfer, with
 * `ruleFinanceCashReceived` settling it on `confirmDisbursement`.
 *
 * So Claims originates nothing and settles nothing. It projects the
 * authoritative receivables for the accountant to work from, and the actions
 * live with the application that owns the deal. Settling *through* Claims would
 * not have been a safe alternative: `confirmDisbursement` posts
 * `hookFinanceCashReceived` before it computes `allocationMinor`, and skips the
 * allocation when the receivable is already fully allocated rather than
 * throwing — so a second settlement door would silently double-credit the GL.
 *
 * `convex/claimsReadOnlyGuard.test.ts` fails CI if a writer is added back.
 *
 * The legacy `claims` table is retained (read-only, no writer) so historical
 * rows stay inspectable; production carried none at 214c843a.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { getReceivableOutstandingMinor } from "./subledger";

/** `applications.ts` stamps this on the receivable it owns. */
const FINANCE_APP_RECEIVABLE_SOURCE = "finance_application";

/**
 * The finance-company AR work queue: every canonical receivable owed by a
 * financier, with the outstanding balance derived from active allocations
 * rather than stored, so it can never drift from the subledger.
 */
export const listFinanceCompanyReceivables = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const page = await ctx.db
      .query("receivableDocuments")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .filter((q) => q.eq(q.field("payerType"), "FINANCE_COMPANY"))
      .paginate(args.paginationOpts);

    const rows = await Promise.all(
      page.page.map(async (doc) => {
        const outstandingMinor = await getReceivableOutstandingMinor(ctx, doc._id);

        // The financier's name comes from the configured company when there is
        // one. A MANUAL_FINANCE_COMPANY deal has no company row by
        // construction, so the application's own snapshot is the only record of
        // who the financier was.
        let financingEntity: string | null = null;
        if (doc.financeCompanyId) {
          const company = await ctx.db.get(doc.financeCompanyId);
          financingEntity = company?.orgId === args.orgId ? company.name : null;
        }

        let applicationId: string | null = null;
        if (doc.sourceType === FINANCE_APP_RECEIVABLE_SOURCE) {
          applicationId = doc.sourceId;
          if (!financingEntity) {
            // sourceId is a plain string on the document, so it has to be
            // normalized rather than cast — a legacy or malformed value must
            // read as "unknown financier", never throw the whole queue away.
            const appId = ctx.db.normalizeId("financeApplications", doc.sourceId);
            const app = appId ? await ctx.db.get(appId) : null;
            if (app?.orgId === args.orgId) {
              financingEntity = app.manualFinanceSnapshot?.providerName ?? null;
            }
          }
        }

        let buyerName: string | null = null;
        if (doc.customerId) {
          const customer = await ctx.db.get(doc.customerId);
          buyerName =
            customer?.orgId === args.orgId
              ? `${customer.firstName} ${customer.lastName}`.trim()
              : null;
        }

        return {
          receivableDocumentId: doc._id,
          documentNumber: doc.documentNumber,
          applicationId,
          sourceType: doc.sourceType,
          financingEntity,
          buyerName,
          originalAmountMinor: doc.originalAmountMinor,
          outstandingMinor,
          currency: doc.currency,
          scale: doc.scale,
          status: doc.status,
          issueDate: doc.issueDate,
          dueDate: doc.dueDate,
        };
      })
    );

    return { ...page, page: rows };
  },
});
