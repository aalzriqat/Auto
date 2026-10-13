/**
 * SCRUM-834 rollout bridge: `reconcileDealFee` accepts BOTH contracts for a short
 * window.
 *
 * The pins ship with a frontend. A merge to main automatically creates a Vercel
 * build, but autoflowdealer.com is promoted by hand, after the protected Convex
 * deployment, so the backend that carries the pin arguments goes live while the
 * old UI (which sends no pins) is still what users load. The old call must keep
 * working until promotion, and the pinned call must be accepted from then on. In
 * the other direction a validator without these arguments rejects a pinned call
 * as extra arguments, so the backend deployment comes first. Until the pins are
 * required:
 *
 *   - a LEGACY call `{ orgId, feeId, notes }` still reconciles;
 *   - a PINNED call, carrying BOTH `expectedActualAmountMinor` and
 *     `expectedActualEvidenceRevision`, is validated strictly, exactly as the
 *     required-pin contract will validate it;
 *   - a call carrying exactly ONE pin is refused: it is neither contract.
 *
 * Every other guard (membership, row ownership, the confirm permission, voided,
 * no actual, custody holder, already reconciled, notes) is the same for all three
 * shapes and is pinned below, along with the revision tracking the pin depends on.
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
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Bridge ${tag}`, createdAt: Date.now() }));
  const ownerRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  const member = async (suffix: string, roleId: Id<"roles">) => {
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_${suffix}`, email: `${tag}.${suffix}@x.com` }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return { userId, as: t.withIdentity({ subject: `${tag}_${suffix}` }) };
  };
  const operator = await member("operator", ownerRole);
  // An owner-tier member who also holds custody cash: may reconcile, may not certify their own reimbursement.
  const holder = await member("holder", ownerRole);
  const salesTemplate = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "SALES");
  if (!salesTemplate) throw new Error("SALES template missing");
  const salesRole = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: [...salesTemplate.permissions] }));
  const sales = await member("sales", salesRole);

  const applicationId = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `BRGVIN${tag}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 10_500, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Bridge", lastName: "Customer" });
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
type FeeId = Id<"financeDealFees">;

async function addFee(
  s: Seeded,
  overrides: { paidBy?: "DEALER" | "EMPLOYEE"; actualAmountMinor?: number | null; estimatedAmountMinor?: number } = {}
): Promise<FeeId> {
  const paidBy = overrides.paidBy ?? "DEALER";
  const actual = overrides.actualAmountMinor === undefined ? jod(1500) : overrides.actualAmountMinor;
  return await s.operator.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(),
    orgId: s.orgId, applicationId: s.applicationId,
    feeType: "FINANCE_COMPANY_FEE", paidBy, paidTo: "FINANCE_COMPANY",
    accountingTreatment: paidBy === "EMPLOYEE" ? "OWNERSHIP_TRANSFER_EXPENSE" : "FINANCE_COMPANY_COMMISSION",
    ...(actual === null ? {} : { actualAmountMinor: actual }),
    ...(overrides.estimatedAmountMinor === undefined ? {} : { estimatedAmountMinor: overrides.estimatedAmountMinor }),
  });
}

const feeRow = (s: Seeded, feeId: FeeId) => s.t.run((ctx) => ctx.db.get(feeId));

async function expectNothingCertified(s: Seeded, feeId: FeeId) {
  const row = await feeRow(s, feeId);
  expect(row?.reconciledAt).toBeUndefined();
  expect(row?.reconciledBy).toBeUndefined();
  expect(row?.reconciliationNotes).toBeUndefined();
}

/** What the old screen sends: no pins. */
const legacy = (s: Seeded, feeId: FeeId, notes = "Matched the company's receipt.", as = s.operator.as) =>
  as.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes });

/** What the new screen sends (`DealCockpit`'s `onReconcile`): both pins, exactly these five keys. */
const pinned = (
  s: Seeded,
  feeId: FeeId,
  expectedActualAmountMinor: number,
  expectedActualEvidenceRevision: number,
  notes = "Matched the company's receipt.",
  as = s.operator.as
) =>
  as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId,
    feeId,
    notes,
    expectedActualAmountMinor,
    expectedActualEvidenceRevision,
  });

