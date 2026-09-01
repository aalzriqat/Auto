import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * SCRUM-51 / 237-A — Claims is retired as a finance-company AR authority.
 *
 * The defect, from the Accounting adversarial review: `claims.add` opened a
 * canonical `receivableDocuments` row with `payerType: FINANCE_COMPANY` and no
 * originating GL debit, while `claims.settle` credited Finance-company AR and
 * `claims.reject` wrote it off. So the subledger could carry finance-company AR
 * the GL had never been told about, and the GL could be credited for a balance
 * nothing had ever debited. The financed-deal path in `applications.ts` already
 * creates the real receivable for the same economic fact, so one financed sale
 * could carry two — with settlement landing on whichever the operator opened.
 *
 * Owner ruling c14514, re-scoped by c14519, chose the model rather than adding
 * a CLAIM_CREATED debit: the Finance Application receivable is authoritative,
 * Claims becomes a read-only view over it, and all five writers refuse.
 *
 * ⚠️ WHAT THIS FILE HAS TO PROVE, AND WHY IT IS NOT ENOUGH TO CATCH THE ERROR.
 * A door that reports a refusal and writes anyway satisfies `rejects.toThrow`
 * perfectly well. So every door here is checked against the ABSENCE of the ten
 * kinds of row it used to be able to produce — claim, receivable, payment,
 * allocation, journal entry, journal line, accounting event, outbox entry,
 * notification and audit record. That is the assertion the ruling asked for,
 * and it is the only one that can tell "refused" apart from "refused, and did
 * it anyway".
 */

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const FINANCE_APPLICATION_SOURCE = "finance_application";

