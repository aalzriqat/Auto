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
  test("an owned cash sale reports price less cost, reconciling to the ledger, with no estimate qualifier", async () => {
    const s = await seed("owned");
    const vehicleId = await ownedVehicle(s, "OWNEDCASH0000001");
    const saleId = await insertSale(s, vehicleId);

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const profit = deal!.money!.profit;

    expect(profit.available).toBe(true);
    if (!profit.available) throw new Error("unreachable");

    expect(profit.basis).toBe("ACCOUNTING_RESULT");
    // The whole point: this figure HAS a journal behind it.
    expect(profit.reconcilesToLedger).toBe(true);
    expect(profit.amountMinor).toBe((OWNED_PRICE - OWNED_COST) * SCALE);
    // And it carries no financed-only classification to render as a caveat.
    expect("classification" in profit).toBe(false);
    /**
     * And it does NOT claim to be postable.
     *
     * "This agrees with the books" and "this is an instruction to post" are
     * different claims, and only the first is true of a derived read: the journal
     * was written by `completeSale` long before anyone asked for a headline, and
     * nothing posts from this object. A field named `postable: true` invites a
     * future caller to treat it as a posting source, so `postable` lives on the
     * FINANCED arm only, as a one-way prohibition.
     *
     * Asserted as absence rather than by value so re-adding it fails here.
     */
    expect("postable" in profit).toBe(false);
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
    expect(profit.reconcilesToLedger).toBe(true);
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

describe("the rail and the headline never disagree about whether a deal is consigned", () => {
  /**
   * A hard-deleted vehicle is the threat model this codebase already documents:
   * reachable through the `/admin` raw-JSON editor, and the reason
   * `saleEconomics` accepts `vehicle: null` and falls back to the SALE's own
   * evidence — a recorded margin, a direct settlement route, or a surviving
   * frozen entitlement — to decide the deal was consigned.
   *
   * The cockpit used a narrower rule (`vehicle ? isConsignedAgentSale(vehicle)
   * : false`), so the two disagreed exactly here: the headline reported a real
   * agency margin while the rail reported the deal fully settled and the
   * supplier row vanished — hiding an open claim for money the supplier still
   * owes. Found independently by the primary agent and an adversarial reviewer.
   */
  test("a hard-deleted consigned vehicle does not silently settle an open supplier claim", async () => {
    const s = await seed("ghost");
    const vehicleId = await consignedVehicle(s, "GHOSTVEHICLE0001");
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
        // Still entirely uncollected.
        amountDue: MARGIN, currency: "JOD", status: "OPEN",
        createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    // The vehicle row disappears; the sale's frozen evidence survives.
    await s.t.run((ctx) => ctx.db.delete(vehicleId));

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const settlement = deal!.stages.find((stage) => stage.key === "SETTLEMENT");
    const supplier = deal!.money!.parties.find((party) => party.party === "SUPPLIER");

    // The claim is open, so the deal is not settled and the supplier must appear.
    expect(settlement!.state).not.toBe("COMPLETE");
    expect(supplier).toBeTruthy();
    expect(supplier!.position).toBe("OWED_TO_DEALERSHIP");
  });
});

describe("an unreadable figure never renders as a zero line", () => {
  /**
   * On an agent sale carrying a recorded margin, the HEADLINE does not depend on
   * `sale.salePrice` at all — `saleEconomics` reads the frozen margin. So a
   * corrupt `salePrice` leaves a perfectly valid, ledger-reconciling headline sitting
   * above a breakdown line claiming the car sold for nothing.
   *
   * Convex accepts `NaN` under a `v.number()` validator, so this arrives from
   * the raw-JSON editor looking valid. `toMinorSameCurrencyOrUndefined`
   * correctly refuses it; the defect was the `?? 0` that turned that refusal
   * into a confident zero on an owner-facing financial screen.
   */
  test("a corrupt sale price does not print 'sale price: 0' beside a valid margin", async () => {
    const s = await seed("nanprice");
    const vehicleId = await consignedVehicle(s, "NANPRICE00000001");
    const saleId = await insertSale(s, vehicleId, {
      salePrice: Number.NaN,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      consignedMarginMinor: MARGIN * SCALE,
      consignedSupplierEntitlementMinor: ENTITLEMENT * SCALE,
      consignedMarginCurrency: "JOD",
    });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const profit = deal!.money!.profit;

    if (!profit.available) throw new Error("expected the frozen margin to still carry the headline");
    // The headline is intact — it came from the frozen margin.
    expect(profit.amountMinor).toBe(MARGIN * SCALE);
    // ...and no line may assert the car sold for nothing.
    //
    // Asserted as ABSENCE of the whole breakdown, not as `?.amountMinor !== 0`.
    // That earlier form passed when the line was MISSING — `undefined !== 0` —
    // so it would equally have passed against a breakdown full of garbage. An
    // unreadable sale price makes every line unverifiable, so the all-or-nothing
    // rule drops the breakdown entirely rather than printing a partial one.
    expect(profit.lines).toEqual([]);
    expect(profit.lines.some((line) => line.key === "SALE_PRICE")).toBe(false);
  });

  /**
   * The lines exist to EXPLAIN the headline. A breakdown that does not add up to
   * the figure above it is worse than no breakdown at all.
   */
  test("the breakdown always reconciles to the headline, or is not shown", async () => {
    const s = await seed("reconcile");
    const vehicleId = await consignedVehicle(s, "RECONCILE0000001");
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

    // The POSITIVE path, asserted explicitly. A reviewer mutated
    // `lines: reconciles ? lines : []` to an unconditional `[]` — a total
    // regression where no deal ever shows its breakdown — and all 21 tests
    // still passed, because every assertion about lines was guarded by
    // `if (lines.length > 0)` and so held vacuously. A well-formed consigned
    // sale MUST produce a breakdown.
    expect(profit.lines.length).toBeGreaterThan(0);
    const sum = profit.lines.reduce((total, line) => total + line.sign * line.amountMinor, 0);
    expect(sum).toBe(profit.amountMinor);
  });
});

describe("a sale financed WITHOUT an application", () => {
  /**
   * `sales.create` accepts `financingType: "FINANCED" | "LEASE"` and has no
   * `applicationId` field at all, so these rows are ordinary. Deriving the deal
   * kind from `applicationId` alone labelled them CASH and titled them "Sale".
   */
  test("is labelled FINANCED even with no application", async () => {
    const s = await seed("nofapp");
    const vehicleId = await ownedVehicle(s, "FINNOAPP00000001");
    const saleId = await insertSale(s, vehicleId, { financingType: "FINANCED" });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });

    expect(deal!.dealKind).toBe("FINANCED");
    // No application exists, so there is no OTHER screen holding a management
    // figure — nothing is being hidden and nothing can be confused. The money
    // is therefore shown, and it is a genuine accounting result.
    expect(deal!.financingApplicationId).toBeNull();
    const profit = deal!.money!.profit;
    if (!profit.available) throw new Error("expected a profit for an owned financed sale");
    expect(profit.basis).toBe("ACCOUNTING_RESULT");
    expect(profit.reconcilesToLedger).toBe(true);
  });

  /**
   * The genuinely dangerous shape: consigned + DIRECT_TO_SUPPLIER + externally
   * financed. There `salePrice − entitlement` reaches no party, so the earning
   * cannot be derived from the sale price. The write path refuses to CREATE
   * this (`FINANCED_DIRECT_NEEDS_APPROVED_AMOUNT`); this proves the READ path
   * also refuses, which is what protects rows that predate that guard.
   */
  /**
   * The counterexample an adversarial reviewer produced AFTER I had rejected
   * the weaker form of this claim — and it was right.
   *
   * I had checked that the dangerous shape could not be CREATED (the write path
   * refuses it since SCRUM-30) and failed to check whether it could already
   * EXIST. `sales.create` accepts `financingType` and `supplierSettlementRoute`
   * together, and the write guard only arrived on 2026-08-11, so a row completed
   * before it can carry `consignedMarginMinor` frozen at the SALE-PRICE spread.
   *
   * `saleEconomics` returns a recorded margin unconditionally — its
   * recorded-margin branch is checked before the evidence rule — so this row
   * would have published a POSTABLE 5,000 for a deal that earned 3,000: the
   * financier pays the supplier what it APPROVED (18,000), so the earning is
   * 18,000 − 15,000, and 20,000 − 15,000 reaches nobody.
   */
  test("refuses a LEGACY financed DIRECT row whose frozen margin is the sale-price spread", async () => {
    const s = await seed("legacyfd");
    const vehicleId = await consignedVehicle(s, "LEGACYFINDIR0001");
    const saleId = await insertSale(s, vehicleId, {
      salePrice: CONSIGNED_PRICE, // 20,000
      financingType: "FINANCED",
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      // What a pre-guard completion froze: salePrice − entitlement = 5,000.
      // The real earning was approved (18,000) − entitlement (15,000) = 3,000.
      consignedMarginMinor: (CONSIGNED_PRICE - ENTITLEMENT) * SCALE,
      consignedSupplierEntitlementMinor: ENTITLEMENT * SCALE,
      consignedMarginCurrency: "JOD",
    });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const profit = deal!.money!.profit;

    // Withheld, not published. Nothing on this row can prove what the finance
    // company approved, and 5,000 overstates the deal by 2,000.
    expect(profit.available).toBe(false);
    if (profit.available) throw new Error("unreachable");
    expect(profit.reason).toBe("FinancedDirectUnverified");
  });

  test("refuses the headline on a financed DIRECT consigned row with no recorded margin", async () => {
    const s = await seed("findirect");
    const vehicleId = await consignedVehicle(s, "FINDIRECT0000001");
    const saleId = await insertSale(s, vehicleId, {
      salePrice: CONSIGNED_PRICE,
      financingType: "FINANCED",
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      // No consignedMarginMinor: the frozen evidence is absent.
    });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const profit = deal!.money!.profit;

    // Never the sale-price spread, which reaches nobody on this route.
    expect(profit.available).toBe(false);
    if (profit.available) throw new Error("unreachable");
    // `FinancedDirectUnverified` rather than `UnknownMargin`: the route-level
    // guard fires before the margin is consulted at all, and it names the actual
    // reason — the approved amount is unrecorded — instead of the symptom.
    // Both are refusals; this one tells the operator what is missing.
    expect(profit.reason).toBe("FinancedDirectUnverified");
  });
});