describe("an OLD client (no pins) still reconciles", () => {
  test("the legacy call certifies the line, with the checker's identity and notes", async () => {
    const s = await seed("old1");
    const feeId = await addFee(s);
    await legacy(s, feeId, "Matched the company's receipt #77.");
    const row = await feeRow(s, feeId);
    expect(row?.reconciledAt).toBeDefined();
    expect(row?.reconciledBy).toBe(s.operator.userId);
    expect(row?.reconciliationNotes).toBe("Matched the company's receipt #77.");
    expect(row?.actualAmountMinor).toBe(jod(1500));
  });

  test("a legacy call after the line was re-recorded still certifies (there is no pin to go stale)", async () => {
    const s = await seed("old2");
    const feeId = await addFee(s, { actualAmountMinor: jod(1250) });
    await s.operator.as.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, expectedCurrency: "JOD", actualAmountMinor: jod(1500),
    });
    await legacy(s, feeId);
    expect((await feeRow(s, feeId))?.reconciledAt).toBeDefined();
  });
});

describe("a NEW client (both pins) is validated strictly", () => {
  test("certifies the figure and evidence revision it saw, using exactly the keys the screen sends", async () => {
    const s = await seed("new1");
    const feeId = await addFee(s);
    await pinned(s, feeId, jod(1500), 0, "Matched the company's receipt #77.");
    const row = await feeRow(s, feeId);
    expect(row?.reconciledAt).toBeDefined();
    expect(row?.reconciledBy).toBe(s.operator.userId);
    expect(row?.reconciliationNotes).toBe("Matched the company's receipt #77.");
  });

  test("a stale amount is refused, nothing is certified, and a fresh retry is accepted", async () => {
    const s = await seed("new2");
    const feeId = await addFee(s, { actualAmountMinor: jod(1250) });
    // The checker looked at 1,250; before they submitted somebody re-recorded it.
    await s.operator.as.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, expectedCurrency: "JOD", actualAmountMinor: jod(1500),
    });
    await expect(pinned(s, feeId, jod(1250), 0, "Matched receipt for 1,250.")).rejects.toThrow(/changed since you opened it/i);
    await expectNothingCertified(s, feeId);
    expect((await feeRow(s, feeId))?.actualAmountMinor).toBe(jod(1500));

    await pinned(s, feeId, jod(1500), 1, "Matched receipt for 1,500.");
    expect((await feeRow(s, feeId))?.reconciliationNotes).toBe("Matched receipt for 1,500.");
  });

  test("a SAME-amount re-record moves the evidence revision, so a stale revision is refused", async () => {
    const s = await seed("new3");
    const feeId = await addFee(s);
    await s.operator.as.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, expectedCurrency: "JOD", actualAmountMinor: jod(1500), receiptReference: "REC-1",
    });
    // The checker opened the form here: amount 1,500, revision 1, receipt REC-1.
    await s.operator.as.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, expectedCurrency: "JOD", actualAmountMinor: jod(1500), receiptReference: "REC-2",
    });
    expect((await feeRow(s, feeId))?.actualEvidenceRevision).toBe(2);

    await expect(pinned(s, feeId, jod(1500), 1, "Matched REC-1.")).rejects.toThrow(/re-recorded since you opened it/i);
    await expectNothingCertified(s, feeId);
    await pinned(s, feeId, jod(1500), 2, "Matched REC-2.");
    expect((await feeRow(s, feeId))?.reconciliationNotes).toBe("Matched REC-2.");
  });

  test.each([
    ["a NaN amount", Number.NaN, 0, /changed since you opened it/i],
    ["a NaN revision", jod(1500), Number.NaN, /re-recorded since you opened it/i],
    ["a negative revision", jod(1500), -1, /re-recorded since you opened it/i],
    ["a fractional revision", jod(1500), 0.5, /re-recorded since you opened it/i],
    ["an amount that is not the recorded one", jod(1500) + 1, 0, /changed since you opened it/i],
    ["a revision ahead of the stored one", jod(1500), 1, /re-recorded since you opened it/i],
  ])("%s matches nothing and certifies nothing", async (_label, amount, revision, refusal) => {
    const s = await seed("new4");
    const feeId = await addFee(s);
    await expect(pinned(s, feeId, amount, revision)).rejects.toThrow(refusal);
    await expectNothingCertified(s, feeId);
  });
});

