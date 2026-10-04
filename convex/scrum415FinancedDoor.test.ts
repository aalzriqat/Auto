/**
 * SCRUM-415 (D-33) — A FINANCED SALE COMPLETES ONLY THROUGH THE FINANCE-FINALIZATION DOOR.
 *
 * INVARIANT: a sale whose financingType is FINANCED becomes COMPLETED only through
 * `applications.finalizeDeal`'s `FINANCE_FINALIZATION` door, and only when the door's
 * applicationId equals the sale's applicationId. Presence of an applicationId on the
 * sale row is not authority: a legacy or drifted PENDING FINANCED row that carries one
 * must not complete through `sales.completeDraft`, whatever the application's state
 * or the supplier route the row records.
 *
 * Fixtures: the legacy rows are seeded with `ctx.db` (no public mutation can create
 * them, which is why the door guard is structural); every ACT goes through a real
 * product mutation under a real identity, except (e), which drives the exported
 * `completeSale` directly because the door is a positional argument no client can set.
 */

import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { expectFinancedSaleRequiresDeal } from "../test-utils/financedSaleRequiresDeal";
import { expectAppError } from "../test-utils/expectAppError";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { completeSale } from "./utils/saleCompletion";
import { RETIRED_DEAL_MODE_MESSAGE } from "./utils/dealModes";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const PERMISSIONS = [
  "create:sales",
  "edit:sales",
  "view:sales",
  "view:customers",
  "edit:vehicles",
  "view:vehicles",
  "approve:requests",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "confirm:finance_disbursement",
  "view:finance",
  "verify:finance_documents",
  "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance",
];

type Route = "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";

async function seedDealer() {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Door Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "door_user", email: "door@example.com", name: "Door User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "door_approver", email: "door.approver@example.com", name: "Door Approver" })
  );
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Door", lastName: "Buyer", phone: "+962790000415" })
  );
  return {
    t,
    orgId,
    userId,
    customerId,
    asUser: t.withIdentity({ subject: "door_user", clerkId: "door_user" }),
    asApprover: t.withIdentity({ subject: "door_approver", clerkId: "door_approver" }),
  };
}
type Seed = Awaited<ReturnType<typeof seedDealer>>;

let vinSeq = 0;
async function vehicleFor(s: Seed, sourced = false) {
  vinSeq += 1;
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId,
      vin: `DOOR415VIN${String(vinSeq).padStart(6, "0")}`,
      make: "Kia",
      model: "Sportage",
      year: 2023,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 1000,
      sellingPrice: 20_000,
      status: "AVAILABLE" as const,
      ...(sourced
        ? { sourceType: "SOURCED" as const, sourcedFromName: "Amman Importer Co", sourceCost: 15_000 }
        : { purchasePrice: 15_000 }),
    })
  );
}

/** A finance application row in `status`, carrying OUR customer and OUR vehicle so no sibling check refuses first. */
async function applicationRow(
  s: Seed,
  vehicleId: Id<"vehicles">,
  status: "CANCELLED" | "REJECTED" | "APPROVED"
) {
  const quoteId = await s.t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: s.orgId,
      customerId: s.customerId,
      vehicleId,
      vehiclePrice: 20_000,
      downPayment: 3_000,
      termMonths: 48,
      status: "ACCEPTED" as const,
      createdBy: s.userId,
      createdAt: Date.now(),
    })
  );
  const applicationId = await s.t.run((ctx) =>
    ctx.db.insert("financeApplications", {
      orgId: s.orgId,
      quoteId,
      customerId: s.customerId,
      vehicleId,
      salespersonId: s.userId,
      status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  return { quoteId, applicationId };
}

/** A legacy PENDING FINANCED sale whose own applicationId is present. No public mutation can create one. */
async function legacyFinancedDraft(
  s: Seed,
  opts: { appStatus: "CANCELLED" | "REJECTED"; route?: Route }
) {
  // A supplier route is only meaningful on a consigned (SOURCED) car.
  const sourced = opts.route !== undefined;
  const vehicleId = await vehicleFor(s, sourced);
  const { quoteId, applicationId } = await applicationRow(s, vehicleId, opts.appStatus);
  const saleId = await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId,
      vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 20_000,
      saleDate: Date.now(),
      status: "PENDING" as const,
      financingType: "FINANCED" as const,
      downPayment: 3_000,
      loanAmount: 17_000,
      termMonths: 48,
      quoteId,
      applicationId,
      ...(opts.route ? { supplierSettlementRoute: opts.route } : {}),
    })
  );
  return { saleId, vehicleId, applicationId };
}

const WATCHED_TABLES = [
  "sales",
  "journalEntries",
  "receivableDocuments",
  "pendingAccountingEvents",
  "accountingEvents",
  "vehicleSupplierReceivables",
  "vehicleSupplierPayables",
  "vehicleCommitmentClaims",
  "financeApplications",
] as const;

/** Row counts of every table a completion would write, plus the full vehicle and sale documents. */
async function snapshot(s: Seed, saleId: Id<"sales"> | undefined, vehicleId: Id<"vehicles">) {
  return await s.t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const table of WATCHED_TABLES) counts[table] = (await ctx.db.query(table).collect()).length;
    return { counts, sale: saleId ? await ctx.db.get(saleId) : null, vehicle: await ctx.db.get(vehicleId) };
  });
}

