/**
 * SCRUM-834: reconciling a recorded cost (the finance company's execution fee
 * was the pilot deal's case: expected 1,250 JOD, actual 1,500 JOD).
 *
 *  F1  The checker certifies the figure THEY SAW. `reconcileDealFee` takes the
 *      actual amount the checker looked at and refuses when the row has moved
 *      since, so an edit that lands between "open the form" and "submit" can
 *      never be certified by notes written about a different number.
 *  F2  The person who certified a cost is not then reimbursed for it: charging
 *      a reconciled cost to the custody record of the person who reconciled it
 *      is the same self-certification loop `reconcileDealFee` already refuses
 *      in the other order.
 *  F3  The amount alone does not identify what was checked. A re-record that
 *      keeps the amount can replace the receipt reference, paid date or
 *      attachments, so `reconcileDealFee` also pins the line's
 *      `actualEvidenceRevision` (absent = 0). `recordActualFeeAmount` moves it,
 *      and so does an identical re-record; charging the line to custody does not
 *      (payment and binding writes are not exercised here).
 *
 *  Until the live screen is promoted the two pins are accepted as a pair or not
 *  at all (the rollout bridge, `scrum834ReconcileRolloutBridge.test.ts`): an
 *  unpinned call still reconciles, one pin without the other is refused, and a
 *  pinned call is validated as in F1 and F3.
 */
import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

const MODULES = import.meta.glob("./**/*.*s");

/** JOD minor units (scale 3). */
const jod = (major: number): number => Math.round(major * 1000);

