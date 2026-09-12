/**
 * SCRUM-319 — a deal's cost lines are denominated once, and every write that
 * touches them has to say which currency it is counting in.
 *
 * The defect (executed on the unfixed code, 2026-09-12): a JOD org records a
 * 150.000 JOD licensing estimate on a deal with no economics pin, switches the
 * organization to USD through `orgSettings.upsert` (allowed — deal costs were
 * not on the lock's list), and `listDealCosts` then publishes `currency: USD`
 * over a JOD row (150,000 minor units read as 1,500.00 USD) while the next
 * actual, entered as 150 USD = 15,000, is patched onto the JOD row as 15.000
 * JOD. Nothing refused, nothing noticed, and the row feeds settlement.
 *
 * The contract proven here (owner-proxy c19454):
 *  1. the settings lock covers finance applications, deal costs and custody;
 *  2. `recordDealFee` / `recordActualFeeAmount` REQUIRE `expectedCurrency`,
 *     validated against server authority before any write — CREATE against the
 *     deal's proven denomination, EDIT against the row's stored one, never
 *     relabelling; a mismatch commits nothing;
 *  3. the CREATE fingerprint covers the whole persisted payload (AF-215-02);
 *  4. no scalar total is published over mixed currencies, and settlement
 *     deductions refuse a foreign line.
 *
 * Evidence boundary: convex-test only — repository behaviour, not the Convex
 * runtime and not production data. Concurrency (a settings change racing the
 * first cost) is NOT provable here; the rehearsal case FD2 exercises it on a
 * real preview with its own honest scope.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { settlementDeductedActualMinor } from "./utils/settlementDeductions";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "view:finance", "manage:finance", "view:settings", "edit:settings",
];

const VEHICLE_PRICE = 20_000;
const JOD_SCALE = 1_000;
const USD_SCALE = 100;

async function seedOrg(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `S319 ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );
  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  // A second member to hold custody: it cannot be issued to the person issuing it.
  const employeeId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_emp`, email: `${tag}.emp@example.com`, name: "Runner" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: employeeId, roleId }));
  return { t, orgId, userId, employeeId, asUser };
}

/** An unpinned deal: created from a quote, no quotation/approval recorded. */
async function seedDeal(tag: string) {
  const s = await seedOrg(tag);
  const customerId = await s.t.run((ctx) =>
    ctx.db.insert("customers", { orgId: s.orgId, firstName: "Buyer", lastName: tag })
  );
  const vehicleId = await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: `VIN319${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: VEHICLE_PRICE, status: "AVAILABLE",
      sourceType: "STOCK" as const, purchasePrice: 15_000,
    })
  );
  const companyId = await s.t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId: s.orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true, defaultLtvPercent: 100,
    })
  );
  const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId, vehicleId,
    vehiclePrice: VEHICLE_PRICE, downPayment: 0, termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY", companyId, totalFinancedAmount: VEHICLE_PRICE,
  });
  const applicationId = await s.asUser.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  const app0 = await s.t.run((ctx) => ctx.db.get(applicationId));
  expect(app0?.economicsCurrency).toBeUndefined();
  return { ...s, applicationId };
}

type Seeded = Awaited<ReturnType<typeof seedDeal>>;

function addArgs(s: Seeded, intent: string, overrides: Record<string, unknown> = {}) {
  return {
    orgId: s.orgId,
    applicationId: s.applicationId,
    feeType: "OWNERSHIP_TRANSFER" as const,
    description: "Transfer at the licensing department",
    estimatedAmountMinor: 150 * JOD_SCALE,
    paidBy: "DEALER" as const,
    paidTo: "GOVERNMENT" as const,
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" as const,
    source: "MANUAL" as const,
    expectedCurrency: "JOD",
    idempotencyKey: `record-deal-fee:${s.applicationId}:${intent}`,
    ...overrides,
  };
}

async function switchCurrencyViaProduct(s: { asUser: Seeded["asUser"]; orgId: Id<"organizations"> }, currency: "USD" | "JOD" | "KWD") {
  return await s.asUser.mutation(api.orgSettings.upsert, {
    orgId: s.orgId, currency, currencySymbol: currency === "USD" ? "$" : currency === "KWD" ? "KD" : "JD",
  });
}

async function rawSwitchCurrency(s: Seeded, currency: string) {
  await s.t.run(async (ctx) => {
    const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique();
    await ctx.db.patch(settings!._id, { currency, currencySymbol: currency === "USD" ? "$" : "JD" });
  });
}

async function feeRows(s: Seeded): Promise<Array<Doc<"financeDealFees">>> {
  return await s.t.run((ctx) =>
    ctx.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", s.applicationId)).collect()
  );
}

async function overrideRows(s: Seeded) {
  return await s.t.run(async (ctx) => {
    return await ctx.db
      .query("financeApplicationOverrides")
      .withIndex("by_application", (q) => q.eq("applicationId", s.applicationId))
      .collect();
  });
}

async function idempotencyRows(s: Seeded) {
  return await s.t.run((ctx) =>
    ctx.db.query("commandIdempotency").withIndex("by_org_createdAt", (q) => q.eq("orgId", s.orgId)).collect()
  );
}

async function costs(s: Seeded) {
  return await s.asUser.query(api.financeDealCosts.listDealCosts, { orgId: s.orgId, applicationId: s.applicationId });
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return String((error as { data?: unknown })?.data ?? (error as Error)?.message ?? error);
  }
  return "";
}

/** A row written around the mutations — the raw-edited / legacy shape. */
async function rawForeignFee(s: Seeded, currency: string, overrides: Partial<Doc<"financeDealFees">> = {}) {
  return await s.t.run((ctx) =>
    ctx.db.insert("financeDealFees", {
      orgId: s.orgId, applicationId: s.applicationId, feeType: "LICENSING", currency,
      estimatedAmountMinor: 40 * USD_SCALE, paidBy: "DEALER", paidTo: "GOVERNMENT",
      accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", includedInQuotation: false,
      deductedFromSettlement: false, refundable: false, source: "MANUAL",
      createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(), ...overrides,
    })
  );
}

describe("SCRUM-319 — the reported sequence, fixed", () => {
  test("CONTROL — unchanged currency: add, edit and void all succeed with expectedCurrency JOD, and the stored row is JOD throughout", async () => {
    const s = await seedDeal("ctrl");
    const feeId = await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i1"));
    await s.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, actualAmountMinor: 152 * JOD_SCALE, expectedCurrency: "JOD",
    });
    let listed = await costs(s);
    expect(listed.currency).toBe("JOD");
    expect(listed.summaryUnavailable).toBeNull();
    expect(listed.summary).toMatchObject({ estimatedTotalMinor: 150 * JOD_SCALE, actualTotalMinor: 152 * JOD_SCALE, lineCount: 1 });
    expect(listed.fees[0]).toMatchObject({ currency: "JOD", estimatedAmountMinor: 150 * JOD_SCALE, actualAmountMinor: 152 * JOD_SCALE });

    await s.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: s.orgId, feeId, reason: "Entered on the wrong deal." });
    listed = await costs(s);
    expect(listed.fees).toHaveLength(0);
    expect(listed.summary).toMatchObject({ lineCount: 0, actualTotalMinor: 0 });
    const [row] = await feeRows(s);
    expect(row).toMatchObject({ currency: "JOD", actualAmountMinor: 152 * JOD_SCALE });
    expect(row.voidedAt).toBeTypeOf("number");
  });

  test("REPORTED SEQUENCE — an early JOD fee on an unpinned deal locks the org currency; the product switch to USD is refused and the row stays 150.000 JOD", async () => {
    const s = await seedDeal("seq");
    await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i1"));

    const refusal = await refusalOf(switchCurrencyViaProduct(s, "USD"));
    expect(refusal).toMatch(/currency cannot be changed after financial records exist/i);

    const settings = await s.t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique()
    );
    expect(settings?.currency).toBe("JOD");
    const listed = await costs(s);
    expect(listed.currency).toBe("JOD");
    expect(listed.fees[0]).toMatchObject({ currency: "JOD", estimatedAmountMinor: 150 * JOD_SCALE });
    expect(listed.summary?.estimatedTotalMinor).toBe(150 * JOD_SCALE);
  });

  test("STALE OPEN FORM (edit) — a client that still believes the deal is in USD sends 15,000 with expectedCurrency USD: refused against the STORED JOD row, zero delta, no override record", async () => {
    const s = await seedDeal("stale_edit");
    const feeId = await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i1"));
    const before = await feeRows(s);

    const refusal = await refusalOf(
      s.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
        orgId: s.orgId, feeId, actualAmountMinor: 150 * USD_SCALE, expectedCurrency: "USD",
      })
    );
    expect(refusal).toMatch(/entered in USD/);
    expect(refusal).toMatch(/recorded in JOD/);

    expect(await feeRows(s)).toEqual(before);
    expect((await feeRows(s))[0].actualAmountMinor).toBeUndefined();
    expect(await overrideRows(s)).toHaveLength(0);
  });

  test("STALE OPEN FORM (add) — a create entered in USD on a JOD deal is refused before any write: no fee row, no idempotency row, no classification note", async () => {
    const s = await seedDeal("stale_add");
    const refusal = await refusalOf(
      s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i1", { expectedCurrency: "USD", estimatedAmountMinor: 150 * USD_SCALE }))
    );
    expect(refusal).toMatch(/entered in USD/);
    expect(refusal).toMatch(/kept in JOD/);
    expect(await feeRows(s)).toHaveLength(0);
    expect(await idempotencyRows(s)).toHaveLength(0);
    expect(await overrideRows(s)).toHaveLength(0);
  });

  test("OUT-OF-CONTRACT DRIFT — a raw settings edit to USD after a JOD fee exists: the JOD row is neither re-scaled nor relabelled; a USD-entered actual is refused; the summary is withheld with a reason", async () => {
    const s = await seedDeal("raw_drift");
    const feeId = await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i1"));
    await rawSwitchCurrency(s, "USD");

    const listed = await costs(s);
    // The deal now resolves to USD (no pin, org says USD) but its only line is JOD.
    expect(listed.currency).toBe("USD");
    expect(listed.fees[0]).toMatchObject({ currency: "JOD", estimatedAmountMinor: 150 * JOD_SCALE });
    expect(listed.summary).toBeNull();
    expect(listed.summaryUnavailable).toMatchObject({ reason: "MIXED_DENOMINATION", dealCurrency: "USD", lineCurrencies: ["JOD"] });

    // The USD-rendered form's integer is refused against the row's JOD.
    const refusal = await refusalOf(
      s.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
        orgId: s.orgId, feeId, actualAmountMinor: 150 * USD_SCALE, expectedCurrency: "USD",
      })
    );
    expect(refusal).toMatch(/recorded in JOD/);
    expect((await feeRows(s))[0].actualAmountMinor).toBeUndefined();

    // Entered in the row's own currency it is accepted — EDIT compares with the
    // stored denomination, not the org's current one, and does not relabel.
    await s.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, actualAmountMinor: 150 * JOD_SCALE, expectedCurrency: "JOD",
    });
    expect((await feeRows(s))[0]).toMatchObject({ currency: "JOD", actualAmountMinor: 150 * JOD_SCALE });

    // A NEW line cannot be added in either currency: USD contradicts the JOD
    // facts already on the deal, JOD contradicts the org's current resolution.
    expect(await refusalOf(s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i2", { expectedCurrency: "USD" }))))
      .toMatch(/already has costs or custody recorded in JOD/);
    expect(await refusalOf(s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i3"))))
      .toMatch(/already has costs or custody recorded in JOD/);
    expect(await feeRows(s)).toHaveLength(1);
  });
});

describe("SCRUM-319 — expectedCurrency is validated against server authority, not against the caller's belief", () => {
  test("same decimals, different code (KWD on a JOD deal) is refused — denomination, not scale, is the contract", async () => {
    const s = await seedDeal("kwd");
    const refusal = await refusalOf(s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i1", { expectedCurrency: "KWD" })));
    expect(refusal).toMatch(/entered in KWD/);
    expect(await feeRows(s)).toHaveLength(0);
  });

  test.each([["jod"], [""], ["JD"], ["XYZ"]])("an unsupported or non-canonical expectedCurrency %j is refused on both commands with zero delta", async (bad) => {
    const s = await seedDeal(`bad_${bad || "empty"}`);
    const feeId = await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i1"));
    const created = await refusalOf(s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i2", { expectedCurrency: bad })));
    expect(created).toMatch(/not one AutoFlow can use/);
    const edited = await refusalOf(s.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, actualAmountMinor: 1 * JOD_SCALE, expectedCurrency: bad,
    }));
    expect(edited).toMatch(/not one AutoFlow can use/);
    const rows = await feeRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].actualAmountMinor).toBeUndefined();
  });

  test("a row whose STORED currency cannot be vouched for (raw-edited \"JD\") refuses an edit even when the caller repeats it", async () => {
    const s = await seedDeal("stored_bad");
    const feeId = await rawForeignFee(s, "JD");
    const refusal = await refusalOf(s.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, actualAmountMinor: 40 * JOD_SCALE, expectedCurrency: "JOD",
    }));
    expect(refusal).toMatch(/"JD"/);
    expect((await feeRows(s))[0].actualAmountMinor).toBeUndefined();
  });
});

describe("SCRUM-319 / AF-215-02 — CREATE identity covers the whole persisted payload", () => {
  test("exact retry replays the same row; the same key with a changed description, paidAt or currency refuses; a new key records a second line", async () => {
    const s = await seedDeal("identity");
    const args = addArgs(s, "i1", { paidAt: 1_760_000_000_000, receiptReference: " R-1 " });
    const first = await s.asUser.mutation(api.financeDealCosts.recordDealFee, args);
    const replay = await s.asUser.mutation(api.financeDealCosts.recordDealFee, { ...args });
    expect(replay).toBe(first);
    expect(await feeRows(s)).toHaveLength(1);

    for (const changed of [
      { description: "Plates" },
      { paidAt: 1_760_000_000_001 },
      { expectedCurrency: "KWD" },
      { includedInQuotation: true },
      { refundable: true },
      { receiptReference: "R-2" },
      { source: "COMPANY_TEMPLATE" as const },
    ]) {
      const refusal = await refusalOf(s.asUser.mutation(api.financeDealCosts.recordDealFee, { ...args, ...changed }));
      expect(refusal, JSON.stringify(changed)).not.toBe("");
      expect(await feeRows(s), JSON.stringify(changed)).toHaveLength(1);
    }
    // Whitespace-only differences normalise to the persisted value and replay.
    expect(await s.asUser.mutation(api.financeDealCosts.recordDealFee, { ...args, receiptReference: "R-1" })).toBe(first);

    const second = await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i2"));
    expect(second).not.toBe(first);
    expect(await feeRows(s)).toHaveLength(2);
  });
});

describe("SCRUM-319 — the lock keeps onboarding open and closes every ordering", () => {
  test("EMPTY ORG — with no application, cost or custody, the currency can still be chosen", async () => {
    const s = await seedOrg("empty");
    await switchCurrencyViaProduct(s, "USD");
    await switchCurrencyViaProduct(s, "JOD");
  });

  test("APPLICATION ONLY — a deal with no money fact yet already locks the currency (explicit conservative existence lock)", async () => {
    const s = await seedDeal("app_only");
    expect(await refusalOf(switchCurrencyViaProduct(s, "USD"))).toMatch(/cannot be changed/);
  });

  test("CUSTODY ONLY — a custody advance is a money fact: it locks the currency and is denominated with the deal", async () => {
    const s = await seedDeal("custody");
    await s.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: s.orgId, applicationId: s.applicationId, userId: s.employeeId, issuedMinor: 500 * JOD_SCALE,
      idempotencyKey: `custody:${s.applicationId}:1`,
    });
    const listed = await costs(s);
    expect(listed.custody[0]).toMatchObject({ currency: "JOD", issuedMinor: 500 * JOD_SCALE });
    expect(listed.custody[0].summary).not.toBeNull();
    expect(await refusalOf(switchCurrencyViaProduct(s, "USD"))).toMatch(/cannot be changed/);
  });

  test("LATER PIN — economics recorded after a JOD fee pin the deal in JOD; after an out-of-contract drift to USD they REFUSE rather than contradict the fee", async () => {
    const s = await seedDeal("pin");
    await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i1"));
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId: s.applicationId, submittedQuotationMinor: VEHICLE_PRICE * JOD_SCALE, source: "MANUAL_ENTRY",
    });
    expect((await s.t.run((ctx) => ctx.db.get(s.applicationId)))?.economicsCurrency).toBe("JOD");

    const s2 = await seedDeal("pin_drift");
    await s2.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s2, "i1"));
    await rawSwitchCurrency(s2, "USD");
    const refusal = await refusalOf(s2.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s2.orgId, applicationId: s2.applicationId, submittedQuotationMinor: VEHICLE_PRICE * USD_SCALE, source: "MANUAL_ENTRY",
    }));
    expect(refusal).toMatch(/already has costs or custody recorded in JOD/);
    const app = await s2.t.run((ctx) => ctx.db.get(s2.applicationId));
    expect(app?.economicsCurrency).toBeUndefined();
    expect(app?.submittedQuotationMinor).toBeUndefined();
  });
});

describe("SCRUM-319 — no valid-looking scalar total across mixed currencies", () => {
  test("MIXED ROWS (negative fixture) — listDealCosts keeps every line readable in its own currency and withholds the summary with the reason; a same-currency deal is unaffected", async () => {
    const s = await seedDeal("mixed");
    await s.asUser.mutation(api.financeDealCosts.recordDealFee, addArgs(s, "i1"));
    await rawForeignFee(s, "USD");

    const listed = await costs(s);
    expect(listed.fees.map((f) => [f.currency, f.estimatedAmountMinor])).toEqual([["JOD", 150 * JOD_SCALE], ["USD", 40 * USD_SCALE]]);
    expect(listed.summary).toBeNull();
    expect(listed.summaryUnavailable).toMatchObject({ reason: "MIXED_DENOMINATION", dealCurrency: "JOD", lineCurrencies: ["JOD", "USD"] });
  });

  test("MIXED CUSTODY — a custody record whose paid lines are in another currency reports no summary", async () => {
    const s = await seedDeal("mixed_custody");
    const custodyId = await s.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: s.orgId, applicationId: s.applicationId, userId: s.employeeId, issuedMinor: 500 * JOD_SCALE,
      idempotencyKey: `custody:${s.applicationId}:1`,
    });
    await rawForeignFee(s, "USD", { custodyId, paidBy: "EMPLOYEE", actualAmountMinor: 40 * USD_SCALE });
    const listed = await costs(s);
    expect(listed.custody[0].summary).toBeNull();
    expect(listed.custody[0].summaryUnavailable).toMatchObject({ reason: "MIXED_DENOMINATION", custodyCurrency: "JOD" });
  });

  test("SETTLEMENT DEDUCTIONS refuse a foreign deducted line instead of summing or dropping it", () => {
    const base = {
      _id: "x" as Id<"financeDealFees">, _creationTime: 0, orgId: "o" as Id<"organizations">,
      applicationId: "a" as Id<"financeApplications">, feeType: "LICENSING" as const,
      paidBy: "DEALER" as const, paidTo: "GOVERNMENT" as const,
      accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" as const, includedInQuotation: false,
      deductedFromSettlement: true, refundable: false, source: "MANUAL" as const,
      createdBy: "u" as Id<"users">, createdAt: 0, updatedAt: 0,
    };
    const jod = { ...base, currency: "JOD", actualAmountMinor: 375 * JOD_SCALE };
    const usd = { ...base, currency: "USD", actualAmountMinor: 40 * USD_SCALE };
    expect(settlementDeductedActualMinor([jod], "JOD")).toBe(375 * JOD_SCALE);
    expect(() => settlementDeductedActualMinor([jod, usd], "JOD")).toThrow(/recorded in USD, but the settlement is in JOD/);
    // Dropping the foreign row would have produced 375,000 — the refusal is the point.
    expect(() => settlementDeductedActualMinor([usd], "JOD")).toThrow(/settlement is in JOD/);
  });
});
