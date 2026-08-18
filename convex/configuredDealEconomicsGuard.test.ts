import {
  convexTestWithComponents,
  registerHandover,
  registerRateLimiter,
} from "../test-utils/convexTest";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";
import { witnessToStore } from "./utils/financingEconomics";

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
async function seedApprovedApplication(
  mode: Mode,
  opts: {
    /** SOURCED stock, so the vehicle is legally the supplier's and a settlement route exists. */
    sourcedVehicle?: boolean;
    /** Names the manual provider, which is what makes it an IDENTIFIED external payer. */
    manualProviderName?: string;
  } = {}
) {
  const t = convexTestWithComponents(schema, MODULES);
  // `vehicles.update` is the real public door these tests move the supplier's
  // cost through, and it rate-limits tenant writes. Without the component
  // registered it aborts before reaching any of the behaviour under test.
  registerRateLimiter(t);
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
      // `legalOwnerTypeOf` reads ONLY `sourceType`, and `setSupplierSettlementRoute`
      // refuses dealership stock outright — so without this there is no supplier
      // to settle with and no route to choose.
      ...(opts.sourcedVehicle
        ? {
            sourceType: "SOURCED" as const,
            sourcedFromName: "Amman Motors",
            // The supplier's entitlement. Completing an agency sale without it
            // refuses outright — there is no margin to recognize — so this is
            // load-bearing fixture, not decoration.
            sourceCost: 17000,
          }
        : {}),
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
    // `createFromQuote` builds `manualFinanceSnapshot` from the QUOTE, so the
    // provider has to arrive through `saveQuote` rather than be patched on after.
    ...(opts.manualProviderName ? { manualProviderName: opts.manualProviderName } : {}),
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

  return { t, orgId, applicationId, asUser, asApprover, registerExpectedPayment, forceHandover };
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

    await registerHandover(asUser, api, orgId, applicationId);
    await registerExpectedPayment();
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    const after = await t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.status).toBe("CLOSED");
    expect(after?.finalizedSaleId).toBeDefined();
  });

  test("a MANUAL direct-to-supplier deal is told to record the amount, not that it does not apply", async () => {
    // Found by the Codex seat at b04f06ba and INTRODUCED BY THIS PR.
    //
    // `financierApprovesPurchase` answers "does a financier approve the
    // purchase" and is false for every recorded non-configured mode. The cockpit
    // used it to decide whether an approved purchase amount APPLIES AT ALL — a
    // different question — so a MANUAL deal reported NotApplicableForFinancingMode
    // while `finalizeDeal` refused closure until that same figure was recorded.
    //
    // ⚠️ The first version of this test MANUFACTURED its own premise: it patched
    // `manualFinanceSnapshot` and `supplierSettlementRoute` onto ordinary dealer
    // stock. `setSupplierSettlementRoute` refuses dealership stock outright, so
    // that state was unreachable and the test proved the contradiction only in a
    // shape production cannot produce. It now travels the real road: SOURCED
    // stock, the provider named on the QUOTE, and the route set by its own
    // mutation.
    const { t, orgId, applicationId, asUser, registerExpectedPayment } =
      await seedApprovedApplication("MANUAL_FINANCE_COMPANY", {
        sourcedVehicle: true,
        manualProviderName: "Amman Finance House",
      });

    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });

    // Non-vacuity: the route really was accepted by the production writer, and
    // the approval really is absent — so there is a live question to answer.
    const seeded = await t.run((ctx) => ctx.db.get(applicationId));
    expect(seeded?.supplierSettlementRoute).toBe("DIRECT_TO_SUPPLIER");
    expect(seeded?.manualFinanceSnapshot?.providerName).toBe("Amman Finance House");
    expect(seeded?.approvedDealerPurchaseAmountMinor).toBeUndefined();

    const cockpit = await asUser.query(api.applications.dealCockpit, {
      orgId,
      applicationId,
    });

    // `ManagementProfit` is a discriminated union and `reason` lives only on the
    // unavailable arm, so this narrows rather than reaching through an optional
    // chain — an unnarrowed `?.reason` compares undefined to undefined and proves
    // nothing, which is how an earlier assertion in this codebase passed while
    // measuring nothing.
    const profit = cockpit?.money?.managementProfit;
    expect(profit?.available).toBe(false);
    if (profit?.available !== false) {
      throw new Error("expected the management profit to be unavailable");
    }
    expect(profit.reason).toBe("NoApprovedPurchaseAmount");

    // The other half of the contradiction, in the same test so the two cannot
    // drift apart again — and it is now asserted at HANDOVER, which is the
    // earlier and safer gate. This originally handed the vehicle over and caught
    // the refusal at finalization; the route-aware authority added for the
    // owner-proxy's first blocker refuses before the vehicle leaves, so the
    // deal stays recoverable instead of becoming stuck with the car gone.
    await expect(
      registerHandover(asUser, api, orgId, applicationId)
    ).rejects.toThrow(/pays the supplier directly|is not recorded/i);
  });

  test("a MANUAL direct deal can RECORD the amount it is asked for, and then close", async () => {
    // The exit, not just the wall.
    //
    // The test above proves the operator is correctly TOLD what is missing. On
    // its own that is only half a workflow, and the owner-proxy was right to
    // call it out: `approveDealerPurchaseAmount` cannot serve this deal, because
    // it resolves a finance-company rule snapshot and a MANUAL application has
    // no configured company. So the screen named a step nothing could perform —
    // the impossible-next-step dead end this issue exists to remove.
    //
    // Everything below goes through PUBLIC mutations. No raw patch anywhere: if
    // any door on this road were shut, this test could not reach the end.
    const { t, orgId, applicationId, asApprover, asUser, registerExpectedPayment } =
      await seedApprovedApplication("MANUAL_FINANCE_COMPANY", {
        sourcedVehicle: true,
        manualProviderName: "Amman Finance House",
      });

    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });

    // The step that did not exist.
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });

    const recorded = await t.run((ctx) => ctx.db.get(applicationId));
    expect(recorded?.approvedDealerPurchaseAmountMinor).toBe(17_000_000);
    // And it manufactured NO configured-company arithmetic. A manual provider
    // has no LTV rule and no funding split; inventing them would be a fabricated
    // figure carrying an audited figure's authority.
    expect(recorded?.submittedQuotationMinor).toBeUndefined();
    expect(recorded?.appliedLtvPercent).toBeUndefined();
    expect(recorded?.financeCompanyFundedPortionMinor).toBeUndefined();

    // Actor, time and source, on the row a later reader asks for.
    const audit = await t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );
    const entry = audit.find((row) => row.field === "approvedDealerPurchaseAmountMinor");
    expect(entry).toBeDefined();
    // The structured receipt, not a bare amount string: what changed has to be
    // readable without parsing the sentence beside it.
    expect(JSON.parse(entry!.newValue)).toStrictEqual({
      amountMinor: 17_000_000,
      source: "Signed purchase agreement",
      notes: null,
      supplierEntitlementMinor: 17_000_000,
    });
    expect(entry?.reason).toMatch(/Signed purchase agreement/);
    expect(entry?.changedAt).toBeTypeOf("number");
    expect(entry?.changedBy).toBeDefined();

    // The cockpit stops asking for THIS figure. It may still name a later one —
    // the supplier settlement is not recorded until finalization — so asserting
    // "available" would be asserting a different step had also been done. What
    // matters is that the complaint MOVED OFF the amount just recorded.
    const cockpit = await asUser.query(api.applications.dealCockpit, { orgId, applicationId });
    const profit = cockpit?.money?.managementProfit;
    if (profit?.available === false) {
      expect(profit.reason).not.toBe("NoApprovedPurchaseAmount");
      expect(profit.reason).not.toBe("NotApplicableForFinancingMode");
    }

    // And the deal completes through the ordinary road.
    await registerHandover(asUser, api, orgId, applicationId);
    await registerExpectedPayment();
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    const after = await t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.status).toBe("CLOSED");
    expect(after?.finalizedSaleId).toBeDefined();
  });

  test("raising the supplier's entitlement after the amount was agreed blocks handover, and re-recording clears it", async () => {
    // The owner-proxy's HIGH. The vehicle's cost is editable through its own
    // public path and nothing about that edit touches this application — so a
    // correctly recorded deal could have the supplier's entitlement raised
    // underneath it, pass a handover that only checked the amount EXISTS, and be
    // refused at finalization with the vehicle gone and the writer sealed. The
    // same trap, entered through a different door.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });

    // Bound to the evidence it was agreed against.
    const recorded = await t.run((ctx) => ctx.db.get(applicationId));
    expect(recorded?.supplierEntitlementWitness?.amountMinor).toBe(17_000_000);
    // Its own provenance, not the approval's.
    expect(recorded?.supplierEntitlementWitness?.via).toBe("MANUAL_RECEIPT");
    expect(recorded?.supplierEntitlementWitness?.validatedAt).toBeTypeOf("number");

    // The supplier's entitlement moves AFTER the agreement — through the REAL
    // public writer, not a raw patch.
    //
    // The distinction is the whole claim: this defect exists because
    // `vehicles.update` is a door an operator can walk through, on a screen that
    // knows nothing about finance applications. A `ctx.db.patch` would have
    // proved only that the guard fires when the field changes by magic, and
    // would still pass if every public path to that field were closed.
    const vehicleId = recorded!.vehicleId;
    await asUser.mutation(api.vehicles.update, {
      orgId,
      vehicleId,
      sourceCost: 18_000,
    });

    await expect(
      registerHandover(asUser, api, orgId, applicationId)
    ).rejects.toThrow(/has changed since what he receives was agreed/i);

    // RECOVERABLE: the vehicle has not gone out, and re-recording against the
    // new entitlement clears the refusal. A guard that blocked without an exit
    // would be the dead end this whole issue exists to remove.
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeUndefined();

    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 18_000_000,
      source: "Revised purchase agreement",
    });
    await registerHandover(asUser, api, orgId, applicationId);
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeTypeOf(
      "number"
    );
  });

  test("a CONFIGURED direct deal is refused too when the entitlement moves under its approval", async () => {
    // The SAME hole, in the writer that was left out.
    //
    // The first fix stored the witness inside the manual writer's own object and
    // checked it inside the non-configured branch of the guard — so the shape a
    // real financier approves kept the defect entirely: approve against cost A,
    // edit the vehicle to B, and every artefact handover inspects (quotation,
    // approval, funded split) is still present. The vehicle goes out and
    // finalization refuses afterwards. A fix for one writer had been written as
    // though it were a fix for the deal.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "CONFIGURED_FINANCE_COMPANY",
      { sourcedVehicle: true }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 17_000_000,
      source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "Approved by the finance company over the phone.",
    });

    // The configured writer stamps the witness it validated against — the fact
    // this whole test depends on, asserted rather than assumed.
    const approved = await t.run((ctx) => ctx.db.get(applicationId));
    expect(approved?.supplierEntitlementWitness?.amountMinor).toBe(17_000_000);
    expect(approved?.supplierEntitlementWitness?.via).toBe("CONFIGURED_APPROVAL");

    await asUser.mutation(api.vehicles.update, {
      orgId,
      vehicleId: approved!.vehicleId,
      sourceCost: 18_000,
    });

    await expect(registerHandover(asUser, api, orgId, applicationId)).rejects.toThrow(
      /has changed since what he receives was agreed/i
    );
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeUndefined();

    // RECOVERABLE through the configured writer's own door: re-approving against
    // the entitlement that now stands writes a fresh witness and clears it.
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 18_000_000,
      basis: "MANUAL",
      notes: "Re-approved after the supplier's cost was corrected.",
      outlierAcknowledged: true,
    });
    await registerHandover(asUser, api, orgId, applicationId);
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeTypeOf(
      "number"
    );
  });

  test("an amount recorded with no witness is refused at handover, not waved through", async () => {
    // UNPROVABLE IS NOT UNCHANGED.
    //
    // The first resolver returned `null` for both "it still matches" and "I
    // cannot tell", so every unprovable row read as proof of safety — a money
    // guard failing OPEN on exactly the deals whose evidence is weakest. A row
    // approved before this release carries no witness, and that is the shape
    // this pins.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });

    // ⚠️ A RAW PATCH, deliberately and narrowly: this is the PRE-RELEASE shape,
    // and no writer can produce it any more — which is the point. Every public
    // path now stamps the witness, so the only way to test the legacy row is to
    // recreate it.
    await t.run((ctx) =>
      ctx.db.patch(applicationId, { supplierEntitlementWitness: undefined })
    );

    await expect(registerHandover(asUser, api, orgId, applicationId)).rejects.toThrow(
      /cannot be checked against what he is owed/i
    );

    // Repaired by re-recording the SAME figures. The retry-identity comparison
    // covers the witness, so this is correctly NOT treated as a no-op — the
    // stored receipt genuinely differs from the one being written.
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });
    await registerHandover(asUser, api, orgId, applicationId);
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeTypeOf(
      "number"
    );
  });

  test("the writer refuses an amount it cannot check against the supplier's cost", async () => {
    // `vehicles.update` accepts `sourceCost: 0` on a SOURCED vehicle — it only
    // refuses absence (`vehicles.ts:1009`), while `createSourcedVehicle` refuses
    // zero. So a deal's entitlement can legitimately become uncheckable through
    // an ordinary public edit, and the writer used to record money against it
    // anyway with no witness. `completeSale` would then refuse the sale after the
    // vehicle had gone.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    const vehicleId = (await t.run((ctx) => ctx.db.get(applicationId)))!.vehicleId;
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceCost: 0 });

    await expect(
      asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId,
        applicationId,
        approvedAmountMinor: 17_000_000,
        source: "Signed purchase agreement",
      })
    ).rejects.toThrow(/cost is not recorded on this vehicle/i);

    // Nothing was written on the way out — a refusal that half-recorded would be
    // worse than the fail-open it replaced.
    const after = await t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.approvedDealerPurchaseAmountMinor).toBeUndefined();
    expect(after?.supplierEntitlementWitness).toBeUndefined();

    // Recoverable in one step, through the vehicle's own screen.
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceCost: 17_000 });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness?.amountMinor
    ).toBe(17_000_000);
  });

  test("what changed in a correction is machine-readable — amount, source and notes each on their own", async () => {
    // The audit row's identity must not live in prose.
    //
    // A source-only or notes-only correction produced the same amount strings on
    // both sides of the row, so the only record of what actually moved was a
    // sentence — and the test that checked it was regex-parsing that sentence,
    // which is the same defect wearing a test's clothes. Somebody reading this
    // history months later is answering "was this figure changed, and what by",
    // and a human explanation is not an answer a machine can check.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });

    const record = (amountMinor: number, source: string, notes?: string) =>
      asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId,
        applicationId,
        approvedAmountMinor: amountMinor,
        source,
        ...(notes ? { notes } : {}),
      });

    // Scoped to the fields THIS writer owns. Counting every row on the deal
    // made these assertions hostage to any sibling mutation that also records
    // history — `setSupplierSettlementRoute` now does, and a count of "all rows"
    // would have failed here while the behaviour under test was untouched.
    const RECEIPT_FIELDS = ["approvedDealerPurchaseAmountMinor", "directSupplierReceipt"];
    const auditRows = async () =>
      t
        .run((ctx) =>
          ctx.db
            .query("financeApplicationOverrides")
            .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
            .collect()
        )
        .then((rows) => rows.filter((r) => RECEIPT_FIELDS.includes(r.field)));
    const latest = async () => {
      const rows = await auditRows();
      const row = rows.sort((a, b) => a.changedAt - b.changedAt).at(-1)!;
      return {
        field: row.field,
        before: row.previousValue === undefined ? undefined : JSON.parse(row.previousValue),
        after: JSON.parse(row.newValue),
        count: rows.length,
      };
    };

    await record(17_000_000, "Signed purchase agreement", "Collected in person.");
    const first = await latest();
    // A first write is distinguishable from a correction WITHOUT reading prose:
    // there is no before.
    expect(first.before).toBeUndefined();
    expect(first.after).toStrictEqual({
      amountMinor: 17_000_000,
      source: "Signed purchase agreement",
      notes: "Collected in person.",
      supplierEntitlementMinor: 17_000_000,
    });

    // AMOUNT ONLY.
    await record(18_000_000, "Signed purchase agreement", "Collected in person.");
    const amountOnly = await latest();
    expect(amountOnly.count).toBe(2);
    expect(amountOnly.field).toBe("approvedDealerPurchaseAmountMinor");
    expect(amountOnly.before.amountMinor).toBe(17_000_000);
    expect(amountOnly.after.amountMinor).toBe(18_000_000);
    expect(amountOnly.after.source).toBe(amountOnly.before.source);
    expect(amountOnly.after.notes).toBe(amountOnly.before.notes);

    // SOURCE ONLY — the amount did not move, so this is not filed against the
    // amount's own history.
    await record(18_000_000, "Revised purchase agreement", "Collected in person.");
    const sourceOnly = await latest();
    expect(sourceOnly.count).toBe(3);
    expect(sourceOnly.field).toBe("directSupplierReceipt");
    expect(sourceOnly.before.source).toBe("Signed purchase agreement");
    expect(sourceOnly.after.source).toBe("Revised purchase agreement");
    expect(sourceOnly.after.amountMinor).toBe(sourceOnly.before.amountMinor);
    expect(sourceOnly.after.notes).toBe(sourceOnly.before.notes);

    // NOTES ONLY.
    await record(18_000_000, "Revised purchase agreement", "Collected by bank transfer.");
    const notesOnly = await latest();
    expect(notesOnly.count).toBe(4);
    expect(notesOnly.field).toBe("directSupplierReceipt");
    expect(notesOnly.before.notes).toBe("Collected in person.");
    expect(notesOnly.after.notes).toBe("Collected by bank transfer.");
    expect(notesOnly.after.amountMinor).toBe(notesOnly.before.amountMinor);
    expect(notesOnly.after.source).toBe(notesOnly.before.source);

    // And a genuine no-op is still a no-op: nothing above turned the identity
    // check into "any call writes a row".
    await record(18_000_000, "Revised purchase agreement", "Collected by bank transfer.");
    expect((await auditRows()).length).toBe(4);
  });

  test("the supplier's evidence does not reach a sales-only caller through ANY door, values included", async () => {
    // A SENTINEL-VALUE scan, and it exists because the key-walking sweep in
    // financedConsignedSettlement.test.ts structurally cannot see this leak.
    //
    // `getEconomics` returns the correction history, whose payloads are STRINGS
    // — the serialized receipt lives inside `newValue`. A guard that recurses
    // over object keys sees the key `newValue` and nothing inside it, so the
    // supplier's cost, the document it was read off and the operator's note all
    // travelled to a default-SALES caller under a field name that looks
    // innocuous. Two kinds of assertion are needed because two kinds of leak
    // exist: a field published whole, and a field serialized into a value.
    const SENTINEL_SOURCE = "SENTINEL-PURCHASE-AGREEMENT-8891";
    const SENTINEL_NOTES = "SENTINEL-NOTE-COLLECTED-BY-HAND-4472";
    const SENTINEL_ENTITLEMENT = 16_431_000;

    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    const vehicleId = (await t.run((ctx) => ctx.db.get(applicationId)))!.vehicleId;
    // A distinctive entitlement so the witness itself is searchable as a value.
    await asUser.mutation(api.vehicles.update, {
      orgId,
      vehicleId,
      sourceCost: SENTINEL_ENTITLEMENT / 1000,
    });
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: SENTINEL_SOURCE,
      notes: SENTINEL_NOTES,
    });
    // A CORRECTION, so the override history carries the evidence twice — once as
    // the before and once as the after. The first write alone would leave
    // `previousValue` empty and under-test the very field that leaked.
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_500_000,
      source: SENTINEL_SOURCE,
      notes: SENTINEL_NOTES,
    });
    /**
     * A third correction that moves the PAPERWORK ONLY, so a row is filed under
     * `directSupplierReceipt` rather than under the amount's own name.
     *
     * ⚠️ Added because the anti-vacuity check below CAUGHT this test being
     * empty: both corrections above move the amount, and the writer deliberately
     * files those under `approvedDealerPurchaseAmountMinor`. Without this call
     * there is no evidence-named row in the table at all, and every assertion
     * about withholding one passes against a deal that never had one.
     */
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_500_000,
      source: SENTINEL_SOURCE,
      notes: `${SENTINEL_NOTES} (corrected)`,
    });

    // Anti-vacuity: the sentinels must really be stored, or every assertion
    // below passes against a deal that never carried them.
    const stored = await t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      const rows = await ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect();
      return {
        witness: app?.supplierEntitlementWitness?.amountMinor,
        receiptSource: app?.directSupplierReceipt?.source,
        historyMentionsSource: rows.some((r) =>
          `${r.previousValue ?? ""}${r.newValue}${r.reason}`.includes(SENTINEL_SOURCE)
        ),
      };
    });
    expect(stored.witness).toBe(SENTINEL_ENTITLEMENT);
    expect(stored.receiptSource).toBe(SENTINEL_SOURCE);
    expect(stored.historyMentionsSource).toBe(true);

    // Now demote the role to the DEFAULT SALES template — the real thing, read
    // from the shipped templates rather than a hand-written list that could
    // drift into granting less than production does.
    const salesTemplate = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "SALES")!;
    expect(salesTemplate.permissions).toContain("view:finance_applications");
    expect(salesTemplate.permissions).not.toContain("view:finance");
    expect(salesTemplate.permissions).not.toContain("view:cost_price");
    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === orgId)!;
      await ctx.db.patch(role._id, {
        permissions: [...salesTemplate.permissions],
        isSystemOwnerRole: false,
      });
    });

    const doors: Array<[string, unknown]> = [
      [
        "applications.list",
        await asUser.query(api.applications.list, {
          orgId,
          paginationOpts: { numItems: 20, cursor: null },
        }),
      ],
      ["applications.get", await asUser.query(api.applications.get, { orgId, applicationId })],
      [
        "applications.dealCockpit",
        await asUser.query(api.applications.dealCockpit, { orgId, applicationId }),
      ],
      [
        "financingEconomics.getEconomics",
        await asUser.query(api.financingEconomics.getEconomics, { orgId, applicationId }),
      ],
    ];

    for (const [name, payload] of doors) {
      const serialized = `${name} → ${JSON.stringify(payload ?? null)}`;
      // Anti-vacuity per door: an empty or null payload contains no evidence for
      // the trivial reason and would pass while proving nothing.
      expect(`${name} returned something: ${serialized.length > 40}`).toBe(
        `${name} returned something: true`
      );
      expect(serialized).not.toContain(SENTINEL_SOURCE);
      expect(serialized).not.toContain(SENTINEL_NOTES);
      expect(serialized).not.toContain(String(SENTINEL_ENTITLEMENT));
    }

    // The WORKFLOW half survives: a sales caller still learns that corrections
    // happened, and when. Withholding the row entirely would hide a fact they
    // legitimately work with, which is the over-correction this file keeps
    // documenting in the other direction.
    const economics = (await asUser.query(api.financingEconomics.getEconomics, {
      orgId,
      applicationId,
    })) as unknown as {
      overrides: Array<{ field: string; changedAt: number; changedBy?: string; newValue?: string }>;
    };
    expect(economics.overrides.length).toBeGreaterThan(0);
    expect(economics.overrides[0].changedAt).toBeTypeOf("number");
    expect(economics.overrides[0].newValue).toBeUndefined();

    /**
     * ⚠️ A REDACTED DOCUMENT WITH AN UNREDACTED CHANGE LOG IS NOT REDACTED.
     *
     * Blanking the VALUES on these rows is not enough. Each row also carries
     * `field`, `changedBy` and `changedAt`, so a caller holding neither
     * `view:finance` nor `view:cost_price` still learned that a
     * supplier-entitlement validation happened, WHEN and BY WHOM — which is
     * precisely the provenance the document gate beside it was just split three
     * ways to withhold. Measured before the fix: 2 such rows reached a
     * default-SALES caller.
     *
     * The rows this PR introduced (`supplierEntitlementWitness`,
     * `directSupplierReceipt`) now follow the same gate as the document fields
     * they describe.
     */
    const evidenceFields = ["supplierEntitlementWitness", "directSupplierReceipt"];
    for (const row of economics.overrides) {
      expect(`sales sees an evidence row (${row.field}): ${evidenceFields.includes(row.field)}`).toBe(
        `sales sees an evidence row (${row.field}): false`
      );
    }

    /**
     * ANTI-VACUITY, and it is load-bearing here: the absence above must be
     * REDACTION, not a fixture that never produced such a row. Read straight
     * from the table, bypassing every gate.
     */
    const storedEvidenceRows = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("financeApplicationOverrides")
          .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
          .collect()
      ).filter((r) => evidenceFields.includes(r.field))
    );
    expect(storedEvidenceRows.length).toBeGreaterThan(0);
    expect(storedEvidenceRows.every((r) => typeof r.changedBy === "string")).toBe(true);

    /**
     * And the WORKFLOW half still survives: withholding the whole log would hide
     * a fact a sales caller legitimately works with. An amount correction files
     * its own row under its own name, and that one still arrives — with its
     * timestamp — so nothing they act on was taken away with the evidence.
     */
    expect(
      economics.overrides.some((r) => r.field === "approvedDealerPurchaseAmountMinor")
    ).toBe(true);

    // A finance caller still receives the evidence rows, so the gate is a gate
    // and not the field having quietly stopped being served to anybody.
    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === orgId)!;
      await ctx.db.patch(role._id, {
        permissions: [...salesTemplate.permissions, "view:finance"],
        isSystemOwnerRole: false,
      });
    });
    const financeEconomics = (await asUser.query(api.financingEconomics.getEconomics, {
      orgId,
      applicationId,
    })) as unknown as { overrides: Array<{ field: string; changedBy?: string }> };
    expect(financeEconomics.overrides.some((r) => evidenceFields.includes(r.field))).toBe(true);
  });

  test("cost visibility earns the number, not the paperwork", async () => {
    // The over-grant. Both fields sat behind `finance || cost_price`, but
    // VIEW_COST_PRICE entitles its holder to the supplier's COST and nothing
    // more — the receipt names the document and carries free-text notes, which
    // are settlement evidence rather than cost data.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
      notes: "Handed over at the branch.",
    });

    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === orgId)!;
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:finance_applications", "view:cost_price"],
        isSystemOwnerRole: false,
      });
    });

    const detail = (await asUser.query(api.applications.get, {
      orgId,
      applicationId,
    })) as unknown as Record<string, unknown>;
    expect(detail).toBeTruthy();
    // Entitled to the supplier's cost — this caller can read it off the vehicle.
    expect((detail.supplierEntitlementWitness as { amountMinor: number }).amountMinor).toBe(
      17_000_000
    );
    // Not entitled to the paperwork. Checked as a KEY, because Convex drops
    // undefined-valued keys on the wire.
    expect(`present: ${Object.hasOwn(detail, "directSupplierReceipt")}`).toBe("present: false");

    /**
     * ⚠️ AND NOT ENTITLED TO THE PROVENANCE EITHER — the half this test
     * used to miss.
     *
     * The assertion above pins what this caller MAY see, and a test that only
     * pins what a caller may see cannot notice a caller starting to see more.
     * The witness was a bare number when the gate was written, so
     * `finance || cost_price` was exactly right; it then grew into an object
     * carrying WHO validated the supplier's entitlement, WHEN, THROUGH WHICH
     * ACT and WHETHER IT WAS VALIDATED AT ALL, and the unchanged gate published
     * the whole of it. The gate did not change; what it was guarding did.
     *
     * Every provenance field is named individually rather than compared as a
     * whole object, so a field added to this witness in future arrives here as
     * a decision somebody has to make rather than as a silent grant.
     */
    const costOnlyWitness = detail.supplierEntitlementWitness as Record<string, unknown>;
    for (const field of ["status", "via", "validatedAt", "validatedBy"]) {
      expect(`cost-only sees ${field}: ${Object.hasOwn(costOnlyWitness, field)}`).toBe(
        `cost-only sees ${field}: false`
      );
    }

    /**
     * THE OTHER TWO ROLE SHAPES, pinned on the SAME serialized response.
     *
     * Three permissions, three different answers, and the middle one is the
     * only one either of the previous versions of this gate could express.
     */
    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === orgId)!;
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:finance_applications", "view:finance"],
        isSystemOwnerRole: false,
      });
    });
    const financeDetail = (await asUser.query(api.applications.get, {
      orgId,
      applicationId,
    })) as unknown as Record<string, unknown>;
    const financeWitness = financeDetail.supplierEntitlementWitness as Record<string, unknown>;
    // The whole record, provenance included. Withholding it from finance would
    // be the over-correction in the other direction: this is precisely the
    // caller the evidence exists for.
    expect(financeWitness.amountMinor).toBe(17_000_000);
    expect(financeWitness.status).toBe("VALIDATED");
    expect(financeWitness.via).toBe("MANUAL_RECEIPT");
    expect(financeWitness.validatedAt).toBeTypeOf("number");
    expect(financeWitness.validatedBy).toBeTypeOf("string");
    expect(`finance sees the paperwork: ${Object.hasOwn(financeDetail, "directSupplierReceipt")}`).toBe(
      "finance sees the paperwork: true"
    );

    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === orgId)!;
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:finance_applications"],
        isSystemOwnerRole: false,
      });
    });
    const salesDetail = (await asUser.query(api.applications.get, {
      orgId,
      applicationId,
    })) as unknown as Record<string, unknown>;
    // Neither half. Not the amount, not the provenance, not the key.
    expect(`sales sees the witness: ${Object.hasOwn(salesDetail, "supplierEntitlementWitness")}`).toBe(
      "sales sees the witness: false"
    );
    expect(`sales sees the paperwork: ${Object.hasOwn(salesDetail, "directSupplierReceipt")}`).toBe(
      "sales sees the paperwork: false"
    );
    // Anti-vacuity: the caller is still being served a real deal, so the three
    // absences above are redaction rather than an empty response.
    expect(salesDetail._id).toBe(applicationId);
  });

  test("the route cannot be changed after the vehicle has gone out", async () => {
    // THE DEAD END, REOPENED THROUGH A DIFFERENT MUTATION.
    //
    // A MANUAL THROUGH deal may legitimately be handed over with no supplier
    // receipt amount. Switching it to DIRECT afterwards made finalization demand
    // that amount — a requirement this PR introduced — while
    // `recordDirectSupplierReceiptAmount` correctly refuses a handed-over deal.
    // The cockpit is back to naming a step nothing can perform, which is the
    // defect SCRUM-61 exists to remove.
    const { t, orgId, applicationId, asUser } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
    await registerHandover(asUser, api, orgId, applicationId);
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeTypeOf(
      "number"
    );

    await expect(
      asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId,
        applicationId,
        route: "DIRECT_TO_SUPPLIER",
      })
    ).rejects.toThrow(/vehicle has gone out/i);

    // The deal is still finalizable on the route it actually went out under — a
    // refusal that stranded it would be the same dead end from the other side.
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.supplierSettlementRoute).toBe(
      "THROUGH_DEALERSHIP"
    );

    // And an idempotent re-submission of the SAME route is still accepted: it
    // changes nothing, and refusing a retry would break the caller that lost its
    // response.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
  });

  test("changing the route invalidates a handover confirmation opened before it", async () => {
    // The stale-stamp race. `handoverStamp` is derived from `economicsRevision`,
    // and the handover mutation refuses a confirmation carrying an old one —
    // that is the entire mechanism stopping an operator from sealing figures
    // they never saw. This writer moved the route AND the entitlement witness
    // without touching the revision, so a confirmation opened while the deal
    // settled THROUGH the dealership still succeeded after somebody switched it
    // to DIRECT.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    /**
     * ⚠️ THE ROUTE CHANGE IS THE ONLY WRITER BETWEEN THE STAMP AND THE SUBMIT.
     *
     * The first version of this test set the route and then recorded the
     * supplier amount before submitting the stale stamp — and a mutant that
     * deleted the route writer's revision bump SURVIVED it, because the AMOUNT
     * writer bumps the revision too. The test named the route as the cause and
     * measured a different one. So the deal's economics are completed FIRST, and
     * the only thing that moves afterwards is the route.
     */
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });

    // Operator A opens the confirmation and reads the stamp.
    const staleStamp = await asUser.query(api.applications.handoverStamp, {
      orgId,
      applicationId,
    });
    // A null stamp would make the refusal below prove nothing about staleness.
    expect(staleStamp).toBeTypeOf("string");

    // Operator B changes how the supplier gets paid — and NOTHING else happens.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });

    // Operator A submits what they were looking at. It must not seal a deal
    // whose settlement route changed underneath them — and the refusal must be
    // the STAMP, not a downstream economics complaint that would pass whether or
    // not the revision moved.
    await expect(
      asUser.mutation(api.applications.registerVehicleHandover, {
        orgId,
        applicationId,
        economicsStamp: staleStamp as string,
      })
    ).rejects.toThrow(/changed while you were confirming/i);
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeUndefined();

    // Re-reading the deal and confirming again succeeds — the refusal is a
    // re-read, not a wall.
    await registerHandover(asUser, api, orgId, applicationId);
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeTypeOf(
      "number"
    );
  });

  test("route selection leaves structured evidence, and an identical re-submission leaves none", async () => {
    const { t, orgId, applicationId, asUser } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    const rows = async () =>
      t.run((ctx) =>
        ctx.db
          .query("financeApplicationOverrides")
          .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
          .collect()
      );

    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    const afterFirst = await rows();
    const routeRow = afterFirst.find((r) => r.field === "supplierSettlementRoute")!;
    expect(routeRow).toBeDefined();
    // Machine-readable on both sides, like every other money fact on this deal.
    expect(JSON.parse(routeRow.newValue)).toStrictEqual({
      route: "DIRECT_TO_SUPPLIER",
      // No approved amount yet, so there was nothing to validate an entitlement
      // against — recorded as null rather than guessed at.
      witness: null,
    });
    const revisionAfterFirst = (await t.run((ctx) => ctx.db.get(applicationId)))?.economicsRevision;

    // The identical act again: no row, no revision bump, no invalidated
    // confirmations.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    expect((await rows()).length).toBe(afterFirst.length);
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.economicsRevision).toBe(
      revisionAfterFirst
    );
  });

  test("repairing a legacy witness records itself, and does not rewrite the approval it sits beside", async () => {
    // PROVENANCE. The witness used to be a bare number under a name that claimed
    // it was observed at the approval. On a legacy repair — re-approving the
    // identical amount to establish the evidence — `approvalMateriallyChanged`
    // is false, so no override row was written at all, and the current supplier
    // cost was presented as though the dealership had observed it back when the
    // finance company approved.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "CONFIGURED_FINANCE_COMPANY",
      { sourcedVehicle: true }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 17_000_000,
      source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "Approved by the finance company over the phone.",
    });

    // The pre-release shape: an approval with no witness beside it.
    await t.run((ctx) => ctx.db.patch(applicationId, { supplierEntitlementWitness: undefined }));
    const beforeRepair = await t.run((ctx) => ctx.db.get(applicationId));
    const approvalStampBefore = beforeRepair?.approvedPurchaseApprovedAt;
    const approverBefore = beforeRepair?.approvedPurchaseApprovedBy;
    expect(approvalStampBefore).toBeTypeOf("number");
    const rowsBefore = await t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );

    // The repair: the SAME approval, re-entered to establish the evidence.
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "Approved by the finance company over the phone.",
    });

    const afterRepair = await t.run((ctx) => ctx.db.get(applicationId));
    // The witness exists, carries its OWN provenance, and says how it was
    // established.
    expect(afterRepair?.supplierEntitlementWitness?.amountMinor).toBe(17_000_000);
    expect(afterRepair?.supplierEntitlementWitness?.via).toBe("CONFIGURED_APPROVAL");
    expect(afterRepair?.supplierEntitlementWitness?.validatedBy).toBeDefined();

    // The finance company's approval is a real historical act. It did not
    // happen again, so nothing about it moved.
    expect(afterRepair?.approvedPurchaseApprovedAt).toBe(approvalStampBefore);
    expect(afterRepair?.approvedPurchaseApprovedBy).toBe(approverBefore);

    // And the repair is not silent: it left its own row, distinct from the
    // approval's history.
    const rowsAfter = await t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );
    expect(rowsAfter.length).toBe(rowsBefore.length + 1);
    const witnessRow = rowsAfter.find((r) => r.field === "supplierEntitlementWitness")!;
    expect(witnessRow).toBeDefined();
    expect(JSON.parse(witnessRow.newValue).supplierEntitlementMinor).toBe(17_000_000);
    expect(JSON.parse(witnessRow.newValue).via).toBe("CONFIGURED_APPROVAL");
  });

  test("an identical re-approval does not re-badge a witness somebody else established", async () => {
    // PROVENANCE IS EVIDENCE, so it moves when the fact moves and not otherwise.
    //
    // Every writer used to stamp its own `via`, actor and timestamp whenever the
    // entitlement was measurable. So a witness established at ROUTE_SELECTION was
    // silently rewritten into a CONFIGURED_APPROVAL one — different person,
    // different time — by a re-approval that changed nothing, and the audit trail
    // said nothing had happened because the AMOUNT had not moved.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "CONFIGURED_FINANCE_COMPANY",
      { sourcedVehicle: true }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 17_000_000,
      source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "Approved by the finance company over the phone.",
    });
    // ⚠️ THE PREMISE MOVED. This test used to have the ROUTE establish the
    // witness; route selection no longer writes one at all, so the evidence is
    // established the only way it can be — by the approval itself, taken while
    // the deal is on the direct route so there is an entitlement to compare.
    const established = (await t.run((ctx) => ctx.db.get(applicationId)))!
      .supplierEntitlementWitness!;
    expect(established.via).toBe("CONFIGURED_APPROVAL");
    expect(established.status).toBe("VALIDATED");
    expect(established.amountMinor).toBe(17_000_000);

    const rowsBefore = await t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );

    // The same approval again — a retry, a colleague confirming, a double click.
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "Approved by the finance company over the phone.",
    });

    const after = (await t.run((ctx) => ctx.db.get(applicationId)))!.supplierEntitlementWitness!;
    // Byte-identical: same origin, same validator, same moment. The entitlement
    // did not move, so nobody observed it again.
    expect(after).toStrictEqual(established);

    // And nothing was appended claiming otherwise.
    const rowsAfter = await t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );
    expect(rowsAfter.length).toBe(rowsBefore.length);
  });

  test("a handed-over DIRECT deal may still move to THROUGH and finalize there, and only CLOSED seals the route", async () => {
    // THE POSITIVE POLICY, pinned deliberately.
    //
    // Owner ruling: handover seals the ECONOMICS; finalization/CLOSED seals the
    // POSTING ROUTE. So a handed-over deal may still change how the money
    // travels, and the protection is not a lock on the route — it is that route
    // selection may never rewrite the evidence the economics were agreed
    // against.
    //
    // Pinned as its own test because the refusal cases alone cannot distinguish
    // "the guard is correct" from "the guard is a blanket lock". A blanket lock
    // passes every refusal test in this file and strands every consigned
    // financed deal in production, which is exactly the defect a previous round
    // nearly shipped.
    const { t, orgId, applicationId, asUser, asApprover, registerExpectedPayment } =
      await seedApprovedApplication("MANUAL_FINANCE_COMPANY", {
        sourcedVehicle: true,
        manualProviderName: "Amman Finance House",
      });
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });
    await registerHandover(asUser, api, orgId, applicationId);
    const agreed = (await t.run((ctx) => ctx.db.get(applicationId)))!.supplierEntitlementWitness!;
    expect(agreed.amountMinor).toBe(17_000_000);

    // ALLOWED after handover: the deal changes how it settles.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
    // The evidence is untouched by that move — byte for byte, provenance
    // included. Route selection records how the money travels; it does not get
    // to restate what the supplier was owed.
    expect(
      (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness
    ).toStrictEqual(agreed);

    // ...and the deal finishes on the route it actually settled by.
    await registerExpectedPayment();
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });
    const closed = await t.run((ctx) => ctx.db.get(applicationId));
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.supplierSettlementRoute).toBe("THROUGH_DEALERSHIP");
    // The witness survived finalization too: it is the record of what was agreed,
    // not a scratch value the lifecycle consumes.
    expect(closed?.supplierEntitlementWitness).toStrictEqual(agreed);

    // NOW the route is sealed — by CLOSED, which is the boundary that decides how
    // the deal posts. Both directions are refused, including back to the route it
    // was handed over on.
    await expect(
      asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId,
        applicationId,
        route: "DIRECT_TO_SUPPLIER",
      })
    ).rejects.toThrow(/already finalized/i);
    await expect(
      asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId,
        applicationId,
        route: "THROUGH_DEALERSHIP",
      })
    ).rejects.toThrow(/already finalized/i);
  });

  test("an amount approved with nothing compared cannot be finalized on the direct route", async () => {
    // THE CRITICAL, pinned. Both reviewer seats found this independently and I
    // reproduced it end to end: approve while the deal settles THROUGH — where
    // nothing measures an entitlement — hand the vehicle over, correct the
    // vehicle's cost, then choose DIRECT for the first time. Route selection had
    // no previous witness to protect, so it MINTED one at the corrected cost, the
    // verdict read UNCHANGED, and the deal posted money against evidence nobody
    // agreed to.
    //
    // ABSENCE IS NOT AGREEMENT. The approval now records that it validated
    // nothing, route selection writes no evidence at all, and finalization fails
    // closed.
    const { t, orgId, applicationId, asUser, asApprover, registerExpectedPayment } =
      await seedApprovedApplication("CONFIGURED_FINANCE_COMPANY", { sourcedVehicle: true });
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 17_000_000,
      source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "Approved by the finance company over the phone.",
    });

    // The silence is now explicit, with its own actor and moment, and carries NO
    // amount — zero, the current cost and a nullable number are each things a
    // later reader could mistake for proof.
    const afterApproval = (await t.run((ctx) => ctx.db.get(applicationId)))!
      .supplierEntitlementWitness!;
    expect(afterApproval.status).toBe("NOT_VALIDATED");
    expect(afterApproval.amountMinor).toBeUndefined();
    expect(afterApproval.via).toBe("CONFIGURED_APPROVAL");

    await registerHandover(asUser, api, orgId, applicationId);
    const vehicleId = (await t.run((ctx) => ctx.db.get(applicationId)))!.vehicleId;
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceCost: 5_000 });

    // The route change is ALLOWED — it has no economic authority, so it is not
    // the place to refuse — and it establishes nothing.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness
    ).toStrictEqual(afterApproval);

    // ...and the money does not move.
    await registerExpectedPayment();
    await expect(
      asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId })
    ).rejects.toThrow(/cannot be checked against what he is owed/i);

    // THE EXIT, so this is a refusal and not a dead end: the deal finishes on the
    // route the vehicle actually went out under.
    //
    // ⚠️ Re-agreement is NOT available here, by an older deliberate rule:
    // `approveDealerPurchaseAmount` refuses once the vehicle is handed over AND
    // an amount is already recorded (SCRUM-78 — the handover dialog promises the
    // figure is final). So post-handover the only honest move is the route the
    // deal was handed over on. The re-agreement path is pinned separately, at the
    // lifecycle point where it is actually reachable.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });

  test("an explicit re-agreement is what opens the direct route, and nothing else", async () => {
    // The other half of the ruling: fail closed until the re-agreement actually
    // happens — and then succeed. Pinned BEFORE handover, which is where the
    // approval writer is still open.
    const { t, orgId, applicationId, asUser, asApprover, registerExpectedPayment } =
      await seedApprovedApplication("CONFIGURED_FINANCE_COMPANY", { sourcedVehicle: true });
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 17_000_000,
      source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "Approved over the phone, before the settlement route was chosen.",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness?.status
    ).toBe("NOT_VALIDATED");

    // Moving to the direct route mints nothing...
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness?.status
    ).toBe("NOT_VALIDATED");
    // ...so the vehicle cannot go out on a figure nothing was compared against.
    await expect(registerHandover(asUser, api, orgId, applicationId)).rejects.toThrow(
      /cannot be checked against what he is owed/i
    );

    // THE RE-AGREEMENT: the same approver, on the direct route, where the writer
    // compares the amount against what the supplier is owed and refuses a
    // shortfall. THIS is the act that may establish evidence.
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "Re-agreed against the supplier's entitlement on the direct route.",
    });
    const witness = (await t.run((ctx) => ctx.db.get(applicationId)))!
      .supplierEntitlementWitness!;
    expect(witness.status).toBe("VALIDATED");
    expect(witness.amountMinor).toBe(17_000_000);
    expect(witness.via).toBe("CONFIGURED_APPROVAL");

    await registerHandover(asUser, api, orgId, applicationId);
    await registerExpectedPayment();
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });

  test("route selection mints no witness before handover either", async () => {
    // The exception used to be scoped to "when none exists", and its danger was
    // not the handover boundary — it was the authority. A route change is not an
    // economic approval at any point in the lifecycle.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness
    ).toBeUndefined();

    // Even flipping back and forth.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness
    ).toBeUndefined();

    /**
     * THE CASE THAT ACTUALLY EXERCISES THE NO-WRITE RULE: an approved amount
     * with NO witness beside it.
     *
     * ⚠️ Added because a mutant SURVIVED. Restoring route selection's
     * establish-when-absent branch left every assertion above green: after this
     * release an approved deal always carries a witness — NOT_VALIDATED at worst
     * — so the mint branch was never reached, and the test proved the ENCODING
     * rather than the authority rule it claimed to prove.
     *
     * The state below is the pre-release shape, which no writer can produce any
     * more, so it is built by patching the row directly. That is precisely the
     * population a route change could once have minted evidence for.
     */
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });
    await t.run((ctx) => ctx.db.patch(applicationId, { supplierEntitlementWitness: undefined }));
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    // Still nothing. The amount is there and the entitlement is measurable, and
    // the route writer declines to draw the obvious conclusion — because drawing
    // it is not its decision to make.
    expect(
      (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness
    ).toBeUndefined();
  });

  test("the route cannot clear a witness, so a THROUGH round trip cannot mint a new one", async () => {
    // ⚠️ THIS TEST REPLACES ONE THAT ASSERTED THE OPPOSITE.
    //
    // The previous version pinned "choosing THROUGH clears the witness" and
    // checked that the clearing was legible in the history. The clearing was
    // itself the defect: Codex found, and I reproduced end to end, that on a
    // handed-over DIRECT deal whose entitlement had drifted, selecting THROUGH
    // wiped the witness and selecting DIRECT again minted a fresh one at the
    // CURRENT cost. DRIFTED became UNCHANGED and a deal approved at 17,000,000
    // against an entitlement of 16,000,000 finalized, with no approver anywhere
    // in the sequence.
    //
    // A test can pin a defect as confidently as it pins a fix. This one now
    // states the invariant that makes the laundering unreachable: route
    // selection may ESTABLISH a witness when none exists, and may never clear or
    // replace one.
    const { t, orgId, applicationId, asUser, asApprover, registerExpectedPayment } =
      await seedApprovedApplication("MANUAL_FINANCE_COMPANY", {
        sourcedVehicle: true,
        manualProviderName: "Amman Finance House",
      });
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });
    await registerHandover(asUser, api, orgId, applicationId);
    const agreed = (await t.run((ctx) => ctx.db.get(applicationId)))!.supplierEntitlementWitness!;
    expect(agreed.amountMinor).toBe(17_000_000);

    // The supplier's entitlement drops after the vehicle has gone out. DOWN, so
    // the below-entitlement guard cannot be the thing that refuses.
    const vehicleId = (await t.run((ctx) => ctx.db.get(applicationId)))!.vehicleId;
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceCost: 16_000 });

    // Step 1 of the laundering run: leave the direct route.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
    // THE WITNESS SURVIVES. It is inert here — the verdict is NOT_APPLICABLE off
    // the direct route — but it is not evidence the deal is entitled to destroy.
    expect(
      (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness
    ).toStrictEqual(agreed);

    // Step 2: come back. The retained witness still disagrees with the vehicle,
    // so the deal is exactly as refused as it was before the detour.
    const view = await asUser.query(api.applications.get, { orgId, applicationId });
    expect(view?.canSettleDirectToSupplier).toBe(false);
    await expect(
      asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId,
        applicationId,
        route: "DIRECT_TO_SUPPLIER",
      })
    ).rejects.toThrow();
    expect(
      (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness
    ).toStrictEqual(agreed);

    // The route did not come back, so the deal cannot finalize as a direct
    // settlement against re-badged evidence — which is what this laundering run
    // achieved before the redesign, reproduced end to end to a successful
    // `finalizeDeal` at 17,000,000 against a 16,000,000 entitlement.
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.supplierSettlementRoute).toBe(
      "THROUGH_DEALERSHIP"
    );

    // ⚠️ NOT ASSERTED HERE: that finalization is refused. The deal is parked on
    // the THROUGH route, where the supplier's entitlement is an ordinary payable
    // rather than what the financier pays him, so the witness is NOT_APPLICABLE
    // and finalizing is permitted by the stated invariant — "a route transition
    // after handover may proceed only if the resulting state is already
    // finalizable without a writer handover has sealed". THROUGH is such a state.
    //
    // Whether a handed-over DIRECT deal should be allowed to become THROUGH at
    // all is a separate question: it moves the accounting basis of a deal whose
    // vehicle has already left. Raised for a ruling rather than decided here,
    // because widening the guard on my own reading is how this subsystem earned
    // its patch halt.
    await registerExpectedPayment();
  });

  test("choosing the direct route records the entitlement it was validated against, with its provenance", async () => {
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });

    // The witness the MANUAL writer established, actor included — the history
    // has to name the person, not just the number and the moment.
    const approverId = await t.run(async (ctx) =>
      (await ctx.db.query("users").collect()).find((u) => u.clerkId === "guard_approver")!._id
    );
    const stored = (await t.run((ctx) => ctx.db.get(applicationId)))!.supplierEntitlementWitness!;
    expect(stored).toStrictEqual({
      status: "VALIDATED",
      amountMinor: 17_000_000,
      via: "MANUAL_RECEIPT",
      validatedAt: expect.any(Number),
      validatedBy: approverId,
    });

    // Leaving the direct route is recorded, and says the witness was kept.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );
    const leaving = rows
      .filter((r) => r.field === "supplierSettlementRoute")
      .sort((a, b) => a.changedAt - b.changedAt)
      .at(-1)!;
    expect(JSON.parse(leaving.previousValue!).witness).toStrictEqual({
      status: "VALIDATED",
      supplierEntitlementMinor: 17_000_000,
      via: "MANUAL_RECEIPT",
      validatedAt: expect.any(Number),
      validatedBy: approverId,
    });
    // Unchanged on the other side, because the route did not touch it.
    expect(JSON.parse(leaving.newValue).witness).toStrictEqual(
      JSON.parse(leaving.previousValue!).witness
    );
  });

  test("the screen and the server agree about a drifted deal, not just an unrecorded one", async () => {
    // The cockpit's rule was NARROWER than the mutation's: it asked only whether
    // an amount was recorded, while the mutation projected the whole final state.
    // A deal with an amount whose entitlement had since drifted was therefore
    // OFFERED the direct route and then refused by the server — the exact
    // screen/server disagreement these two surfaces exist to prevent.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });
    await registerHandover(asUser, api, orgId, applicationId);
    // Back to THROUGH after handover — permitted, since that route demands
    // nothing the sealed writer would have to supply.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });

    // The supplier's entitlement now moves, so the recorded amount no longer
    // matches what he is owed. The AMOUNT is still present — which is all the
    // old projection looked at.
    const vehicleId = (await t.run((ctx) => ctx.db.get(applicationId)))!.vehicleId;
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceCost: 18_000 });

    const view = await asUser.query(api.applications.get, { orgId, applicationId });
    expect(view?.approvedDealerPurchaseAmountMinor).toBe(17_000_000);

    // ONE ANSWER. Whatever the screen says, the mutation must do.
    const offered = view?.canSettleDirectToSupplier;
    const attempt = asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    if (offered) {
      await expect(attempt).resolves.toBeDefined();
    } else {
      await expect(attempt).rejects.toThrow();
    }
    // ...and specifically, both refuse, naming the obstacle that actually
    // applies. The recorded amount now sits BELOW what the supplier is owed,
    // which is true whether or not the vehicle has gone out — so that is the
    // reason reported, rather than the handover, which is merely why it can no
    // longer be corrected.
    expect(offered).toBe(false);
    expect(view?.directRouteRefusal).toBe("BelowSupplierEntitlement");
  });

  test("a handed-over deal cannot re-validate its witness by re-submitting the route it already has", async () => {
    // THE BACKDOOR. `directRouteTransitionRefusal` treated a same-route
    // re-submission as "not a transition" and returned early, but the mutation
    // then re-measured the supplier's entitlement and stored it — so a DRIFTED
    // deal became UNCHANGED, and finalization stopped objecting. No amount was
    // re-agreed and no approver was involved: the evidence simply caught up with
    // the vehicle behind everyone's back, through the one writer that was never
    // supposed to be an economics writer at all.
    //
    // ⚠️ THE COST MOVES **DOWN** HERE, DELIBERATELY. Raising it trips the
    // below-entitlement refusal first, which is what made this look covered: the
    // guard that fires is not the guard under test. A cost corrected downward
    // leaves the approved amount comfortably above it, so nothing else refuses
    // — and the concealed fact is that the supplier is now being paid MORE than
    // he is owed.
    const { t, orgId, applicationId, asUser, asApprover, registerExpectedPayment } =
      await seedApprovedApplication("MANUAL_FINANCE_COMPANY", {
        sourcedVehicle: true,
        manualProviderName: "Amman Finance House",
      });
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });
    await registerHandover(asUser, api, orgId, applicationId);

    const sealed = (await t.run((ctx) => ctx.db.get(applicationId)))!;
    expect(sealed.supplierEntitlementWitness?.amountMinor).toBe(17_000_000);
    await asUser.mutation(api.vehicles.update, {
      orgId,
      vehicleId: sealed.vehicleId,
      sourceCost: 16_000,
    });

    // The retry. The route does not change; only the witness would.
    await expect(
      asUser.mutation(api.applications.setSupplierSettlementRoute, {
        orgId,
        applicationId,
        route: "DIRECT_TO_SUPPLIER",
      })
    ).rejects.toThrow(/no longer matches what this deal recorded/i);

    // The seal held: the witness is the one that was agreed, and the revision
    // did not move, so no open confirmation was invalidated by a refused call.
    const after = (await t.run((ctx) => ctx.db.get(applicationId)))!;
    expect(after.supplierEntitlementWitness).toStrictEqual(sealed.supplierEntitlementWitness);
    expect(after.economicsRevision).toBe(sealed.economicsRevision);

    // And the drift is still visible to the transition that matters.
    await registerExpectedPayment();
    await expect(
      asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId })
    ).rejects.toThrow(/has changed since what he receives was agreed/i);
  });

  test("correcting only the source leaves the witness exactly as whoever validated it left it", async () => {
    // The third writer had the same re-badging defect as the configured one.
    // `recordDirectSupplierReceiptAmount` stamped a fresh witness whenever its
    // receipt-level comparison found ANY difference — and that comparison
    // includes the source and the notes. So fixing a typo in the document name
    // moved the actor and timestamp on evidence about the supplier's entitlement,
    // which that edit never examined.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
      notes: "Collected in person.",
    });
    const established = (await t.run((ctx) => ctx.db.get(applicationId)))!
      .supplierEntitlementWitness!;
    expect(established.amountMinor).toBe(17_000_000);

    // A real correction to the paperwork — the amount and the entitlement are
    // untouched.
    await asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Revised purchase agreement",
      notes: "Collected in person.",
    });

    const after = (await t.run((ctx) => ctx.db.get(applicationId)))!;
    // The receipt moved, because that is what was corrected...
    expect(after.directSupplierReceipt?.source).toBe("Revised purchase agreement");
    // ...and the witness did NOT, because the entitlement did not.
    expect(after.supplierEntitlementWitness).toStrictEqual(established);
  });

  test("an exact retry is the same act — no revision bump, no second audit row", async () => {
    // A lost response or a double submit repeated the whole write: it bumped the
    // concurrency revision, invalidating every open confirmation for nothing, and
    // appended an override event claiming the figure had been corrected. The
    // audit trail is what somebody reads to find out whether a number moved, so
    // fabricating a correction corrupts the record it exists to protect.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });

    const call = (amountMinor: number, source: string) =>
      asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId,
        applicationId,
        approvedAmountMinor: amountMinor,
        source,
      });

    const snapshot = async () => {
      const app = await t.run((ctx) => ctx.db.get(applicationId));
      const audit = await t.run((ctx) =>
        ctx.db
          .query("financeApplicationOverrides")
          .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
          .collect()
      );
      return {
        revision: app?.economicsRevision,
        // This writer's own rows only — see the note in the machine-readable
        // test above.
        auditRows: audit.filter((r) =>
          ["approvedDealerPurchaseAmountMinor", "directSupplierReceipt"].includes(r.field)
        ).length,
      };
    };

    await call(17_000_000, "Signed purchase agreement");
    const afterFirst = await snapshot();
    // Non-vacuity: the first write really did record something to retry.
    expect(afterFirst.auditRows).toBe(1);
    expect(afterFirst.revision).toBeTypeOf("number");

    // The identical act, including whitespace that normalizes to the same value.
    await call(17_000_000, "  Signed purchase agreement  ");
    expect(await snapshot()).toStrictEqual(afterFirst);

    // A REAL change is still a correction, and says what it replaced.
    await call(18_000_000, "Revised purchase agreement");
    const afterCorrection = await snapshot();
    expect(afterCorrection.auditRows).toBe(2);
    expect(afterCorrection.revision).toBeGreaterThan(afterFirst.revision as number);

    const audit = await t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );
    const correction = audit.find((row) => row.reason.includes("corrected"));
    expect(correction?.reason).toMatch(/Was 17000000/);
    expect(correction?.reason).toMatch(/now 18000000/);
  });

  test("a DEFAULT MANAGER is told they cannot record it, not shown an action the server refuses", async () => {
    // The owner-proxy's fourth blocker, and the fixture is the point.
    //
    // The card gated on the approval permission alone; the mutation requires the
    // money permission as well. A default MANAGER holds the first WITHOUT the
    // second, so that manager was shown a button the server would refuse. The
    // earlier negative test passed `canRecordApproval: false`, which is a
    // caller the split never applies to — it could not have caught this.
    //
    // Built from DEFAULT_ROLE_TEMPLATES rather than a hand-written permission
    // list, because a hand-written list is exactly what hid the defect: it can
    // omit the permission that makes the combination dangerous.
    const managerTemplate = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "MANAGER");
    expect(managerTemplate).toBeDefined();
    // The premise, asserted rather than assumed: if MANAGER ever gains
    // `view:finance` this test must be reconsidered, not silently keep passing.
    expect(managerTemplate!.permissions).toContain("approve:finance_application");
    expect(managerTemplate!.permissions).not.toContain("view:finance");

    const { t, orgId, applicationId, asUser } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });

    // A real default MANAGER, and NOT the salesperson on this deal — otherwise
    // the own-deal rule would answer first and the permission half would go
    // untested.
    const managerId = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "guard_manager",
        email: "manager@test.com",
        name: "Default Manager",
      })
    );
    const managerRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "MANAGER",
        permissions: managerTemplate!.permissions,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId })
    );
    const asManager = t.withIdentity({ subject: "guard_manager", clerkId: "guard_manager" });

    // The SERVER decides eligibility, so the screen cannot disagree with it.
    const cockpit = await asManager.query(api.applications.dealCockpit, { orgId, applicationId });
    expect(cockpit?.directSupplierAmount.applicable).toBe(true);
    expect(cockpit?.directSupplierAmount.available).toBe(false);
    expect(cockpit?.directSupplierAmount.reasonKey).toBe("DirectSupplierAmountNeedsPermission");

    // And the mutation refuses that same caller, which is the fact the verdict
    // above exists to predict.
    await expect(
      asManager.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId,
        applicationId,
        approvedAmountMinor: 17_000_000,
        source: "Signed purchase agreement",
      })
    ).rejects.toThrow(/permission/i);
  });

  test("a MANUAL direct deal cannot be HANDED OVER without the supplier amount", async () => {
    // The owner-proxy's first blocker, and the sharpest of the five.
    //
    // `finalizeDeal` already refused a direct deal with no approved amount.
    // Handover did not, because the economics guard returned early for every
    // non-configured mode. So the vehicle could go to the customer with nothing
    // recorded — and THEN both doors are shut: the writer refuses a handed-over
    // deal, and finalization refuses a missing amount. The vehicle is gone and
    // the deal cannot be completed or corrected.
    //
    // The screen withdrawing its button after handover does not make that server
    // transition safe. Refusing before the vehicle leaves is what keeps the
    // refusal recoverable.
    const { t, orgId, applicationId, asUser } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );

    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });

    // Non-vacuity: the amount really is absent, so the refusal is about that.
    const before = await t.run((ctx) => ctx.db.get(applicationId));
    expect(before?.supplierSettlementRoute).toBe("DIRECT_TO_SUPPLIER");
    expect(before?.approvedDealerPurchaseAmountMinor).toBeUndefined();

    await expect(
      registerHandover(asUser, api, orgId, applicationId)
    ).rejects.toThrow(/pays the supplier directly|is not recorded/i);

    // And the vehicle has NOT gone out, so the deal is still recoverable.
    const after = await t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.vehicleHandoverAt).toBeUndefined();
  });

  test("recording less than the supplier is owed is refused, and changes nothing at all", async () => {
    // The entitlement guard. `setSupplierSettlementRoute` checks an amount that
    // is already there; the configured approver checks one entered after the
    // route. This writer is the third ordering — route first, amount later — and
    // it was the one with no entitlement check, so an operator could record less
    // than the supplier is owed and only meet the refusal at finalization,
    // potentially after the vehicle had gone.
    //
    // ATOMIC: the rejected attempt must move nothing — not the amount, not the
    // denomination, not the concurrency revision, not the audit trail.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });

    const snapshot = async () => {
      const app = await t.run((ctx) => ctx.db.get(applicationId));
      const audit = await t.run((ctx) =>
        ctx.db
          .query("financeApplicationOverrides")
          .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
          .collect()
      );
      return {
        amount: app?.approvedDealerPurchaseAmountMinor,
        currency: app?.economicsCurrency,
        revision: app?.economicsRevision,
        // Every row, deliberately: this test asserts the refused call wrote
        // NOTHING anywhere, so narrowing the field would weaken it.
        auditRows: audit.length,
      };
    };

    const before = await snapshot();

    // The fixture records `sourceCost: 17000` as the supplier's entitlement, so
    // 16,000 is genuinely below it rather than merely small.
    await expect(
      asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId,
        applicationId,
        approvedAmountMinor: 16_000_000,
        source: "Signed purchase agreement",
      })
    ).rejects.toThrow(/owed more than this/i);

    expect(await snapshot()).toStrictEqual(before);
    // Non-vacuity: a snapshot of all-undefined would compare equal to itself, so
    // prove the fields the comparison depends on are real ones.
    expect(before.amount).toBeUndefined();
    // Not zero: choosing the settlement route legitimately recorded one row
    // before this test's own call. What matters is that the REFUSAL adds none,
    // which the comparison below measures — an absolute count here would pin an
    // unrelated writer's behaviour by accident.
    expect(before.auditRows).toBe(1);
  });

  test("recording the amount MOVES the stamp, so an open handover confirmation cannot seal a figure it never saw", async () => {
    // The concurrency race. `handoverStamp` derives from `economicsRevision`, and
    // an open handover confirmation carries the stamp it was opened against.
    // Without a bump, operator A could open against amount A, operator B record
    // amount B, and A's stale confirmation still succeed — sealing B while having
    // reviewed A. Every other writer of these figures moves the revision; this
    // one did not.
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "MANUAL_FINANCE_COMPANY",
      { sourcedVehicle: true, manualProviderName: "Amman Finance House" }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });

    const record = (amountMinor: number) =>
      asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId,
        applicationId,
        approvedAmountMinor: amountMinor,
        source: "Signed purchase agreement",
      });

    // FIRST write.
    await record(17_000_000);
    const first = await t.run((ctx) => ctx.db.get(applicationId));
    expect(first?.approvedDealerPurchaseAmountMinor).toBe(17_000_000);
    const revisionAfterFirst = first?.economicsRevision;
    expect(revisionAfterFirst).toBeTypeOf("number");

    // The stamp operator A is holding, read BEFORE the correction below.
    const staleStamp = await asUser.query(api.applications.handoverStamp, {
      orgId,
      applicationId,
    });
    expect(staleStamp).toBeTruthy();

    // CORRECTION by operator B.
    await record(18_000_000);
    const second = await t.run((ctx) => ctx.db.get(applicationId));
    expect(second?.approvedDealerPurchaseAmountMinor).toBe(18_000_000);
    expect(second?.economicsRevision).toBeGreaterThan(revisionAfterFirst as number);

    // Operator A's confirmation must now be refused rather than sealing 18,000
    // against a review of 17,000.
    await expect(
      asUser.mutation(api.applications.registerVehicleHandover, {
        orgId,
        applicationId,
        economicsStamp: staleStamp!,
      })
    ).rejects.toThrow();

    // A FRESH stamp succeeds, so the guard refuses staleness rather than
    // handover itself — otherwise this would be a dead end of its own.
    const freshStamp = await asUser.query(api.applications.handoverStamp, {
      orgId,
      applicationId,
    });
    expect(freshStamp).toBeTruthy();
    expect(freshStamp).not.toBe(staleStamp);
    await asUser.mutation(api.applications.registerVehicleHandover, {
      orgId,
      applicationId,
      economicsStamp: freshStamp!,
    });
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeTypeOf(
      "number"
    );
  });

  test("the manual writer refuses the deals that belong to the approval step, and the states that are sealed", async () => {
    // The boundary. Without these the new writer is a second way to set a field
    // that already has an owner, which is how two derivations of one number
    // start disagreeing.
    const configured = await seedApprovedApplication("CONFIGURED_FINANCE_COMPANY", {
      sourcedVehicle: true,
    });
    await configured.asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId: configured.orgId,
      applicationId: configured.applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await expect(
      configured.asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId: configured.orgId,
        applicationId: configured.applicationId,
        approvedAmountMinor: 17_000_000,
        source: "Signed purchase agreement",
      })
    ).rejects.toThrow(/finance company approves the purchase amount/i);

    // Not on the direct route, where the figure has no meaning.
    const through = await seedApprovedApplication("MANUAL_FINANCE_COMPANY", {
      sourcedVehicle: true,
      manualProviderName: "Amman Finance House",
    });
    await expect(
      through.asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId: through.orgId,
        applicationId: through.applicationId,
        approvedAmountMinor: 17_000_000,
        source: "Signed purchase agreement",
      })
    ).rejects.toThrow(/does not pay the supplier directly/i);

    // NaN passes `v.number()`, so the guard is asserted rather than assumed.
    const manual = await seedApprovedApplication("MANUAL_FINANCE_COMPANY", {
      sourcedVehicle: true,
      manualProviderName: "Amman Finance House",
    });
    await manual.asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId: manual.orgId,
      applicationId: manual.applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await expect(
      manual.asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId: manual.orgId,
        applicationId: manual.applicationId,
        approvedAmountMinor: Number.NaN,
        source: "Signed purchase agreement",
      })
    ).rejects.toThrow();
    // An unrecorded source is refused: an amount nobody can trace is not evidence.
    await expect(
      manual.asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId: manual.orgId,
        applicationId: manual.applicationId,
        approvedAmountMinor: 17_000_000,
        source: "   ",
      })
    ).rejects.toThrow(/where this amount came from/i);

    // Sealed once the vehicle has gone out.
    await manual.asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
      orgId: manual.orgId,
      applicationId: manual.applicationId,
      approvedAmountMinor: 17_000_000,
      source: "Signed purchase agreement",
    });
    await registerHandover(manual.asUser, api, manual.orgId, manual.applicationId);
    await expect(
      manual.asApprover.mutation(api.applications.recordDirectSupplierReceiptAmount, {
        orgId: manual.orgId,
        applicationId: manual.applicationId,
        approvedAmountMinor: 18_000_000,
        source: "Revised agreement",
      })
    ).rejects.toThrow(/handed over/i);
  });

  test("a MANUAL deal settling THROUGH the dealership is not asked for an approved amount", async () => {
    // The contrast that stops the fix being widened into a new defect. Same
    // vehicle, same named provider, same mode — only the ROUTE differs. Nothing
    // outside the dealership pays the supplier here, so no approved purchase
    // amount applies and the deal must close without one.
    const { t, orgId, applicationId, asUser, registerExpectedPayment } =
      await seedApprovedApplication("MANUAL_FINANCE_COMPANY", {
        sourcedVehicle: true,
        manualProviderName: "Amman Finance House",
      });

    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });

    const seeded = await t.run((ctx) => ctx.db.get(applicationId));
    expect(seeded?.supplierSettlementRoute).toBe("THROUGH_DEALERSHIP");

    await registerHandover(asUser, api, orgId, applicationId);
    await registerExpectedPayment();
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    const after = await t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.status).toBe("CLOSED");
    expect(after?.finalizedSaleId).toBeDefined();
  });

  // The blocker the owner-proxy found. Structurally real; NOT reachable today.
  //
  // `assertDealerEconomicsRecorded` puts its non-applicable exemption INSIDE the
  // `submittedQuotationMinor === undefined` branch. So the exemption only ever
  // fires for a non-CONFIGURED deal that has NO quotation. Give one a quotation
  // and it falls straight through into the CONFIGURED-only requirements —
  // approved purchase amount, then funded portion — neither of which these modes
  // need produce. The comment above that guard says it is "deliberately NOT
  // extended to the other modes"; the code extends it the moment a quotation
  // exists. Intent, not reach.
  //
  // Reachability, checked rather than assumed: `recordSubmittedQuotation` has no
  // MODE guard, but it needs a company rule snapshot and these modes cannot
  // carry a company, so it always refuses them. See the note in each case below.
  for (const mode of ["MANUAL_FINANCE_COMPANY", "LEASE", "INTERNAL_INSTALLMENT"] as const) {
    test(`a ${mode} deal carrying a quotation is still not blocked by the configured-mode requirement`, async () => {
      const { t, orgId, applicationId, asUser, registerExpectedPayment } =
        await seedApprovedApplication(mode);

      // Written directly, and the reason matters. No production writer can put
      // a quotation on these modes TODAY: `recordSubmittedQuotation` resolves a
      // company rule snapshot and throws "This application has no finance
      // company" without one, while `quotes.saveQuote` (line 124) forbids a
      // `companyId` on any mode that is present and not CONFIGURED. The
      // application also FREEZES `quoteModeAtSubmission`, so a later edit to the
      // quote cannot turn a configured deal into a manual one carrying its old
      // quotation.
      //
      // So this is defensive/legacy coverage, NOT a reachable live path — stated
      // plainly rather than dressed up as a reproduction. The guard is still
      // wrong in shape: it puts the non-applicable exemption INSIDE the
      // "no quotation" branch, so any row that ever acquires one — by a future
      // writer, a migration, or an import — silently inherits CONFIGURED-only
      // requirements the comment above it says are deliberately not extended.
      await t.run((ctx) =>
        ctx.db.patch(applicationId, { submittedQuotationMinor: 17_000_000 })
      );

      // Non-vacuity: the quotation really is on the row, so the branch under
      // test is the one being exercised.
      const seeded = await t.run((ctx) => ctx.db.get(applicationId));
      expect(seeded?.submittedQuotationMinor).toBe(17_000_000);
      expect(seeded?.approvedDealerPurchaseAmountMinor).toBeUndefined();

      await registerHandover(asUser, api, orgId, applicationId);
      await registerExpectedPayment();
      await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

      const after = await t.run((ctx) => ctx.db.get(applicationId));
      expect(after?.status).toBe("CLOSED");
      expect(after?.finalizedSaleId).toBeDefined();
    });
  }

  test("a LEASE deal is not blocked by the configured-mode requirement", async () => {
    const { t, orgId, applicationId, asUser, registerExpectedPayment } =
      await seedApprovedApplication("LEASE");

    await registerHandover(asUser, api, orgId, applicationId);
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

    await registerHandover(asUser, api, orgId, applicationId);
    await registerExpectedPayment();
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    const after = await t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.status).toBe("CLOSED");
    expect(after?.finalizedSaleId).toBeDefined();
  });
});

