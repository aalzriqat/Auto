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
 * The legacy `claims` table is retained with no writer so historical rows are
 * not destroyed. In-org Accounting does not read it — the only remaining reader
 * is the cross-tenant Super Admin browser (`adminData.ts`). Both production and
 * dev carried zero rows at 214c843a, so nothing is hidden by that.
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
 * Statuses that mean nothing is collectible.
 *
 * `getReceivableOutstandingMinor` only zeroes CANCELLED, so a WRITTEN_OFF or
 * REVERSED document with no active allocations comes back at its **full**
 * original amount. Reporting that as outstanding would assert the financier
 * still owes money the dealership has already given up on — and would mark it
 * overdue and add it to the headline. `applications.ts` excludes exactly these
 * three for the same reason; this is that rule, not a second one.
 */
const NOT_COLLECTIBLE_STATUSES = new Set(["CANCELLED", "WRITTEN_OFF", "REVERSED"]);

function collectibleOutstanding(status: string, derivedOutstandingMinor: number) {
  return NOT_COLLECTIBLE_STATUSES.has(status) ? 0 : derivedOutstandingMinor;
}

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
      .withIndex("by_org_payerType", (q) =>
        q.eq("orgId", args.orgId).eq("payerType", "FINANCE_COMPANY")
      )
      .order("desc")
      .paginate(args.paginationOpts);

    const rows = await Promise.all(
      page.page.map(async (doc) => {
        const outstandingMinor = collectibleOutstanding(
          doc.status,
          await getReceivableOutstandingMinor(ctx, doc._id)
        );

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
          // A row whose receivable was not raised by a finance application has
          // no deal to act on. The screen says so rather than rendering a row
          // with a silently missing action.
          hasOwningDeal: applicationId !== null,
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

/**
 * Org-wide outstanding per currency.
 *
 * Separate from the paginated queue on purpose: a headline computed from
 * whichever page happened to load is a subtotal wearing the word "total", and
 * this table is ordered newest-first, so the oldest and most overdue balances
 * are exactly the ones a page-bounded sum would omit.
 *
 * Never summed across currencies — a receivable is denominated when it is
 * raised, and one cross-currency number is the misstatement `accountingPhase14`
 * exists to prevent.
 *
 * Bounded by the org's finance-company receivables (roughly one per financed
 * deal), not by the whole receivables table, which is what the
 * `by_org_payerType` index buys.
 */
export const financeCompanyOutstandingTotals = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const docs = await ctx.db
      .query("receivableDocuments")
      .withIndex("by_org_payerType", (q) =>
        q.eq("orgId", args.orgId).eq("payerType", "FINANCE_COMPANY")
      )
      .collect();

    const byCurrency = new Map<string, { currency: string; scale: number; outstandingMinor: number }>();
    for (const doc of docs) {
      const outstandingMinor = collectibleOutstanding(
        doc.status,
        await getReceivableOutstandingMinor(ctx, doc._id)
      );
      if (outstandingMinor <= 0) continue;
      const bucket = byCurrency.get(doc.currency) ?? {
        currency: doc.currency,
        scale: doc.scale,
        outstandingMinor: 0,
      };
      bucket.outstandingMinor += outstandingMinor;
      byCurrency.set(doc.currency, bucket);
    }

    return [...byCurrency.values()];
  },
});