async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Reconcile ${tag}`, createdAt: Date.now() }));
  const ownerRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  const member = async (suffix: string, roleId: Id<"roles">) => {
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_${suffix}`, email: `${tag}.${suffix}@x.com` }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return { userId, as: t.withIdentity({ subject: `${tag}_${suffix}` }) };
  };
  const operator = await member("operator", ownerRole);
  // The holder of the custody cash is an owner-tier member in their own right:
  // the case under test is a person who may reconcile AND holds cash.
  const holder = await member("holder", ownerRole);
  const salesTemplate = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "SALES");
  if (!salesTemplate) throw new Error("SALES template missing");
  const salesRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: [...salesTemplate.permissions] })
  );
  const sales = await member("sales", salesRole);

  const applicationId = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `RECVIN${tag}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 10_500, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Rec", lastName: "Customer" });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 10_500, downPayment: 500,
      termMonths: 48, status: "ACCEPTED", createdBy: operator.userId, createdAt: Date.now(),
    });
    return await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: operator.userId,
      status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await operator.as.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await operator.as.mutation(api.accountingPeriods.create, {
    orgId, fiscalYear: year, periodNumber: 1,
    startDate: Date.UTC(year - 1, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    openImmediately: true,
  });
  return { t, orgId, applicationId, operator, holder, sales };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function addFee(s: Seeded, paidBy: "DEALER" | "EMPLOYEE", actualAmountMinor: number): Promise<Id<"financeDealFees">> {
  return await s.operator.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(),
    orgId: s.orgId, applicationId: s.applicationId,
    feeType: "FINANCE_COMPANY_FEE", paidBy, paidTo: "FINANCE_COMPANY",
    accountingTreatment: paidBy === "EMPLOYEE" ? "OWNERSHIP_TRANSFER_EXPENSE" : "FINANCE_COMPANY_COMMISSION",
    actualAmountMinor,
  });
}

async function feeRow(s: Seeded, feeId: Id<"financeDealFees">) {
  return await s.t.run((ctx) => ctx.db.get(feeId));
}

describe("F1: a reconciliation is pinned to the amount the checker saw", () => {
  test("certifies the displayed figure when it is still the recorded one", async () => {
    const s = await seed("f1a");
    const feeId = await addFee(s, "DEALER", jod(1500));
    await s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes: "Matched the company's receipt #77.", expectedActualAmountMinor: jod(1500), expectedActualEvidenceRevision: 0,
    });
    const row = await feeRow(s, feeId);
    expect(row?.reconciledAt).toBeDefined();
    expect(row?.reconciledBy).toBe(s.operator.userId);
    expect(row?.reconciliationNotes).toBe("Matched the company's receipt #77.");
  });

  test("refuses when the actual was edited after the checker opened the form, and certifies nothing", async () => {
    const s = await seed("f1b");
    const feeId = await addFee(s, "DEALER", jod(1250));
    // The checker looked at 1,250; before they submitted, somebody re-recorded it.
    await s.operator.as.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, expectedCurrency: "JOD", actualAmountMinor: jod(1500),
    });
    await expect(
      s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "Matched receipt for 1,250.", expectedActualAmountMinor: jod(1250), expectedActualEvidenceRevision: 0,
      })
    ).rejects.toThrow(/changed since you opened it/i);
    const row = await feeRow(s, feeId);
    expect(row?.reconciledAt).toBeUndefined();
    expect(row?.reconciledBy).toBeUndefined();
    expect(row?.reconciliationNotes).toBeUndefined();
    expect(row?.actualAmountMinor).toBe(jod(1500));
    // Re-opening against what is actually recorded works.
    await s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes: "Matched receipt for 1,500.", expectedActualAmountMinor: jod(1500), expectedActualEvidenceRevision: 1,
    });
    expect((await feeRow(s, feeId))?.reconciledAt).toBeDefined();
  });

  test("refuses NaN, which passes Convex's number validator and equals nothing", async () => {
    const s = await seed("f1c");
    const feeId = await addFee(s, "DEALER", jod(1500));
    await expect(
      s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "x", expectedActualAmountMinor: Number.NaN, expectedActualEvidenceRevision: 0,
      })
    ).rejects.toThrow(/changed since you opened it/i);
    expect((await feeRow(s, feeId))?.reconciledAt).toBeUndefined();
  });

  test("an unpinned call (the screen from before the frontend changed) still reconciles during the rollout bridge", async () => {
    const s = await seed("f1d");
    const feeId = await addFee(s, "DEALER", jod(1500));
    await s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes: "Matched receipt #77." });
    const row = await feeRow(s, feeId);
    expect(row?.reconciledAt).toBeDefined();
    expect(row?.reconciledBy).toBe(s.operator.userId);
    expect(row?.reconciliationNotes).toBe("Matched receipt #77.");
  });

  test("a member without confirm:finance_disbursement cannot reconcile", async () => {
    const s = await seed("f1e");
    const feeId = await addFee(s, "DEALER", jod(1500));
    await expect(
      s.sales.as.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "x", expectedActualAmountMinor: jod(1500), expectedActualEvidenceRevision: 0,
      })
    ).rejects.toThrow(/missing required permissions: confirm:finance_disbursement/i);
    expect((await feeRow(s, feeId))?.reconciledAt).toBeUndefined();
  });

  test("another organization's operator cannot reconcile this organization's cost", async () => {
    const s = await seed("f1f");
    const feeId = await addFee(s, "DEALER", jod(1500));
    // A second organization in the SAME database, with its own owner.
    const otherOrgId = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Other dealer", createdAt: Date.now() }));
    const otherRole = await s.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: otherOrgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
    );
    const otherUserId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "f1f_other", email: "other@x.com" }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUserId, roleId: otherRole }));
    const asOther = s.t.withIdentity({ subject: "f1f_other" });
    // Naming the victim's org: the caller is not a member of it.
    await expect(
      asOther.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "x", expectedActualAmountMinor: jod(1500), expectedActualEvidenceRevision: 0,
      })
    ).rejects.toThrow(/You are not a member of this organization/);
    // Naming their own org with this org's row id: the row is not theirs.
    await expect(
      asOther.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: otherOrgId, feeId, notes: "x", expectedActualAmountMinor: jod(1500), expectedActualEvidenceRevision: 0,
      })
    ).rejects.toThrow(/not found in this organization/i);
    expect((await feeRow(s, feeId))?.reconciledAt).toBeUndefined();
  });
});

describe("F2: the person who reconciled a cost is not reimbursed for it from their own custody", () => {
  async function holderCustody(s: Seeded): Promise<Id<"financeDealCustody">> {
    return await s.operator.as.mutation(api.financeDealCosts.openDealCustody, {
      method: "CASH", idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId, applicationId: s.applicationId, userId: s.holder.userId, issuedMinor: jod(5000),
    });
  }

  test("charging a cost the holder reconciled to the holder's custody is refused, and nothing moves", async () => {
    const s = await seed("f2a");
    const feeId = await addFee(s, "EMPLOYEE", jod(100));
    const custodyId = await holderCustody(s);
    // The holder certifies the cost while it sits on no custody record, which
    // `reconcileDealFee` allows.
    await s.holder.as.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes: "Checked the receipt.", expectedActualAmountMinor: jod(100), expectedActualEvidenceRevision: 0,
    });
    // Another person then charges it to the holder's own custody.
    await expect(
      s.operator.as.mutation(api.financeDealCosts.setFeeCustody, { orgId: s.orgId, feeId, custodyId })
    ).rejects.toThrow(/reconciled by the person holding that custody record, who cannot then be reimbursed for it/);
    const row = await feeRow(s, feeId);
    expect(row?.custodyId).toBeUndefined();
    expect(row?.custodyPosted).toBeUndefined();
  });

  test("a cost reconciled by somebody else may still be charged to the holder's custody", async () => {
    const s = await seed("f2b");
    const feeId = await addFee(s, "EMPLOYEE", jod(100));
    const custodyId = await holderCustody(s);
    await s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes: "Checked the receipt.", expectedActualAmountMinor: jod(100), expectedActualEvidenceRevision: 0,
    });
    await s.operator.as.mutation(api.financeDealCosts.setFeeCustody, { orgId: s.orgId, feeId, custodyId });
    expect((await feeRow(s, feeId))?.custodyId).toBe(custodyId);
  });

  test("an unreconciled cost may be charged to the holder's custody (no regression)", async () => {
    const s = await seed("f2c");
    const feeId = await addFee(s, "EMPLOYEE", jod(100));
    const custodyId = await holderCustody(s);
    await s.operator.as.mutation(api.financeDealCosts.setFeeCustody, { orgId: s.orgId, feeId, custodyId });
    expect((await feeRow(s, feeId))?.custodyId).toBe(custodyId);
  });
});

describe("F3: a reconciliation is pinned to the evidence revision the checker saw", () => {
  const reconcile = (s: Seeded, feeId: Id<"financeDealFees">, amount: number, revision: number, notes = "Checked the evidence.") =>
    s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes, expectedActualAmountMinor: amount, expectedActualEvidenceRevision: revision,
    });
  const reRecord = (
    s: Seeded,
    feeId: Id<"financeDealFees">,
    amount: number,
    evidence: { paidAt?: number; receiptReference?: string; documentStorageIds?: Id<"_storage">[] } = {}
  ) =>
    s.operator.as.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, expectedCurrency: "JOD", actualAmountMinor: amount, ...evidence,
    });
  const staleRefusal = /re-recorded since you opened it/i;
  const lonePinRefusal = /pins both the amount and the evidence revision it was checked against, or neither/;

  async function expectNothingCertified(s: Seeded, feeId: Id<"financeDealFees">) {
    const row = await feeRow(s, feeId);
    expect(row?.reconciledAt).toBeUndefined();
    expect(row?.reconciledBy).toBeUndefined();
    expect(row?.reconciliationNotes).toBeUndefined();
  }

  test("a fresh line stores no revision and reconciles with a pinned revision of 0", async () => {
    const s = await seed("f3a");
    const feeId = await addFee(s, "DEALER", jod(1500));
    expect((await feeRow(s, feeId))?.actualEvidenceRevision).toBeUndefined();
    await reconcile(s, feeId, jod(1500), 0);
    expect((await feeRow(s, feeId))?.reconciledAt).toBeDefined();
  });

  test("the read serves the revision the form must pin: 0 for a legacy row, one more per re-record", async () => {
    const s = await seed("f3b");
    const feeId = await addFee(s, "DEALER", jod(1500));
    const read = async () =>
      (await s.operator.as.query(api.financeDealCosts.listDealCosts, { orgId: s.orgId, applicationId: s.applicationId }))
        .fees.find((fee) => fee._id === feeId)?.actualEvidenceRevision;
    expect(await read()).toBe(0);
    await reRecord(s, feeId, jod(1500));
    expect(await read()).toBe(1);
  });

  test("SAME amount, replaced receipt reference: the stale check is refused and a fresh retry is certified", async () => {
    const s = await seed("f3c");
    const feeId = await addFee(s, "DEALER", jod(1500));
    await reRecord(s, feeId, jod(1500), { receiptReference: "REC-1" });
    // The checker opened the form here: amount 1,500, revision 1, receipt REC-1.
    await reRecord(s, feeId, jod(1500), { receiptReference: "REC-2" });
    const row = await feeRow(s, feeId);
    expect(row?.actualAmountMinor).toBe(jod(1500));
    expect(row?.receiptReference).toBe("REC-2");
    expect(row?.actualEvidenceRevision).toBe(2);

    await expect(reconcile(s, feeId, jod(1500), 1, "Matched REC-1.")).rejects.toThrow(staleRefusal);
    await expectNothingCertified(s, feeId);

    await reconcile(s, feeId, jod(1500), 2, "Matched REC-2.");
    expect((await feeRow(s, feeId))?.reconciliationNotes).toBe("Matched REC-2.");
  });

  test("SAME amount, replaced paid date: the stale check is refused and a fresh retry is certified", async () => {
    const s = await seed("f3d");
    const feeId = await addFee(s, "DEALER", jod(1500));
    const day = 24 * 60 * 60 * 1000;
    await reRecord(s, feeId, jod(1500), { paidAt: Date.now() - 10 * day });
    await reRecord(s, feeId, jod(1500), { paidAt: Date.now() - 3 * day });

    await expect(reconcile(s, feeId, jod(1500), 1)).rejects.toThrow(staleRefusal);
    await expectNothingCertified(s, feeId);
    await reconcile(s, feeId, jod(1500), 2);
    expect((await feeRow(s, feeId))?.reconciledAt).toBeDefined();
  });

  test("SAME amount, replaced attachments: the stale check is refused and a fresh retry is certified", async () => {
    const s = await seed("f3e");
    const feeId = await addFee(s, "DEALER", jod(1500));
    const first = await s.t.run((ctx) => ctx.storage.store(new Blob(["receipt-a"])));
    const second = await s.t.run((ctx) => ctx.storage.store(new Blob(["receipt-b"])));
    await reRecord(s, feeId, jod(1500), { documentStorageIds: [first] });
    await reRecord(s, feeId, jod(1500), { documentStorageIds: [second] });
    expect((await feeRow(s, feeId))?.documentStorageIds).toEqual([second]);

    await expect(reconcile(s, feeId, jod(1500), 1)).rejects.toThrow(staleRefusal);
    await expectNothingCertified(s, feeId);
    await reconcile(s, feeId, jod(1500), 2);
    expect((await feeRow(s, feeId))?.reconciledAt).toBeDefined();
  });

  test("an IDENTICAL re-record still moves the revision, so a pin taken before it is refused", async () => {
    const s = await seed("f3f");
    const feeId = await addFee(s, "DEALER", jod(1500));
    await reRecord(s, feeId, jod(1500));
    await expect(reconcile(s, feeId, jod(1500), 0)).rejects.toThrow(staleRefusal);
    await reconcile(s, feeId, jod(1500), 1);
  });

  test("an amount change is still caught by the amount pin, whatever revision is sent", async () => {
    const s = await seed("f3g");
    const feeId = await addFee(s, "DEALER", jod(1250));
    await reRecord(s, feeId, jod(1500));
    await expect(reconcile(s, feeId, jod(1250), 1)).rejects.toThrow(/changed since you opened it/i);
    await expectNothingCertified(s, feeId);
  });

  test("a revision from the future and a NaN certify nothing, and one pin without the other is refused (both or neither)", async () => {
    const s = await seed("f3h");
    const feeId = await addFee(s, "DEALER", jod(1500));
    await expect(reconcile(s, feeId, jod(1500), 1)).rejects.toThrow(staleRefusal);
    await expect(reconcile(s, feeId, jod(1500), Number.NaN)).rejects.toThrow(staleRefusal);
    await expect(
      s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "x", expectedActualAmountMinor: jod(1500),
      })
    ).rejects.toThrow(lonePinRefusal);
    await expect(
      s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "x", expectedActualEvidenceRevision: 0,
      })
    ).rejects.toThrow(lonePinRefusal);
    await expectNothingCertified(s, feeId);
  });

  test("charging the line to custody does not move the revision, and a pin at 0 still certifies", async () => {
    const s = await seed("f3i");
    const feeId = await addFee(s, "EMPLOYEE", jod(100));
    const custodyId = await s.operator.as.mutation(api.financeDealCosts.openDealCustody, {
      method: "CASH", idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId, applicationId: s.applicationId, userId: s.holder.userId, issuedMinor: jod(5000),
    });
    expect((await feeRow(s, feeId))?.custodyId).toBeUndefined();
    await s.operator.as.mutation(api.financeDealCosts.setFeeCustody, { orgId: s.orgId, feeId, custodyId });
    const after = await feeRow(s, feeId);
    // The write really happened (the line sits on the record now)...
    expect(after?.custodyId).toBe(custodyId);
    // ...and it replaced no evidence, so the revision a checker pinned earlier is still the one on file.
    expect(after?.actualEvidenceRevision).toBeUndefined();
    await reconcile(s, feeId, jod(100), 0);
    expect((await feeRow(s, feeId))?.reconciledAt).toBeDefined();
  });

  test("re-recording a reconciled line withdraws the reconciliation AND moves the revision", async () => {
    const s = await seed("f3j");
    const feeId = await addFee(s, "DEALER", jod(1500));
    await reconcile(s, feeId, jod(1500), 0);
    await reRecord(s, feeId, jod(1500), { receiptReference: "REC-9" });
    const row = await feeRow(s, feeId);
    expect(row?.reconciledAt).toBeUndefined();
    expect(row?.actualEvidenceRevision).toBe(1);
    await expect(reconcile(s, feeId, jod(1500), 0)).rejects.toThrow(staleRefusal);
    await reconcile(s, feeId, jod(1500), 1);
  });

  test("a stored revision that is not a count refuses the re-record rather than minting the next one", async () => {
    const s = await seed("f3k");
    const feeId = await addFee(s, "DEALER", jod(1500));
    await s.t.run((ctx) => ctx.db.patch(feeId, { actualEvidenceRevision: -1 }));
    await expect(reRecord(s, feeId, jod(1500), { receiptReference: "REC-1" })).rejects.toThrow(/not a usable count/i);
    const row = await feeRow(s, feeId);
    expect(row?.actualEvidenceRevision).toBe(-1);
    expect(row?.receiptReference).toBeUndefined();
  });

  test("a SALES member is refused a pinned and an unpinned reconcile, and nothing is certified", async () => {
    const s = await seed("f3l");
    const feeId = await addFee(s, "DEALER", jod(1500));
    await expect(
      s.sales.as.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "x", expectedActualAmountMinor: jod(1500), expectedActualEvidenceRevision: 0,
      })
    ).rejects.toThrow(/missing required permissions: confirm:finance_disbursement/i);
    await expect(
      s.sales.as.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes: "x" })
    ).rejects.toThrow(/missing required permissions: confirm:finance_disbursement/i);
    await expectNothingCertified(s, feeId);
  });
});