describe("SCRUM-61: a witness never outlives the amount it attests to", () => {
  /**
   * THE GOVERNING INVARIANT, exercised as a MATRIX rather than as the one
   * sequence that happened to be reproduced.
   *
   * ⚠️ Written this way on the owner's instruction, after four consecutive
   * rounds in which a fix of mine opened a new HIGH in this subsystem. Every one
   * of those four was the same authority mistake wearing different clothes, and
   * every one was found by attacking a path the previous round's test did not
   * enumerate. Fixing only the reproduced sequence is what kept producing a
   * fifth.
   *
   * The dimensions are the ones that can actually disagree:
   *   amount changed / unchanged
   *     x  entitlement applicable+provable / not applicable / unprovable
   *     x  evidence already held: none / VALIDATED / NOT_VALIDATED
   *
   * This pins the RULE. It does not prove every caller passes the right flag —
   * that is what the two end-to-end sequences below cover, through the real
   * public mutations. Both halves are needed: the rule was correct in the first
   * design and a caller bypassed it, and here the caller was correct and the
   * rule leaked.
   */
  const FRESH = {
    validatedAt: 1_700_000_000_000,
    validatedBy: "fresh_actor" as unknown as Id<"users">,
    via: "CONFIGURED_APPROVAL" as const,
  };
  const HELD_VALIDATED = {
    status: "VALIDATED" as const,
    amountMinor: 17_000_000,
    validatedAt: 1_600_000_000_000,
    validatedBy: "earlier_actor" as unknown as Id<"users">,
    via: "MANUAL_RECEIPT" as const,
  };
  const HELD_NOT_VALIDATED = {
    status: "NOT_VALIDATED" as const,
    validatedAt: 1_600_000_000_000,
    validatedBy: "earlier_actor" as unknown as Id<"users">,
    via: "MANUAL_RECEIPT" as const,
  };

  // "Applicable and provable at the SAME entitlement" is the case the defect
  // hid in: the supplier's number had not moved, so the old code called the
  // evidence current while the amount it attested to had changed underneath it.
  const SAME_ENTITLEMENT = { validated: true as const, entitlementMinor: 17_000_000 };
  const MOVED_ENTITLEMENT = { validated: true as const, entitlementMinor: 18_000_000 };
  const NOTHING_COMPARED = { validated: false as const };

  const cases: Array<{
    name: string;
    held: typeof HELD_VALIDATED | typeof HELD_NOT_VALIDATED | undefined;
    measured: typeof SAME_ENTITLEMENT | typeof NOTHING_COMPARED;
    amountChanged: boolean;
    expected: { status: "VALIDATED" | "NOT_VALIDATED"; amountMinor?: number; fresh: boolean };
  }> = [
    // ---- THE AMOUNT MOVED. Nothing held may survive it, in any combination.
    {
      name: "amount moved, entitlement unchanged, VALIDATED held — THE HIGH",
      held: HELD_VALIDATED,
      measured: SAME_ENTITLEMENT,
      amountChanged: true,
      expected: { status: "VALIDATED", amountMinor: 17_000_000, fresh: true },
    },
    {
      name: "amount moved, entitlement moved, VALIDATED held",
      held: HELD_VALIDATED,
      measured: MOVED_ENTITLEMENT,
      amountChanged: true,
      expected: { status: "VALIDATED", amountMinor: 18_000_000, fresh: true },
    },
    {
      name: "amount moved, nothing comparable, VALIDATED held — fails closed",
      held: HELD_VALIDATED,
      measured: NOTHING_COMPARED,
      amountChanged: true,
      expected: { status: "NOT_VALIDATED", fresh: true },
    },
    {
      name: "amount moved, nothing comparable, NOT_VALIDATED held",
      held: HELD_NOT_VALIDATED,
      measured: NOTHING_COMPARED,
      amountChanged: true,
      expected: { status: "NOT_VALIDATED", fresh: true },
    },
    {
      name: "amount moved, entitlement provable, NOT_VALIDATED held — upgrades",
      held: HELD_NOT_VALIDATED,
      measured: SAME_ENTITLEMENT,
      amountChanged: true,
      expected: { status: "VALIDATED", amountMinor: 17_000_000, fresh: true },
    },
    {
      name: "amount moved, entitlement provable, nothing held — first evidence",
      held: undefined,
      measured: SAME_ENTITLEMENT,
      amountChanged: true,
      expected: { status: "VALIDATED", amountMinor: 17_000_000, fresh: true },
    },
    {
      name: "amount moved, nothing comparable, nothing held",
      held: undefined,
      measured: NOTHING_COMPARED,
      amountChanged: true,
      expected: { status: "NOT_VALIDATED", fresh: true },
    },
    // ---- THE AMOUNT DID NOT MOVE. Identity is preserved, but only where
    //      nothing was genuinely re-observed.
    {
      name: "amount unchanged, same entitlement re-measured — identity preserved",
      held: HELD_VALIDATED,
      measured: SAME_ENTITLEMENT,
      amountChanged: false,
      expected: { status: "VALIDATED", amountMinor: 17_000_000, fresh: false },
    },
    {
      name: "amount unchanged, entitlement itself moved — re-observed",
      held: HELD_VALIDATED,
      measured: MOVED_ENTITLEMENT,
      amountChanged: false,
      expected: { status: "VALIDATED", amountMinor: 18_000_000, fresh: true },
    },
    {
      name: "amount unchanged, nothing comparable, VALIDATED held — still true of it",
      held: HELD_VALIDATED,
      measured: NOTHING_COMPARED,
      amountChanged: false,
      expected: { status: "VALIDATED", amountMinor: 17_000_000, fresh: false },
    },
    {
      name: "amount unchanged, NOT_VALIDATED held, now provable — genuine upgrade",
      held: HELD_NOT_VALIDATED,
      measured: SAME_ENTITLEMENT,
      amountChanged: false,
      expected: { status: "VALIDATED", amountMinor: 17_000_000, fresh: true },
    },
    {
      name: "amount unchanged, NOT_VALIDATED held, still nothing compared — no re-badge",
      held: HELD_NOT_VALIDATED,
      measured: NOTHING_COMPARED,
      amountChanged: false,
      expected: { status: "NOT_VALIDATED", fresh: false },
    },
    {
      name: "amount unchanged, nothing held, now provable",
      held: undefined,
      measured: SAME_ENTITLEMENT,
      amountChanged: false,
      expected: { status: "VALIDATED", amountMinor: 17_000_000, fresh: true },
    },
    {
      name: "amount unchanged, nothing held, nothing comparable",
      held: undefined,
      measured: NOTHING_COMPARED,
      amountChanged: false,
      expected: { status: "NOT_VALIDATED", fresh: true },
    },
  ];

  for (const c of cases) {
    test(`witness rule: ${c.name}`, () => {
      const { witness, changed } = witnessToStore(c.held, c.measured, FRESH, c.amountChanged);
      expect(witness?.status).toBe(c.expected.status);
      expect(witness?.amountMinor).toBe(c.expected.amountMinor);
      /**
       * PROVENANCE IS THE ASSERTION, not the amount.
       *
       * The defect produced a witness whose amount was RIGHT and whose meaning
       * was wrong: 17,000,000 was still the supplier's entitlement, and the
       * record still said an earlier actor had agreed it against an amount that
       * no longer existed. Comparing amounts alone cannot see that, which is why
       * the old tests did not.
       */
      expect(witness?.validatedBy).toBe(
        c.expected.fresh ? FRESH.validatedBy : c.held?.validatedBy
      );
      expect(witness?.validatedAt).toBe(c.expected.fresh ? FRESH.validatedAt : c.held?.validatedAt);
      expect(witness?.via).toBe(c.expected.fresh ? FRESH.via : c.held?.via);
      expect(changed).toBe(c.expected.fresh);
    });
  }

  test("a witness cannot cross a window in which the vehicle was not consigned", async () => {
    /**
     * THE REPRODUCED HIGH, end to end, through the ORDINARY public doors.
     *
     * Nothing here is patched in and nothing is exotic: `vehicles.update` is the
     * screen a manager uses to correct how a car was acquired, and it is
     * deliberately open while the car is unsold — `retroactiveOwnershipChangeRefusal`
     * only closes it once the vehicle has been SOLD, because converting a sold
     * car rewrites posted accounting. So this sequence is a real operator's
     * afternoon, not an attack.
     *
     *   approve 17,000,000 against the supplier's 17,000,000  → VALIDATED
     *   convert the car to dealership STOCK
     *   re-approve 16,000,000                                  → nothing compares it
     *   convert the car back to SOURCED
     *   hand it over
     *
     * The witness was written only while the vehicle was consigned, so the
     * middle step left the ORIGINAL 17,000,000 evidence in place beside a
     * 16,000,000 decision. Coming back out the other side, the verdict compared
     * that stale 17,000,000 against the vehicle's unchanged 17,000,000, read
     * UNCHANGED, and the handover SUCCEEDED on evidence for an amount that had
     * been abandoned. The supplier's 1,000,000 vanished with the vehicle.
     *
     * ⚠️ The vehicle's cost is deliberately left at 17,000 for the return trip.
     * Lowering it would make the stale witness DRIFTED, and the drift guard —
     * which was never broken — would refuse the handover for its own reasons,
     * leaving this test green against the unfixed code while proving nothing
     * about the rule it names.
     */
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "CONFIGURED_FINANCE_COMPANY",
      { sourcedVehicle: true }
    );
    const vehicleId = (await t.run((ctx) => ctx.db.get(applicationId)))!.vehicleId;

    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 17_000_000,
      source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "Approved by the finance company over the phone.",
    });

    const agreed = await t.run((ctx) => ctx.db.get(applicationId));
    expect(agreed?.supplierEntitlementWitness?.status).toBe("VALIDATED");
    expect(agreed?.supplierEntitlementWitness?.amountMinor).toBe(17_000_000);
    const revisionBefore = agreed?.economicsRevision ?? 0;

    // The window. An ordinary correction on an unsold car.
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceType: "STOCK" });

    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 16_000_000,
      basis: "MANUAL",
      notes: "Finance company reduced the purchase amount.",
      outlierAcknowledged: true,
    });

    const afterReapproval = await t.run((ctx) => ctx.db.get(applicationId));
    expect(afterReapproval?.approvedDealerPurchaseAmountMinor).toBe(16_000_000);
    // THE INVARIANT. Evidence taken for 17,000,000 may not still be standing
    // beside a 16,000,000 decision, whatever the car happens to be right now.
    expect(afterReapproval?.supplierEntitlementWitness?.status).toBe("NOT_VALIDATED");
    expect(afterReapproval?.supplierEntitlementWitness?.amountMinor).toBeUndefined();
    // And the concurrency token moved, so a handover confirmation opened against
    // the 17,000,000 view cannot seal the 16,000,000 one.
    expect(afterReapproval?.economicsRevision ?? 0).toBeGreaterThan(revisionBefore);

    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceType: "SOURCED" });
    // Anti-vacuity: the car really is consigned again at the SAME cost, so the
    // refusal below is the witness rule and not a drift the fixture engineered.
    const vehicle = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(vehicle?.sourceType).toBe("SOURCED");
    expect(vehicle?.sourceCost).toBe(17_000);

    await expect(registerHandover(asUser, api, orgId, applicationId)).rejects.toThrow(
      /does not record what the supplier was owed/i
    );
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeUndefined();

    /**
     * RECOVERABLE, which is the half that makes this a guard rather than a dead
     * end. The supplier's cost is corrected to the 16,000 the parties actually
     * settled on, and re-agreeing the same 16,000,000 against it re-takes the
     * evidence — an amount that did not move, but a comparison that genuinely
     * happened.
     */
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceCost: 16_000 });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 16_000_000,
      basis: "MANUAL",
      notes: "Re-agreed against the corrected supplier cost.",
      outlierAcknowledged: true,
    });
    const reagreed = await t.run((ctx) => ctx.db.get(applicationId));
    expect(reagreed?.supplierEntitlementWitness?.status).toBe("VALIDATED");
    expect(reagreed?.supplierEntitlementWitness?.amountMinor).toBe(16_000_000);

    await registerHandover(asUser, api, orgId, applicationId);
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.vehicleHandoverAt).toBeTypeOf(
      "number"
    );
  });

  test("re-approving a different amount re-takes the evidence even where the supplier's number never moved", async () => {
    /**
     * THE SIBLING CONTROL, and the reason the fix is not merely "stop skipping
     * the helper".
     *
     * No vehicle conversion, no route change, nothing unusual at all: a plain
     * consigned direct deal whose finance company revises its purchase amount
     * from 18,000,000 to 19,000,000 while the supplier is owed 17,000,000
     * throughout. The helper preserved the witness whenever the ENTITLEMENT
     * number matched, so the 19,000,000 decision inherited evidence created for
     * the 18,000,000 one — same amount, same actor, same timestamp.
     *
     * The entitlement is only HALF of what this evidence attests to. A witness
     * records a COMPARISON, and the other side of it just moved.
     *
     * The second approval is made by a DIFFERENT actor, because a fresh
     * timestamp alone is not a safe assertion — two approvals inside one test
     * can land on the same millisecond, and the test would then pass for a
     * reason that has nothing to do with the rule.
     *
     * ⚠️ That actor is a THIRD user, not the fixture's `asUser`. The first
     * version reused `asUser`, who is the deal's salesperson, so
     * `approveDealerPurchaseAmount` refused it on separation of duties — and the
     * test duly "failed first" against the unfixed code for a reason that had
     * nothing whatever to do with the witness rule. A neighbouring guard firing
     * first makes an uncovered guard look covered.
     */
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "CONFIGURED_FINANCE_COMPANY",
      { sourcedVehicle: true }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 18_000_000,
      source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 18_000_000,
      basis: "MANUAL",
      notes: "First approval.",
    });
    const first = (await t.run((ctx) => ctx.db.get(applicationId)))!.supplierEntitlementWitness!;
    expect(first.status).toBe("VALIDATED");
    expect(first.amountMinor).toBe(17_000_000);

    // A DIFFERENT actor re-agrees a DIFFERENT amount against the SAME 17,000,000.
    const secondApprover = await t.run(async (ctx) => {
      const roleId = (await ctx.db.query("roles").collect()).find((r) => r.orgId === orgId)!._id;
      const userId = await ctx.db.insert("users", {
        clerkId: "guard_approver_2",
        email: "guard.a2@test.com",
        name: "Second Approver",
      });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
      return userId;
    });
    const asSecondApprover = t.withIdentity({
      subject: "guard_approver_2",
      clerkId: "guard_approver_2",
    });
    await asSecondApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 19_000_000,
      basis: "MANUAL",
      notes: "Finance company revised the purchase amount upward.",
      outlierAcknowledged: true,
    });
    const second = (await t.run((ctx) => ctx.db.get(applicationId)))!.supplierEntitlementWitness!;

    // The supplier's number legitimately did not move — asserted, so the case
    // this test is named for is the case it actually exercised.
    expect(second.amountMinor).toBe(17_000_000);
    expect(second.status).toBe("VALIDATED");
    // But the evidence is NOT the same evidence. Somebody else agreed a
    // different amount against it, and that act has its own actor — named
    // exactly, so this cannot pass on any difference that happens to appear.
    expect(second.validatedBy).toBe(secondApprover);
    expect(second.validatedBy).not.toBe(first.validatedBy);

    // And it left a trace. Evidence being re-taken on a money decision is
    // exactly what the override table exists to record.
    const witnessRows = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("financeApplicationOverrides")
          .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
          .collect()
      ).filter((r) => r.field === "supplierEntitlementWitness")
    );
    expect(witnessRows.length).toBeGreaterThan(0);
  });

  test("a cost-only caller cannot read NOT_VALIDATED off the shape of what it is served", async () => {
    /**
     * THE SECOND-ORDER LEAK, closed while re-reading the first fix.
     *
     * The cost-only projection strips the provenance and keeps the amount. A
     * NOT_VALIDATED witness has no amount, so the first version returned an
     * empty object — and an empty object is `status: NOT_VALIDATED` spelled by
     * SHAPE rather than by name. The caller learns the deal holds evidence
     * recording that nothing was compared, which is precisely the finance fact
     * the projection exists to withhold.
     *
     * Collapsing "no witness" and "witness with no amount" to the same absence
     * is the non-disclosing answer, and it withholds nothing this caller is
     * entitled to: either way there is no entitlement amount to read.
     */
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "CONFIGURED_FINANCE_COMPANY",
      { sourcedVehicle: true }
    );
    // THROUGH the dealership: the approval compares no entitlement, so it
    // records NOT_VALIDATED rather than staying silent about it.
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "THROUGH_DEALERSHIP",
    });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 17_000_000,
      source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "Approved while the deal settles through the dealership.",
    });
    // Anti-vacuity: the deal really does hold the shape this test is about.
    const held = (await t.run((ctx) => ctx.db.get(applicationId)))?.supplierEntitlementWitness;
    expect(held?.status).toBe("NOT_VALIDATED");
    expect(held?.amountMinor).toBeUndefined();

    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === orgId)!;
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:finance_applications", "view:cost_price"],
        isSystemOwnerRole: false,
      });
    });
    const costOnly = (await asUser.query(api.applications.get, {
      orgId,
      applicationId,
    })) as unknown as Record<string, unknown>;
    // No key at all — indistinguishable from a deal that holds no witness.
    expect(`cost-only sees a witness: ${Object.hasOwn(costOnly, "supplierEntitlementWitness")}`).toBe(
      "cost-only sees a witness: false"
    );
    expect(costOnly._id).toBe(applicationId);

    // And finance still sees it, so the absence above is redaction rather than
    // the field having quietly stopped being served to anybody.
    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === orgId)!;
      await ctx.db.patch(role._id, {
        permissions: ["view:sales", "view:finance_applications", "view:finance"],
        isSystemOwnerRole: false,
      });
    });
    const financeView = (await asUser.query(api.applications.get, {
      orgId,
      applicationId,
    })) as unknown as Record<string, unknown>;
    expect((financeView.supplierEntitlementWitness as { status: string }).status).toBe(
      "NOT_VALIDATED"
    );
  });

  test("the witness change log follows the same gate as the witness", async () => {
    /**
     * A REDACTED DOCUMENT WITH AN UNREDACTED CHANGE LOG IS NOT REDACTED.
     *
     * ⚠️ Found by the Codex reviewer seat and reproduced here before being
     * believed. Splitting `redactSettlementEvidence` three ways withheld the
     * witness provenance from the DOCUMENT — and `getEconomics` went on serving
     * the override rows this release introduced, blanking only their VALUES. The
     * rows still carried `field: "supplierEntitlementWitness"`, `changedBy` and
     * `changedAt`, so a default-SALES caller still learned that a
     * supplier-entitlement validation happened, when, and by whom.
     *
     * Measured before the fix: 2 such rows reached a caller holding neither
     * `view:finance` nor `view:cost_price`. It is the same mistake as the leak
     * it sits beside — gate the field, publish the sentence written next to it
     * — one layer further down.
     */
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "CONFIGURED_FINANCE_COMPANY",
      { sourcedVehicle: true }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 17_000_000,
      source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_000_000,
      basis: "MANUAL",
      notes: "First approval.",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 17_500_000,
      basis: "MANUAL",
      notes: "Revised.",
      outlierAcknowledged: true,
    });

    // ANTI-VACUITY FIRST, straight from the table and past every gate: the rows
    // must exist, or withholding them proves nothing.
    const stored = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("financeApplicationOverrides")
          .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
          .collect()
      ).filter((r) => r.field === "supplierEntitlementWitness")
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((r) => typeof r.changedBy === "string")).toBe(true);

    const salesTemplate = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "SALES")!;
    expect(salesTemplate.permissions).not.toContain("view:finance");
    expect(salesTemplate.permissions).not.toContain("view:cost_price");
    const setPermissions = (permissions: string[]) =>
      t.run(async (ctx) => {
        const role = (await ctx.db.query("roles").collect()).find((r) => r.orgId === orgId)!;
        await ctx.db.patch(role._id, { permissions, isSystemOwnerRole: false });
      });
    const overridesFor = async () =>
      (
        (await asUser.query(api.financingEconomics.getEconomics, {
          orgId,
          applicationId,
        })) as unknown as { overrides: Array<{ field: string; changedBy?: string }> }
      ).overrides;

    await setPermissions([...salesTemplate.permissions]);
    const salesRows = await overridesFor();
    expect(
      `sales sees witness rows: ${salesRows.some((r) => r.field === "supplierEntitlementWitness")}`
    ).toBe("sales sees witness rows: false");
    // The WORKFLOW half survives: the amount correction files its own row under
    // its own name, and that one still arrives. Withholding the whole log would
    // hide a fact this caller legitimately works with.
    expect(salesRows.some((r) => r.field === "approvedDealerPurchaseAmountMinor")).toBe(true);

    // COST-ONLY gets the entitlement AMOUNT on the document, and still not the
    // provenance here — `changedBy` is who validated it, which is finance.
    await setPermissions([...salesTemplate.permissions, "view:cost_price"]);
    const costRows = await overridesFor();
    expect(
      `cost-only sees witness rows: ${costRows.some((r) => r.field === "supplierEntitlementWitness")}`
    ).toBe("cost-only sees witness rows: false");

    // FINANCE receives them, so this is a gate rather than the rows having
    // quietly stopped being served to anybody.
    await setPermissions([...salesTemplate.permissions, "view:finance"]);
    const financeRows = await overridesFor();
    const financeWitnessRows = financeRows.filter(
      (r) => r.field === "supplierEntitlementWitness"
    );
    expect(financeWitnessRows.length).toBe(stored.length);
    expect(financeWitnessRows.every((r) => typeof r.changedBy === "string")).toBe(true);
  });

  test("a byte-identical re-approval still re-badges nothing", async () => {
    /**
     * THE OTHER DIRECTION, kept honest.
     *
     * A rule that re-takes evidence whenever the amount moves is only safe if it
     * does NOT re-take it when nothing moved. Otherwise every retry, double
     * click and dropped connection quietly transfers authorship of a money
     * decision — which is a defect this same file closed two rounds ago, and the
     * kind a stricter fix is most likely to reopen.
     */
    const { t, orgId, applicationId, asUser, asApprover } = await seedApprovedApplication(
      "CONFIGURED_FINANCE_COMPANY",
      { sourcedVehicle: true }
    );
    await asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId,
      applicationId,
      route: "DIRECT_TO_SUPPLIER",
    });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 18_000_000,
      source: "MANUAL_ENTRY",
    });
    const approve = () =>
      asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId,
        applicationId,
        approvedAmountMinor: 18_000_000,
        basis: "MANUAL",
        notes: "First approval.",
      });
    await approve();
    const before = (await t.run((ctx) => ctx.db.get(applicationId)))!.supplierEntitlementWitness!;
    await approve();
    const after = (await t.run((ctx) => ctx.db.get(applicationId)))!.supplierEntitlementWitness!;
    expect(after).toEqual(before);
  });
});
