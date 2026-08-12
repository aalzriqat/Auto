import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULES = import.meta.glob("./**/*.ts");

/**
 * SCRUM-61 — a CONFIGURED_FINANCE_COMPANY deal must not reach vehicle handover
 * or finalization without its economics recorded.
 *
 * `assertDealerEconomicsRecorded` returned early when `submittedQuotationMinor`
 * was absent, which let a deal be handed over AND finalized with no approved
 * dealer purchase amount at all. The resulting application is CLOSED, and CLOSED
 * is terminal: `VALID_STATUS_TRANSITIONS` maps it to `[]`, and
 * `recordSubmittedQuotation` / `approveDealerPurchaseAmount` / `reopenApproval`
 * each refuse a closed application. So the economics can never be recorded, the
 * dealership's profit on that deal is permanently uncomputable, and the deal
 * cockpit tells the operator to record an amount nothing will accept.
 *
 * The early return existed for legacy rows predating the economics flow. That is
 * a fair reading for history and the wrong one for new deals, which is what these
 * tests pin.
 *
 * SCOPE, per the product ruling: this applies to CONFIGURED_FINANCE_COMPANY only.
 * MANUAL_FINANCE_COMPANY, LEASE and INTERNAL_INSTALLMENT may not structurally
 * produce a submitted quotation, and manufacturing that requirement for them
 * would invent a business rule. The permissive cases below are not filler — they
 * are what stops this guard being widened into a different defect.
 */

const PERMISSIONS = [
  "create:sales",
  "view:sales",
  "edit:vehicles",
  "approve:requests",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "confirm:finance_disbursement",
  "verify:finance_documents",
  "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance",
  // The cockpit returns `money: null` to a caller without it, so the profit
  // assertions below would read a null rather than the reason under test.
  "view:finance",
];

type Mode =
  | "CONFIGURED_FINANCE_COMPANY"
  | "MANUAL_FINANCE_COMPANY"
  | "LEASE"
  | "INTERNAL_INSTALLMENT"
  /**
   * A real finance company with NO mode recorded — creatable today through
   * `quotes.saveQuote`, which rejects a `companyId` only when a mode is present
   * and is not the configured one.
   */
  | "OMIT_MODE";

/** An APPROVED application with NO economics recorded, in the given quote mode. */
async function seedApprovedApplication(mode: Mode) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Guard Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "guard_user", email: "guard@test.com", name: "Guard User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "guard_approver", email: "guard.a@test.com", name: "Guard Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const asUser = t.withIdentity({ subject: "guard_user", clerkId: "guard_user" });
  const asApprover = t.withIdentity({ subject: "guard_approver", clerkId: "guard_approver" });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A333333",
      make: "Kia",
      model: "Sportage",
      year: 2023,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 1000,
      sellingPrice: 20000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Sam", lastName: "Lee" })
  );

  // Only a CONFIGURED deal carries a finance company; `quotes.saveQuote` rejects
  // a companyId on every other mode, so this is not an incidental difference.
  const companyId =
    mode === "CONFIGURED_FINANCE_COMPANY" || mode === "OMIT_MODE"
      ? await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Jordan Auto Finance",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            // `recordSubmittedQuotation` runs the solver, and `resolveAppliedLtv`
            // refuses a company with no LTV rather than defaulting to 100%. This
            // is load-bearing for the chain test, not decoration. Note it is
            // `defaultLtvPercent` (the dealer-purchase rule) and NOT
            // `maxFinancingLTV` (the customer loan) — they are different terms of
            // different transactions.
            defaultLtvPercent: 85,
            isActive: true,
          })
        )
      : undefined;

  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId,
    customerId,
    vehicleId,
    vehiclePrice: 20000,
    downPayment: 3000,
    termMonths: 48,
    // OMIT_MODE sends no mode at all, which is the whole point of that case.
    ...(mode === "OMIT_MODE" ? {} : { mode }),
    ...(companyId ? { companyId } : {}),
    totalFinancedAmount: 17000,
  });

  const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
  await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });

  // Guards the fixture itself: if the seed ever starts recording economics, these
  // tests would keep passing while no longer covering the branch they name.
  const economics = await t.run(async (ctx) => {
    const app = await ctx.db.get(applicationId);
    return {
      submittedQuotationMinor: app?.submittedQuotationMinor,
      approvedDealerPurchaseAmountMinor: app?.approvedDealerPurchaseAmountMinor,
      financeCompanyFundedPortionMinor: app?.financeCompanyFundedPortionMinor,
    };
  });
  expect(economics.submittedQuotationMinor).toBeUndefined();
  expect(economics.approvedDealerPurchaseAmountMinor).toBeUndefined();
  expect(economics.financeCompanyFundedPortionMinor).toBeUndefined();

  const registerExpectedPayment = () =>
    asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "BANK_TRANSFER",
      expectedDate: Date.now(),
    });

  /**
   * Stamps the handover directly so the FINALIZE call site can be tested on its
   * own. The two call sites are separate lines guarding separate transitions;
   * driving finalize through the handover mutation would only ever re-test the
   * first one.
   */
  const forceHandover = () =>
    t.run((ctx) => ctx.db.patch(applicationId, { vehicleHandoverAt: Date.now(), vehicleHandoverBy: userId }));

  return { t, orgId, applicationId, asUser, registerExpectedPayment, forceHandover };
}

