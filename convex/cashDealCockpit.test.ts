/**
 * The deal screen for a sale that was NOT financed.
 *
 * SCRUM-29 put a cash deal and a financed deal on one screen. The operational
 * spine is shared deliberately; the money is not, and these tests exist mostly
 * to hold that line. A cash deal's profit is an ordinary accounting result with
 * a journal behind it. The financed screen's headline is a management figure
 * built on a spread that appears on no invoice. Showing either one wearing the
 * other's label is a financial misstatement, and it is the failure mode this
 * whole design is shaped around.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
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

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const FULL_PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "manage:finance", "view:finance", "view:reports",
];

/** Everything except `view:finance` — the salesperson who may not see margins. */
const NO_FINANCE_PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "view:customers",
];

const OWNED_PRICE = 8_000;
const OWNED_COST = 6_000;

const CONSIGNED_PRICE = 20_000;
const ENTITLEMENT = 17_000;
const MARGIN = CONSIGNED_PRICE - ENTITLEMENT;

/** JOD is a three-decimal currency; a hardcoded ×100 would be a 10x error. */
const SCALE = 1_000;

async function seed(tag: string, perms: string[] = FULL_PERMS) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Cash ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Laith" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Role", permissions: perms,
      // NOT a system owner: that role bypasses the finance gate by design, so a
      // fixture using it could never demonstrate the gate working.
      isSystemOwnerRole: false,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  return { t, orgId, userId, asUser, customerId };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function ownedVehicle(s: Seeded, vin: string) {
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin, make: "Kia", model: "Rio", year: 2023, mileage: 5,
      color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: OWNED_PRICE,
      status: "AVAILABLE", sourceType: "STOCK", purchasePrice: OWNED_COST,
    })
  );
}

async function consignedVehicle(s: Seeded, vin: string) {
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: CONSIGNED_PRICE,
      status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
    })
  );
}

/**
 * Inserted directly rather than through `sales.create`, so each test states the
 * exact row shape it is about — including the ones a mutation would refuse to
 * produce, which is where the interesting reader behaviour lives.
 */
async function insertSale(
  s: Seeded,
  vehicleId: Id<"vehicles">,
  fields: Record<string, unknown> = {}
) {
  return await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: OWNED_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
      ...fields,
    } as never)
  );
}

describe("who can open a cash deal at all", () => {
  test("a sale in another org is indistinguishable from one that does not exist", async () => {
    const mine = await seed("own");
    const theirs = await seed("other");
    const vehicleId = await ownedVehicle(theirs, "OTHERORG00000001");
    const foreignSale = await insertSale(theirs, vehicleId);

    // Same `null` as a missing id, so this screen cannot be used to discover
    // which ids are real.
    expect(
      await mine.asUser.query(api.sales.dealCockpit, {
        orgId: mine.orgId,
        saleId: foreignSale,
      })
    ).toBeNull();
  });

  test("a soft-deleted sale reads as not found", async () => {
    const s = await seed("del");
    const vehicleId = await ownedVehicle(s, "DELETED000000001");
    const saleId = await insertSale(s, vehicleId, { isDeleted: true });

    expect(
      await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId })
    ).toBeNull();
  });

  test("a caller without view:finance gets the deal and none of the money", async () => {
    const s = await seed("nofin", NO_FINANCE_PERMS);
    const vehicleId = await ownedVehicle(s, "NOFINANCE0000001");
    const saleId = await insertSale(s, vehicleId);

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });

    // The deal itself is readable — a salesperson follows their own deal.
    expect(deal).not.toBeNull();
    expect(deal!.stages.length).toBeGreaterThan(0);
    // The money is withheld by the SERVER, not hidden by the component.
    expect(deal!.money).toBeNull();
  });
});

