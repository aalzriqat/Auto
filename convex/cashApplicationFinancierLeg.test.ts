import { TestConvex as ConvexTestInstance } from "convex-test";
import { describe, expect, test } from "vitest";
import { convexTestWithComponents, recordReconciledZeroCost, registerHandover } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { FC_RETURN_MESSAGES } from "./utils/fcCheque";
import { salesAr } from "../lib/i18n/domains/sales";

type TestConvex = ConvexTestInstance<typeof schema>;
const MODULES = import.meta.glob("./**/*.*s");

/**
 * SCRUM-567 - the financier leg of a deal that is PROVABLY financier-less.
 *
 * Invariant: a finalized Unified Deal application carries exactly one of two
 * financier-leg states. NONE ("no finance company pays the dealership") only
 * when the deal is PROVABLY financier-less - a CASH sale whose own row names
 * this application back, with no company and no manual payer on it. In every
 * other case the leg is EXPECTED / UNKNOWN and fails closed. The stored
 * `settlementStatus`, the cockpit stage rail, the overview and the
 * `confirmDisbursement` guard all agree with that state.
 *
 * Every deal below is closed by the REAL `finalizeDeal`; no sale row is seeded.
 * The few rows patched AFTER finalize are the "what if the evidence later
 * disagrees" fixtures, each commented where it is used.
 *
 * Evidence boundary: convex-test only (no OCC, no real runtime, no prod data).
 */