async function expectRefusedAndNothingWritten(
  s: Seed,
  fixture: { saleId: Id<"sales">; vehicleId: Id<"vehicles"> }
) {
  const before = await snapshot(s, fixture.saleId, fixture.vehicleId);
  await expectFinancedSaleRequiresDeal(
    s.asUser.mutation(api.sales.completeDraft, {
      idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      saleId: fixture.saleId,
    })
  );
  const after = await snapshot(s, fixture.saleId, fixture.vehicleId);
  expect(after.sale?.status, "the draft stays a draft").toBe("PENDING");
  expect(after.vehicle?.status, "the car is not SOLD").toBe("AVAILABLE");
  expect(after, "nothing at all was written").toEqual(before);
}

describe("(a) a legacy FINANCED draft carrying its own applicationId is not completable through completeDraft", () => {
  test.each(["CANCELLED", "REJECTED"] as const)(
    "application %s, vehicle free: refused, nothing written",
    async (appStatus) => {
      const s = await seedDealer();
      const fixture = await legacyFinancedDraft(s, { appStatus });
      expect((await s.t.run((ctx) => ctx.db.get(fixture.applicationId)))?.status, "precondition").toBe(appStatus);
      await expectRefusedAndNothingWritten(s, fixture);
    }
  );
});

describe("(b) the THROUGH_DEALERSHIP supplier route variant (the demonstrated risk)", () => {
  test.each(["THROUGH_DEALERSHIP", "DIRECT_TO_SUPPLIER"] as const)(
    "SOURCED car, route %s: refused, no supplier payable or receivable, nothing written",
    async (route) => {
      const s = await seedDealer();
      const fixture = await legacyFinancedDraft(s, { appStatus: "CANCELLED", route });
      expect(
        (await s.t.run((ctx) => ctx.db.get(fixture.vehicleId)))?.sourceType,
        "precondition: a consigned car"
      ).toBe("SOURCED");
      expect((await s.t.run((ctx) => ctx.db.get(fixture.saleId)))?.supplierSettlementRoute).toBe(route);
      await expectRefusedAndNothingWritten(s, fixture);
    }
  );
});

describe("(c) positive control: finalizeDeal still completes a FINANCED sale through its door", () => {
  test("a configured-finance-company deal finalizes to a COMPLETED FINANCED sale carrying its application", async () => {
    const s = await seedDealer();
    const vehicleId = await vehicleFor(s);
    const customerStatusId = await s.t.run((ctx) =>
      ctx.db.insert("orgCustomerStatuses", { orgId: s.orgId, label: "Eligible", isActive: true, order: 1 })
    );
    const companyId = await s.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: s.orgId,
        name: "Jordan Auto Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        adminFees: 0,
        defaultLtvPercent: 100,
      })
    );
    const { asUser, asApprover, orgId } = s;
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId: s.customerId,
      vehicleId,
      vehiclePrice: 20_000,
      downPayment: 3_000,
      termMonths: 48,
      mode: "CONFIGURED_FINANCE_COMPANY",
      companyId,
      customerEligibilityStatusIds: [customerStatusId],
      totalFinancedAmount: 17_000,
    });
    await asUser.mutation(api.deposits.create, {
      method: "CASH",
      idempotencyKey: crypto.randomUUID(),
      orgId,
      quoteId,
      amount: 3_000,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
    await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId,
      applicationId,
      submittedQuotationMinor: 20_000_000,
      source: "MANUAL_ENTRY",
    });
    await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId,
      applicationId,
      approvedAmountMinor: 20_000_000,
      basis: "MANUAL",
      notes: "Approved at the quotation.",
    });
    await registerHandover(asUser, api, orgId, applicationId);
    await asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "BANK_TRANSFER",
      expectedDate: Date.now(),
    });
    await asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId,
      applicationId,
      legalInvoiceAmountMinor: 20_000_000,
      legalInvoiceNumber: `INV-${applicationId}`,
      legalInvoiceDate: Date.now(),
      issuedTo: "FINANCE_COMPANY",
    });
    const feeId = await asUser.mutation(api.financeDealCosts.recordDealFee, {
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
      orgId,
      applicationId,
      feeType: "OTHER_CLOSING_EXPENSE",
      paidBy: "DEALER",
      paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE",
      deductedFromSettlement: false,
      actualAmountMinor: 0,
      description: "The dealership bore no closing costs on this deal.",
    });
    await asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId, feeId, notes: "Nothing to match." });

    const saleId = await asUser.mutation(api.applications.finalizeDeal, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      applicationId,
    });

    const sale = await s.t.run((ctx) => ctx.db.get(saleId as Id<"sales">));
    expect(sale?.status).toBe("COMPLETED");
    expect(sale?.financingType, "precondition: the sale really is FINANCED").toBe("FINANCED");
    expect(sale?.applicationId).toBe(applicationId);
    expect((await s.t.run((ctx) => ctx.db.get(vehicleId)))?.status).toBe("SOLD");
  });
});