describe("SCRUM-61: a CONFIGURED deal may not close without its economics", () => {
  test("vehicle handover is refused when nothing is recorded", async () => {
    const { orgId, applicationId, asUser } = await seedApprovedApplication("CONFIGURED_FINANCE_COMPANY");

    await expect(
      asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId })
    ).rejects.toThrow(/submitted quotation is not recorded/i);
  });

  test("finalization is refused when nothing is recorded, and the deal stays recoverable", async () => {
    const { t, orgId, applicationId, asUser, registerExpectedPayment, forceHandover } =
      await seedApprovedApplication("CONFIGURED_FINANCE_COMPANY");

    await forceHandover();
    await registerExpectedPayment();

    await expect(
      asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId })
    ).rejects.toThrow(/submitted quotation is not recorded/i);

    // The refusal must leave the application recoverable rather than half-closed.
    // A deal CLOSED with no sale is the terminal state this whole issue is about,
    // so a guard that refused *after* patching the status would be no better than
    // the fail-open it replaces.
    const after = await t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.status).toBe("APPROVED");
    expect(after?.finalizedSaleId).toBeUndefined();
  });

  test("recording the quotation advances the refusal to the approved purchase amount", async () => {
    const { orgId, applicationId, asUser, registerExpectedPayment, forceHandover } =
      await seedApprovedApplication("CONFIGURED_FINANCE_COMPANY");

    // Pins the CHAIN rather than the first gate. Asserting only the first message
    // would pass just as well against a guard that checked the quotation and then
    // let a deal through with no approved amount — which is the original defect.
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 17_000_000,
      source: "MANUAL_ENTRY",
    });

    await forceHandover();
    await registerExpectedPayment();

    await expect(
      asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId })
    ).rejects.toThrow(/approved purchase amount/i);
  });
});

describe("SCRUM-61: a finance company is evidence, even when the mode is missing", () => {
  /**
   * The bypass two independent reviews found, one of them by reproducing it end
   * to end: a quote carrying a real `companyId` with `mode` OMITTED.
   *
   * `quotes.saveQuote` rejects a `companyId` only when a mode is present and is
   * not the configured one, so this shape is creatable today through the
   * ordinary public mutation with ordinary permissions — it is not a legacy
   * artefact. Keying the guard on the mode alone let it reach the terminal
   * CLOSED state with no economics at all, while carrying a real finance
   * company: exactly the defect this issue exists to remove, through a door the
   * fix had left open.
   *
   * `settlementPayer` already treats this shape as externally financed by that
   * company. The guard now agrees with it, because two derivations disagreeing
   * about what kind of deal this is was the second source of truth this work set
   * out to avoid.
   */
  test("a quote with a finance company but no mode is still held to the requirement", async () => {
    const { orgId, applicationId, asUser, t } = await seedApprovedApplication("OMIT_MODE");

    // The shape is what the finding describes: no mode anywhere, real company.
    const app = await t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.quoteModeAtSubmission).toBeUndefined();
    expect(app?.companyId).toBeDefined();
    const quote = await t.run((ctx) => ctx.db.get(app!.quoteId));
    expect(quote?.mode).toBeUndefined();

    await expect(
      asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId })
    ).rejects.toThrow(/submitted quotation is not recorded/i);
  });

  test("and its cockpit calls the amount unrecorded, not inapplicable", async () => {
    // The other half: if the guard now demands the economics, the screen must
    // say they are missing rather than that this kind of deal never has them.
    const { orgId, applicationId, asUser } = await seedApprovedApplication("OMIT_MODE");

    const view = await asUser.query(api.applications.dealCockpit, { orgId, applicationId });
    const profit = view!.money!.managementProfit;
    expect(profit.available).toBe(false);
    if (profit.available) return;
    expect(profit.reason).toBe("NoApprovedPurchaseAmount");
  });
});