describe("the cash headline is an ACCOUNTING result, and says so", () => {
  test("an owned cash sale reports price less cost, postable, with no estimate qualifier", async () => {
    const s = await seed("owned");
    const vehicleId = await ownedVehicle(s, "OWNEDCASH0000001");
    const saleId = await insertSale(s, vehicleId);

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const profit = deal!.money!.profit;

    expect(profit.available).toBe(true);
    if (!profit.available) throw new Error("unreachable");

    expect(profit.basis).toBe("ACCOUNTING_RESULT");
    // The whole point: this figure HAS a journal behind it.
    expect(profit.postable).toBe(true);
    expect(profit.amountMinor).toBe((OWNED_PRICE - OWNED_COST) * SCALE);
    // And it carries no financed-only classification to render as a caveat.
    expect("classification" in profit).toBe(false);
  });

  test("a consigned cash sale reports the agency margin, not the sale price", async () => {
    const s = await seed("consigned");
    const vehicleId = await consignedVehicle(s, "CONSIGNCASH00001");
    const saleId = await insertSale(s, vehicleId, {
      salePrice: CONSIGNED_PRICE,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      consignedMarginMinor: MARGIN * SCALE,
      consignedSupplierEntitlementMinor: ENTITLEMENT * SCALE,
      consignedMarginCurrency: "JOD",
    });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const profit = deal!.money!.profit;

    if (!profit.available) throw new Error("expected a profit");
    // 3,000 — what the dealership earned. NOT 20,000, which is the size of the
    // deal it arranged with a car it never owned.
    expect(profit.amountMinor).toBe(MARGIN * SCALE);
    expect(profit.postable).toBe(true);
  });

  test("a cancelled sale reports no profit rather than the figure its reversed journal once had", async () => {
    const s = await seed("cancel");
    const vehicleId = await ownedVehicle(s, "CANCELLED0000001");
    const saleId = await insertSale(s, vehicleId, { status: "CANCELLED" });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const profit = deal!.money!.profit;

    expect(profit.available).toBe(false);
    if (profit.available) throw new Error("unreachable");
    expect(profit.reason).toBe("DealCancelled");
  });
});

describe("a financed sale never publishes a SECOND profit here", () => {
  /**
   * The sharpest edge in SCRUM-29.
   *
   * `sales.applicationId` is set on every financed deal once it finalizes, so
   * this route can be opened on one. If it answered normally, that deal would
   * show `NetDealershipProfit` as the POSTABLE accounting margin while
   * `/applications/[id]/deal` shows the same label carrying the UNPOSTABLE
   * management figure — two owner-facing profit numbers for one deal, under one
   * label. This fails closed instead.
   */
  test("the money is withheld and the caller is told where the deal lives", async () => {
    const s = await seed("financed");
    const vehicleId = await consignedVehicle(s, "FINANCEDSALE0001");

    const quoteId = await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: s.orgId, customerId: s.customerId, vehicleId,
        vehiclePrice: CONSIGNED_PRICE, downPayment: 0, termMonths: 60,
        status: "ACCEPTED", createdBy: s.userId, createdAt: Date.now(),
      } as never)
    );
    const applicationId = await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: s.orgId, customerId: s.customerId, vehicleId, quoteId,
        salespersonId: s.userId, status: "APPROVED",
        createdAt: Date.now(), updatedAt: Date.now(),
      } as never)
    );
    const saleId = await insertSale(s, vehicleId, {
      salePrice: CONSIGNED_PRICE,
      financingType: "FINANCED",
      applicationId,
      consignedMarginMinor: MARGIN * SCALE,
      consignedSupplierEntitlementMinor: ENTITLEMENT * SCALE,
      consignedMarginCurrency: "JOD",
    });

    // A caller with FULL finance permission — so this is not the permission gate
    // doing the work. There is simply no second profit for this deal.
    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });

    expect(deal!.money).toBeNull();
    expect(deal!.financingApplicationId).toBe(applicationId);
    expect(deal!.dealKind).toBe("FINANCED");
  });
});

describe("the cash rail is shorter, and never permanently grey", () => {
  test("a cash deal has three stages and none of the finance-company ones", async () => {
    const s = await seed("rail");
    const vehicleId = await ownedVehicle(s, "CASHRAIL00000001");
    const saleId = await insertSale(s, vehicleId);

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const keys = deal!.stages.map((stage) => stage.key);

    expect(keys).toEqual(["SALE_AGREED", "HANDOVER", "SETTLEMENT"]);
    // Absent, not present-and-inactive. A permanently grey stage teaches
    // operators that grey means ignore, and this rail carries real blockers.
    expect(keys).not.toContain("CREDIT_DECISION");
    expect(keys).not.toContain("APPRAISAL");
    expect(keys).not.toContain("GAP_RESOLUTION");
    expect(keys).not.toContain("APPROVED_PURCHASE");
  });

  test("an owned cash sale that is completed is finished — nothing left owing", async () => {
    const s = await seed("done");
    const vehicleId = await ownedVehicle(s, "CASHDONE00000001");
    const saleId = await insertSale(s, vehicleId);

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });

    // There is no third party to settle with on dealership-owned stock.
    expect(deal!.stages.every((stage) => stage.state === "COMPLETE")).toBe(true);
    expect(deal!.money!.parties).toEqual([]);
  });

  test("a pending sale is CURRENT at handover, not blocked and not finished", async () => {
    const s = await seed("pending");
    const vehicleId = await ownedVehicle(s, "CASHPEND00000001");
    const saleId = await insertSale(s, vehicleId, { status: "PENDING" });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const byKey = Object.fromEntries(deal!.stages.map((stage) => [stage.key, stage.state]));

    expect(byKey.SALE_AGREED).toBe("COMPLETE");
    expect(byKey.HANDOVER).toBe("CURRENT");
    expect(byKey.SETTLEMENT).toBe("PENDING");
  });

  test("a cancelled sale STOPS the rail rather than leaving it pending", async () => {
    const s = await seed("stopped");
    const vehicleId = await ownedVehicle(s, "CASHSTOP00000001");
    const saleId = await insertSale(s, vehicleId, { status: "CANCELLED" });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const byKey = Object.fromEntries(deal!.stages.map((stage) => [stage.key, stage.state]));

    // PENDING would invite an operator to work a dead deal.
    expect(byKey.HANDOVER).toBe("STOPPED");
  });
});