async function seedClaimsOrg(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Claims ${suffix}`, createdAt: Date.now() })
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
    ctx.db.insert("users", {
      clerkId: `claims_${suffix}`,
      email: `${suffix}@example.com`,
      name: "Finance Manager",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    })
  );

  const asOwner = t.withIdentity({ subject: `claims_${suffix}`, clerkId: `claims_${suffix}` });
  return { t, orgId, userId, asOwner };
}

type Seeded = Awaited<ReturnType<typeof seedClaimsOrg>>;

/**
 * A pre-existing claim row, planted directly.
 *
 * ⚠️ DEFENCE IN DEPTH, and stated as such: `claims.add` is the only door that
 * ever inserted one and it now refuses, so on fresh data this row cannot occur.
 * It is planted so that `settle`, `reject`, `update` and `remove` are refused
 * for the RIGHT reason — the retirement — and not merely because their target
 * does not exist. Against a missing claim every one of them would throw
 * "Claim not found", and the matrix below would pass without the retirement
 * existing at all.
 */
async function plantClaim(s: Seeded): Promise<Id<"claims">> {
  return await s.t.run((ctx) =>
    ctx.db.insert("claims", {
      orgId: s.orgId,
      claimDate: Date.now(),
      financingEntity: "Jordan Finance Co",
      buyerName: "Planted Buyer",
      claimAmountMinor: 750_000,
      currency: "JOD",
      status: "PENDING",
    })
  );
}

/** Every row class a Claims writer used to be able to create. */
async function economicFootprint(s: Seeded) {
  return await s.t.run(async (ctx) => ({
    receivables: (await ctx.db.query("receivableDocuments").collect()).length,
    payments: (await ctx.db.query("canonicalPayments").collect()).length,
    allocations: (await ctx.db.query("paymentAllocations").collect()).length,
    journalEntries: (await ctx.db.query("journalEntries").collect()).length,
    journalLines: (await ctx.db.query("journalLines").collect()).length,
    accountingEvents: (await ctx.db.query("accountingEvents").collect()).length,
    outbox: (await ctx.db.query("pendingAccountingEvents").collect()).length,
    notifications: (await ctx.db.query("notifications").collect()).length,
    auditLog: (await ctx.db.query("financialAuditLog").collect()).length,
  }));
}

describe("SCRUM-51 — every Claims writer refuses, and writes nothing", () => {
  test("add cannot open a second finance-company receivable", async () => {
    const s = await seedClaimsOrg("add");
    const before = await economicFootprint(s);

    await expect(
      s.asOwner.mutation(api.claims.add, {
        orgId: s.orgId,
        claimDate: Date.now(),
        financingEntity: "Jordan Finance Co",
        buyerName: "Buyer X",
        claimAmountMinor: 750_000,
      })
    ).rejects.toThrow(/retired/i);

    const claims = await s.t.run((ctx) => ctx.db.query("claims").collect());
    expect(claims).toHaveLength(0);
    expect(await economicFootprint(s)).toEqual(before);
  });

  test("settle cannot pay a claim, even one that already exists", async () => {
    const s = await seedClaimsOrg("settle");
    const claimId = await plantClaim(s);
    const before = await economicFootprint(s);

    await expect(
      s.asOwner.mutation(api.claims.settle, {
        orgId: s.orgId,
        claimId,
        paymentMethod: "BANK_TRANSFER",
      })
    ).rejects.toThrow(/retired/i);

    const claim = await s.t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("PENDING");
    expect(claim?.receivableDocumentId).toBeUndefined();
    expect(await economicFootprint(s)).toEqual(before);
  });

  test("reject cannot write a claim off", async () => {
    const s = await seedClaimsOrg("reject");
    const claimId = await plantClaim(s);
    const before = await economicFootprint(s);

    await expect(
      s.asOwner.mutation(api.claims.reject, { orgId: s.orgId, claimId })
    ).rejects.toThrow(/retired/i);

    const claim = await s.t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("PENDING");
    expect(await economicFootprint(s)).toEqual(before);
  });

  test("update cannot edit a claim", async () => {
    const s = await seedClaimsOrg("update");
    const claimId = await plantClaim(s);
    const before = await economicFootprint(s);

    await expect(
      s.asOwner.mutation(api.claims.update, {
        orgId: s.orgId,
        claimId,
        notes: "should not land",
      })
    ).rejects.toThrow(/retired/i);

    const claim = await s.t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.notes).toBeUndefined();
    expect(await economicFootprint(s)).toEqual(before);
  });

  test("remove cannot delete a claim", async () => {
    const s = await seedClaimsOrg("remove");
    const claimId = await plantClaim(s);
    const before = await economicFootprint(s);

    await expect(
      s.asOwner.mutation(api.claims.remove, { orgId: s.orgId, claimId })
    ).rejects.toThrow(/retired/i);

    const claim = await s.t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.isDeleted).not.toBe(true);
    expect(await economicFootprint(s)).toEqual(before);
  });

  test("the refusal is named, and it points at the authority that replaced it", async () => {
    const s = await seedClaimsOrg("named");

    // The ruling asked for a NAMED refusal, not a bare string: a client has to
    // be able to branch on the code, and an operator has to be told where the
    // money actually lives now.
    await expect(
      s.asOwner.mutation(api.claims.add, {
        orgId: s.orgId,
        claimDate: Date.now(),
        financingEntity: "FC",
        buyerName: "B",
        claimAmountMinor: 1,
      })
    ).rejects.toThrow(/Finance Application/i);

    const error = await s.asOwner
      .mutation(api.claims.add, {
        orgId: s.orgId,
        claimDate: Date.now(),
        financingEntity: "FC",
        buyerName: "B",
        claimAmountMinor: 1,
      })
      .catch((e: unknown) => e as { data?: { code?: string } });
    expect(error?.data?.code).toBe("CLAIMS_RETIRED");
  });

  test("authentication still comes first, so the refusal leaks nothing", async () => {
    const s = await seedClaimsOrg("authfirst");
    const outsiderOrgId = await s.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Someone Else", createdAt: Date.now() })
    );

    // A caller with no membership must get the ordinary tenancy error. If the
    // retirement refusal came first it would confirm the org exists to someone
    // with no access to it — and the ruling put the refusal AFTER
    // authentication precisely so this stays true.
    await expect(
      s.asOwner.mutation(api.claims.add, {
        orgId: outsiderOrgId,
        claimDate: Date.now(),
        financingEntity: "FC",
        buyerName: "B",
        claimAmountMinor: 1,
      })
    ).rejects.toThrow(/not a member|forbidden|unauthor|access/i);
  });
});

describe("SCRUM-51 — the authoritative projection Claims was retired in favour of", () => {
  async function seedFinanceApplicationReceivable(
    s: Seeded,
    opts: {
      amountMinor: number;
      allocatedMinor?: number;
      reversedMinor?: number;
      status?: string;
      applicationId?: string;
    }
  ) {
    const financeCompanyId = await s.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: s.orgId,
        name: "Jordan Finance Co",
        profitRate: 5.5,
        maxTermMonths: 72,
        gracePeriodMonths: 3,
        isActive: true,
      })
    );
    const customerId = await s.t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId: s.orgId,
        firstName: "Real",
        lastName: "Buyer",
      })
    );
    const receivableId = await s.t.run((ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId: s.orgId,
        documentType: "INVOICE" as const,
        documentNumber: `AR-${opts.applicationId ?? "app1"}`,
        payerType: "FINANCE_COMPANY" as const,
        financeCompanyId,
        customerId,
        sourceType: FINANCE_APPLICATION_SOURCE,
        sourceId: opts.applicationId ?? "app1",
        originalAmountMinor: opts.amountMinor,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: (opts.status ?? "OPEN") as never,
        createdAt: Date.now(),
        createdBy: s.userId,
      })
    );

    if (opts.allocatedMinor) {
      const paymentId = await s.t.run((ctx) =>
        ctx.db.insert("canonicalPayments", {
          orgId: s.orgId,
          direction: "IN" as const,
          payerType: "FINANCE_COMPANY" as const,
          financeCompanyId,
          method: "BANK_TRANSFER" as const,
          amountMinor: opts.allocatedMinor!,
          currency: "JOD",
          scale: 3,
          status: "SETTLED" as const,
          idempotencyKey: `alloc_${opts.applicationId ?? "app1"}`,
          receivedAt: Date.now(),
          createdAt: Date.now(),
          createdBy: s.userId,
        })
      );
      await s.t.run((ctx) =>
        ctx.db.insert("paymentAllocations", {
          orgId: s.orgId,
          paymentId,
          receivableDocumentId: receivableId,
          amountMinor: opts.allocatedMinor!,
          currency: "JOD",
          scale: 3,
          allocationDate: Date.now(),
          status: "ACTIVE" as const,
          createdBy: s.userId,
          createdAt: Date.now(),
        })
      );
    }

    if (opts.reversedMinor) {
      const reversedPaymentId = await s.t.run((ctx) =>
        ctx.db.insert("canonicalPayments", {
          orgId: s.orgId,
          direction: "IN" as const,
          payerType: "FINANCE_COMPANY" as const,
          financeCompanyId,
          method: "BANK_TRANSFER" as const,
          amountMinor: opts.reversedMinor!,
          currency: "JOD",
          scale: 3,
          status: "FAILED" as const,
          idempotencyKey: `reversed_${opts.applicationId ?? "app1"}`,
          receivedAt: Date.now(),
          createdAt: Date.now(),
          createdBy: s.userId,
        })
      );
      await s.t.run((ctx) =>
        ctx.db.insert("paymentAllocations", {
          orgId: s.orgId,
          paymentId: reversedPaymentId,
          receivableDocumentId: receivableId,
          amountMinor: opts.reversedMinor!,
          currency: "JOD",
          scale: 3,
          allocationDate: Date.now(),
          status: "REVERSED" as const,
          createdBy: s.userId,
          createdAt: Date.now(),
        })
      );
    }

    return { receivableId, financeCompanyId, customerId };
  }

  test("it reports the financier, the buyer and the live outstanding balance", async () => {
    const s = await seedClaimsOrg("proj");
    await seedFinanceApplicationReceivable(s, { amountMinor: 750_000, allocatedMinor: 250_000 });

    const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: s.orgId,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].financingEntity).toBe("Jordan Finance Co");
    expect(rows[0].buyerName).toBe("Real Buyer");
    expect(rows[0].originalAmountMinor).toBe(750_000);
    expect(rows[0].outstandingMinor).toBe(500_000);
    // The deep link the client must not have to reconstruct for itself.
    expect(rows[0].applicationId).toBe("app1");
  });

  test("the totals are computed from the same rows the list returns", async () => {
    const s = await seedClaimsOrg("totals");
    await seedFinanceApplicationReceivable(s, {
      amountMinor: 750_000,
      allocatedMinor: 250_000,
      applicationId: "appA",
    });
    await seedFinanceApplicationReceivable(s, { amountMinor: 100_000, applicationId: "appB" });

    const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: s.orgId,
    });
    const totals = await s.asOwner.query(api.claims.financeCompanyReceivableTotals, {
      orgId: s.orgId,
    });

    // A list and its own total disagreeing is the failure this asserts against,
    // so the total is compared to the list rather than to a hand-written number.
    const listOutstanding = rows
      .filter((r) => r.status === "OPEN" || r.status === "PARTIALLY_PAID")
      .reduce((sum, r) => sum + r.outstandingMinor, 0);
    expect(totals.count).toBe(rows.length);
    expect(totals.outstandingMinor).toBe(listOutstanding);
    expect(totals.originalMinor).toBe(850_000);
    expect(totals.outstandingMinor).toBe(600_000);
  });

  test("a cancelled receivable reads as zero outstanding, not as fully owed", async () => {
    const s = await seedClaimsOrg("cancelled");
    await seedFinanceApplicationReceivable(s, {
      amountMinor: 500_000,
      status: "CANCELLED",
      applicationId: "appC",
    });

    const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: s.orgId,
    });
    // Cancellation reverses the allocations, so `original - allocated` would
    // otherwise report the whole amount as owed again.
    expect(rows[0].outstandingMinor).toBe(0);

    const totals = await s.asOwner.query(api.claims.financeCompanyReceivableTotals, {
      orgId: s.orgId,
    });
    expect(totals.outstandingMinor).toBe(0);
    expect(totals.byStatus.CANCELLED.count).toBe(1);
  });

  test("a reversed allocation does not count as money received", async () => {
    const s = await seedClaimsOrg("reversed");
    await seedFinanceApplicationReceivable(s, {
      amountMinor: 900_000,
      allocatedMinor: 200_000,
      reversedMinor: 400_000,
      applicationId: "appR",
    });

    // Cancelling a settlement reverses its allocation in place, so a reader
    // that counted every allocation would treat 600.000 as received and report
    // 300.000 still owed. Only the 200.000 that is still ACTIVE was really
    // received, so 700.000 is outstanding — the difference is money the dealer
    // would otherwise stop chasing.
    const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: s.orgId,
    });
    expect(rows[0].outstandingMinor).toBe(700_000);

    const totals = await s.asOwner.query(api.claims.financeCompanyReceivableTotals, {
      orgId: s.orgId,
    });
    expect(totals.outstandingMinor).toBe(700_000);
  });

  test("a written-off receivable is not counted as still collectable", async () => {
    const s = await seedClaimsOrg("writtenoff");
    await seedFinanceApplicationReceivable(s, {
      amountMinor: 300_000,
      status: "WRITTEN_OFF",
      applicationId: "appW",
    });

    // A write-off is recorded as an expense in the GL, not as an allocation, so
    // `original - allocated` stays at the full amount. Counting that as
    // outstanding would tell the dealer the financier still owes 300.000 that
    // the books have already given up on.
    const totals = await s.asOwner.query(api.claims.financeCompanyReceivableTotals, {
      orgId: s.orgId,
    });
    expect(totals.outstandingMinor).toBe(0);
    expect(totals.originalMinor).toBe(300_000);
    expect(totals.byStatus.WRITTEN_OFF.count).toBe(1);

    // It stays visible rather than being dropped — the money left the books,
    // the record of it did not.
    const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: s.orgId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("WRITTEN_OFF");
  });

  test("it never shows another org's finance-company receivables", async () => {
    const s = await seedClaimsOrg("tenancy");
    const other = await seedClaimsOrg("tenancy_other");
    await seedFinanceApplicationReceivable(other, { amountMinor: 999_000, applicationId: "appX" });

    const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: s.orgId,
    });
    expect(rows).toHaveLength(0);

    const totals = await s.asOwner.query(api.claims.financeCompanyReceivableTotals, {
      orgId: s.orgId,
    });
    expect(totals.count).toBe(0);
    expect(totals.originalMinor).toBe(0);
  });

  test("a claims-sourced receivable is not mistaken for an authoritative one", async () => {
    const s = await seedClaimsOrg("legacysrc");
    await seedFinanceApplicationReceivable(s, { amountMinor: 100_000, applicationId: "appD" });

    // A row left behind by the retired writer. The projection reads the
    // `finance_application` source range only, so this cannot be counted as
    // authoritative finance-company AR — which was the whole duplication risk.
    await s.t.run((ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId: s.orgId,
        documentType: "INVOICE" as const,
        documentNumber: "AR-LEGACY-CLAIM",
        payerType: "FINANCE_COMPANY" as const,
        sourceType: "claims",
        sourceId: "someClaimId",
        originalAmountMinor: 640_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: "OPEN" as const,
        createdAt: Date.now(),
        createdBy: s.userId,
      })
    );

    const totals = await s.asOwner.query(api.claims.financeCompanyReceivableTotals, {
      orgId: s.orgId,
    });
    expect(totals.count).toBe(1);
    expect(totals.originalMinor).toBe(100_000);
  });
});
