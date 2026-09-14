/**
 * SCRUM-117 — the SETTLEMENT CONSEQUENCE of the LTV authority hole, now a
 * REGRESSION TEST rather than a probe.
 *
 * PROVENANCE. The fixture, the four arms and every figure below were produced
 * by the ACCOUNTING-RC-INTEGRATION lane as read-only synthetic evidence at
 * frozen `d87214605f2b294ea20a8a245301165a3efbd7c0` (SCRUM-117 c19577, Slack
 * p1789301612975899), handed over at `E:/tmp/scrum117-handoff/` with sha256
 * `A9BFBF37…516DD52E`. This copy is that file, byte-identical apart from line
 * endings, with the two REPRO arms INVERTED from recording to asserting — which
 * is exactly what their acceptance floor item 4 asked the implementing lane to
 * do on integration. Accounting's implementation role was NONE; the inversion,
 * and any defect in it, is this lane's.
 *
 * WHAT IT NOW GUARDS. The authority contract (c19576) makes the unauthorized
 * rate write impossible, so the arms that used to record the damage now assert
 * it cannot happen:
 *
 *   • the attack is REFUSED at the quotation writer, by the authority guard and
 *     not by some incidental validation;
 *   • the NETTED CONTROL's finalization refusal STILL FIRES — their floor item
 *     2, which exists because a fix that silently disabled that refusal would
 *     look like a pass;
 *   • no journal is posted on either poisoned arm, so the 20,000,000 minor
 *     receivable that finalized at the old head cannot return.
 *
 * Evidence boundary, carried forward verbatim from the handoff because it is a
 * limit and not a hedge: fixture / `convex-test` observations only, never a
 * live-production finding. No duplicate posting was shown anywhere. Under
 * PAID_SEPARATELY the journals were byte-identical between arms — record
 * accuracy moved, the posting did not. No `financedSalePlan` is frozen on this
 * route, so the finance-company claim seen here is the `1210` JOURNAL LINE, not
 * a canonical receivable or plan document.
 *
 * ---- the original header follows ----
 *
 * SCRUM-117 / c19575 — the SETTLEMENT CONSEQUENCE question, answered.
 *
 * Not a source fix and not a competing implementation: a read-only probe at
 * frozen d87214605f2b294ea20a8a245301165a3efbd7c0 that runs the product's own
 * sequence twice from ONE starting fixture and compares.
 *
 *   CONTROL  — the legitimate rate: the company's configured snapshot rate is
 *              used; nobody supplies one anywhere.
 *   REPRO    — the non-finance write: a default-MANAGER-shaped role
 *              (approve:finance_application, create:finance_application, NO
 *              view:finance) sends `recordSubmittedQuotation` MANUAL_ENTRY
 *              carrying `ltvPercent: 100`, then approves with the rate OMITTED.
 *
 * Both arms then walk classification and finalization as far as the product
 * allows, and the derived split, the stored remittance, the finance-company
 * receivable and the journal lines are read from the DATABASE, never from a
 * mutation's return value.
 *
 * No guard is removed, no formula is changed, no permission is added to make a
 * path reachable. Where a chain stops, the exact refusal is recorded as the
 * answer rather than worked around.
 */
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

/** JOD is three-decimal: one major unit is 1,000 minor units. */
const SCALE = 1_000;
const VEHICLE_PRICE = 20_000;
const PURCHASE_COST = 15_000;
/** The company's configured, legitimate rate. */
const SNAPSHOT_LTV = 80;
/** The rate the non-finance caller writes. */
const POISON_LTV = 100;

/**
 * A default-MANAGER-shaped role: it may record a quotation and approve an
 * amount, and it may NOT read finance economics. Mirrors the template the
 * finding names; `view:finance` and `view:cost_price` are deliberately absent.
 */
const MANAGER_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "finalize:financed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "view:reports",
];