describe("a call carrying exactly ONE pin is neither contract and is refused", () => {
  const either = /both|together/i;

  test("the amount pin alone", async () => {
    const s = await seed("part1");
    const feeId = await addFee(s);
    await expect(
      s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "Matched.", expectedActualAmountMinor: jod(1500),
      })
    ).rejects.toThrow(either);
    await expectNothingCertified(s, feeId);
  });

  test("the revision pin alone", async () => {
    const s = await seed("part2");
    const feeId = await addFee(s);
    await expect(
      s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "Matched.", expectedActualEvidenceRevision: 0,
      })
    ).rejects.toThrow(either);
    await expectNothingCertified(s, feeId);
  });

  test("even a correct lone pin is refused, never read as a legacy call", async () => {
    const s = await seed("part3");
    const feeId = await addFee(s, { actualAmountMinor: jod(1250) });
    await expect(
      s.operator.as.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId, feeId, notes: "Matched.", expectedActualAmountMinor: jod(1250),
      })
    ).rejects.toThrow(either);
    await expectNothingCertified(s, feeId);
  });
});

describe("every guard is the same for the old and the new call", () => {
  /** The two contracts, so each invariant is proven on both. */
  const CALLS = [
    ["legacy", (s: Seeded, feeId: FeeId, notes?: string, as?: Seeded["operator"]["as"]) => legacy(s, feeId, notes, as)],
    ["pinned", (s: Seeded, feeId: FeeId, notes?: string, as?: Seeded["operator"]["as"], amount = jod(1500)) => pinned(s, feeId, amount, 0, notes, as)],
  ] as const;

  describe.each(CALLS)("%s call", (_name, call) => {
    test("a member without confirm:finance_disbursement is refused", async () => {
      const s = await seed(`perm_${_name}`);
      const feeId = await addFee(s);
      await expect(call(s, feeId, "x", s.sales.as)).rejects.toThrow(/missing required permissions: confirm:finance_disbursement/i);
      await expectNothingCertified(s, feeId);
    });

    test("another organization's owner cannot reach this organization's cost, by either route", async () => {
      const s = await seed(`tenant_${_name}`);
      const feeId = await addFee(s);
      const otherOrgId = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Other dealer", createdAt: Date.now() }));
      const otherRole = await s.t.run((ctx) =>
        ctx.db.insert("roles", { orgId: otherOrgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
      );
      const otherUserId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: `tenant_${_name}_other`, email: `other.${_name}@x.com` }));
      await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUserId, roleId: otherRole }));
      const asOther = s.t.withIdentity({ subject: `tenant_${_name}_other` });
      const body = _name === "pinned" ? { expectedActualAmountMinor: jod(1500), expectedActualEvidenceRevision: 0 } : {};
      await expect(
        asOther.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes: "x", ...body })
      ).rejects.toThrow(/You are not a member of this organization/);
      await expect(
        asOther.mutation(api.financeDealCosts.reconcileDealFee, { orgId: otherOrgId, feeId, notes: "x", ...body })
      ).rejects.toThrow(/not found in this organization/i);
      await expectNothingCertified(s, feeId);
    });

    test("a voided cost cannot be reconciled", async () => {
      const s = await seed(`void_${_name}`);
      const feeId = await addFee(s);
      await s.operator.as.mutation(api.financeDealCosts.voidDealFee, { orgId: s.orgId, feeId, reason: "Entered on the wrong deal" });
      await expect(call(s, feeId)).rejects.toThrow(/voided and cannot be reconciled/i);
      await expectNothingCertified(s, feeId);
    });

    test("an estimate is not evidence", async () => {
      const s = await seed(`est_${_name}`);
      const feeId = await addFee(s, { actualAmountMinor: null, estimatedAmountMinor: jod(1250) });
      await expect(call(s, feeId, "x", undefined, 0)).rejects.toThrow(/estimate is not evidence/i);
      await expectNothingCertified(s, feeId);
    });

    test("a cost cannot be reconciled twice, erasing who checked it first", async () => {
      const s = await seed(`twice_${_name}`);
      const feeId = await addFee(s);
      await call(s, feeId, "First check.");
      await expect(call(s, feeId, "Second check.", s.holder.as)).rejects.toThrow(/already been reconciled/i);
      const row = await feeRow(s, feeId);
      expect(row?.reconciledBy).toBe(s.operator.userId);
      expect(row?.reconciliationNotes).toBe("First check.");
    });

    test("notes are required, and a refused call leaves the row exactly as it was", async () => {
      const s = await seed(`notes_${_name}`);
      const feeId = await addFee(s);
      const before = await feeRow(s, feeId);
      await expect(call(s, feeId, "   ")).rejects.toThrow(/Record what was checked before reconciling/i);
      expect(await feeRow(s, feeId)).toEqual(before);
    });

    test("the holder of the custody record a cost sits on cannot certify it", async () => {
      const s = await seed(`custody_${_name}`);
      const feeId = await addFee(s, { paidBy: "EMPLOYEE", actualAmountMinor: jod(100) });
      const custodyId = await s.operator.as.mutation(api.financeDealCosts.openDealCustody, {
        method: "CASH", idempotencyKey: crypto.randomUUID(),
        orgId: s.orgId, applicationId: s.applicationId, userId: s.holder.userId, issuedMinor: jod(5000),
      });
      await s.operator.as.mutation(api.financeDealCosts.setFeeCustody, { orgId: s.orgId, feeId, custodyId });
      const amount = jod(100);
      const attempt = _name === "pinned" ? pinned(s, feeId, amount, 0, "x", s.holder.as) : legacy(s, feeId, "x", s.holder.as);
      await expect(attempt).rejects.toThrow(/custody/i);
      await expectNothingCertified(s, feeId);
    });
  });
});

