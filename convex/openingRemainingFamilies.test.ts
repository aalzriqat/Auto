import type { TestConvex } from "convex-test";
import type { Id } from "./_generated/dataModel";
import {
  createOpeningSettlementReader,
  resolveOpeningSettlementBasis,
} from "./utils/openingSettlementBasis";
import { beginResetGenerationPatch } from "./utils/orgResetGeneration";
import {
  runContinuationBatch,
  resetOrgToCompletion,
} from "../test-utils/orgResetFixtures";
import { postAccountingEvent } from "./accounting/postingEngine";
import { expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

// SCRUM-869#c23881: historical receipt-reversal mechanics with the pilot door explicitly open.
// The shipped-state refusal lives in supplierSettlementContainment.test.ts.
vi.mock("./utils/supplierSettlementContainment", async (importOriginal) =>
  (await import("../test-utils/supplierSettlementSwitches")).openSupplierSettlementDoors(
    await importOriginal<typeof import("./utils/supplierSettlementContainment")>()
  ));

const families = [
  {
    name: "supplier recoverable",
    type: "ASSET",
    allocation: {
      kind: "SUPPLIER_RECOVERABLE",
      counterpartyName: "Synthetic supplier",
      title: "Synthetic opening claim",
      purpose: "CLAIM",
    },
  },
  {
    name: "supplier payable",
    type: "LIABILITY",
    allocation: {
      kind: "SUPPLIER_PAYABLE",
      counterpartyName: "Synthetic supplier",
      title: "Synthetic opening payable",
    },
  },
  {
    name: "other payable",
    type: "LIABILITY",
    allocation: {
      kind: "OTHER_PAYABLE",
      counterpartyName: "Synthetic creditor",
      title: "Synthetic opening obligation",
    },
  },
  {
    name: "unallocated deposit",
    type: "LIABILITY",
    allocation: {
      kind: "UNALLOCATED_LIABILITY",
      purpose: "CUSTOMER_DEPOSIT",
      title: "Synthetic unresolved deposit pool",
    },
  },
  {
    name: "unidentified receipt",
    type: "LIABILITY",
    allocation: {
      kind: "UNALLOCATED_LIABILITY",
      purpose: "UNIDENTIFIED_RECEIPT",
      title: "Synthetic unresolved receipts pool",
    },
  },
] as const;

/** Corruptions attack source identity after a genuine public opening; every
 * mutation is harness-only and is restored before native settlement continues. */
async function assertReadbackSourceIsolation(
  t: TestConvex<typeof schema>,
  owner: ReturnType<TestConvex<typeof schema>["withIdentity"]>,
  orgId: Id<"organizations">,
) {
  const draft = await t.run((ctx) =>
    ctx.db
      .query("openingBalanceDrafts")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique(),
  );
  if (!draft?.journalEntryId) throw new Error("Missing real opening source");
  const journal = await t.run((ctx) => ctx.db.get(draft.journalEntryId!));
  if (!journal) throw new Error("Missing real opening journal");
  const draftFields = Object.fromEntries(
    Object.entries(draft).filter(
      ([key]) => key !== "_id" && key !== "_creationTime",
    ),
  ) as Omit<typeof draft, "_id" | "_creationTime">;
  const journalFields = Object.fromEntries(
    Object.entries(journal).filter(
      ([key]) => key !== "_id" && key !== "_creationTime",
    ),
  ) as Omit<typeof journal, "_id" | "_creationTime">;
  const duplicate = await t.run((ctx) =>
    ctx.db.insert("openingBalanceDrafts", draftFields),
  );
  await expect(
    owner.query(api.accountingCutover.postedOpeningAllocationReadback, {
      orgId,
    }),
  ).rejects.toThrow(/finance review/);
  await t.run((ctx) => ctx.db.delete(duplicate));
  await t.run((ctx) => ctx.db.patch(draft._id, { journalEntryId: undefined }));
  await expect(
    owner.query(api.accountingCutover.postedOpeningAllocationReadback, {
      orgId,
    }),
  ).rejects.toThrow(/finance review/);
  await t.run((ctx) =>
    ctx.db.patch(draft._id, { journalEntryId: journal._id }),
  );
  const duplicateJournal = await t.run((ctx) =>
    ctx.db.insert("journalEntries", journalFields),
  );
  await expect(
    owner.query(api.accountingCutover.postedOpeningAllocationReadback, {
      orgId,
    }),
  ).rejects.toThrow(/finance review/);
  await t.run((ctx) => ctx.db.delete(duplicateJournal));
  const foreignOrg = await t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: "Synthetic source-isolation org",
      createdAt: Date.now(),
    }),
  );
  await t.run((ctx) => ctx.db.patch(journal._id, { orgId: foreignOrg }));
  await expect(
    owner.query(api.accountingCutover.postedOpeningAllocationReadback, {
      orgId,
    }),
  ).rejects.toThrow(/finance review/);
  await t.run((ctx) => ctx.db.patch(journal._id, { orgId }));
  await t.run((ctx) =>
    ctx.db.patch(journal._id, { sourceId: "synthetic-unrelated-source" }),
  );
  await expect(
    owner.query(api.accountingCutover.postedOpeningAllocationReadback, {
      orgId,
    }),
  ).rejects.toThrow(/finance review/);
  await t.run((ctx) =>
    ctx.db.patch(journal._id, { sourceId: journal.sourceId }),
  );
  await t.run((ctx) => ctx.db.patch(journal._id, { status: "REVERSED" }));
  expect(
    await owner.query(api.accountingCutover.postedOpeningAllocationReadback, {
      orgId,
    }),
  ).toMatchObject({
    journalStatus: "REVERSED",
    rows: [{ allocationStatus: "UNAVAILABLE", recordAvailable: false }],
  });
  await t.run((ctx) => ctx.db.patch(journal._id, { status: "POSTED" }));
  const historical = await t.run(async (ctx) => {
    const ids: Id<"openingBalanceDrafts">[] = [];
    for (let index = 0; index < 100; index += 1)
      ids.push(
        await ctx.db.insert("openingBalanceDrafts", {
          ...draftFields,
          journalEntryId: undefined,
          createdAt: Date.now() + index + 1,
        }),
      );
    return ids;
  });
  await expect(
    owner.query(api.accountingCutover.postedOpeningAllocationReadback, {
      orgId,
    }),
  ).rejects.toThrow(/finance review/);
  await t.run(async (ctx) => {
    for (const id of historical) await ctx.db.delete(id);
  });
  expect(
    (
      await owner.query(api.accountingCutover.postedOpeningAllocationReadback, {
        orgId,
      })
    )?.rows[0],
  ).toMatchObject({ allocationStatus: "AVAILABLE", recordAvailable: true });
}