async function seed(tag: string, opts: { dealerContributionSettlement?: "PAID_SEPARATELY" | "NETTED_FROM_REMITTANCE" } = {}) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Probe ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_mgr`, email: `${tag}.mgr@example.com`, name: "Manager" })
  );
  const manager2Id = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_mgr2`, email: `${tag}.mgr2@example.com`, name: "Manager Two" })
  );
  // The dealership owner, who exists only to set the books up. Every step of
  // the path under test is driven by a MANAGER; this account never touches the
  // quotation, the approval, the rate, or the settlement.
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_own`, email: `${tag}.own@example.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Manager", permissions: MANAGER_PERMS })
  );
  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: [...MANAGER_PERMS, "manage:finance", "view:finance", "view:cost_price", "manage:settings"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: manager2Id, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRoleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asManager = t.withIdentity({ subject: `${tag}_mgr`, clerkId: `${tag}_mgr` });
  const asManager2 = t.withIdentity({ subject: `${tag}_mgr2`, clerkId: `${tag}_mgr2` });
  const asOwner = t.withIdentity({ subject: `${tag}_own`, clerkId: `${tag}_own` });

  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN117${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: VEHICLE_PRICE, status: "AVAILABLE",
      sourceType: "STOCK" as const, purchasePrice: PURCHASE_COST,
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true,
      // The legitimate, configured rate. Present, so nothing here is the
      // "missing rate" recovery case — the CONTROL needs no rate supplied.
      defaultLtvPercent: SNAPSHOT_LTV,
      ...(opts.dealerContributionSettlement
        ? { dealerContributionSettlement: opts.dealerContributionSettlement }
        : {}),
    })
  );

  return { t, orgId, managerId, manager2Id, ownerId, customerId, vehicleId, companyId, asManager, asManager2, asOwner };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** Quote → application → APPROVED. Identical in both arms. */
async function toApprovedApplication(s: Seeded): Promise<Id<"financeApplications">> {
  const quoteId = await s.asManager.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    vehiclePrice: VEHICLE_PRICE,
    downPayment: 0,
    termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: s.companyId,
    totalFinancedAmount: VEHICLE_PRICE,
  });
  const applicationId = await s.asManager.mutation(api.applications.createFromQuote, {
    orgId: s.orgId,
    quoteId,
  });
  await s.asManager.mutation(api.applications.updateStatus, {
    orgId: s.orgId, applicationId, status: "UNDER_REVIEW",
  });
  // The approver may not be the applicant on the same application.
  await s.asManager2.mutation(api.applications.updateStatus, {
    orgId: s.orgId, applicationId, status: "APPROVED",
  });
  return applicationId;
}

/** The stored row, read directly — never a mutation's return value. */
async function row(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run((ctx) => ctx.db.get(applicationId));
}

/** Every journal line on this org, by account CODE/NAME — the posting itself. */
async function journals(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const entries = await ctx.db.query("journalEntries").collect();
    const allLines = await ctx.db.query("journalLines").collect();
    const accounts = await ctx.db.query("chartOfAccounts").collect();
    const nameOf = (id: unknown) => {
      const a = accounts.find((x) => x._id === id);
      return a ? `${a.code} ${a.name}` : String(id);
    };
    return entries.map((entry) => {
      const lines = allLines.filter((l) => l.journalEntryId === entry._id);
      return {
        sourceType: entry.sourceType,
        debitTotalMinor: lines.reduce((n, l) => n + Number(l.debitMinor ?? 0), 0),
        lines: lines
          .slice()
          .sort((a, b) => a.lineNumber - b.lineNumber)
          .map((l) => ({
            account: nameOf(l.accountId),
            debitMinor: Number(l.debitMinor ?? 0),
            creditMinor: Number(l.creditMinor ?? 0),
          })),
      };
    });
  });
}

/** The plan frozen onto the SALE row — the canonical finance-company receivable. */
async function frozenPlan(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run(async (ctx) => {
    const sales = await ctx.db.query("sales").collect();
    const sale = sales.find(
      (row) => String((row as { applicationId?: unknown }).applicationId) === String(applicationId)
    );
    const plan = (sale as { financedSalePlan?: Record<string, unknown> } | undefined)?.financedSalePlan;
    const docs = await ctx.db.query("receivableDocuments").collect();
    const canonical = docs.find(
      (d) => String((d as { _id: unknown })._id) === String((sale as { canonicalReceivableDocumentId?: unknown })?.canonicalReceivableDocumentId)
    ) as Record<string, unknown> | undefined;
    if (!plan) {
      return {
        planAbsent: true,
        salePriceMajor: (sale as { salePrice?: number } | undefined)?.salePrice,
        loanAmountMajor: (sale as { loanAmount?: number } | undefined)?.loanAmount,
        downPaymentMajor: (sale as { downPayment?: number } | undefined)?.downPayment,
        canonicalReceivable: canonical
          ? {
              payerType: canonical.payerType,
              documentType: canonical.documentType,
              totalMinor: canonical.totalMinor,
              openBalanceMinor: canonical.openBalanceMinor,
              amountMinor: canonical.amountMinor,
              currency: canonical.currency,
              status: canonical.status,
              allKeys: Object.keys(canonical).filter((k) => /minor|amount|balance/i.test(k)),
            }
          : null,
      } as Record<string, unknown>;
    }
    return plan
      ? {
          legalInvoiceConsiderationMinor: plan.legalInvoiceConsiderationMinor,
          financeCompanyReceivableMinor: plan.financeCompanyReceivableMinor,
          financeCompanyPayableMinor: plan.financeCompanyPayableMinor,
          customerReceivableMinor: plan.customerReceivableMinor,
          fingerprint: plan.fingerprint,
        }
      : null;
  });
}