describe("SCRUM-567: the financier leg of a finalized CASH deal", () => {
  interface Seed {
    t: TestConvex;
    orgId: Id<"organizations">;
    userId: Id<"users">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    quoteId: Id<"quotes">;
    asOwner: ReturnType<TestConvex["withIdentity"]>;
  }

  async function seed(tag: string, opts: { sourced?: boolean } = {}): Promise<Seed> {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `CF ${tag}`, createdAt: Date.now() }));
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `cf_${tag}`, email: `cf.${tag}@example.com`, name: "CF Owner" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
    );
    const asOwner = t.withIdentity({ subject: `cf_${tag}`, clerkId: `cf_${tag}` });
    // A live chart and an open period, so a posting that WOULD happen is observable.
    await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
    const fiscalYear = new Date().getUTCFullYear();
    await asOwner.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(fiscalYear, 0, 1),
      endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear,
      periodNumber: 1,
    });
    const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
    await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

    const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "CF", lastName: "Customer" }));
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: `CFVIN${tag}`,
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 100,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 10_500,
        status: "AVAILABLE",
        ...(opts.sourced
          ? { sourceType: "SOURCED" as const, sourcedFromName: "Amman Importer Co", sourceCost: 9_500 }
          : { sourceType: "STOCK" as const, purchasePrice: 9_500, landedCostTotal: 100 }),
      })
    );
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 10_500,
        downPayment: 500,
        termMonths: 60,
        status: "ACCEPTED",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    return { t, orgId, userId, customerId, vehicleId, quoteId, asOwner };
  }

  /** `NONE`: a mode-less application (no `quoteModeAtSubmission`; the seed quote carries no mode either). */
  type Mode = "CASH" | "NONE" | "MANUAL_FINANCE_COMPANY" | "INTERNAL_INSTALLMENT";

  /**
   * An APPROVED application that has passed every `finalizeDeal` precondition,
   * so the test body calls the real mutation. Same shape the SCRUM-446 suite
   * (`financierLegNotApplicable.test.ts` `readyToFinalize`) uses; that helper is
   * a closure inside its describe and is not importable.
   */
  async function readyToFinalize(s: Seed, opts: { mode?: Mode; manualLetter?: boolean } = {}) {
    const mode = opts.mode ?? "CASH";
    const applicationId = await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: s.orgId,
        quoteId: s.quoteId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        salespersonId: s.userId,
        status: "APPROVED",
        ...(mode === "NONE" ? {} : { quoteModeAtSubmission: mode }),
        economicsCurrency: "JOD",
        targetSellingAmountMinor: 12_000_000,
        approvedDealerPurchaseAmountMinor: 11_000_000,
        financeCompanyFundedPortionMinor: 9_350_000,
        dealerContributionMinor: 1_650_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    // The approval letter freezes at handover, so it is recorded (by an approver who is not the
    // salesperson) BEFORE the handover patch below.
    if (opts.manualLetter) {
      const roleId = await s.t.run(async (ctx) => (await ctx.db.query("roles").first())!._id);
      const approverUserId = await s.t.run((ctx) =>
        ctx.db.insert("users", { clerkId: `ap_${applicationId}`, email: `ap.${applicationId}@example.com`, name: "CF Approver" })
      );
      await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId: approverUserId, roleId }));
      await s.t.withIdentity({ subject: `ap_${applicationId}` }).mutation(api.financingEconomics.recordManualFinanceApproval, {
        orgId: s.orgId,
        applicationId,
        approvedAmountMinor: 12_000_000,
        financierName: "Al-Ameen Islamic Finance",
        dealerSendsMinor: 1_650_000,
      });
    }
    await s.t.run(async (ctx) => {
      const quote = (await ctx.db.get(s.quoteId))!;
      const financed = quote.vehiclePrice - quote.downPayment;
      const snapshot = {
        currency: "JOD", vehiclePrice: quote.vehiclePrice, downPayment: quote.downPayment, termMonths: quote.termMonths,
        executionFees: 0, commission: 0, profitRate: 5, insuranceRate: 0, gracePeriodMonths: 0,
        includesCommissionInDebt: false, totalFinancedAmount: financed, totalContractValue: financed,
        monthlyInstallment: financed / quote.termMonths, totalProfit: 0, takafulAmount: 0,
      };
      await ctx.db.patch(s.quoteId, { totalFinancedAmount: financed, customerQuotePricingSnapshot: snapshot });
      await ctx.db.patch(applicationId, {
        customerQuotePricingSnapshot: snapshot,
        vehicleHandoverAt: Date.now(),
        expectedPaymentMethod: "BANK_TRANSFER",
        expectedPaymentDate: Date.now(),
      });
    });
    return applicationId;
  }

  /** A manual-finance-company deal that is otherwise finalizable (letter, invoice, zero cost). */
  async function readyManualDeal(s: Seed) {
    const applicationId = await readyToFinalize(s, { mode: "MANUAL_FINANCE_COMPANY", manualLetter: true });
    await s.asOwner.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: s.orgId,
      applicationId,
      legalInvoiceAmountMinor: 12_000_000,
      legalInvoiceNumber: `INV-${applicationId}`,
      legalInvoiceDate: Date.now(),
      issuedTo: "FINANCE_COMPANY",
    });
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerFirstPaymentMinor: 0 }));
    await recordReconciledZeroCost(s.asOwner, api, s.orgId, applicationId);
    return applicationId;
  }

  const finalize = (s: Seed, applicationId: Id<"financeApplications">, idempotencyKey = crypto.randomUUID()) =>
    s.asOwner.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId, idempotencyKey });

  const appOf = (s: Seed, applicationId: Id<"financeApplications">) =>
    s.t.run((ctx) => ctx.db.get(applicationId)) as Promise<Doc<"financeApplications">>;

  /** seed -> readyToFinalize -> real finalizeDeal -> read the application back. */
  async function finalizedCash(tag: string, opts: { mode?: Mode; sourced?: boolean } = {}) {
    const s = await seed(tag, { sourced: opts.sourced });
    const applicationId = await readyToFinalize(s, { mode: opts.mode ?? "CASH" });
    await finalize(s, applicationId);
    return { s, applicationId, app: await appOf(s, applicationId) };
  }

  async function cockpitOf(s: Seed, applicationId: Id<"financeApplications">) {
    const view = (await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId }))!;
    const stage = (key: string) => view.stages.find((st) => st.key === key)!;
    return { view, disbursement: stage("DISBURSEMENT"), settlement: stage("SETTLEMENT"), all: view.stages };
  }

  /** Document counts that a finalize writes; the parity pin compares them to the pre-change run. */
  async function ledgerCounts(s: Seed) {
    return s.t.run(async (ctx) => ({
      journalEntries: (await ctx.db.query("journalEntries").take(1000)).length,
      journalLines: (await ctx.db.query("journalLines").take(1000)).length,
      receivableDocuments: (await ctx.db.query("receivableDocuments").take(1000)).length,
      supplierReceivables: (await ctx.db.query("vehicleSupplierReceivables").take(1000)).length,
      supplierPayables: (await ctx.db.query("vehicleSupplierPayables").take(1000)).length,
      sales: (await ctx.db.query("sales").take(1000)).length,
    }));
  }

  const codeOf = (error: unknown): string | null => {
    const data = (error as { data?: unknown })?.data;
    return typeof data === "object" && data !== null && typeof (data as { code?: unknown }).code === "string"
      ? (data as { code: string }).code
      : null;
  };
  async function refusalCode(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      return codeOf(error) ?? `UNCODED: ${String((error as Error)?.message ?? error)}`;
    }
    return "NO_REFUSAL";
  }
  const confirm = (s: Seed, applicationId: Id<"financeApplications">) =>
    s.asOwner.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 1_000,
      idempotencyKey: crypto.randomUUID(),
    });

  // ── (a) / (b) the proven-financier-less population ─────────────────────────
  describe.each<{ name: string; mode: Mode }>([
    { name: "a CASH-mode application", mode: "CASH" },
    { name: "a mode-less application (posted CASH)", mode: "NONE" },
  ])("$name, finalized through the real finalizeDeal", ({ mode }) => {
    test("stores NOT_APPLICABLE, the cockpit shows no financier leg, and the rail agrees", async () => {
      const s = await seed(`a_${mode}`);
      const applicationId = await readyToFinalize(s, { mode });
      await finalize(s, applicationId);

      const app = await appOf(s, applicationId);
      expect(app.status).toBe("CLOSED");
      const sale = (await s.t.run((ctx) => ctx.db.get(app.finalizedSaleId!)))!;
      expect(sale.financingType).toBe("CASH");
      expect(sale.applicationId).toBe(applicationId);

      // The raw field every get / list reader sees.
      expect(app.settlementStatus).toBe("NOT_APPLICABLE");
      const viaGet = await s.asOwner.query(api.applications.get, { orgId: s.orgId, applicationId });
      expect(viaGet?.settlementStatus).toBe("NOT_APPLICABLE");
      const listed = await s.asOwner.query(api.applications.list, {
        orgId: s.orgId,
        paginationOpts: { numItems: 20, cursor: null },
      });
      expect(listed.page.find((r) => r._id === applicationId)?.settlementStatus).toBe("NOT_APPLICABLE");

      // The cockpit: disbursement is not applicable and none of its cheque flags is offered.
      const { view, disbursement, settlement, all } = await cockpitOf(s, applicationId);
      expect(disbursement.state).toBe("NOT_APPLICABLE");
      expect(disbursement.blocker).toBeUndefined();
      expect(all.some((st) => st.state === "BLOCKED" && st.blocker === "AwaitingDisbursement")).toBe(false);
      expect(view.chequeFaceUnrecorded).toBe(false);
      expect(view.expectedPaymentReRegistrable).toBe(false);
      expect(view.chequeNeedsCorrection).toBe(false);
      expect(view.unattestedChequeId).toBeNull();
      // Stock vehicle: nothing else is owed, so the money is finished.
      expect(settlement.state).toBe("COMPLETE");

      // The overview reads the same cockpit stage for "money settled". Its profit stays an
      // estimate here only because this deal records no cost lines (`expensesFullyReconciled`,
      // dealOverview.ts) - a separate, unchanged half of "fully settled" - so the overview
      // is asserted to load, not to flip classification.
      const overview = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
      expect(overview).not.toBeNull();
    });

    test("confirmDisbursement refuses with the coded NONE refusal and changes nothing", async () => {
      const { s, applicationId, app: before } = await finalizedCash(`ai_${mode}`, { mode });
      expect(await refusalCode(confirm(s, applicationId))).toBe("FINANCE_CONFIRM_NO_FINANCIER_PAYS");
      expect(await appOf(s, applicationId)).toEqual(before);
    });
  });

  // Parity pin, NOT a failing-first test: it passes before and after. The counts were taken from the
  // unmodified code, so any journal / receivable this change adds (or removes) fails here.
  test("ledger parity: finalizing a CASH deal writes exactly the documents it wrote before this change", async () => {
    const { s } = await finalizedCash("parity");
    expect(await ledgerCounts(s)).toEqual({
      journalEntries: 1,
      journalLines: 4,
      receivableDocuments: 1,
      supplierReceivables: 0,
      supplierPayables: 0,
      sales: 1,
    });
  });

  // ── (c) / (d) a financier exists: stays EXPECTED ───────────────────────────
  test("(c) a configured finance company deal stays EXPECTED", async () => {
    // The REAL configured chain (same steps as financeDisbursementChequeReturn.test.ts
    // `finalizedChequeDeal`): quote -> application -> approval -> handover -> expected payment -> finalize.
    const s = await seed("c_company");
    const G = 12_500_000;
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sellingPrice: G / 1000 }));
    const roleId = await s.t.run(async (ctx) => (await ctx.db.query("roles").first())!._id);
    const approverId = await s.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "cf_c_appr", email: "cf.c.appr@example.com", name: "CF Approver C" })
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId: approverId, roleId }));
    const asApprover = s.t.withIdentity({ subject: "cf_c_appr", clerkId: "cf_c_appr" });
    const statusId = await s.t.run((ctx) =>
      ctx.db.insert("orgCustomerStatuses", { orgId: s.orgId, label: "Eligible", isActive: true, order: 1 })
    );
    const companyId = await s.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: s.orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
        gracePeriodMonths: 0, isActive: true, defaultLtvPercent: 100, adminFees: 0,
      })
    );
    const quoteId = await s.asOwner.mutation(api.quotes.saveQuote, {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
      vehiclePrice: G / 1000, downPayment: 0, termMonths: 48,
      mode: "CONFIGURED_FINANCE_COMPANY", companyId,
      customerEligibilityStatusIds: [statusId], totalFinancedAmount: G / 1000,
    });
    const applicationId = await s.asOwner.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
    await s.asOwner.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
    await s.asOwner.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId, submittedQuotationMinor: G, source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId, applicationId, approvedAmountMinor: G, basis: "MANUAL", notes: "Approved at the quotation.",
    });
    await registerHandover(s.asOwner, api, s.orgId, applicationId);
    await s.asOwner.mutation(api.applications.registerExpectedPayment, {
      orgId: s.orgId, applicationId, method: "CHEQUE", expectedDate: Date.now(),
      chequeDetails: { bank: "Arab Bank", chequeNumber: "CHQ-567-1" }, faceAmount: String(G / 1000),
    });
    await s.asOwner.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: s.orgId, applicationId, legalInvoiceAmountMinor: G, legalInvoiceNumber: `INV-${applicationId}`,
      legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
    });
    await recordReconciledZeroCost(s.asOwner, api, s.orgId, applicationId);
    await finalize(s, applicationId);
    const app = await appOf(s, applicationId);
    expect(app.companyId).toBeDefined();
    expect(app.settlementStatus).toBe("EXPECTED");
    const { disbursement, settlement } = await cockpitOf(s, applicationId);
    expect(disbursement.state).not.toBe("NOT_APPLICABLE");
    expect(settlement.state).not.toBe("COMPLETE");
  });

  test("(d) a manual finance payer (no companyId) stays EXPECTED", async () => {
    const s = await seed("d_manual");
    const applicationId = await readyManualDeal(s);
    await finalize(s, applicationId);
    const app = await appOf(s, applicationId);
    expect(app.companyId).toBeUndefined();
    expect(app.settlementStatus).toBe("EXPECTED");
    const { disbursement, settlement } = await cockpitOf(s, applicationId);
    expect(disbursement.state).toBe("BLOCKED");
    expect(settlement.state).not.toBe("COMPLETE");
  });

  test("a manual payer is never NONE even if the sale row is later read as CASH (the reader's manual-payer conjunct)", async () => {
    // A manual-payer application cannot reach a CASH sale through finalizeDeal, so the fixture is a
    // real finalize followed by one hand-edited field (financingType -> CASH), which is exactly the
    // evidence the reader must not trust over the manual payer.
    const s = await seed("d_cashmanual");
    const applicationId = await readyManualDeal(s);
    await finalize(s, applicationId);
    const app = await appOf(s, applicationId);
    expect(app.settlementStatus).toBe("EXPECTED");
    await s.t.run((ctx) => ctx.db.patch(app.finalizedSaleId!, { financingType: "CASH" }));
    expect((await cockpitOf(s, applicationId)).disbursement.state).not.toBe("NOT_APPLICABLE");
  });

  // ── (e)(f)(g) the evidence later disagrees: fail closed ─────────────────────
  // `finalizeDeal` always writes a financingType, so (e) cannot be produced through it: the narrowest
  // fixture is a real finalize followed by clearing that one field (a legacy / hand-edited sale row).
  test("(e) a sale whose financingType is unreadable is UNKNOWN, not NONE", async () => {
    const { s, applicationId, app } = await finalizedCash("e_untyped");
    expect((await cockpitOf(s, applicationId)).disbursement.state).toBe("NOT_APPLICABLE"); // control
    await s.t.run((ctx) => ctx.db.patch(app.finalizedSaleId!, { financingType: undefined }));
    const { disbursement, settlement } = await cockpitOf(s, applicationId);
    expect(disbursement.state).toBe("BLOCKED");
    expect(settlement.state).not.toBe("COMPLETE");
    expect(await refusalCode(confirm(s, applicationId))).toBe("FINANCE_CONFIRM_NO_FINANCE_COMPANY");
  });

  test("(f) a sale that does not name this application back is not evidence", async () => {
    const { s, applicationId, app } = await finalizedCash("f_mismatch");
    expect((await cockpitOf(s, applicationId)).disbursement.state).toBe("NOT_APPLICABLE"); // control
    const otherAppId = await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: s.orgId, quoteId: s.quoteId, customerId: s.customerId, vehicleId: s.vehicleId,
        salespersonId: s.userId, status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    for (const link of [otherAppId, undefined]) {
      await s.t.run((ctx) => ctx.db.patch(app.finalizedSaleId!, { applicationId: link }));
      const { disbursement, settlement } = await cockpitOf(s, applicationId);
      expect(disbursement.state, `link=${String(link)}`).not.toBe("NOT_APPLICABLE");
      expect(settlement.state, `link=${String(link)}`).not.toBe("COMPLETE");
    }
  });

  test("(g) a cancelled deal is never NONE, never NOT_APPLICABLE and never settled (sale cancelled behind the app, and a real cancelApplication)", async () => {
    // Legacy shape (a sale cancelled behind the application's back): `sales.update` now refuses to cancel a
    // finance-linked sale, so the cancellation is patched onto the row the way the SCRUM-446 suite does.
    const legacy = await finalizedCash("g_cancelled");
    await legacy.s.t.run((ctx) => ctx.db.patch(legacy.app.finalizedSaleId!, { status: "CANCELLED" }));
    const stopped = await cockpitOf(legacy.s, legacy.applicationId);
    expect(stopped.disbursement.state).toBe("STOPPED");
    expect(stopped.settlement.state).not.toBe("COMPLETE");
    expect(stopped.all.some((st) => st.state === "NOT_APPLICABLE")).toBe(false);

    const { s, applicationId } = await finalizedCash("g_cancelapp");
    await s.asOwner.mutation(api.applications.cancelApplication, {
      idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      applicationId,
      reason: "Customer changed their mind",
    });
    const app = await appOf(s, applicationId);
    expect(app.status).toBe("CANCELLED");
    expect(app.settlementStatus).toBe("NOT_READY");
    const { all } = await cockpitOf(s, applicationId);
    expect(all.some((st) => st.state === "NOT_APPLICABLE")).toBe(false);
  });

  // ── (h) replay ─────────────────────────────────────────────────────────────
  test("(h) finalizing twice is idempotent (same key or new key); the status never flips and no second sale is made", async () => {
    const s = await seed("h_replay");
    const applicationId = await readyToFinalize(s);
    const key = crypto.randomUUID();
    const first = await finalize(s, applicationId, key);
    const afterFirst = await appOf(s, applicationId);
    expect(afterFirst.settlementStatus).toBe("NOT_APPLICABLE");
    expect(await finalize(s, applicationId, key)).toEqual(first);
    expect((await appOf(s, applicationId)).settlementStatus).toBe("NOT_APPLICABLE");
    // A fresh key on an already-closed application returns the SAME sale (no second one is made).
    expect(await finalize(s, applicationId)).toEqual(first);
    const after = await appOf(s, applicationId);
    expect(after.settlementStatus).toBe("NOT_APPLICABLE");
    expect(after.finalizedSaleId).toBe(afterFirst.finalizedSaleId);
    expect((await ledgerCounts(s)).sales).toBe(1);
  });

  // ── (i) the coded refusals and their translations ──────────────────────────
  // EN text equality with the server message is covered by financeDisbursementChequeReturn.test.ts.
  test("(i) the confirmDisbursement no-financier refusals are coded, with Arabic text in the dictionary", () => {
    for (const code of ["FINANCE_CONFIRM_NO_FINANCIER_PAYS", "FINANCE_CONFIRM_NO_FINANCE_COMPANY"] as const) {
      expect(Object.keys(FC_RETURN_MESSAGES), code).toContain(code);
      const key = `ServerError_${code}`;
      const ar = (salesAr as Record<string, unknown>)[key];
      expect(typeof ar, `${code} ar`).toBe("string");
      expect(/[؀-ۿ]/.test(ar as string), `${code} ar is Arabic`).toBe(true);
    }
  });

  // ── (j) controls: open money stays open ────────────────────────────────────
  test("(j) a consigned CASH deal: the financier leg is NONE but the supplier's money is still owed, so settlement stays open", async () => {
    const { s, applicationId, app } = await finalizedCash("j_consigned", { sourced: true });
    expect(app.settlementStatus).toBe("NOT_APPLICABLE");
    const { disbursement, settlement } = await cockpitOf(s, applicationId);
    expect(disbursement.state).toBe("NOT_APPLICABLE");
    // NOT_APPLICABLE on the financier leg must never read as the whole deal being settled.
    expect(settlement.state).not.toBe("COMPLETE");

    // Same family: a handover-less STOCK CASH deal never reads all-complete off NOT_APPLICABLE alone.
    const stock = await finalizedCash("j_handover");
    await stock.s.t.run((ctx) => ctx.db.patch(stock.applicationId, { handoverStatus: "READY" }));
    const { all } = await cockpitOf(stock.s, stock.applicationId);
    expect(all.every((st) => st.state === "COMPLETE" || st.state === "NOT_APPLICABLE")).toBe(false);
  });

  // ── the shared predicate (reader and writer) ───────────────────────────────
  test("a retired INTERNAL_INSTALLMENT deal cannot be finalized, so the writer's INTERNAL_INSTALLMENT arm is not reachable through finalizeDeal", async () => {
    // SCRUM-495: finalizeDeal refuses the retired mode before any write. The arm still exists in the
    // shared predicate because the READER must keep reading legacy INTERNAL_INSTALLMENT rows
    // (financierLegNotApplicable.test.ts); this pins that the write side cannot produce one.
    const s = await seed("ii_retired");
    const applicationId = await readyToFinalize(s, { mode: "INTERNAL_INSTALLMENT" });
    await expect(finalize(s, applicationId)).rejects.toThrow();
    const app = await appOf(s, applicationId);
    expect(app.status).toBe("APPROVED");
    expect(app.settlementStatus).toBeUndefined();
  });

  test("control: a manual application whose letter is not yet entered is never NONE and never NOT_APPLICABLE", async () => {
    // manualPayerOf(app) === null means "payer not known yet", not "no payer". Finalize with the
    // letter, then drop it and hand-edit the sale to CASH: the manual MODE alone must keep the leg closed.
    const s = await seed("manual_noletter");
    const applicationId = await readyManualDeal(s);
    await finalize(s, applicationId);
    const app = await appOf(s, applicationId);
    expect(app.settlementStatus).toBe("EXPECTED");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, { manualApproval: undefined });
      await ctx.db.patch(app.finalizedSaleId!, { financingType: "CASH" });
    });
    const { disbursement, settlement } = await cockpitOf(s, applicationId);
    expect(disbursement.state).not.toBe("NOT_APPLICABLE");
    expect(settlement.state).not.toBe("COMPLETE");
    expect((await appOf(s, applicationId)).settlementStatus).not.toBe("NOT_APPLICABLE");
  });
});
