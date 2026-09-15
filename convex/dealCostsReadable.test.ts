import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { deriveExpectedFees, MAX_CUSTODY_ENTRIES, unreadableCustodyAmounts } from "./financeDealCosts";
import { assertConfiguredFeesRecorded, loadActiveFees, unrecordedConfiguredFeePositions } from "./utils/settlementDeductions";

/**
 * The readable-amount contract, end to end, on the deal's cost, custody and
 * expected-fee surfaces.
 *
 * The writers assert every amount; the schema (`v.number()`) does not, and a
 * legacy or raw-edited row carries whatever it carries. Each surface here
 * must (a) keep the screen up while serving the corrupt figure NOWHERE, with
 * a typed reason, and (b) refuse every write that would decide on it —
 * committing nothing, not even the row the write itself inserted.
 */

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;
const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);

/** Every value `v.number()` admits that is not a readable minor-unit amount. */
const CORRUPT: Array<[string, number]> = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a fraction of a fils", 120_000.5],
  ["a negative amount", -120_000],
  ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
];

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  employeeId: Id<"users">;
  applicationId: Id<"financeApplications">;
  asUser: AuthenticatedTestConvex;
}

async function seedDeal(suffix: string): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `RA Dealer ${suffix}`, createdAt: Date.now() }));
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `ra_user_${suffix}`, email: `ra${suffix}@x.com`, name: "Rana" }));
  const employeeId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `ra_emp_${suffix}`, email: `rae${suffix}@x.com`, name: "Rami" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: employeeId, roleId }));
  const applicationId = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `RAVIN${suffix}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 10_500, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "RA", lastName: "Customer" });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 10_500, downPayment: 500,
      termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    });
    return await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: userId,
      status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
  return { t, orgId, userId, employeeId, applicationId, asUser: t.withIdentity({ subject: `ra_user_${suffix}` }) };
}

async function openCustody(seed: Seed, issued = jod(700)) {
  return await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    applicationId: seed.applicationId,
    userId: seed.employeeId,
    issuedMinor: issued,
    method: "CASH",
  });
}

async function addFee(
  seed: Seed,
  overrides: Partial<{ actualAmountMinor: number; paidBy: "DEALER" | "EMPLOYEE"; custodyId: Id<"financeDealCustody"> }> = {}
): Promise<Id<"financeDealFees">> {
  return await seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD",
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    applicationId: seed.applicationId,
    feeType: "LICENSING",
    paidBy: overrides.paidBy ?? "DEALER",
    paidTo: "GOVERNMENT",
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
    ...(overrides.actualAmountMinor !== undefined ? { actualAmountMinor: overrides.actualAmountMinor } : {}),
    ...(overrides.custodyId ? { custodyId: overrides.custodyId } : {}),
  });
}

async function readCosts(seed: Seed) {
  return await seed.asUser.query(api.financeDealCosts.listDealCosts, { orgId: seed.orgId, applicationId: seed.applicationId });
}

/** Bypasses the writers, exactly as a legacy row or an admin raw edit does. */
async function corruptFee(seed: Seed, feeId: Id<"financeDealFees">, actualAmountMinor: number) {
  await seed.t.run((ctx) => ctx.db.patch(feeId, { actualAmountMinor }));
}

async function custodyRow(seed: Seed, custodyId: Id<"financeDealCustody">) {
  return (await seed.t.run((ctx) => ctx.db.get(custodyId)))!;
}

async function custodyEntries(seed: Seed, custodyId: Id<"financeDealCustody">) {
  return await seed.t.run((ctx) =>
    ctx.db.query("financeDealCustodyEntries").withIndex("by_custody", (q) => q.eq("custodyId", custodyId)).collect()
  );
}

// ---------------------------------------------------------------------------
// 1. Custody
// ---------------------------------------------------------------------------

describe("custody balances fail closed on an unreadable amount, end to end", () => {
  test.each(CORRUPT)(
    "a linked cost carrying %s: the screen stays up, the record serves no balance and names UNSAFE_AMOUNT, and closing it is refused",
    async (label, corrupt) => {
      const seed = await seedDeal(`c-${label}`);
      const custodyId = await openCustody(seed);
      const good = await addFee(seed, { actualAmountMinor: jod(100), paidBy: "EMPLOYEE", custodyId });
      const bad = await addFee(seed, { actualAmountMinor: jod(50), paidBy: "EMPLOYEE", custodyId });
      await corruptFee(seed, bad, corrupt);

      const costs = await readCosts(seed);
      const record = costs.custody.find((row) => row._id === custodyId)!;
      expect(record.summary).toBeNull();
      expect(record.summaryUnavailable).toEqual({ reason: "UNSAFE_AMOUNT", custodyCurrency: "JOD", dealCurrency: "JOD" });
      // The readable line's partial figure is served as no balance either.
      expect(JSON.stringify(record)).not.toContain(`"actualExpensesMinor"`);
      expect(record.paidFeeIds).toEqual(expect.arrayContaining([good, bad]));
      // Distinct from the denomination reason, which is about currency.
      expect(costs.summaryUnavailable?.reason).toBe("UNSAFE_AMOUNT");

      await expect(
        seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "checked" })
      ).rejects.toThrow(/not a readable figure/);
      await expect(
        seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
          orgId: seed.orgId, custodyId, notes: "checked", writeOffReason: "cannot account for it",
        })
      ).rejects.toThrow(/not a readable figure/);
      expect((await custodyRow(seed, custodyId)).status).toBe("OPEN");
    }
  );

  test.each(CORRUPT)(
    "a STORED custody total carrying %s (raw) serves no balance with UNSAFE_AMOUNT and refuses closure",
    async (label, corrupt) => {
      const seed = await seedDeal(`s-${label}`);
      const custodyId = await openCustody(seed);
      await seed.t.run((ctx) => ctx.db.patch(custodyId, { returnedMinor: corrupt }));
      const record = (await readCosts(seed)).custody.find((row) => row._id === custodyId)!;
      expect(record.summary).toBeNull();
      expect(record.summaryUnavailable?.reason).toBe("UNSAFE_AMOUNT");
      await expect(
        seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "checked" })
      ).rejects.toThrow(/not a readable figure/);
    }
  );

  test("linked actuals that overflow between them are unreadable, never summed into a balance", async () => {
    const seed = await seedDeal("overflow");
    const custodyId = await openCustody(seed);
    const a = await addFee(seed, { actualAmountMinor: 1, paidBy: "EMPLOYEE", custodyId });
    const b = await addFee(seed, { actualAmountMinor: 1, paidBy: "EMPLOYEE", custodyId });
    await corruptFee(seed, a, Number.MAX_SAFE_INTEGER - 1);
    await corruptFee(seed, b, 2);
    const record = (await readCosts(seed)).custody.find((row) => row._id === custodyId)!;
    expect(record.summary).toBeNull();
    expect(record.summaryUnavailable?.reason).toBe("UNSAFE_AMOUNT");
  });

  test("a custody whose stored totals are safe but add past the safe range is unreadable", () => {
    const nearMax = Number.MAX_SAFE_INTEGER - 1;
    expect(unreadableCustodyAmounts({ issuedMinor: nearMax, returnedMinor: 2, reimbursedMinor: 0 }, 0)).toBe("UNSAFE_AMOUNT");
    expect(unreadableCustodyAmounts({ issuedMinor: nearMax, returnedMinor: 0, reimbursedMinor: 0 }, 1)).toBeNull();
    expect(unreadableCustodyAmounts({ issuedMinor: 1, returnedMinor: 0, reimbursedMinor: 0 }, null)).toBe("UNSAFE_AMOUNT");
  });

  test.each(CORRUPT)(
    "a HISTORICAL movement carrying %s (raw) makes the next movement roll back: no new entry, totals untouched",
    async (label, corrupt) => {
      const seed = await seedDeal(`m-${label}`);
      const custodyId = await openCustody(seed, jod(700));
      const before = await custodyRow(seed, custodyId);
      // A second, corrupt ISSUED entry written raw — the totals still say 700.
      await seed.t.run((ctx) =>
        ctx.db.insert("financeDealCustodyEntries", {
          orgId: seed.orgId, custodyId, kind: "ISSUED", amountMinor: corrupt,
          occurredAt: Date.now(), recordedBy: seed.userId, recordedAt: Date.now(),
        })
      );
      const entriesBefore = await custodyEntries(seed, custodyId);
      expect(entriesBefore).toHaveLength(2);

      await expect(
        seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
          orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: jod(100), idempotencyKey: crypto.randomUUID(),
        })
      ).rejects.toThrow(/not a readable amount/);

      // The mutation's own RETURNED insert did not survive the throw, and the
      // stored totals were not recomputed over the corrupt entry.
      expect(await custodyEntries(seed, custodyId)).toHaveLength(2);
      const after = await custodyRow(seed, custodyId);
      expect([after.issuedMinor, after.returnedMinor, after.reimbursedMinor]).toEqual([
        before.issuedMinor, before.returnedMinor, before.reimbursedMinor,
      ]);
    }
  );

  test("historical movements that overflow between them roll the next movement back", async () => {
    const seed = await seedDeal("m-overflow");
    const custodyId = await openCustody(seed, 1);
    await seed.t.run(async (ctx) => {
      for (const amountMinor of [Number.MAX_SAFE_INTEGER - 1, 2]) {
        await ctx.db.insert("financeDealCustodyEntries", {
          orgId: seed.orgId, custodyId, kind: "ISSUED", amountMinor,
          occurredAt: Date.now(), recordedBy: seed.userId, recordedAt: Date.now(),
        });
      }
    });
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: 1, idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/outside the readable range/);
    expect(await custodyEntries(seed, custodyId)).toHaveLength(3);
    expect((await custodyRow(seed, custodyId)).issuedMinor).toBe(1);
  });

  test(`decision reads are bounded at ${MAX_CUSTODY_ENTRIES} movements: the movement that would cross the bound rolls back, nothing is sampled, and the record at the bound still works`, async () => {
    const seed = await seedDeal("bound");
    const custodyId = await openCustody(seed, jod(700));
    // Fill the log to EXACTLY the bound with tiny raw RETURNED entries (the
    // product would refuse this many; the bound is about what a decision read
    // can carry). Totals are recomputed by the next real movement.
    await seed.t.run(async (ctx) => {
      for (let n = 1; n < MAX_CUSTODY_ENTRIES; n += 1) {
        await ctx.db.insert("financeDealCustodyEntries", {
          orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: 1,
          occurredAt: Date.now(), recordedBy: seed.userId, recordedAt: Date.now(),
        });
      }
    });
    expect(await custodyEntries(seed, custodyId)).toHaveLength(MAX_CUSTODY_ENTRIES);
    const before = await custodyRow(seed, custodyId);

    // The (MAX + 1)th movement is the one that would make the log undecidable.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: 1, idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(new RegExp(`more than ${MAX_CUSTODY_ENTRIES} movements`));
    expect(await custodyEntries(seed, custodyId)).toHaveLength(MAX_CUSTODY_ENTRIES);
    const after = await custodyRow(seed, custodyId);
    expect([after.issuedMinor, after.returnedMinor, after.reimbursedMinor]).toEqual([before.issuedMinor, before.returnedMinor, before.reimbursedMinor]);

    // A reversal of the issuance is decided on the same bounded read and is
    // refused the same way past the bound — never on a prefix.
    const issued = (await custodyEntries(seed, custodyId)).find((entry) => entry.kind === "ISSUED")!;
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "REVERSAL", reversesEntryId: issued._id, amountMinor: jod(700), idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(new RegExp(`more than ${MAX_CUSTODY_ENTRIES} movements`));
    expect(await custodyEntries(seed, custodyId)).toHaveLength(MAX_CUSTODY_ENTRIES);
  });

  test("one movement BELOW the bound still records and recomputes; a movement already reversed is refused by the indexed point read", async () => {
    const seed = await seedDeal("bound-ok");
    const custodyId = await openCustody(seed, jod(700));
    await seed.t.run(async (ctx) => {
      for (let n = 2; n < MAX_CUSTODY_ENTRIES; n += 1) {
        await ctx.db.insert("financeDealCustodyEntries", {
          orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: 1,
          occurredAt: Date.now(), recordedBy: seed.userId, recordedAt: Date.now(),
        });
      }
    });
    await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
      orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: 2, idempotencyKey: crypto.randomUUID(),
    });
    expect(await custodyEntries(seed, custodyId)).toHaveLength(MAX_CUSTODY_ENTRIES);
    expect((await custodyRow(seed, custodyId)).returnedMinor).toBe(MAX_CUSTODY_ENTRIES - 2 + 2);

    const seed2 = await seedDeal("reversed-twice");
    const custody2 = await openCustody(seed2, jod(700));
    await seed2.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
      orgId: seed2.orgId, custodyId: custody2, kind: "RETURNED", amountMinor: jod(100), idempotencyKey: crypto.randomUUID(),
    });
    const returnedEntry = (await custodyEntries(seed2, custody2)).find((entry) => entry.kind === "RETURNED")!;
    const reverse = () =>
      seed2.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed2.orgId, custodyId: custody2, kind: "REVERSAL", reversesEntryId: returnedEntry._id, amountMinor: jod(100), idempotencyKey: crypto.randomUUID(),
      });
    await reverse();
    await expect(reverse()).rejects.toThrow(/already been reversed/);
  });

  test("a readable custody is unchanged by the contract: balance served, closure and movements work", async () => {
    const seed = await seedDeal("ok");
    const custodyId = await openCustody(seed, jod(700));
    await addFee(seed, { actualAmountMinor: jod(600), paidBy: "EMPLOYEE", custodyId });
    await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
      orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: jod(100), idempotencyKey: crypto.randomUUID(),
    });
    const record = (await readCosts(seed)).custody.find((row) => row._id === custodyId)!;
    expect(record.summaryUnavailable).toBeNull();
    expect(record.summary?.settled).toBe(true);
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "balanced" });
    expect((await custodyRow(seed, custodyId)).status).toBe("RECONCILED");
  });
});

// ---------------------------------------------------------------------------
// 2. Accounting classification
// ---------------------------------------------------------------------------

describe("accounting classification refuses a deal whose costs are not readable figures", () => {
  async function invoiced(suffix: string) {
    const seed = await seedDeal(suffix);
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: "INV-1", legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
    });
    return seed;
  }

  async function reconciledFee(seed: Seed, actualAmountMinor: number) {
    const feeId = await addFee(seed, { actualAmountMinor });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId, notes: "matched" });
    return feeId;
  }

  async function classify(seed: Seed) {
    return seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
      orgId: seed.orgId, applicationId: seed.applicationId, notes: "all on file",
    });
  }

  async function assertNotClassified(seed: Seed) {
    const app = (await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))!;
    expect(app.accountingClassification).not.toBe("CLASSIFIED");
    expect(app.accountingClassifiedAt).toBeUndefined();
    expect(app.accountingClassifiedBy).toBeUndefined();
    expect(app.accountingClassificationNotes).toBeUndefined();
  }

  test.each(CORRUPT)(
    "a RECONCILED same-currency line whose actual is %s (raw) refuses classification with no stamp and no partial write",
    async (label, corrupt) => {
      const seed = await invoiced(`k-${label}`);
      await reconciledFee(seed, jod(100));
      const bad = await reconciledFee(seed, jod(50));
      await corruptFee(seed, bad, corrupt);
      const appBefore = (await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))!;

      await expect(classify(seed)).rejects.toThrow(/not a readable figure/);

      await assertNotClassified(seed);
      const appAfter = (await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))!;
      expect(appAfter.updatedAt).toBe(appBefore.updatedAt);
      expect(appAfter.expectedDealerRemittanceMinor).toBe(appBefore.expectedDealerRemittanceMinor);
    }
  );

  test("two reconciled actuals that overflow between them refuse classification", async () => {
    const seed = await invoiced("k-overflow");
    const a = await reconciledFee(seed, 1);
    const b = await reconciledFee(seed, 1);
    await corruptFee(seed, a, Number.MAX_SAFE_INTEGER - 1);
    await corruptFee(seed, b, 2);
    await expect(classify(seed)).rejects.toThrow(/not a readable figure/);
    await assertNotClassified(seed);
  });

  test("readable, reconciled costs still classify", async () => {
    const seed = await invoiced("k-ok");
    await reconciledFee(seed, jod(137));
    await classify(seed);
    expect((await readCosts(seed)).accountingClassification).toBe("CLASSIFIED");
  });
});

// ---------------------------------------------------------------------------
// 3. Frozen snapshot expected fees
// ---------------------------------------------------------------------------

describe("a frozen snapshot template whose estimate is not readable withholds its money, keeps its identity, and is never rewritten", () => {
  const template = (estimatedAmountMinor: number, feeType: "LICENSING" | "STAMPS" = "LICENSING") => ({
    feeType,
    description: feeType === "LICENSING" ? "Plates" : "Legal stamps",
    estimatedAmountMinor,
    paidBy: "DEALER" as const,
    paidTo: "GOVERNMENT" as const,
    includedInQuotation: false,
    deductedFromSettlement: false,
    refundable: false,
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" as const,
  });

  test.each(CORRUPT)("a template estimate of %s — pure derivation", (_label, corrupt) => {
    const expected = deriveExpectedFees({
      snapshot: { ruleVersion: 1, companyName: "Policy Co", feeTemplates: [template(jod(250)), template(corrupt, "STAMPS")] },
      fees: [],
      currency: "JOD",
      actualTotalMinor: 0,
    });
    expect(expected.rows.map((row) => [row.feeType, row.expectedAmountMinor, row.expectedAmountReason])).toEqual([
      ["LICENSING", jod(250), null],
      ["STAMPS", null, "UNSAFE_AMOUNT"],
    ]);
    expect(expected.rows[1].description).toBe("Legal stamps");
    expect(expected.expectedTotalMinor).toBeNull();
    expect(expected.expectedTotalReason).toBe("UNSAFE_AMOUNT");
    expect(expected.differenceMinor).toBeNull();
    expect(JSON.stringify(expected)).not.toContain(String(corrupt));
  });

  test("safe template estimates that overflow between them withhold the total, each row stays readable", () => {
    const expected = deriveExpectedFees({
      snapshot: {
        ruleVersion: 1,
        companyName: "Policy Co",
        feeTemplates: [template(Number.MAX_SAFE_INTEGER - 1), template(2, "STAMPS")],
      },
      fees: [],
      currency: "JOD",
      actualTotalMinor: 0,
    });
    expect(expected.rows.every((row) => row.expectedAmountReason === null)).toBe(true);
    expect(expected.expectedTotalMinor).toBeNull();
    expect(expected.expectedTotalReason).toBe("UNSAFE_AMOUNT");
    expect(expected.differenceMinor).toBeNull();
  });

  test.each(CORRUPT)(
    "on a real deal a %s estimate withholds the expected and dealer-borne totals, the snapshot is untouched, and a REAL actual can still be recorded against that position without carrying the corrupt estimate",
    async (label, corrupt) => {
      const seed = await seedDeal(`t-${label}`);
      const snapshot = { ruleVersion: 1, companyName: "Policy Co", feeTemplates: [template(jod(250)), template(corrupt, "STAMPS")] };
      await seed.t.run((ctx) => ctx.db.patch(seed.applicationId, { companyRuleSnapshot: snapshot }));

      const costs = await readCosts(seed);
      expect(costs.expected.expectedTotalMinor).toBeNull();
      expect(costs.expected.expectedTotalReason).toBe("UNSAFE_AMOUNT");
      expect(costs.expected.rows[1]).toMatchObject({ feeType: "STAMPS", expectedAmountMinor: null, expectedAmountReason: "UNSAFE_AMOUNT", actual: null });
      expect(costs.expected.rows[0]).toMatchObject({ feeType: "LICENSING", expectedAmountMinor: jod(250), expectedAmountReason: null });

      const overview = await seed.asUser.query(api.dealOverview.financedDealOverview, { orgId: seed.orgId, applicationId: seed.applicationId });
      expect(overview!.financialSummary!.dealerOutlay).toMatchObject({
        expectedCostsRemainingMinor: null,
        expectedCostsReason: "UNSAFE_AMOUNT",
        totalExpectedMinor: null,
      });

      // The position is not a dead end: the operator records what was really
      // paid. The line carries the REAL actual and NO estimate — the corrupt
      // one is neither copied nor repaired — and the totals stay readable.
      const stampsFeeId = await seed.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
        orgId: seed.orgId, applicationId: seed.applicationId, templateIndex: 1, feeType: "STAMPS",
        expectedCurrency: "JOD", actualAmountMinor: jod(90), idempotencyKey: crypto.randomUUID(),
      });
      const stampsLine = (await seed.t.run((ctx) => ctx.db.get(stampsFeeId)))!;
      expect(stampsLine).toMatchObject({ source: "COMPANY_TEMPLATE", templateIndex: 1, actualAmountMinor: jod(90) });
      expect(stampsLine.estimatedAmountMinor).toBeUndefined();

      const after = await readCosts(seed);
      expect(after.summary).not.toBeNull();
      expect(after.summary!.actualTotalMinor).toBe(jod(90));
      expect(after.summaryUnavailable).toBeNull();
      // The checklist shows the actual against its position; the expected side stays withheld — never invented.
      expect(after.expected.rows[1]).toMatchObject({ expectedAmountMinor: null, expectedAmountReason: "UNSAFE_AMOUNT" });
      expect(after.expected.rows[1].actual).toMatchObject({ feeId: stampsFeeId, actualAmountMinor: jod(90), status: "ACTUAL_RECORDED" });
      expect(after.expected.expectedTotalMinor).toBeNull();
      expect(after.expected.differenceMinor).toBeNull();
      expect(JSON.stringify(after)).not.toContain(String(corrupt));

      // The frozen snapshot is exactly as it was.
      const app = (await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))!;
      expect(app.companyRuleSnapshot).toEqual(snapshot);

      // The finalization door judges positions on the same live rows: the
      // estimate-less line satisfies position 1, position 0 is still owed.
      await seed.t.run(async (ctx) => {
        const liveFees = await loadActiveFees(ctx, seed.applicationId);
        expect(unrecordedConfiguredFeePositions(app.companyRuleSnapshot, liveFees)).toEqual([0]);
        expect(() => assertConfiguredFeesRecorded(app.companyRuleSnapshot, liveFees, "finalizing")).toThrow();
      });

      // And the configured-position gate is satisfied by the real actual:
      // once every other real requirement is met, classification proceeds.
      await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
        orgId: seed.orgId, applicationId: seed.applicationId,
        legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: "INV-1", legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
      });
      const platesFeeId = await seed.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
        orgId: seed.orgId, applicationId: seed.applicationId, templateIndex: 0, feeType: "LICENSING",
        expectedCurrency: "JOD", actualAmountMinor: jod(250), idempotencyKey: crypto.randomUUID(),
      });
      for (const feeId of [stampsFeeId, platesFeeId]) {
        await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId, notes: "matched" });
      }
      await seed.t.run(async (ctx) => {
        const liveFees = await loadActiveFees(ctx, seed.applicationId);
        expect(unrecordedConfiguredFeePositions(app.companyRuleSnapshot, liveFees)).toEqual([]);
        expect(() => assertConfiguredFeesRecorded(app.companyRuleSnapshot, liveFees, "finalizing")).not.toThrow();
      });
      await seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
        orgId: seed.orgId, applicationId: seed.applicationId, notes: "all on file",
      });
      expect((await readCosts(seed)).accountingClassification).toBe("CLASSIFIED");
    }
  );
});