describe("a draft has no journal, so it has nothing to reconcile against", () => {
  /**
   * `reconcilesToLedger: true` is a claim that a journal exists. `createDraftSale`
   * performs no accounting side effects, so on a PENDING sale that claim is
   * false — the same class of false statement as dropping the qualifier from
   * the financed figure, in the opposite direction.
   */
  test("a PENDING sale reports no accounting profit rather than an unposted one", async () => {
    const s = await seed("draftprofit");
    const vehicleId = await ownedVehicle(s, "DRAFTPROFIT00001");
    const saleId = await insertSale(s, vehicleId, { status: "PENDING" });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });
    const profit = deal!.money!.profit;

    expect(profit.available).toBe(false);
    if (profit.available) throw new Error("unreachable");
    expect(profit.reason).toBe("SaleNotCompleted");
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

/**
 * The status history has to read forwards — as a STATE SEQUENCE, not as a
 * timestamp sort.
 *
 * `saleDate` is caller-supplied and routinely BACK-DATED: a dealership
 * recording on Tuesday a sale that happened last week enters a `saleDate`
 * earlier than the row's own `_creationTime`. An earlier round "fixed" that by
 * sorting on `changedAt`, which produced `COMPLETED -> PENDING` — a completed
 * deal whose history ends in "pending".
 *
 * The first version of this test asserted monotonically increasing `changedAt`
 * and so PASSED against that broken output, because it asserted the property
 * that had been implemented rather than the property that matters. It now
 * asserts the status sequence itself.
 */
describe("the cash timeline", () => {
  test("a back-dated sale still reads pending -> completed", async () => {
    const s = await seed("backdated");
    const vehicleId = await ownedVehicle(s, "BACKDATED0000001");
    // A week before the row exists — the ordinary case, not a corrupt one.
    const saleId = await insertSale(s, vehicleId, {
      saleDate: Date.now() - 7 * 24 * 60 * 60 * 1000,
    });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });

    expect(deal!.timeline.map((entry) => entry.toStatus)).toEqual(["PENDING", "COMPLETED"]);
  });

  /**
   * An unreadable moment must not take the screen down with it.
   *
   * Convex's `v.number()` accepts NaN, so a corrupt `saleDate` is stored
   * verbatim. The view renders every entry through date-fns `format`, which
   * throws `RangeError: Invalid time value` on a non-finite input — and an
   * uncaught throw during render loses the WHOLE deal screen, not one row.
   */
  test.each([
    ["NaN", Number.NaN, "NANDATE000000001"],
    ["Infinity", Number.POSITIVE_INFINITY, "INFDATE000000001"],
  ])(
    "a %s sale date withholds the moment but keeps the transition",
    async (_label, badDate, vin) => {
      const s = await seed(`baddate${vin}`);
      const vehicleId = await ownedVehicle(s, vin);
      const saleId = await insertSale(s, vehicleId, { saleDate: badDate });

      const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });

      // The transition SURVIVES. Dropping it produced a screen that badged the
      // sale COMPLETED while its own history stopped at PENDING.
      expect(deal!.timeline.map((entry) => entry.toStatus)).toEqual(["PENDING", "COMPLETED"]);

      // Only the unreadable moment is withheld — and every moment that IS
      // emitted must be renderable, because date-fns `format` throws
      // `RangeError` on a non-finite input and that throw loses the screen.
      const completed = deal!.timeline.find((entry) => entry.toStatus === "COMPLETED");
      expect(completed!.changedAt).toBeUndefined();
      for (const entry of deal!.timeline) {
        if (entry.changedAt !== undefined) {
          expect(Number.isFinite(entry.changedAt)).toBe(true);
        }
      }
    }
  );

  /**
   * No CANCELLED entry is emitted, and the honest reason is narrower than the
   * one first written here.
   *
   * A real cancellation moment IS captured in the system — `sales.update`
   * stamps one onto the reversal records it writes — but it is never persisted
   * onto the sale row this query reads, and a cancelled PENDING sale has no
   * reversal records at all, so for that case no moment exists anywhere.
   * Emitting an entry would mean inventing a time for some deals and guessing
   * for others. Surfacing it honestly needs a persisted `cancelledAt`, which is
   * a schema change and a tracked follow-up.
   *
   * This pins that the screen still SAYS the deal is cancelled — via the status
   * and the headline's refusal — rather than going quiet about it.
   */
  test("a cancelled sale is reported by the headline, not by a fabricated entry", async () => {
    const s = await seed("cancelled");
    const vehicleId = await ownedVehicle(s, "CANCELLED0000001");
    const saleId = await insertSale(s, vehicleId, { status: "CANCELLED" });

    const deal = await s.asUser.query(api.sales.dealCockpit, { orgId: s.orgId, saleId });

    expect(deal!.status).toBe("CANCELLED");
    expect(deal!.timeline.some((entry) => entry.toStatus === "CANCELLED")).toBe(false);
    const profit = deal!.money!.profit;
    if (profit.available) throw new Error("a cancelled deal must not publish a headline");
    expect(profit.reason).toBe("DealCancelled");
  });
});