async function replayRemainingOpeningFamily({
  type,
  allocation,
}: (typeof families)[number]) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const ownerRole = DEFAULT_ROLE_TEMPLATES.find(
    (role) => role.name === "OWNER",
  );
  if (!ownerRole) throw new Error("Missing native owner template");
  const {
    orgId,
    userId,
    identity: owner,
  } = await seedOrgWithMember(t, {
    clerkId: "remaining_opening_owner",
    roleName: "OWNER",
    permissions: [...ownerRole.permissions],
  });
  await t.run(async (ctx) => {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();
    if (!membership) throw new Error("Missing fixture membership");
    await ctx.db.patch(membership.roleId, { isSystemOwnerRole: true });
    await ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    });
  });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  await owner.mutation(api.accountingPeriods.open, {
    orgId,
    periodId: period._id,
  });
  const accountId = await owner.mutation(api.chartOfAccounts.create, {
    orgId,
    code: "1999",
    name: "Synthetic declared opening control",
    type,
    normalBalance: type === "ASSET" ? "DEBIT" : "CREDIT",
    currencyRestriction: "JOD",
    isControlAccount: true,
    allowManualPosting: false,
  });
  const retained = (
    await owner.query(api.chartOfAccounts.list, { orgId })
  ).find((account) => account.systemKey === "RETAINED_EARNINGS");
  if (!retained) throw new Error("Missing synthetic balancing account");
  const debit = type === "ASSET";
  if (allocation.kind === "SUPPLIER_PAYABLE") {
    const member = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique(),
    );
    if (!member) throw new Error("Missing member");
    await expect(
      owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
        orgId,
        expectedCurrency: "JOD",
        asOfDate: Date.now(),
        lines: [
          { accountId, debitMinor: 0, creditMinor: 100_000 },
          { accountId: retained._id, debitMinor: 100_000, creditMinor: 0 },
        ],
        allocations: [
          {
            ...allocation,
            rowKey: "mixed-payable",
            accountId,
            amountMinor: 50_000,
          },
          {
            kind: "EMPLOYEE_COMMISSION",
            rowKey: "mixed-commission",
            accountId,
            amountMinor: 50_000,
            userId: member.userId,
          },
        ],
      }),
    ).rejects.toThrow(/one explicitly declared allocation family/);
    expect(
      await t.run((ctx) => ctx.db.query("vehicleSupplierPayables").collect()),
    ).toEqual([]);
    expect(
      await t.run((ctx) =>
        ctx.db.query("openingCommissionLiabilities").collect(),
      ),
    ).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.query("journalEntries").collect()),
    ).toEqual([]);
  }
  if (allocation.kind === "SUPPLIER_RECOVERABLE") {
    const nativeAccounts = await owner.query(api.chartOfAccounts.list, {
      orgId,
    });
    for (const nativeKey of ["CASH_ON_HAND", "BANK_ACCOUNT"]) {
      const cash = nativeAccounts.find(
        (account) => account.systemKey === nativeKey,
      );
      if (!cash) throw new Error("Missing native cash control");
      const bankAccountId =
        nativeKey === "BANK_ACCOUNT"
          ? await t.run((ctx) =>
              ctx.db.insert("bankAccounts", {
                orgId,
                name: "Synthetic physical bank control",
                currency: "JOD",
                openingBalanceMinor: 0,
                openingBalanceDate: Date.now(),
                isActive: true,
                isReconciliationTarget: false,
                createdBy: userId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              }),
            )
          : undefined;
      await expect(
        owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
          orgId,
          expectedCurrency: "JOD",
          asOfDate: Date.now(),
          lines: [
            {
              accountId: cash._id,
              bankAccountId,
              debitMinor: 100_000,
              creditMinor: 0,
            },
            { accountId: retained._id, debitMinor: 0, creditMinor: 100_000 },
          ],
          allocations: [
            {
              ...allocation,
              rowKey: "misclassified-cash",
              accountId: cash._id,
              amountMinor: 100_000,
            },
          ],
        }),
      ).rejects.toThrow(/does not match/);
      expect(
        await t.run((ctx) => ctx.db.query("supplierCostRecoveries").collect()),
      ).toEqual([]);
    }
  }
  const result = await owner.mutation(
    api.accountingCutover.postOpeningBalanceDirect,
    {
      orgId,
      expectedCurrency: "JOD",
      asOfDate: Date.now(),
      lines: [
        {
          accountId,
          debitMinor: debit ? 100_000 : 0,
          creditMinor: debit ? 0 : 100_000,
        },
        // Synthetic balancing fixture only; no classification of the guide difference.
        {
          accountId: retained._id,
          debitMinor: debit ? 0 : 100_000,
          creditMinor: debit ? 100_000 : 0,
        },
      ],
      allocations: [
        {
          ...allocation,
          rowKey: "remaining-1",
          accountId,
          amountMinor: 100_000,
        },
      ],
    },
  );
  expect(result.journalId).toBeTruthy();
  const view = await owner.query(
    api.accountingCutover.postedOpeningAllocationReadback,
    { orgId },
  );
  expect(view?.rows).toHaveLength(1);
  expect(view?.rows[0]).toMatchObject({
    kind: allocation.kind,
    accountId,
    amountMinor: 100_000,
    allocationStatus:
      allocation.kind === "UNALLOCATED_LIABILITY" ? "UNALLOCATED" : "AVAILABLE",
  });
  expect(
    await t.run((ctx) => ctx.db.query("accountingEvents").collect()),
  ).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("expenses").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("sales").collect())).toEqual([]);
  if (allocation.kind === "SUPPLIER_PAYABLE")
    await assertReadbackSourceIsolation(t, owner, orgId);
  if (allocation.kind === "UNALLOCATED_LIABILITY") {
    const heldBefore = await owner.query(
      api.accountingReports.customerDepositsReconciliation,
      { orgId },
    );
    expect(heldBefore.isReconciled).toBe(true);
    if (allocation.purpose === "CUSTOMER_DEPOSIT")
      expect(heldBefore).toMatchObject({
        attributionStatus: "UNALLOCATED",
        heldOpeningMinor: { JOD: 100_000 },
      });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Synthetic",
        lastName: "Current receipt owner",
      }),
    );
    await owner.mutation(api.collections.recordPayment, {
      orgId,
      customerId,
      amount: 25,
      method: "CASH",
      paymentDate: Date.now(),
      idempotencyKey: "synthetic-current-credit",
    });
    const credits = await owner.query(api.collections.listRetainedCredits, {
      orgId,
      customerId,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(credits.page).toHaveLength(1);
    expect(credits.page[0].remainingUnappliedMinor).toBe(25_000);
    const receivableId = await owner.mutation(
      api.collections.createReceivable,
      {
        orgId,
        customerId,
        sourceType: "OTHER",
        creditSystemKey: "MISCELLANEOUS_INCOME",
        title: "Synthetic current invoice",
        amount: 25,
        dueDate: Date.now(),
        idempotencyKey: "synthetic-current-invoice",
      },
    );
    await owner.mutation(api.collections.applyRetainedCredit, {
      orgId,
      receiptMovementId: credits.page[0].receiptMovementId,
      receivableId,
      requestedAmount: 25,
      idempotencyKey: "synthetic-apply-current-credit",
    });
    const lines = await t.run((ctx) => ctx.db.query("journalLines").collect());
    expect(
      lines
        .filter((line) => line.accountId === accountId)
        .reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0),
    ).toBe(100_000);
    expect(
      (
        await owner.query(
          api.accountingCutover.postedOpeningAllocationReadback,
          { orgId },
        )
      )?.rows[0],
    ).toMatchObject({
      allocationStatus: "UNALLOCATED",
      partyId: null,
      documentId: null,
      amountMinor: 100_000,
    });
    expect(
      (
        await owner.query(api.collections.listRetainedCredits, {
          orgId,
          customerId,
          paginationOpts: { cursor: null, numItems: 10 },
        })
      ).page,
    ).toMatchObject([{ remainingUnappliedMinor: 0, applicationCount: 1 }]);
    const controls = await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId,
        make: "Synthetic",
        model: "Current deposit control",
        year: 2024,
        mileage: 0,
        color: "Gray",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 100,
        status: "AVAILABLE",
      });
      const role = DEFAULT_ROLE_TEMPLATES.find(
        (role) => role.name === "MANAGER",
      );
      if (!role) throw new Error("Missing manager template");
      const roleId = await ctx.db.insert("roles", {
        orgId,
        name: "MANAGER",
        permissions: [...role.permissions],
      });
      const userId = await ctx.db.insert("users", {
        clerkId: "remaining_refund_approver",
        email: "synthetic-approver@example.test",
      });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
      return { vehicleId };
    });
    const quoteId = await owner.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId: controls.vehicleId,
      vehiclePrice: 100,
      downPayment: 10,
      termMonths: 0,
    });
    const depositId = await owner.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 10,
      method: "CASH",
      idempotencyKey: "synthetic-current-deposit",
    });
    const approver = t.withIdentity({ subject: "remaining_refund_approver" });
    await approver.mutation(api.deposits.release, {
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
      idempotencyKey: "synthetic-current-deposit-refund",
    });
    const afterRefund = await t.run((ctx) =>
      ctx.db.query("journalLines").collect(),
    );
    expect(
      afterRefund
        .filter((line) => line.accountId === accountId)
        .reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0),
    ).toBe(100_000);
    const heldAfter = await owner.query(
      api.accountingReports.customerDepositsReconciliation,
      { orgId },
    );
    expect(heldAfter.heldOpeningMinor).toEqual(heldBefore.heldOpeningMinor);
    expect(heldAfter.isReconciled).toBe(true);
    const draft = await t.run((ctx) =>
      ctx.db
        .query("openingBalanceDrafts")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique(),
    );
    if (!draft) throw new Error("Missing opening parent");
    await t.run((ctx) => ctx.db.patch(draft._id, { allocationResults: [] }));
    expect(
      await owner.query(api.accountingReports.customerDepositsReconciliation, {
        orgId,
      }),
    ).toMatchObject({
      attributionStatus: "UNAVAILABLE",
      isReconciled: false,
    });
    expect(
      (
        await owner.query(
          api.accountingCutover.postedOpeningAllocationReadback,
          { orgId },
        )
      )?.rows[0],
    ).toMatchObject({
      allocationStatus: "UNAVAILABLE",
      recordAvailable: false,
    });
    await t.run((ctx) =>
      ctx.db.patch(draft._id, { allocationResults: draft.allocationResults }),
    );
  }
  if (allocation.kind === "SUPPLIER_RECOVERABLE") {
    const recovery = await t.run((ctx) =>
      ctx.db.query("supplierCostRecoveries").first(),
    );
    if (!recovery) throw new Error("Missing opening recovery");
    await t.run(async (ctx) => {
      const draft = await ctx.db
        .query("openingBalanceDrafts")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique();
      const org = await ctx.db.get(orgId);
      if (!draft || !org) throw new Error("Missing synthetic source");
      const reader = createOpeningSettlementReader(ctx, orgId);
      const ref = { draftId: draft._id, rowKey: "remaining-1" };
      expect(
        (
          await resolveOpeningSettlementBasis(
            ctx,
            orgId,
            ref,
            "SUPPLIER_RECOVERABLE",
            reader,
          )
        ).kind,
      ).toBe("AVAILABLE");
      await ctx.db.patch(accountId, { active: false });
      expect(
        (
          await resolveOpeningSettlementBasis(
            ctx,
            orgId,
            ref,
            "SUPPLIER_RECOVERABLE",
            reader,
          )
        ).kind,
      ).toBe("UNAVAILABLE");
      await ctx.db.patch(accountId, { active: true });
      await ctx.db.patch(orgId, beginResetGenerationPatch(org));
      expect(
        (
          await resolveOpeningSettlementBasis(
            ctx,
            orgId,
            ref,
            "SUPPLIER_RECOVERABLE",
            reader,
          )
        ).kind,
      ).toBe("UNAVAILABLE");
      await ctx.db.patch(orgId, {
        financialResetGeneration: org.financialResetGeneration,
        financialResetCompletedGeneration:
          org.financialResetCompletedGeneration,
      });
    });

    await expect(
      owner.mutation(api.supplierCostRecoveries.recordReceipt, {
        orgId,
        recoveryId: recovery._id,
        amountMinor: 1,
        method: "CASH",
        receivedDate: Date.now() - 60_000,
        idempotencyKey: "synthetic-backdated-receipt",
      }),
    ).rejects.toThrow(/before/);
    const received = await owner.mutation(
      api.supplierCostRecoveries.recordReceipt,
      {
        orgId,
        recoveryId: recovery._id,
        amountMinor: 40_000,
        method: "CASH",
        receivedDate: Date.now(),
        idempotencyKey: "synthetic-opening-receipt",
      },
    );
    const journals = await t.run((ctx) =>
      ctx.db.query("journalLines").collect(),
    );
    expect(
      journals
        .filter((line) => line.accountId === accountId)
        .reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0),
    ).toBe(60_000);
    await owner.mutation(api.supplierCostRecoveries.reverseReceipt, {
      orgId,
      receiptId: received.receiptId,
      reason: "Synthetic incorrect receipt",
      idempotencyKey: "synthetic-opening-reverse",
    });
    const restored = await t.run((ctx) =>
      ctx.db.query("journalLines").collect(),
    );
    expect(
      restored
        .filter((line) => line.accountId === accountId)
        .reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0),
    ).toBe(100_000);
    await t.run((ctx) => ctx.db.patch(orgId, { suspended: true }));
    await runContinuationBatch(t, orgId, 1);
    await resetOrgToCompletion(t, orgId, 100, 40);
    expect(await t.run((ctx) => ctx.db.get(recovery._id))).toBeNull();
    const oldDraft = await t.run((ctx) =>
      ctx.db
        .query("openingBalanceDrafts")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first(),
    );
    expect(oldDraft?.allocations).toHaveLength(1);
    expect(oldDraft?.allocationResults).toEqual([]);
    await t.run((ctx) => ctx.db.patch(orgId, { suspended: false }));
    expect(
      await owner.query(api.accountingCutover.postedOpeningAllocationReadback, {
        orgId,
      }),
    ).toMatchObject({
      journalStatus: "MISSING",
      rows: [{ allocationStatus: "UNAVAILABLE", recordAvailable: false }],
    });
    await owner.mutation(api.chartOfAccounts.initialize, { orgId });
    const newAccount = await owner.mutation(api.chartOfAccounts.create, {
      orgId,
      code: "1998",
      name: "Synthetic new opening claim",
      type: "ASSET",
      normalBalance: "DEBIT",
      currencyRestriction: "JOD",
    });
    const newRetained = (
      await owner.query(api.chartOfAccounts.list, { orgId })
    ).find((account) => account.systemKey === "RETAINED_EARNINGS");
    if (!newRetained) throw new Error("Missing fresh chart");
    await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId,
      expectedCurrency: "JOD",
      asOfDate: Date.now(),
      lines: [
        { accountId: newAccount, debitMinor: 100_000, creditMinor: 0 },
        { accountId: newRetained._id, debitMinor: 0, creditMinor: 100_000 },
      ],
      allocations: [
        {
          ...allocation,
          rowKey: "new-recovery",
          accountId: newAccount,
          amountMinor: 100_000,
        },
      ],
    });
    const newRecovery = await t.run((ctx) =>
      ctx.db
        .query("supplierCostRecoveries")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique(),
    );
    if (!newRecovery) throw new Error("Missing new recovery");
    await owner.mutation(api.supplierCostRecoveries.recordReceipt, {
      orgId,
      recoveryId: newRecovery._id,
      amountMinor: 10_000,
      method: "CASH",
      receivedDate: Date.now(),
      idempotencyKey: "synthetic-new-cutover-receipt",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(newRecovery._id)))?.amountRecoveredMinor,
    ).toBe(10_000);
    expect(
      (
        await owner.query(
          api.accountingCutover.postedOpeningAllocationReadback,
          { orgId },
        )
      )?.rows[0],
    ).toMatchObject({
      rowKey: "new-recovery",
      recordAvailable: true,
      allocationStatus: "AVAILABLE",
    });
  } else if (
    allocation.kind === "SUPPLIER_PAYABLE" ||
    allocation.kind === "OTHER_PAYABLE"
  ) {
    const payable = await t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").first(),
    );
    if (!payable) throw new Error("Missing opening payable");
    await owner.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId,
      payableId: payable._id,
      amount: 40,
      paymentMethod: "CASH",
      idempotencyKey: "synthetic-opening-payment",
    });
    const journals = await t.run((ctx) =>
      ctx.db.query("journalLines").collect(),
    );
    expect(
      journals
        .filter((line) => line.accountId === accountId)
        .reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0),
    ).toBe(60_000);
    const event = await t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").collect()).find(
        (event) => event.eventType === "SUPPLIER_PAYMENT_SETTLED",
      ),
    );
    if (!event) throw new Error("Missing native settlement event");
    const before = await t.run((ctx) => ctx.db.query("journalLines").collect());
    for (const payload of [
      { ...event.payload, amountMinor: 41_000 },
      { ...event.payload, openingSource: undefined },
    ]) {
      await expect(
        t.run((ctx) =>
          postAccountingEvent(ctx, {
            orgId,
            eventType: event.eventType,
            sourceType: event.sourceType,
            sourceId: event.sourceId,
            eventVersion: event.eventVersion,
            currency: event.currency,
            accountingDate: event.accountingDate,
            occurredAt: event.occurredAt,
            idempotencyKey: event.idempotencyKey,
            actorId: event.createdBy,
            payload,
          }),
        ),
      ).rejects.toThrow(/cannot be verified/);
    }
    expect(
      await t.run((ctx) => ctx.db.query("journalLines").collect()),
    ).toEqual(before);
    if (allocation.kind === "OTHER_PAYABLE") {
      const checklist = await owner.query(
        api.accountingPeriods.closeChecklist,
        { orgId, periodId: period._id },
      );
      expect(checklist.canClose).toBe(true);
      await owner.mutation(api.accountingPeriods.close, {
        orgId,
        periodId: period._id,
        acknowledgedWarnings: checklist.warnings,
      });
      expect(
        await owner.query(
          api.accountingReports.supplierPayablesReconciliation,
          { orgId, toDate: period.endDate },
        ),
      ).toMatchObject({
        status: "AVAILABLE",
        isReconciled: true,
        byCurrency: {
          JOD: { glBalanceMinor: 60_000, subledgerBalanceMinor: 60_000 },
        },
      });
      await owner.mutation(api.sourcingPayables.markPaid, {
        orgId,
        payableId: payable._id,
        paymentMethod: "CASH",
        idempotencyKey: "synthetic-queued-balance",
      });
      const pending = await t.run((ctx) =>
        ctx.db
          .query("pendingAccountingEvents")
          .withIndex("by_org_status", (q) =>
            q.eq("orgId", orgId).eq("status", "PENDING"),
          )
          .unique(),
      );
      if (!pending) throw new Error("Missing authentic queued settlement");
      expect(pending.payload).toMatchObject({ amountMinor: 60_000 });
      const beforeQueued = await t.run((ctx) =>
        ctx.db.query("journalLines").collect(),
      );
      await t.run((ctx) =>
        ctx.db.patch(pending._id, {
          payload: { ...pending.payload, amountMinor: 60_001 },
        }),
      );
      await t.mutation(internal.accountingOutbox.claimOutboxRow, {
        rowId: pending._id,
      });
      const claimed = await t.run((ctx) => ctx.db.get(pending._id));
      if (!claimed?.activeAttemptId || claimed.generation === undefined)
        throw new Error("Native claim did not mint an attempt");
      expect(
        await t.mutation(internal.accountingOutbox.postOutboxRow, {
          rowId: pending._id,
          attemptId: claimed.activeAttemptId,
          generation: claimed.generation,
        }),
      ).toMatchObject({ outcome: "REFUSED" });
      expect(
        await t.run((ctx) => ctx.db.query("journalLines").collect()),
      ).toEqual(beforeQueued);
      const refused = await t.run((ctx) => ctx.db.get(pending._id));
      if (!refused?.nextActionAt)
        throw new Error("Native retry deadline missing");
      await t.run((ctx) =>
        ctx.db.patch(pending._id, { payload: pending.payload }),
      );
      await owner.mutation(api.accountingPeriods.reopen, {
        orgId,
        periodId: period._id,
        reason: "Synthetic queued payment correction",
      });
      vi.useFakeTimers();
      try {
        vi.setSystemTime(refused.nextActionAt + 1);
        await t.mutation(internal.accountingOutbox.claimOutboxRow, {
          rowId: pending._id,
        });
        const retry = await t.run((ctx) => ctx.db.get(pending._id));
        if (!retry?.activeAttemptId || retry.generation === undefined)
          throw new Error("Native retry did not mint an attempt");
        expect(
          await t.mutation(internal.accountingOutbox.postOutboxRow, {
            rowId: pending._id,
            attemptId: retry.activeAttemptId,
            generation: retry.generation,
          }),
        ).toMatchObject({ outcome: "POSTED" });
      } finally {
        vi.useRealTimers();
      }
      const paidLines = await t.run((ctx) =>
        ctx.db.query("journalLines").collect(),
      );
      expect(
        paidLines
          .filter((line) => line.accountId === accountId)
          .reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0),
      ).toBe(0);
    }
    {
      const guards = await t.run(async (ctx) => {
        const member = await ctx.db
          .query("memberships")
          .withIndex("by_org", (q) => q.eq("orgId", orgId))
          .unique();
        if (!member) throw new Error("Missing synthetic member");
        const vehicleId = await ctx.db.insert("vehicles", {
          orgId,
          make: "Synthetic",
          model: "Legacy control",
          year: 2024,
          mileage: 0,
          color: "Gray",
          fuelType: "Gas",
          transmission: "Auto",
          sellingPrice: 1,
          status: "AVAILABLE",
        });
        const legacyId = await ctx.db.insert("vehicleSupplierPayables", {
          orgId,
          vehicleId,
          sourcedFromName: "Synthetic legacy supplier",
          amountDue: 10,
          currency: "JOD",
          status: "PENDING",
          createdBy: member.userId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        const otherOrg = await ctx.db.insert("organizations", {
          name: "Synthetic other reset org",
          createdAt: Date.now(),
        });
        const otherVehicle = await ctx.db.insert("vehicles", {
          orgId: otherOrg,
          make: "Synthetic",
          model: "Other org control",
          year: 2024,
          mileage: 0,
          color: "Gray",
          fuelType: "Gas",
          transmission: "Auto",
          sellingPrice: 1,
          status: "AVAILABLE",
        });
        const otherId = await ctx.db.insert("vehicleSupplierPayables", {
          orgId: otherOrg,
          vehicleId: otherVehicle,
          sourcedFromName: "Synthetic other supplier",
          amountDue: 10,
          currency: "JOD",
          status: "PENDING",
          createdBy: member.userId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await ctx.db.patch(orgId, { suspended: true });
        return { legacyId, otherId };
      });
      const first = await runContinuationBatch(t, orgId, 1);
      expect(first.remaining).toBeGreaterThan(0);
      expect(await t.run((ctx) => ctx.db.get(payable._id))).not.toBeNull();
      expect(
        await t.run((ctx) =>
          ctx.db
            .query("openingPayablePayments")
            .withIndex("by_org", (q) => q.eq("orgId", orgId))
            .collect(),
        ),
      ).toHaveLength(allocation.kind === "SUPPLIER_PAYABLE" ? 0 : 1);
      // A second committed batch removes the AP after its payment child. The
      // retained historical header must atomically lose only this new result
      // reference; its allocation/economics and all legacy AP remain intact.
      const historicalBefore = await t.run((ctx) => ctx.db.get(result.draftId as Id<"openingBalanceDrafts">));
      if (!historicalBefore) throw new Error("Missing authentic opening parent");
      expect(historicalBefore.allocationResults).toEqual([
        {kind:allocation.kind,rowKey:"remaining-1",payableId:payable._id},
      ]);
      // OTHER_PAYABLE has two authentic payments, so consume one child per
      // batch until the source itself disappears. Inspect each committed state.
      let sourceDeleted = false;
      for (let batch=0;batch<4;batch+=1) {
        await runContinuationBatch(t, orgId, 1);
        const afterSourceDelete = await t.run(async (ctx) => ({
          parent:await ctx.db.get(historicalBefore._id),
          payable:await ctx.db.get(payable._id),
          legacy:await ctx.db.get(guards.legacyId),
          foreign:await ctx.db.get(guards.otherId),
        }));
        expect(afterSourceDelete.legacy).not.toBeNull();
        expect(afterSourceDelete.foreign).not.toBeNull();
        expect(afterSourceDelete.parent?.allocations).toEqual(historicalBefore.allocations);
        if(afterSourceDelete.payable === null) {
          expect(afterSourceDelete.parent?.allocationResults,
            "new opening payable result must not point to its reset-deleted AP after a committed batch").toEqual([]);
          expect(afterSourceDelete.parent).toEqual({...historicalBefore,allocationResults:[]});
          expect(await t.run(ctx=>resolveOpeningSettlementBasis(ctx,orgId,
            {draftId:historicalBefore._id,rowKey:"remaining-1"},allocation.kind))).toMatchObject({kind:"UNAVAILABLE"});
          sourceDeleted = true;
          break;
        }
        expect(afterSourceDelete.parent?.allocationResults).toEqual(historicalBefore.allocationResults);
      }
      expect(sourceDeleted,"bounded reset must actually reach source deletion").toBe(true);
      await resetOrgToCompletion(t, orgId, 100, 40);
      expect(await t.run((ctx) => ctx.db.get(payable._id))).toBeNull();
      expect(await t.run((ctx) => ctx.db.get(guards.legacyId))).not.toBeNull();
      expect(await t.run((ctx) => ctx.db.get(guards.otherId))).not.toBeNull();
      await t.run((ctx) => ctx.db.patch(orgId, { suspended: false }));
      await owner.mutation(api.chartOfAccounts.initialize, { orgId });
      const [newPeriod] = await owner.query(api.accountingPeriods.list, {
        orgId,
      });
      expect(newPeriod.status).toBe("OPEN");
      const accounts = await owner.query(api.chartOfAccounts.list, { orgId });
      const cash = accounts.find(
        (account) => account.systemKey === "CASH_ON_HAND",
      );
      const offset = accounts.find(
        (account) => account.systemKey === "RETAINED_EARNINGS",
      );
      if (!cash || !offset) throw new Error("Missing fresh synthetic chart");
      expect(
        await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
          orgId,
          expectedCurrency: "JOD",
          asOfDate: Date.now(),
          lines: [
            { accountId: cash._id, debitMinor: 1000, creditMinor: 0 },
            { accountId: offset._id, debitMinor: 0, creditMinor: 1000 },
          ],
        }),
      ).toMatchObject({ journalId: expect.any(String) });
    }
  }
}

test("opening supplier recoverable collects reverses and resets without fake expense", () =>
  replayRemainingOpeningFamily(families[0]));
test("opening supplier payable settles selected control and resets without deleting legacy debt", () =>
  replayRemainingOpeningFamily(families[1]));
test("opening other payable revalidates authentic queued settlement before retry posting", () =>
  replayRemainingOpeningFamily(families[2]));
test("unallocated opening customer deposit stays held through current credit and refund", () =>
  replayRemainingOpeningFamily(families[3]));
test("unidentified opening receipt stays separate and unspendable through current credit and refund", () =>
  replayRemainingOpeningFamily(families[4]));