/**
 * Everything after the approval that the product allows, recording where it
 * stops rather than forcing it. Returns the first refusal encountered, if any.
 */
async function walkToFinalization(
  s: Seeded,
  applicationId: Id<"financeApplications">
): Promise<{ stoppedAt: string | null; message: string | null }> {
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      const raw = e as { data?: unknown; message?: string };
      const msg =
        typeof raw?.data === "string"
          ? raw.data
          : raw?.message ?? String(e);
      return { stoppedAt: name, message: msg };
    }
  };

  let stop =
    (await step("registerHandover", () => registerHandover(s.asManager, api, s.orgId, applicationId))) ??
    (await step("registerExpectedPayment", () =>
      s.asManager.mutation(api.applications.registerExpectedPayment, {
        orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
      })
    )) ??
    (await step("recordLegalInvoice", () =>
      s.asManager.mutation(api.financeDealCosts.recordLegalInvoice, {
        orgId: s.orgId,
        applicationId,
        legalInvoiceAmountMinor: VEHICLE_PRICE * SCALE,
        legalInvoiceNumber: `INV-${applicationId}`,
        legalInvoiceDate: Date.now(),
        issuedTo: "FINANCE_COMPANY",
      })
    ));
  if (stop) return stop;

  const feeId = await s.asManager.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD",
    idempotencyKey: crypto.randomUUID(),
    orgId: s.orgId,
    applicationId,
    feeType: "OTHER_CLOSING_EXPENSE",
    paidBy: "DEALER",
    paidTo: "OTHER",
    accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false,
    actualAmountMinor: 0,
    description: "No closing costs on this deal.",
  });
  stop =
    (await step("reconcileDealFee", () =>
      s.asManager.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "Nothing to match.",
      })
    )) ??
    (await step("classifyDealAccounting", () =>
      s.asManager.mutation(api.financeDealCosts.classifyDealAccounting, {
        orgId: s.orgId,
        applicationId,
        notes: "Invoice and settlement advice on file.",
      })
    )) ??
    (await step("finalizeDeal", () =>
      s.asManager.mutation(api.applications.finalizeDeal, {
        idempotencyKey: crypto.randomUUID(),
        orgId: s.orgId,
        applicationId,
      })
    ));
  return stop ?? { stoppedAt: null, message: null };
}

function report(label: string, payload: Record<string, unknown>) {
  // Kept from the handoff: when one of these arms fails, the whole arm's
  // figures are what tell you WHICH invariant moved. The disable directive the
  // original carried is dropped - `no-console` is not enabled for test files
  // here, and an unused directive is itself a lint warning.
  console.log(`\n### ${label}\n${JSON.stringify(payload, null, 2)}\n`);
}

const AUTHORITY_REFUSAL = /needs both finance visibility and approval authority/i;