describe("SCRUM-61: the cockpit says why a profit is missing, and does not promise one", () => {
  /**
   * The other half of the ruling. Refusing the deal is not enough if the screen
   * then tells the operator to go and record a figure that does not exist for
   * their kind of deal — that is the same dead end reached through the copy.
   *
   * "Not recorded" names an action. "Not available for this financing mode"
   * names a fact. Only one of them is true on a deal the dealership financed
   * itself, and only one of them can be acted on.
   */
  test("a mode with no finance company reports the profit as inapplicable, not as pending", async () => {
    const { t, orgId, applicationId, asUser } =
      await seedApprovedApplication("INTERNAL_INSTALLMENT");
    void t;

    const view = await asUser.query(api.applications.dealCockpit, { orgId, applicationId });
    const profit = view!.money!.managementProfit;

    expect(profit.available).toBe(false);
    if (profit.available) return;
    expect(profit.reason).toBe("NotApplicableForFinancingMode");
  });

  test("a CONFIGURED deal still reports the amount as merely unrecorded", async () => {
    // The control. Without it, the change above could be widened to every mode
    // and this file would stay green while telling a configured dealership that
    // a figure it genuinely must record is "not available".
    const { orgId, applicationId, asUser } =
      await seedApprovedApplication("CONFIGURED_FINANCE_COMPANY");

    const view = await asUser.query(api.applications.dealCockpit, { orgId, applicationId });
    const profit = view!.money!.managementProfit;

    expect(profit.available).toBe(false);
    if (profit.available) return;
    expect(profit.reason).toBe("NoApprovedPurchaseAmount");
  });
});

describe("SCRUM-61: the requirement is scoped to CONFIGURED, not to financing in general", () => {
  // These are the control cases. Without them, the guard could be widened to
  // every financing mode and this file would still be green — while blocking
  // deals that structurally cannot produce a submitted quotation.
  test("a MANUAL_FINANCE_COMPANY deal is not blocked by the configured-mode requirement", async () => {
    const { t, orgId, applicationId, asUser, registerExpectedPayment } =
      await seedApprovedApplication("MANUAL_FINANCE_COMPANY");

    await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
    await registerExpectedPayment();
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    const after = await t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.status).toBe("CLOSED");
    expect(after?.finalizedSaleId).toBeDefined();
  });

  test("a LEASE deal is not blocked by the configured-mode requirement", async () => {
    const { t, orgId, applicationId, asUser, registerExpectedPayment } =
      await seedApprovedApplication("LEASE");

    await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
    await registerExpectedPayment();
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    const after = await t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.status).toBe("CLOSED");
    expect(after?.finalizedSaleId).toBeDefined();
  });

  /**
   * The third mode the product ruling names, and the one this file originally
   * left unpinned.
   *
   * It is covered because INTERNAL_INSTALLMENT genuinely travels this
   * lifecycle — verified rather than assumed: `createFromQuote` applies no mode
   * filter at all, `finalizeDeal` maps the mode to `financingType: "FINANCED"`
   * when completing the sale (`applications.ts`), and
   * `setSupplierSettlementRoute` reasons about these deals explicitly. So the
   * guard CAN reach them, and something has to say that it must not.
   *
   * The dealership finances this one itself — the customer pays it over time.
   * There is no external company to submit a quotation to, so demanding one
   * would dead-end exactly the deals this ruling set out to protect.
   */
  test("an INTERNAL_INSTALLMENT deal is not blocked by the configured-mode requirement", async () => {
    const { t, orgId, applicationId, asUser, registerExpectedPayment } =
      await seedApprovedApplication("INTERNAL_INSTALLMENT");

    await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
    await registerExpectedPayment();
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    const after = await t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.status).toBe("CLOSED");
    expect(after?.finalizedSaleId).toBeDefined();
  });
});