describe("(d) CASH controls: nothing about CASH completion changed", () => {
  test("a CASH draft completes through completeDraft", async () => {
    const s = await seedDealer();
    const vehicleId = await vehicleFor(s);
    const saleId = await s.asUser.mutation(api.sales.createDraft, {
      orgId: s.orgId,
      vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 20_000,
      saleDate: Date.now(),
    });
    await s.asUser.mutation(api.sales.completeDraft, {
      idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      saleId,
    });
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("COMPLETED");
    expect((await s.t.run((ctx) => ctx.db.get(vehicleId)))?.status).toBe("SOLD");
  });

  test("a CASH quote completes through completeFromQuote", async () => {
    const s = await seedDealer();
    const vehicleId = await vehicleFor(s);
    const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
      orgId: s.orgId,
      customerId: s.customerId,
      vehicleId,
      vehicleItems: [{ vehicleId, unitPrice: 20_000 }],
      mode: "CASH" as const,
      vehiclePrice: 20_000,
      downPayment: 0,
      termMonths: 0,
    });
    const saleIds = await s.asUser.mutation(api.sales.completeFromQuote, {
      idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      quoteId,
    });
    expect(saleIds).toHaveLength(1);
    expect((await s.t.run((ctx) => ctx.db.get(vehicleId)))?.status).toBe("SOLD");
  });
});

describe("(e) completeSale itself: the door must name the sale's own application", () => {
  /** Every FINANCED argument set below differs only in the door; the sale row is never reached by the refusal. */
  async function financedArgs(s: Seed) {
    const vehicleId = await vehicleFor(s);
    const own = await applicationRow(s, vehicleId, "APPROVED");
    const other = await applicationRow(s, vehicleId, "APPROVED");
    return {
      vehicleId,
      own: own.applicationId,
      other: other.applicationId,
      args: {
        orgId: s.orgId,
        vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 20_000,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
        financingType: "FINANCED" as const,
        downPayment: 3_000,
        loanAmount: 17_000,
        termMonths: 48,
        applicationId: own.applicationId,
        quoteId: own.quoteId,
        idempotencyKey: crypto.randomUUID(),
        actorId: s.userId,
      },
    };
  }

  test("a door for a DIFFERENT application is refused and nothing is written", async () => {
    const s = await seedDealer();
    const f = await financedArgs(s);
    const before = await snapshot(s, undefined, f.vehicleId);
    await expectFinancedSaleRequiresDeal(
      s.t.run((ctx) => completeSale(ctx, f.args, { kind: "FINANCE_FINALIZATION", applicationId: f.other }))
    );
    expect(await snapshot(s, undefined, f.vehicleId)).toEqual(before);
  });

  test("a door of an unknown kind naming the sale's own application is refused (runtime guard past the type)", async () => {
    const s = await seedDealer();
    const f = await financedArgs(s);
    const forged = { kind: "SOMETHING_ELSE", applicationId: f.own } as unknown as Parameters<typeof completeSale>[2];
    await expectFinancedSaleRequiresDeal(s.t.run((ctx) => completeSale(ctx, f.args, forged)));
    expect((await s.t.run((ctx) => ctx.db.get(f.vehicleId)))?.status).toBe("AVAILABLE");
  });

  test("a forged door with no applicationId on a FINANCED sale with no applicationId is refused (undefined must not equal undefined)", async () => {
    const s = await seedDealer();
    const f = await financedArgs(s);
    const forged = { kind: "FINANCE_FINALIZATION", applicationId: undefined } as unknown as Parameters<
      typeof completeSale
    >[2];
    await expectFinancedSaleRequiresDeal(
      s.t.run((ctx) => completeSale(ctx, { ...f.args, applicationId: undefined }, forged))
    );
    expect((await s.t.run((ctx) => ctx.db.get(f.vehicleId)))?.status).toBe("AVAILABLE");
  });

  test("no door at all is refused for a FINANCED sale that names an application", async () => {
    const s = await seedDealer();
    const f = await financedArgs(s);
    await expectFinancedSaleRequiresDeal(s.t.run((ctx) => completeSale(ctx, f.args)));
    expect((await s.t.run((ctx) => ctx.db.get(f.vehicleId)))?.status).toBe("AVAILABLE");
  });
});

describe("(f) precedence: a retired mode is refused as retired, before the door check", () => {
  test("a legacy LEASE draft carrying an application is refused with DEAL_MODE_RETIRED", async () => {
    const s = await seedDealer();
    const fixture = await legacyFinancedDraft(s, { appStatus: "CANCELLED" });
    await s.t.run((ctx) => ctx.db.patch(fixture.saleId, { financingType: "LEASE" as const }));
    await expectAppError(
      s.asUser.mutation(api.sales.completeDraft, {
        idempotencyKey: crypto.randomUUID(),
        orgId: s.orgId,
        saleId: fixture.saleId,
      }),
      "DEAL_MODE_RETIRED",
      RETIRED_DEAL_MODE_MESSAGE
    );
    expect((await s.t.run((ctx) => ctx.db.get(fixture.saleId)))?.status).toBe("PENDING");
  });
});