describe("the evidence revision the pin depends on", () => {
  test("a never-re-recorded line reads 0, and the read serves one more per re-record", async () => {
    const s = await seed("rev1");
    const feeId = await addFee(s);
    const read = async () =>
      (await s.operator.as.query(api.financeDealCosts.listDealCosts, { orgId: s.orgId, applicationId: s.applicationId }))
        .fees.find((fee) => fee._id === feeId)?.actualEvidenceRevision;
    expect((await feeRow(s, feeId))?.actualEvidenceRevision).toBeUndefined();
    expect(await read()).toBe(0);
    await s.operator.as.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, expectedCurrency: "JOD", actualAmountMinor: jod(1500),
    });
    expect(await read()).toBe(1);
  });

  test("an IDENTICAL re-record still moves the revision: the checker cannot tell it was identical", async () => {
    const s = await seed("rev2");
    const feeId = await addFee(s);
    await s.operator.as.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, expectedCurrency: "JOD", actualAmountMinor: jod(1500),
    });
    await expect(pinned(s, feeId, jod(1500), 0)).rejects.toThrow(/re-recorded since you opened it/i);
    await expectNothingCertified(s, feeId);
  });

  test("charging the line to custody does not move it, and the pin at 0 still certifies", async () => {
    const s = await seed("rev3");
    const feeId = await addFee(s, { paidBy: "EMPLOYEE", actualAmountMinor: jod(100) });
    const custodyId = await s.operator.as.mutation(api.financeDealCosts.openDealCustody, {
      method: "CASH", idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId, applicationId: s.applicationId, userId: s.holder.userId, issuedMinor: jod(5000),
    });
    await s.operator.as.mutation(api.financeDealCosts.setFeeCustody, { orgId: s.orgId, feeId, custodyId });
    expect((await feeRow(s, feeId))?.actualEvidenceRevision).toBeUndefined();
    await pinned(s, feeId, jod(100), 0, "Checked.", s.operator.as);
    expect((await feeRow(s, feeId))?.reconciledAt).toBeDefined();
  });

  test("re-recording a reconciled line still withdraws the reconciliation (the existing audited behaviour)", async () => {
    const s = await seed("rev4");
    const feeId = await addFee(s);
    await pinned(s, feeId, jod(1500), 0);
    await s.operator.as.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: s.orgId, feeId, expectedCurrency: "JOD", actualAmountMinor: jod(1600),
    });
    const row = await feeRow(s, feeId);
    expect(row?.reconciledAt).toBeUndefined();
    expect(row?.actualEvidenceRevision).toBe(1);
    await pinned(s, feeId, jod(1600), 1, "Re-checked at 1,600.");
    expect((await feeRow(s, feeId))?.reconciledAt).toBeDefined();
  });
});