describe("a consigned cash deal's supplier row, and UNKNOWN never reading as settled", () => {
  test("a consigned sale with no claim record keeps the settlement stage OPEN", async () => {
    const s = await seed("noclaim");
    const vehicleId = await consignedVehicle(s, "NOCLAIM000000001");
    const saleId = await insertSale(s, vehicleId, {
      salePrice: CONSIGNED_PRICE,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      consignedMarginMinor: MARGIN * SCALE,
      consignedSupplierEntitlementMinor: ENTITLEMENT * SCALE,
      consignedMarginCurrency: "JOD",
    });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const settlement = deal!.stages.find((stage) => stage.key === "SETTLEMENT");
    const supplier = deal!.money!.parties.find((party) => party.party === "SUPPLIER");

    // Missing evidence is not proof of settlement. Reporting this deal finished
    // because no claim row was found would close it on an absent record.
    expect(settlement!.state).not.toBe("COMPLETE");
    expect(supplier!.position).toBe("UNKNOWN");
  });

  test("an open claim shows the supplier owing the dealership its margin", async () => {
    const s = await seed("openclaim");
    const vehicleId = await consignedVehicle(s, "OPENCLAIM0000001");
    const saleId = await insertSale(s, vehicleId, {
      salePrice: CONSIGNED_PRICE,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      consignedMarginMinor: MARGIN * SCALE,
      consignedSupplierEntitlementMinor: ENTITLEMENT * SCALE,
      consignedMarginCurrency: "JOD",
    });
    await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId, vehicleId, saleId,
        sourcedFromName: "Amman Importer Co",
        amountDue: MARGIN, currency: "JOD", status: "OPEN",
        createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const supplier = deal!.money!.parties.find((party) => party.party === "SUPPLIER");

    // He holds the dealership's margin on this route and owes it back.
    expect(supplier!.position).toBe("OWED_TO_DEALERSHIP");
    expect(supplier!.amountMinor).toBe(MARGIN * SCALE);
    // The collection action is keyed to the claim the SERVER resolved, so the
    // client never names a receivable of its own choosing.
    expect(supplier!.receivableId).toBeTruthy();
  });

  test("a fully collected claim reads SETTLED and finishes the rail", async () => {
    const s = await seed("paidclaim");
    const vehicleId = await consignedVehicle(s, "PAIDCLAIM0000001");
    const saleId = await insertSale(s, vehicleId, {
      salePrice: CONSIGNED_PRICE,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      consignedMarginMinor: MARGIN * SCALE,
      consignedSupplierEntitlementMinor: ENTITLEMENT * SCALE,
      consignedMarginCurrency: "JOD",
    });
    await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId, vehicleId, saleId,
        sourcedFromName: "Amman Importer Co",
        amountDue: MARGIN, amountReceived: MARGIN, currency: "JOD", status: "PAID",
        createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const settlement = deal!.stages.find((stage) => stage.key === "SETTLEMENT");
    const supplier = deal!.money!.parties.find((party) => party.party === "SUPPLIER");

    expect(supplier!.position).toBe("SETTLED");
    expect(settlement!.state).toBe("COMPLETE");
  });

  test("a claim in another currency is UNKNOWN, not a zero balance", async () => {
    const s = await seed("fxclaim");
    const vehicleId = await consignedVehicle(s, "FXCLAIM000000001");
    const saleId = await insertSale(s, vehicleId, {
      salePrice: CONSIGNED_PRICE,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      consignedMarginMinor: MARGIN * SCALE,
      consignedSupplierEntitlementMinor: ENTITLEMENT * SCALE,
      consignedMarginCurrency: "JOD",
    });
    await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId, vehicleId, saleId,
        sourcedFromName: "Amman Importer Co",
        // A balance in a currency this screen cannot state.
        amountDue: MARGIN, currency: "USD", status: "OPEN",
        createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const supplier = deal!.money!.parties.find((party) => party.party === "SUPPLIER");
    const settlement = deal!.stages.find((stage) => stage.key === "SETTLEMENT");

    // Rendering "owes 0" would report a real debt as settled.
    expect(supplier!.position).toBe("UNKNOWN");
    expect(settlement!.state).not.toBe("COMPLETE");
  });
});
