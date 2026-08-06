import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;

const MODULES = import.meta.glob("./**/*.*s");

/** JOD minor units (scale 3), matching getOrgCurrency's default. */
const jod = (major: number): number => Math.round(major * 1000);

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  userId: Id<"users">;
  clerkId: Id<"users">;
  employeeId: Id<"users">;
  applicationId: Id<"financeApplications">;
  asUser: AuthenticatedTestConvex;
}

async function seedDeal(suffix = "1"): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Costs Dealer ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `costs_user_${suffix}`, email: `c${suffix}@x.com` })
  );
  const employeeId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `costs_emp_${suffix}`, email: `e${suffix}@x.com` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: employeeId, roleId }));

  const applicationId = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `COSTVIN${suffix}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 10_500, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", {
      orgId, firstName: "Costs", lastName: "Customer",
    });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 10_500, downPayment: 500,
      termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    });
    return await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: userId,
      status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
    });
  });

  return {
    t, orgId, userId, clerkId: userId, employeeId, applicationId,
    asUser: t.withIdentity({ subject: `costs_user_${suffix}` }),
  };
}

/** The common case: a licensing fee the dealership pays. */
async function addFee(
  seed: Seed,
  overrides: Partial<{
    estimatedAmountMinor: number;
    actualAmountMinor: number;
    paidBy: "DEALER" | "CUSTOMER" | "EMPLOYEE" | "FINANCE_COMPANY";
    custodyId: Id<"financeDealCustody">;
  }> = {}
): Promise<Id<"financeDealFees">> {
  return await seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
    orgId: seed.orgId,
    applicationId: seed.applicationId,
    feeType: "LICENSING",
    paidBy: overrides.paidBy ?? "DEALER",
    paidTo: "GOVERNMENT",
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
    ...(overrides.estimatedAmountMinor !== undefined
      ? { estimatedAmountMinor: overrides.estimatedAmountMinor }
      : {}),
    ...(overrides.actualAmountMinor !== undefined
      ? { actualAmountMinor: overrides.actualAmountMinor }
      : {}),
    ...(overrides.custodyId ? { custodyId: overrides.custodyId } : {}),
  });
}

async function readCosts(seed: Seed) {
  return await seed.asUser.query(api.financeDealCosts.listDealCosts, {
    orgId: seed.orgId,
    applicationId: seed.applicationId,
  });
}

// ---------------------------------------------------------------------------

describe("itemized deal costs", () => {
  test("keeps the estimate and the actual apart instead of overwriting one with the other", async () => {
    const seed = await seedDeal();
    const feeId = await addFee(seed, { estimatedAmountMinor: jod(120) });

    let costs = await readCosts(seed);
    expect(costs.summary.estimatedTotalMinor).toBe(jod(120));
    // The actual is genuinely unknown, and an unknown is not a zero and not the
    // estimate. A total that quietly substituted one for the other would read
    // as complete when nothing has been paid.
    expect(costs.summary.actualTotalMinor).toBe(0);
    expect(costs.summary.linesAwaitingActual).toBe(1);
    expect(costs.fees[0]?.status).toBe("ESTIMATED_ONLY");

    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId,
      feeId,
      actualAmountMinor: jod(137),
    });

    costs = await readCosts(seed);
    // Both survive, so the comparison the reconciliation depends on is still
    // there afterwards.
    expect(costs.summary.estimatedTotalMinor).toBe(jod(120));
    expect(costs.summary.actualTotalMinor).toBe(jod(137));
    expect(costs.fees[0]?.status).toBe("ACTUAL_RECORDED");
  });

  test("a cost named but not yet quantified is not read as zero", async () => {
    const seed = await seedDeal();
    await addFee(seed);

    const costs = await readCosts(seed);
    expect(costs.fees[0]?.status).toBe("UNQUANTIFIED");
    expect(costs.summary.estimatedTotalMinor).toBe(0);
    expect(costs.summary.linesAwaitingActual).toBe(1);
    expect(costs.summary.fullyReconciled).toBe(false);
  });

  test("nothing itemized reports nothing, rather than inferring a residual", async () => {
    const seed = await seedDeal();

    const costs = await readCosts(seed);
    expect(costs.summary.lineCount).toBe(0);
    expect(costs.summary.estimatedTotalMinor).toBe(0);
    expect(costs.summary.actualTotalMinor).toBe(0);
    // And an empty deal is NOT "fully reconciled" — there is nothing to have
    // reconciled, which is a different claim from everything checking out.
    expect(costs.summary.fullyReconciled).toBe(false);
  });

  test("changing a recorded actual withdraws the reconciliation it was checked under", async () => {
    const seed = await seedDeal();
    const feeId = await addFee(seed, { actualAmountMinor: jod(137) });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: seed.orgId,
      feeId,
      notes: "Matched to the licensing receipt.",
    });
    expect((await readCosts(seed)).fees[0]?.status).toBe("RECONCILED");

    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId,
      feeId,
      actualAmountMinor: jod(152),
    });

    // Leaving the reconciliation attached would let an edit walk straight past
    // the only gate standing between an estimate and a closed deal.
    const costs = await readCosts(seed);
    expect(costs.fees[0]?.status).toBe("ACTUAL_RECORDED");
    expect(costs.fees[0]?.reconciledAt).toBeUndefined();
  });

  test("an estimate cannot be reconciled", async () => {
    const seed = await seedDeal();
    const feeId = await addFee(seed, { estimatedAmountMinor: jod(120) });

    await expect(
      seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: seed.orgId,
        feeId,
        notes: "Looks about right.",
      })
    ).rejects.toThrow(/estimate is not evidence/i);
  });

  test("voiding keeps the line visible rather than erasing that it existed", async () => {
    const seed = await seedDeal();
    const feeId = await addFee(seed, { estimatedAmountMinor: jod(120) });

    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, {
      orgId: seed.orgId,
      feeId,
      reason: "Charged to the customer instead.",
    });

    // Gone from the working totals, still on the record.
    expect((await readCosts(seed)).summary.lineCount).toBe(0);
    const row = await seed.t.run((ctx) => ctx.db.get(feeId));
    expect(row?.voidedAt).toBeDefined();
    expect(row?.voidReason).toBe("Charged to the customer instead.");
  });
});

describe("employee custody", () => {
  test("closes the identity when the balance is returned", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId,
      applicationId: seed.applicationId,
      userId: seed.employeeId,
      issuedMinor: jod(700),
    });
    await addFee(seed, { actualAmountMinor: jod(650), paidBy: "EMPLOYEE", custodyId });

    let costs = await readCosts(seed);
    expect(costs.custody[0]?.summary.employeeOwesDealerMinor).toBe(jod(50));
    expect(costs.custody[0]?.summary.settled).toBe(false);

    await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
      orgId: seed.orgId,
      custodyId,
      kind: "RETURNED",
      amountMinor: jod(50),
    });

    costs = await readCosts(seed);
    expect(costs.custody[0]?.summary.remainingEmployeeBalanceMinor).toBe(0);
    expect(costs.custody[0]?.summary.settled).toBe(true);
  });

  test("an employee who spent their own money is owed it, not charged for it", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId,
      applicationId: seed.applicationId,
      userId: seed.employeeId,
      issuedMinor: jod(700),
    });
    await addFee(seed, { actualAmountMinor: jod(750), paidBy: "EMPLOYEE", custodyId });

    const costs = await readCosts(seed);
    // The sign is the whole point. Collapsing this into an unsigned "variance"
    // is how a debt owed TO a person becomes a shortage charged against them.
    //
    // Their own contribution is DERIVED from the shortfall, never recorded as a
    // separate figure — an earlier version took it as an input and added it to
    // the advance, which drove the reimbursement due to zero and reported the
    // record as reconciled. The dealership that documented it most carefully
    // was the one that erased it.
    expect(costs.custody[0]?.summary.reimbursementIncurredMinor).toBe(jod(50));
    expect(costs.custody[0]?.summary.reimbursementIncurredMinor).toBe(jod(50));
    expect(costs.custody[0]?.summary.employeeOwesDealerMinor).toBe(0);
    expect(costs.custody[0]?.summary.reimbursementOutstandingMinor).toBe(jod(50));
    expect(costs.custody[0]?.summary.settled).toBe(false);
  });

  test("a debt to the employee is not settled until it is actually paid", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId,
      applicationId: seed.applicationId,
      userId: seed.employeeId,
      issuedMinor: jod(700),
    });
    await addFee(seed, { actualAmountMinor: jod(750), paidBy: "EMPLOYEE", custodyId });

    // The engine says the debt is DUE. Owed and paid are different facts, and
    // closing on the first would quietly write the second off.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
        orgId: seed.orgId,
        custodyId,
        notes: "Receipts all present.",
      })
    ).rejects.toThrow(/still owed to this person/i);

    await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
      orgId: seed.orgId, custodyId, kind: "REIMBURSED", amountMinor: jod(50),
    });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      orgId: seed.orgId,
      custodyId,
      notes: "Receipts all present, reimbursement paid.",
    });
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))?.status).toBe("RECONCILED");
  });

  test("totals are a sum of movements, so a correction stays visible", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId,
      applicationId: seed.applicationId,
      userId: seed.employeeId,
      issuedMinor: jod(700),
    });
    await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
      orgId: seed.orgId, custodyId, kind: "ISSUED", amountMinor: jod(100),
      note: "Second handover for the insurance premium.",
    });

    const custody = await seed.t.run((ctx) => ctx.db.get(custodyId));
    expect(custody?.issuedMinor).toBe(jod(800));
    // Both movements are on the record, not just the total they add up to.
    const entries = await seed.t.run((ctx) =>
      ctx.db
        .query("financeDealCustodyEntries")
        .withIndex("by_custody", (q) => q.eq("custodyId", custodyId))
        .collect()
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.amountMinor).sort((a, b) => a - b)).toEqual([
      jod(100),
      jod(700),
    ]);
  });

  test("an unbalanced record can only be closed as an explicit write-off", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId,
      applicationId: seed.applicationId,
      userId: seed.employeeId,
      issuedMinor: jod(700),
    });
    await addFee(seed, { actualAmountMinor: jod(600), paidBy: "EMPLOYEE", custodyId });

    await expect(
      seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
        orgId: seed.orgId, custodyId, notes: "Closing this off.",
      })
    ).rejects.toThrow(/still unaccounted for/i);

    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      orgId: seed.orgId,
      custodyId,
      notes: "Employee left; balance not recovered.",
      writeOffReason: "100 JOD unaccounted for after the employee left.",
    });
    const row = await seed.t.run((ctx) => ctx.db.get(custodyId));
    expect(row?.status).toBe("WRITTEN_OFF");
    expect(row?.writeOffReason).toMatch(/unaccounted for/i);
  });

  test("custody cannot be handed to someone outside the organization", async () => {
    const seed = await seedDeal();
    const outsider = await seed.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "outsider_1", email: "out@x.com" })
    );

    await expect(
      seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
        orgId: seed.orgId,
        applicationId: seed.applicationId,
        userId: outsider,
        issuedMinor: jod(700),
      })
    ).rejects.toThrow(/not a member of this organization/i);
  });

  test("a second open record for the same person on the same deal is refused", async () => {
    const seed = await seedDeal();
    await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });

    await expect(
      seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
        orgId: seed.orgId, applicationId: seed.applicationId,
        userId: seed.employeeId, issuedMinor: jod(200),
      })
    ).rejects.toThrow(/already holds an open custody record/i);
  });

  test("a fee cannot be attached to another deal's custody record", async () => {
    const seed = await seedDeal();
    const other = await seedDeal("2");
    // Same org, different deal — so the org check passes and only the
    // application check can catch it.
    const otherApplicationId = await seed.t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId: seed.orgId, vin: "COSTVINOTHER", make: "Toyota", model: "Yaris",
        year: 2024, mileage: 10, color: "Red", fuelType: "Gas", transmission: "Auto",
        sellingPrice: 9000, status: "AVAILABLE",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId: seed.orgId, firstName: "Other", lastName: "Customer",
      });
      const quoteId = await ctx.db.insert("quotes", {
        orgId: seed.orgId, customerId, vehicleId, vehiclePrice: 9000, downPayment: 500,
        termMonths: 48, status: "ACCEPTED", createdBy: seed.userId, createdAt: Date.now(),
      });
      return await ctx.db.insert("financeApplications", {
        orgId: seed.orgId, quoteId, customerId, vehicleId, salespersonId: seed.userId,
        status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
    const otherCustodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId,
      applicationId: otherApplicationId,
      userId: seed.employeeId,
      issuedMinor: jod(300),
    });
    void other;

    await expect(
      addFee(seed, {
        actualAmountMinor: jod(100),
        paidBy: "EMPLOYEE",
        custodyId: otherCustodyId,
      })
    ).rejects.toThrow(/different deal/i);
  });
});

describe("a closed record cannot go quietly wrong afterwards", () => {
  async function settledCustody(seed: Seed) {
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });
    const feeId = await addFee(seed, {
      actualAmountMinor: jod(700), paidBy: "EMPLOYEE", custodyId,
    });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      orgId: seed.orgId, custodyId, notes: "All receipts in.",
    });
    return { custodyId, feeId };
  }

  async function invoiceIt(seed: Seed, number: string) {
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: number,
      legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
    });
  }

  test("a late receipt cannot silently unbalance a reconciled custody record", async () => {
    const seed = await seedDeal();
    const { custodyId, feeId } = await settledCustody(seed);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))?.status).toBe("RECONCILED");

    // Nothing froze the lines the balance was computed from, so this used to
    // succeed — leaving the record stored as RECONCILED while the arithmetic
    // said the employee was out of pocket, and every route to fixing it then
    // refused with an error naming a mutation that did not exist.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
        orgId: seed.orgId, feeId, actualAmountMinor: jod(750),
      })
    ).rejects.toThrow(/closed\. Reopen it/i);

    await expect(
      addFee(seed, { actualAmountMinor: jod(50), paidBy: "EMPLOYEE", custodyId })
    ).rejects.toThrow(/closed\. Reopen it/i);

    await expect(
      seed.asUser.mutation(api.financeDealCosts.voidDealFee, {
        orgId: seed.orgId, feeId, reason: "Wrong line.",
      })
    ).rejects.toThrow(/closed\. Reopen it/i);
  });

  test("reopening is possible, audited, and withdraws the classification", async () => {
    const seed = await seedDeal();
    const { custodyId, feeId } = await settledCustody(seed);
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: seed.orgId, feeId, notes: "Matched.",
    });
    await invoiceIt(seed, "INV-9");
    await seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
      orgId: seed.orgId, applicationId: seed.applicationId, notes: "All documents on file.",
    });
    expect((await readCosts(seed)).accountingClassification).toBe("CLASSIFIED");

    await seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, {
      orgId: seed.orgId, custodyId, reason: "A late licensing receipt arrived.",
    });

    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))?.status).toBe("OPEN");
    // The classification was granted on this record being settled, so it goes
    // back to pending rather than standing on a basis that has changed.
    expect((await readCosts(seed)).accountingClassification).toBe("PENDING_CLASSIFICATION");
    const overrides = await seed.t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId))
        .collect()
    );
    expect(overrides.some((o) => o.field === "financeDealCustody.status")).toBe(true);
    expect(overrides.some((o) => o.field === "accountingClassification")).toBe(true);
  });

  test("adding a cost after classification withdraws it rather than leaving it stale", async () => {
    const seed = await seedDeal();
    const feeId = await addFee(seed, { actualAmountMinor: jod(120) });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: seed.orgId, feeId, notes: "Matched.",
    });
    await invoiceIt(seed, "INV-10");
    await seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
      orgId: seed.orgId, applicationId: seed.applicationId, notes: "Documents on file.",
    });

    // The flag exists to be the gate a posting design reads. A gate that
    // silently stops representing its own precondition is the whole hazard.
    await addFee(seed);

    const costs = await readCosts(seed);
    expect(costs.accountingClassification).toBe("PENDING_CLASSIFICATION");
    expect(costs.summary.linesAwaitingActual).toBe(1);
  });

  test("classifying twice is refused rather than overwriting who decided", async () => {
    const seed = await seedDeal();
    const feeId = await addFee(seed, { actualAmountMinor: jod(120) });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: seed.orgId, feeId, notes: "Matched.",
    });
    await invoiceIt(seed, "INV-11");
    await seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
      orgId: seed.orgId, applicationId: seed.applicationId, notes: "First decision.",
    });

    await expect(
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
        orgId: seed.orgId, applicationId: seed.applicationId, notes: "Second decision.",
      })
    ).rejects.toThrow(/already been classified/i);
  });

  test("a deal with nothing itemized does not classify clean", async () => {
    const seed = await seedDeal();
    await invoiceIt(seed, "INV-12");

    // Both awaiting-counts are zero for an empty list, so reading only those
    // let "nobody itemized anything" through as complete — the exact state the
    // module's own summary refuses to call reconciled.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
        orgId: seed.orgId, applicationId: seed.applicationId, notes: "Nothing to record.",
      })
    ).rejects.toThrow(/No costs have been itemized/i);
  });
});

describe("money can only move in directions that are true", () => {
  test("a cost somebody else paid cannot be charged to an employee's custody", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });

    // The dealership pays the fee itself by bank transfer, and the line is
    // attached to the custody record by mis-click. That drove the balance to
    // zero and let the record close while 700 in cash was still in the
    // employee's pocket.
    await expect(
      addFee(seed, { actualAmountMinor: jod(700), paidBy: "DEALER", custodyId })
    ).rejects.toThrow(/paid by that employee/i);

    const costs = await readCosts(seed);
    expect(costs.custody[0]?.summary.employeeOwesDealerMinor).toBe(jod(700));
  });

  test("a duplicate reimbursement is surfaced, not clamped away", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });
    await addFee(seed, { actualAmountMinor: jod(750), paidBy: "EMPLOYEE", custodyId });

    // Two people recording the same payment, or a retry after a timeout.
    for (let i = 0; i < 2; i += 1) {
      await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "REIMBURSED", amountMinor: jod(50),
      });
    }

    const costs = await readCosts(seed);
    expect(costs.custody[0]?.summary.reimbursementOverpaidMinor).toBe(jod(50));
    expect(costs.custody[0]?.summary.settled).toBe(false);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
        orgId: seed.orgId, custodyId, notes: "Close it.",
      })
    ).rejects.toThrow(/more than they were owed/i);
  });

  test("a return larger than the advance is refused rather than inverting the balance", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });

    // Left alone this drives the balance negative, and the module then
    // instructs somebody to pay a reimbursement that is not owed.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: jod(800),
      })
    ).rejects.toThrow(/issued/i);
  });

  test("a debt owed to an employee cannot be written off unpaid", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });
    await addFee(seed, { actualAmountMinor: jod(750), paidBy: "EMPLOYEE", custodyId });

    // A write-off is the dealership absorbing a loss. It is not a way to stop
    // owing a person — and closing it that way would let the deal classify as
    // settled.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
        orgId: seed.orgId, custodyId,
        notes: "Employee left.",
        writeOffReason: "Not paying this back.",
      })
    ).rejects.toThrow(/cannot be written off here/i);
  });

  test("a mistyped issuance is corrected by a reversal, not by a fictitious return", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(7000),
    });
    const entryId = await seed.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("financeDealCustodyEntries")
        .withIndex("by_custody", (q) => q.eq("custodyId", custodyId))
        .collect();
      return rows[0]._id;
    });

    // The only alternative was a RETURNED of 6,300, asserting as fact that the
    // employee handed back cash they never received.
    await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
      orgId: seed.orgId, custodyId, kind: "REVERSAL",
      reversesEntryId: entryId, amountMinor: jod(7000),
      note: "Mistyped: should have been 700.",
    });
    await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
      orgId: seed.orgId, custodyId, kind: "ISSUED", amountMinor: jod(700),
    });

    const custody = await seed.t.run((ctx) => ctx.db.get(custodyId));
    expect(custody?.issuedMinor).toBe(jod(700));
    // Both the mistake and its correction stay on the record.
    const entries = await seed.t.run((ctx) =>
      ctx.db
        .query("financeDealCustodyEntries")
        .withIndex("by_custody", (q) => q.eq("custodyId", custodyId))
        .collect()
    );
    expect(entries).toHaveLength(3);

    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "REVERSAL",
        reversesEntryId: entryId, amountMinor: jod(7000),
      })
    ).rejects.toThrow(/already been reversed/i);
  });

  test("reversing an issuance cannot leave more returned than was ever issued", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });
    const entryId = await seed.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("financeDealCustodyEntries")
        .withIndex("by_custody", (q) => q.eq("custodyId", custodyId))
        .collect();
      return rows[0]._id;
    });
    await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
      orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: jod(700),
    });

    // The RETURNED guard is satisfied (700 is not > 700), so reversing the
    // ISSUED entry reached the same forbidden state from the other side: the
    // log said more came back than ever went out, and the module then reported
    // a 700 reimbursement due and instructed somebody to pay it. Guarding one
    // mutation was not enough; the invariant belongs where the paths converge.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "REVERSAL",
        reversesEntryId: entryId, amountMinor: jod(700),
      })
    ).rejects.toThrow(/cannot both be true/i);

    const costs = await readCosts(seed);
    expect(costs.custody[0]?.summary.reimbursementOutstandingMinor).toBe(0);
    expect(costs.custody[0]?.summary.overReturnedMinor).toBe(0);
  });

  test("a reversal can only cancel a movement on its own custody record", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });
    const otherUserId = await seed.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "costs_emp2_1", email: "e2@x.com" })
    );
    await seed.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", seed.orgId))
        .first();
      await ctx.db.insert("memberships", {
        orgId: seed.orgId, userId: otherUserId, roleId: membership!.roleId,
      });
    });
    const otherCustodyId = await seed.asUser.mutation(
      api.financeDealCosts.openDealCustody,
      {
        orgId: seed.orgId, applicationId: seed.applicationId,
        userId: otherUserId, issuedMinor: jod(300),
      }
    );
    const otherEntryId = await seed.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("financeDealCustodyEntries")
        .withIndex("by_custody", (q) => q.eq("custodyId", otherCustodyId))
        .collect();
      return rows[0]._id;
    });

    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "REVERSAL",
        reversesEntryId: otherEntryId, amountMinor: jod(300),
      })
    ).rejects.toThrow(/different custody record/i);
  });

  test("a reversal must cancel the whole movement, and only a reversal may name one", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });
    const entryId = await seed.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("financeDealCustodyEntries")
        .withIndex("by_custody", (q) => q.eq("custodyId", custodyId))
        .collect();
      return rows[0]._id;
    });

    // A partial reversal would leave the record asserting an issuance that
    // never happened at an amount nobody chose.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "REVERSAL",
        reversesEntryId: entryId, amountMinor: jod(300),
      })
    ).rejects.toThrow(/whole movement/i);

    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "RETURNED",
        reversesEntryId: entryId, amountMinor: jod(100),
      })
    ).rejects.toThrow(/Only a reversal/i);

    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "REVERSAL", amountMinor: jod(700),
      })
    ).rejects.toThrow(/which movement this reverses/i);
  });

  test("replacing a cost's receipts deletes the ones it drops", async () => {
    const seed = await seedDeal();
    const first = await seed.t.run((ctx) => ctx.storage.store(new Blob(["receipt-a"])));
    const second = await seed.t.run((ctx) => ctx.storage.store(new Blob(["receipt-b"])));

    const feeId = await seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
      orgId: seed.orgId,
      applicationId: seed.applicationId,
      feeType: "LICENSING",
      paidBy: "DEALER",
      paidTo: "GOVERNMENT",
      accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
      actualAmountMinor: jod(120),
      documentStorageIds: [first],
    });

    // Both deletion paths enumerate ROWS, so a blob dropped from the array is
    // referenced by nothing and survives the org hard-delete and the financial
    // reset alike.
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(137),
      documentStorageIds: [second],
    });

    expect(await seed.t.run((ctx) => ctx.storage.getUrl(first))).toBeNull();
    expect(await seed.t.run((ctx) => ctx.storage.getUrl(second))).not.toBeNull();
  });

  test("custody cannot be issued to yourself", async () => {
    const seed = await seedDeal();
    await expect(
      seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
        orgId: seed.orgId, applicationId: seed.applicationId,
        userId: seed.userId, issuedMinor: jod(700),
      })
    ).rejects.toThrow(/other than the person receiving it/i);
  });
});

describe("reconciled work is not destroyable from below", () => {
  /** A member holding the SALES template: CREATE but not CONFIRM. */
  async function addSalesMember(seed: Seed): Promise<AuthenticatedTestConvex> {
    const template = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "SALES");
    if (!template) throw new Error("SALES template missing");
    await seed.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkId: "costs_sales_1",
        email: "sales@x.com",
      });
      const roleId = await ctx.db.insert("roles", {
        orgId: seed.orgId,
        name: "SALES",
        permissions: [...template.permissions],
      });
      await ctx.db.insert("memberships", { orgId: seed.orgId, userId, roleId });
    });
    return seed.t.withIdentity({ subject: "costs_sales_1" });
  }

  test("a salesperson cannot overwrite an accountant's reconciled figure", async () => {
    const seed = await seedDeal();
    const asSales = await addSalesMember(seed);
    const feeId = await addFee(seed, { actualAmountMinor: jod(750) });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: seed.orgId, feeId, notes: "Matched receipt #4471.",
    });

    // Re-recording the amount is the MORE destructive of the two routes:
    // voiding preserves the figure and records a reason, this replaces the
    // figure, the checker's identity and their notes outright. Escalating only
    // the void left the easier door open.
    await expect(
      asSales.mutation(api.financeDealCosts.recordActualFeeAmount, {
        orgId: seed.orgId, feeId, actualAmountMinor: jod(300),
      })
    ).rejects.toThrow(/confirm finance disbursements/i);
    await expect(
      asSales.mutation(api.financeDealCosts.voidDealFee, {
        orgId: seed.orgId, feeId, reason: "Not needed.",
      })
    ).rejects.toThrow(/confirm finance disbursements/i);

    const costs = await readCosts(seed);
    expect(costs.fees[0]?.actualAmountMinor).toBe(jod(750));
    expect(costs.fees[0]?.reconciliationNotes).toBe("Matched receipt #4471.");
  });

  test("re-recording a reconciled amount is audited, not silent", async () => {
    const seed = await seedDeal();
    const feeId = await addFee(seed, { actualAmountMinor: jod(750) });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: seed.orgId, feeId, notes: "Matched receipt #4471.",
    });

    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(770),
    });

    const overrides = await seed.t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId))
        .collect()
    );
    const row = overrides.find((o) => o.field === "financeDealFees.actualAmountMinor");
    expect(row?.previousValue).toContain(String(jod(750)));
    expect(row?.previousValue).toContain("#4471");
  });

  test("a cost cannot be reconciled twice, erasing who checked it first", async () => {
    const seed = await seedDeal();
    const feeId = await addFee(seed, { actualAmountMinor: jod(750) });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: seed.orgId, feeId, notes: "Matched receipt #4471.",
    });

    await expect(
      seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: seed.orgId, feeId, notes: "ok",
      })
    ).rejects.toThrow(/already been reconciled/i);
    expect((await readCosts(seed)).fees[0]?.reconciliationNotes).toBe(
      "Matched receipt #4471."
    );
  });

  test("reopening a written-off record keeps the reason the loss was accepted for", async () => {
    const seed = await seedDeal();
    const custodyId = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });
    await addFee(seed, { actualAmountMinor: jod(600), paidBy: "EMPLOYEE", custodyId });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      orgId: seed.orgId, custodyId,
      notes: "Receipts 4471, 4472 checked against the till.",
      writeOffReason: "100 JOD shortfall absorbed per manager approval.",
    });

    await seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, {
      orgId: seed.orgId, custodyId, reason: "A late receipt turned up.",
    });

    // The patch clears four fields. Without a snapshot, the justification for a
    // loss the dealership absorbed becomes unrecoverable.
    const overrides = await seed.t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId))
        .collect()
    );
    const row = overrides.find((o) => o.field === "financeDealCustody.status");
    expect(row?.previousValue).toContain("WRITTEN_OFF");
    expect(row?.previousValue).toContain("manager approval");
    expect(row?.previousValue).toContain("4471");
  });
});

describe("the legal invoice and accounting classification", () => {
  test("classification refuses until the legal invoice is recorded", async () => {
    const seed = await seedDeal();

    await expect(
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
        orgId: seed.orgId, applicationId: seed.applicationId, notes: "Looks fine.",
      })
    ).rejects.toThrow(/legal invoice/i);
  });

  test("estimates run the deal but cannot close it", async () => {
    const seed = await seedDeal();
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: seed.orgId,
      applicationId: seed.applicationId,
      legalInvoiceAmountMinor: jod(10_500),
      legalInvoiceNumber: "INV-2026-0042",
      legalInvoiceDate: Date.now(),
      issuedTo: "FINANCE_COMPANY",
    });
    const feeId = await addFee(seed, { estimatedAmountMinor: jod(120) });

    await expect(
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
        orgId: seed.orgId, applicationId: seed.applicationId, notes: "Close it.",
      })
    ).rejects.toThrow(/no actual amount recorded/i);

    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(137),
    });

    // Recorded is still not checked.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
        orgId: seed.orgId, applicationId: seed.applicationId, notes: "Close it.",
      })
    ).rejects.toThrow(/nobody has checked it/i);

    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: seed.orgId, feeId, notes: "Matched to the receipt.",
    });
    await seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
      orgId: seed.orgId,
      applicationId: seed.applicationId,
      notes: "Invoice, agreement and settlement advice all on file.",
    });

    expect((await readCosts(seed)).accountingClassification).toBe("CLASSIFIED");
  });

  test("an open custody record blocks classification", async () => {
    const seed = await seedDeal();
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: "INV-1",
      legalInvoiceDate: Date.now(), issuedTo: "CUSTOMER",
    });
    // A reconciled cost, so the gate gets past the itemization check and the
    // custody one is what actually fires.
    const feeId = await addFee(seed, { actualAmountMinor: jod(120) });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: seed.orgId, feeId, notes: "Matched to the receipt.",
    });
    await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      userId: seed.employeeId, issuedMinor: jod(700),
    });

    await expect(
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, {
        orgId: seed.orgId, applicationId: seed.applicationId, notes: "Close it.",
      })
    ).rejects.toThrow(/custody record on this deal is still open/i);
  });

  test("a deal defaults to pending classification rather than looking settled", async () => {
    const seed = await seedDeal();
    expect((await readCosts(seed)).accountingClassification).toBe("PENDING_CLASSIFICATION");
  });

  test("replacing a recorded invoice is audited", async () => {
    const seed = await seedDeal();
    const invoice = {
      orgId: seed.orgId,
      applicationId: seed.applicationId,
      legalInvoiceDate: Date.now(),
      issuedTo: "FINANCE_COMPANY" as const,
    };
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      ...invoice, legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: "INV-1",
    });
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      ...invoice, legalInvoiceAmountMinor: jod(12_500), legalInvoiceNumber: "INV-2",
    });

    // This is the one figure revenue may be posted from, so a silent edit to it
    // is the most consequential silent edit on the deal.
    const overrides = await seed.t.run((ctx) =>
      ctx.db
        .query("financeApplicationOverrides")
        .withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId))
        .collect()
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.previousValue).toContain(String(jod(10_500)));
    expect(overrides[0]?.previousValue).toContain("INV-1");
    expect(overrides[0]?.newValue).toContain(String(jod(12_500)));
    expect(overrides[0]?.newValue).toContain("INV-2");
  });

  test("the invoice amount is never derived from the deal's other figures", async () => {
    const seed = await seedDeal();
    // The deal carries a target selling amount and an approved purchase amount.
    await seed.t.run((ctx) =>
      ctx.db.patch(seed.applicationId, {
        targetNetProceedsMinor: jod(10_500),
        approvedDealerPurchaseAmountMinor: jod(12_500),
      })
    );

    // Neither becomes the invoice. It stays unset until somebody records the
    // document, because on a financed deal those are three different numbers
    // describing three different things.
    const costs = await readCosts(seed);
    expect(costs.legalInvoiceAmountMinor).toBeUndefined();
    expect(costs.accountingClassification).toBe("PENDING_CLASSIFICATION");
  });
});

describe("tenancy", () => {
  test("another organization's deal is not reachable", async () => {
    // Both orgs in ONE instance. Seeding two separate convexTest instances
    // gives two separate databases, where an id from one may coincidentally
    // resolve to a different row in the other — so the test would pass without
    // the ownership check doing anything.
    const seed = await seedDeal();
    const { otherOrgId, otherApplicationId } = await seed.t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", {
        name: "Rival Motors",
        createdAt: Date.now(),
      });
      const rivalUserId = await ctx.db.insert("users", {
        clerkId: "rival_user_1",
        email: "rival@x.com",
      });
      const roleId = await ctx.db.insert("roles", {
        orgId: otherOrgId,
        name: "OWNER",
        permissions: ALL_PERMISSIONS,
        isSystemOwnerRole: true,
      });
      await ctx.db.insert("memberships", { orgId: otherOrgId, userId: rivalUserId, roleId });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId: otherOrgId, vin: "RIVALVIN1", make: "Kia", model: "Rio", year: 2024,
        mileage: 10, color: "Blue", fuelType: "Gas", transmission: "Auto",
        sellingPrice: 8000, status: "AVAILABLE",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId: otherOrgId, firstName: "Rival", lastName: "Customer",
      });
      const quoteId = await ctx.db.insert("quotes", {
        orgId: otherOrgId, customerId, vehicleId, vehiclePrice: 8000, downPayment: 500,
        termMonths: 48, status: "ACCEPTED", createdBy: rivalUserId, createdAt: Date.now(),
      });
      const otherApplicationId = await ctx.db.insert("financeApplications", {
        orgId: otherOrgId, quoteId, customerId, vehicleId, salespersonId: rivalUserId,
        status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      });
      return { otherOrgId, otherApplicationId };
    });
    void otherOrgId;

    // Naming your own org while pointing at another org's deal is the exact
    // shape that shipped two Criticals: the tenant check passes, and only the
    // row-ownership check can catch it.
    await expect(
      seed.asUser.query(api.financeDealCosts.listDealCosts, {
        orgId: seed.orgId,
        applicationId: otherApplicationId,
      })
    ).rejects.toThrow(/not found/i);

    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
        orgId: seed.orgId,
        applicationId: otherApplicationId,
        feeType: "LICENSING",
        paidBy: "DEALER",
        paidTo: "GOVERNMENT",
        accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
        estimatedAmountMinor: jod(100),
      })
    ).rejects.toThrow(/not found/i);

    await expect(
      seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
        orgId: seed.orgId,
        applicationId: otherApplicationId,
        userId: seed.employeeId,
        issuedMinor: jod(100),
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe("input validation", () => {
  test("rejects NaN and negative money, which pass Convex's own validator", async () => {
    const seed = await seedDeal();

    await expect(
      addFee(seed, { estimatedAmountMinor: Number.NaN })
    ).rejects.toThrow();
    await expect(addFee(seed, { actualAmountMinor: -1 })).rejects.toThrow();
    await expect(
      seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
        orgId: seed.orgId,
        applicationId: seed.applicationId,
        userId: seed.employeeId,
        issuedMinor: Number.NaN,
      })
    ).rejects.toThrow();
  });
});