describe("SCRUM-117 settlement consequence — one fixture, two arms", () => {
  test("CONTROL: legitimate snapshot rate, nobody supplies one", async () => {
    const s = await seed("ctl");
    const applicationId = await toApprovedApplication(s);

    await s.asManager.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId,
      applicationId,
      submittedQuotationMinor: VEHICLE_PRICE * SCALE,
      source: "MANUAL_ENTRY",
    });
    const afterQuotation = await row(s, applicationId);

    await s.asManager2.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId,
      applicationId,
      approvedAmountMinor: VEHICLE_PRICE * SCALE,
      basis: "MANUAL",
      notes: "Approved at the quotation.",
    });
    const afterApproval = await row(s, applicationId);
    const walk = await walkToFinalization(s, applicationId);
    const finalRow = await row(s, applicationId);
    const entries = await journals(s);
    const plan = await frozenPlan(s, applicationId);

    report("CONTROL", {
      rateAfterQuotation: afterQuotation?.appliedLtvPercent,
      rateAfterApproval: afterApproval?.appliedLtvPercent,
      fundedPortionMinor: afterApproval?.financeCompanyFundedPortionMinor,
      unfinancedPortionMinor: afterApproval?.unfinancedPortionMinor,
      dealerContributionMinor: afterApproval?.dealerContributionMinor,
      expectedDealerRemittanceMinor: afterApproval?.expectedDealerRemittanceMinor,
      stoppedAt: walk.stoppedAt,
      stopMessage: walk.message,
      needsFinancingReconciliation: (finalRow as { needsFinancingReconciliation?: boolean } | null)?.needsFinancingReconciliation,
      frozenPlan: plan,
      journals: entries,
    });

    expect(afterApproval?.appliedLtvPercent).toBe(SNAPSHOT_LTV);

    // Every figure this arm reports is asserted, not just observed (CodeRabbit
    // on #305): a control that carried one `expect` would not have noticed the
    // finalization walk breaking or the posting changing on this route. At 80%
    // of 20,000 the company funds 16,000, the dealership contributes 4,000 and
    // — PAID_SEPARATELY — still expects the whole 20,000 remitted; the walk
    // completes; this route freezes no `financedSalePlan`, so the
    // finance-company claim is the 1210 journal line and nothing else.
    expect(walk.stoppedAt).toBeNull();
    expect(afterApproval?.financeCompanyFundedPortionMinor).toBe(16_000 * SCALE);
    expect(afterApproval?.unfinancedPortionMinor).toBe(4_000 * SCALE);
    expect(afterApproval?.dealerContributionMinor).toBe(4_000 * SCALE);
    expect(afterApproval?.expectedDealerRemittanceMinor).toBe(VEHICLE_PRICE * SCALE);
    expect(finalRow?.appliedLtvPercent).toBe(SNAPSHOT_LTV);
    expect(plan).not.toBeNull();
    expect((plan as Record<string, unknown>).planAbsent).toBe(true);
    const saleEntries = entries.filter((entry) => entry.sourceType === "sales");
    expect(saleEntries).toHaveLength(1);
    const posted = saleEntries[0].lines.map((line) => [
      line.account.split(" ")[0],
      line.debitMinor,
      line.creditMinor,
    ]);
    expect(posted).toEqual([
      ["1210", VEHICLE_PRICE * SCALE, 0],
      ["4100", 0, VEHICLE_PRICE * SCALE],
      ["5100", PURCHASE_COST * SCALE, 0],
      ["1400", 0, PURCHASE_COST * SCALE],
    ]);
  }, 180_000);

  test("REPRO: non-finance MANAGER writes ltvPercent=100 via MANUAL_ENTRY, then approves with the rate omitted", async () => {
    const s = await seed("rep");
    const applicationId = await toApprovedApplication(s);

    let quotationRefusal: string | null = null;
    try {
      await s.asManager.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: s.orgId,
        applicationId,
        submittedQuotationMinor: VEHICLE_PRICE * SCALE,
        source: "MANUAL_ENTRY",
        ltvPercent: POISON_LTV,
      });
    } catch (e) {
      const raw = e as { data?: unknown; message?: string };
      quotationRefusal = typeof raw?.data === "string" ? raw.data : raw?.message ?? String(e);
    }
    const afterQuotation = await row(s, applicationId);

    let approvalRefusal: string | null = null;
    try {
      await s.asManager2.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: s.orgId,
        applicationId,
        approvedAmountMinor: VEHICLE_PRICE * SCALE,
        basis: "MANUAL",
        notes: "Approved at the quotation.",
        // RATE OMITTED — the question is whether the poisoned row supplies it.
      });
    } catch (e) {
      const raw = e as { data?: unknown; message?: string };
      approvalRefusal = typeof raw?.data === "string" ? raw.data : raw?.message ?? String(e);
    }
    const afterApproval = await row(s, applicationId);
    const walk = await walkToFinalization(s, applicationId);
    const finalRow = await row(s, applicationId);
    const entries = await journals(s);
    const plan = await frozenPlan(s, applicationId);

    report("REPRO", {
      quotationRefusal,
      approvalRefusal,
      rateAfterQuotation: afterQuotation?.appliedLtvPercent,
      rateAfterApproval: afterApproval?.appliedLtvPercent,
      fundedPortionMinor: afterApproval?.financeCompanyFundedPortionMinor,
      unfinancedPortionMinor: afterApproval?.unfinancedPortionMinor,
      dealerContributionMinor: afterApproval?.dealerContributionMinor,
      expectedDealerRemittanceMinor: afterApproval?.expectedDealerRemittanceMinor,
      stoppedAt: walk.stoppedAt,
      stopMessage: walk.message,
      needsFinancingReconciliation: (finalRow as { needsFinancingReconciliation?: boolean } | null)?.needsFinancingReconciliation,
      frozenPlan: plan,
      journals: entries,
    });

    /**
     * INVERTED. This arm recorded the damage; it now denies it.
     *
     * The refusal is matched against the AUTHORITY guard's own wording rather
     * than "it threw something": at the old head this call succeeded, and a
     * fixture that merely broke would satisfy a looser assertion while proving
     * nothing about who is allowed to set the rate.
     */
    expect(quotationRefusal ?? "NOT REFUSED").toMatch(AUTHORITY_REFUSAL);
    // The rate never landed, so nothing downstream can inherit it.
    expect(afterQuotation?.appliedLtvPercent ?? null).not.toBe(POISON_LTV);
    expect(afterApproval?.appliedLtvPercent ?? null).not.toBe(POISON_LTV);
    // And no posting exists to carry a wrong composition into the ledger.
    expect(entries).toEqual([]);
  }, 180_000);

  /**
   * The same two arms under a company that NETS the dealership's contribution
   * out of what it transfers. This is the configuration in which the rate is
   * not merely a composition figure: `computeExpectedRemittance` subtracts the
   * contribution from the gross, so a different rate is a different transfer.
   */
  test.each([
    ["NETTED CONTROL (legit 80)", SNAPSHOT_LTV, false],
    ["NETTED REPRO (poisoned 100)", POISON_LTV, true],
  ])("%s", async (label, rate, poisoned) => {
    const s = await seed(`n${rate}`, { dealerContributionSettlement: "NETTED_FROM_REMITTANCE" });
    const applicationId = await toApprovedApplication(s);

    let quotationRefusal: string | null = null;
    try {
      await s.asManager.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: s.orgId,
        applicationId,
        submittedQuotationMinor: VEHICLE_PRICE * SCALE,
        source: "MANUAL_ENTRY",
        ...(poisoned ? { ltvPercent: rate } : {}),
      });
    } catch (e) {
      const raw = e as { data?: unknown; message?: string };
      quotationRefusal = typeof raw?.data === "string" ? raw.data : raw?.message ?? String(e);
    }

    let approvalRefusal: string | null = null;
    try {
      await s.asManager2.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: s.orgId,
        applicationId,
        approvedAmountMinor: VEHICLE_PRICE * SCALE,
        basis: "MANUAL",
        notes: "Approved at the quotation.",
      });
    } catch (e) {
      const raw = e as { data?: unknown; message?: string };
      approvalRefusal = typeof raw?.data === "string" ? raw.data : raw?.message ?? String(e);
    }
    const afterApproval = await row(s, applicationId);
    const walk = await walkToFinalization(s, applicationId);
    const entries = await journals(s);

    report(label, {
      quotationRefusal,
      approvalRefusal,
      rateAfterApproval: afterApproval?.appliedLtvPercent,
      fundedPortionMinor: afterApproval?.financeCompanyFundedPortionMinor,
      dealerContributionMinor: afterApproval?.dealerContributionMinor,
      expectedDealerRemittanceMinor: afterApproval?.expectedDealerRemittanceMinor,
      stoppedAt: walk.stoppedAt,
      stopMessage: walk.message,
      journals: entries,
    });

    if (poisoned) {
      // The attack is refused by the authority guard, and the rate never lands.
      expect(quotationRefusal ?? "NOT REFUSED").toMatch(AUTHORITY_REFUSAL);
      expect(afterApproval?.appliedLtvPercent ?? null).not.toBe(POISON_LTV);
    } else {
      /**
       * THE FLOOR'S SHARPEST ITEM (handoff acceptance item 2).
       *
       * The legitimate arm must STILL be refused at finalization, for the
       * original accounting reason. A fix that closed the authority hole by
       * collaterally disabling this refusal would post the very entry the hole
       * used to produce, and every other assertion here would still pass.
       */
      expect(quotationRefusal).toBeNull();
      expect(approvalRefusal).toBeNull();
      expect(afterApproval?.appliedLtvPercent).toBe(SNAPSHOT_LTV);
      expect(afterApproval?.dealerContributionMinor).toBe(4_000_000);
      expect(walk.stoppedAt).toBe("finalizeDeal");
      expect(walk.message ?? "").toMatch(/settlement-deducted cost/i);
    }

    // Neither arm may post. The poisoned one because it was refused; the
    // legitimate one because the deal genuinely is not ready to finalize.
    expect(entries).toEqual([]);
  }, 180_000);
});
