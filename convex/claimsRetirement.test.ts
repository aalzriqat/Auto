import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { getReceivableOutstandingMinor } from "./subledger";
import { drainPendingForOrg } from "./accountingOutbox";
import { postAccountingEvent } from "./accounting/postingEngine";

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

/**
 * ⚠️ THE DOOR I CLOSED LAST, AND SHOULD HAVE CLOSED FIRST.
 *
 * Retiring the five writers stopped NEW claim events. It did nothing about
 * events ALREADY QUEUED. `postClaimEvent` routed through `postDomainEvent`,
 * which parks the event in `pendingAccountingEvents` whenever the org cannot
 * post yet — no chart of accounts, or no open period covering the date. That
 * is not an edge case; it is the entire reason the outbox exists. So any org
 * that settled or rejected a claim before this deploy, at a moment when it
 * could not post, still has a live CLAIM_SETTLED or CLAIM_WRITTEN_OFF waiting.
 * Opening a period drains it, and it credits Accounts Receivable — Finance
 * Companies with nothing having debited it: the exact defect this ticket
 * exists to remove, arriving through ordinary business activity with no
 * operator action at all.
 *
 * Both review seats found this independently after the first remediation.
 * Closing it at the drain would have been the third patch to the same defect
 * and the next path would have been the fourth, so it is closed at
 * `postAccountingEvent` — the single function every posting path reaches.
 */
describe("SCRUM-51 — a queued claim event can never post, however it got queued", () => {
  async function chartAndPeriod(s: Seeded) {
    await s.asOwner.mutation(api.chartOfAccounts.initialize, { orgId: s.orgId });
    const fiscalYear = new Date().getUTCFullYear();
    await s.asOwner.mutation(api.accountingPeriods.create, {
      orgId: s.orgId,
      startDate: Date.UTC(fiscalYear, 0, 1),
      endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear,
      periodNumber: 1,
    });
    const period = (await s.asOwner.query(api.accountingPeriods.list, { orgId: s.orgId }))[0];
    await s.asOwner.mutation(api.accountingPeriods.open, { orgId: s.orgId, periodId: period._id });
  }

  for (const eventType of ["CLAIM_SETTLED", "CLAIM_WRITTEN_OFF"]) {
    test(`a queued ${eventType} is refused by the drain and posts nothing`, async () => {
      const s = await seedClaimsOrg(`outbox_${eventType}`);
      await chartAndPeriod(s);

      // Exactly what the pre-retirement `claims.settle` / `claims.reject` left
      // behind for an org that could not post at the time. Planted directly
      // because the door that used to write it is now closed — which is the
      // point: the row outlives the writer.
      await s.t.run((ctx) =>
        ctx.db.insert("pendingAccountingEvents", {
          orgId: s.orgId,
          kind: "POST" as const,
          status: "PENDING" as const,
          idempotencyKey: `${eventType.toLowerCase()}_staleclaim`,
          accountingDate: Date.now(),
          actorId: s.userId,
          reason: "No chart of accounts or open period at operation time",
          attempts: 0,
          createdAt: Date.now(),
          eventType,
          sourceType: "claims",
          sourceId: "staleclaim",
          eventVersion: 1,
          occurredAt: Date.now(),
          currency: "JOD",
          payload: {
            claimId: "staleclaim",
            amountMinor: 500_000,
            currency: "JOD",
            paymentMethod: "BANK_TRANSFER",
          },
        })
      );

      const result = await s.t.run((ctx) =>
        drainPendingForOrg(ctx as unknown as MutationCtx, s.orgId)
      );

      // Failed, not posted. A retired event will never become postable, so
      // holding it would retry forever and describe a wait that never ends.
      expect(result.posted).toBe(0);
      expect(result.failed).toBe(1);

      // The assertion that matters is in the ledger, not in the counters.
      const events = await s.t.run((ctx) => ctx.db.query("accountingEvents").collect());
      expect(events.filter((e) => e.eventType === eventType)).toHaveLength(0);

      const accounts = await s.t.run((ctx) =>
        ctx.db.query("chartOfAccounts").collect()
      );
      const arFc = accounts.find(
        (a) => a.orgId === s.orgId && a.systemKey === "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES"
      );
      const lines = await s.t.run((ctx) => ctx.db.query("journalLines").collect());
      expect(lines.filter((l) => arFc && l.accountId === arFc._id)).toHaveLength(0);
    });
  }

  test("the refusal names the event type and points at the real authority", async () => {
    const s = await seedClaimsOrg("outbox_message");
    await chartAndPeriod(s);

    await expect(
      s.t.run((ctx) =>
        postAccountingEvent(ctx as unknown as MutationCtx, {
          orgId: s.orgId,
          eventType: "CLAIM_SETTLED",
          sourceType: "claims",
          sourceId: "direct",
          eventVersion: 1,
          accountingDate: Date.now(),
          occurredAt: Date.now(),
          currency: "JOD",
          idempotencyKey: "direct_call",
          payload: { claimId: "direct", amountMinor: 1_000, currency: "JOD", paymentMethod: "CASH" },
          actorId: s.userId,
        })
      )
    ).rejects.toThrow(/CLAIM_SETTLED accounting event is retired/i);
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
      currency?: string;
      scale?: number;
      companyOrgId?: Id<"organizations">;
      customerOrgId?: Id<"organizations">;
    }
  ) {
    const currency = opts.currency ?? "JOD";
    const scale = opts.scale ?? 3;
    const financeCompanyId = await s.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: (opts.companyOrgId ?? s.orgId) as never,
        name: "Jordan Finance Co",
        profitRate: 5.5,
        maxTermMonths: 72,
        gracePeriodMonths: 3,
        isActive: true,
      })
    );
    const customerId = await s.t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId: (opts.customerOrgId ?? s.orgId) as never,
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
        currency,
        scale,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: (opts.status ?? "OPEN") as never,
        createdAt: Date.now(),
        createdBy: s.userId,
      })
    );

    async function allocate(amountMinor: number, status: "ACTIVE" | "REVERSED", tag: string) {
      const paymentId = await s.t.run((ctx) =>
        ctx.db.insert("canonicalPayments", {
          orgId: s.orgId,
          direction: "IN" as const,
          payerType: "FINANCE_COMPANY" as const,
          financeCompanyId,
          method: "BANK_TRANSFER" as const,
          amountMinor,
          currency,
          scale,
          status: "SETTLED" as const,
          idempotencyKey: `${tag}_${opts.applicationId ?? "app1"}`,
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
          amountMinor,
          currency,
          scale,
          allocationDate: Date.now(),
          status,
          createdBy: s.userId,
          createdAt: Date.now(),
        })
      );
    }

    if (opts.allocatedMinor) await allocate(opts.allocatedMinor, "ACTIVE", "alloc");
    if (opts.reversedMinor) await allocate(opts.reversedMinor, "REVERSED", "reversed");

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

  test("the outstanding it reports IS the canonical subledger balance", async () => {
    const s = await seedClaimsOrg("canonical");
    const { receivableId } = await seedFinanceApplicationReceivable(s, {
      amountMinor: 900_000,
      allocatedMinor: 125_000,
    });

    const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: s.orgId,
    });
    // Compared against the helper itself, not against a number I chose. This is
    // the assertion that stops the projection quietly growing a second
    // definition of what is owed.
    const canonical = await s.t.run((ctx) =>
      getReceivableOutstandingMinor(ctx as unknown as MutationCtx, receivableId)
    );
    expect(rows[0].outstandingMinor).toBe(canonical);
    expect(canonical).toBe(775_000);
  });

  test("the totals agree with the list, per currency", async () => {
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
    const listOutstanding = rows.reduce((sum, r) => sum + r.outstandingMinor, 0);
    expect(totals.count).toBe(rows.length);
    expect(totals.byCurrency.JOD.outstandingMinor).toBe(listOutstanding);
    expect(totals.byCurrency.JOD.originalMinor).toBe(850_000);
    expect(totals.byCurrency.JOD.outstandingMinor).toBe(600_000);
  });

  test("two currencies are never added into one number", async () => {
    const s = await seedClaimsOrg("multicurrency");
    await seedFinanceApplicationReceivable(s, { amountMinor: 750_000, applicationId: "jod" });
    await seedFinanceApplicationReceivable(s, {
      amountMinor: 50_000,
      applicationId: "usd",
      currency: "USD",
      scale: 2,
    });

    const totals = await s.asOwner.query(api.claims.financeCompanyReceivableTotals, {
      orgId: s.orgId,
    });

    // 750_000 minor at scale 3 is 750.000 JOD; 50_000 at scale 2 is 500.00 USD.
    // Added together they would read 800_000 of nothing at all — a number with
    // no unit. Each currency keeps its own total and its own scale.
    expect(totals.byCurrency.JOD.originalMinor).toBe(750_000);
    expect(totals.byCurrency.JOD.scale).toBe(3);
    expect(totals.byCurrency.USD.originalMinor).toBe(50_000);
    expect(totals.byCurrency.USD.scale).toBe(2);
    expect(Object.keys(totals.byCurrency).sort()).toEqual(["JOD", "USD"]);
  });

  test("a terminal receivable reads as nothing owed, in the row AND in the total", async () => {
    for (const status of ["CANCELLED", "WRITTEN_OFF", "REVERSED"]) {
      const s = await seedClaimsOrg(`terminal_${status}`);
      await seedFinanceApplicationReceivable(s, {
        amountMinor: 500_000,
        status,
        applicationId: `app_${status}`,
      });

      const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
        orgId: s.orgId,
      });
      const totals = await s.asOwner.query(api.claims.financeCompanyReceivableTotals, {
        orgId: s.orgId,
      });

      // ⚠️ THE ROW, NOT ONLY THE TOTAL. An earlier version of this suite asserted
      // the total was zero and never looked at the row, and the row was reporting
      // the full balance as still owed — a list and its own total disagreeing
      // about whether a written-off debt is collectable. Both seats caught it.
      expect(rows[0].outstandingMinor).toBe(0);
      expect(totals.byCurrency.JOD.outstandingMinor).toBe(0);

      // Still visible, and its face value still reported: the money left the
      // books, the record of it did not.
      expect(rows[0].status).toBe(status);
      expect(totals.byCurrency.JOD.originalMinor).toBe(500_000);
      expect(totals.byStatus[status]).toBe(1);
    }
  });

  test("a reversed allocation does not count as money received", async () => {
    const s = await seedClaimsOrg("reversed");
    await seedFinanceApplicationReceivable(s, {
      amountMinor: 900_000,
      allocatedMinor: 200_000,
      reversedMinor: 400_000,
      applicationId: "appR",
    });

    // Cancelling a settlement reverses its allocation in place, so a reader that
    // counted every allocation would treat 600.000 as received and report
    // 300.000 still owed. Only the 200.000 still ACTIVE was really received, so
    // 700.000 is outstanding — the difference is money the dealer would
    // otherwise stop chasing.
    const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: s.orgId,
    });
    expect(rows[0].outstandingMinor).toBe(700_000);

    const totals = await s.asOwner.query(api.claims.financeCompanyReceivableTotals, {
      orgId: s.orgId,
    });
    expect(totals.byCurrency.JOD.outstandingMinor).toBe(700_000);
  });

  /**
   * ⚠️ THE FOREIGN ORG MUST LIVE IN THE SAME DATABASE.
   *
   * `seedClaimsOrg` builds a fresh `convexTest` instance each time, so rows
   * seeded into a second one are not in the database being queried at all —
   * and both instances hand out ids from the same counter, so their ids even
   * COLLIDE. A tenancy test written that way passes because the table is
   * empty, not because the filter works, and a cross-tenant read would sail
   * straight through it. An earlier version of these two tests did exactly
   * that. The neighbour org is therefore inserted into `s`'s own database.
   */
  async function foreignOrg(s: Seeded) {
    return await s.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Neighbour Motors", createdAt: Date.now() })
    );
  }

  test("it never shows another org's finance-company receivables", async () => {
    const s = await seedClaimsOrg("tenancy");
    const otherOrgId = await foreignOrg(s);
    await s.t.run((ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId: otherOrgId,
        documentType: "INVOICE" as const,
        documentNumber: "AR-NEIGHBOUR",
        payerType: "FINANCE_COMPANY" as const,
        sourceType: FINANCE_APPLICATION_SOURCE,
        sourceId: "appX",
        originalAmountMinor: 999_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: "OPEN" as const,
        createdAt: Date.now(),
        createdBy: s.userId,
      })
    );

    const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: s.orgId,
    });
    expect(rows).toHaveLength(0);

    const totals = await s.asOwner.query(api.claims.financeCompanyReceivableTotals, {
      orgId: s.orgId,
    });
    expect(totals.count).toBe(0);
    expect(totals.byCurrency).toEqual({});
  });

  test("a related company or customer from another org is never printed", async () => {
    const s = await seedClaimsOrg("relatedtenancy");
    const otherOrgId = await foreignOrg(s);
    await seedFinanceApplicationReceivable(s, {
      amountMinor: 100_000,
      applicationId: "appRel",
      companyOrgId: otherOrgId,
      customerOrgId: otherOrgId,
    });

    // The ids come off the document, not off the request, so a malformed or
    // legacy row must not turn this view into a cross-tenant disclosure. The row
    // still appears — it belongs to this org — but the foreign names do not.
    const rows = await s.asOwner.query(api.claims.listFinanceCompanyReceivables, {
      orgId: s.orgId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].financingEntity).toBeNull();
    expect(rows[0].buyerName).toBeNull();
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
    expect(totals.byCurrency.JOD.originalMinor).toBe(100_000);
  });

  test("two scales under one currency are refused, not averaged", async () => {
    const s = await seedClaimsOrg("scaleclash");
    await seedFinanceApplicationReceivable(s, {
      amountMinor: 100_000,
      applicationId: "scaleA",
      currency: "JOD",
      scale: 3,
    });
    await seedFinanceApplicationReceivable(s, {
      amountMinor: 100_000,
      applicationId: "scaleB",
      currency: "JOD",
      scale: 2,
    });

    // ⚠️ DEFENCE IN DEPTH, and stated as such: `ensureReceivableDocument`
    // derives scale from the currency, so two JOD documents cannot disagree
    // about it today. The state is built directly because no door produces it.
    // It would become reachable if the currency-scale table were ever edited
    // between two writes, and the wrong answer then is not a rounding error —
    // 100_000 at scale 3 is 100.000 and at scale 2 is 1,000.00, so adding them
    // reports a number that is wrong by a factor of ten with no sign of it.
    await expect(
      s.asOwner.query(api.claims.financeCompanyReceivableTotals, { orgId: s.orgId })
    ).rejects.toThrow(/disagree about scale/i);
  });

  test("the cap counts settled history too, which is a known limitation", async () => {
    const s = await seedClaimsOrg("capratchet");
    // 501 receivables that are all PAID — every one economically finished,
    // nothing collectable among them. The view still refuses.
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert("receivableDocuments", {
          orgId: s.orgId,
          documentType: "INVOICE" as const,
          documentNumber: `AR-PAID-${i}`,
          payerType: "FINANCE_COMPANY" as const,
          sourceType: FINANCE_APPLICATION_SOURCE,
          sourceId: `paid_${i}`,
          originalAmountMinor: 1_000,
          currency: "JOD",
          scale: 3,
          issueDate: Date.now(),
          dueDate: Date.now(),
          status: "PAID" as const,
          createdAt: Date.now(),
          createdBy: s.userId,
        });
      }
    });

    // ⚠️ THIS TEST PINS A LIMITATION, NOT A GUARANTEE. The cap counts lifetime
    // documents, so a long-lived dealer loses the view even with nothing owed.
    // It is asserted rather than left implicit so that 237-B designs pagination
    // from the real behaviour instead of from the comment above the constant.
    await expect(
      s.asOwner.query(api.claims.financeCompanyReceivableTotals, { orgId: s.orgId })
    ).rejects.toThrow(/more than this view can total/i);
  });

  test("beyond the cap it refuses rather than reporting a partial total", async () => {
    const s = await seedClaimsOrg("cap");
    // 501 documents against a cap of 500. A capped list is merely short; a
    // capped TOTAL is wrong and reads exactly like a complete one, so this view
    // fails loudly and leaves pagination to the client that eventually needs it.
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert("receivableDocuments", {
          orgId: s.orgId,
          documentType: "INVOICE" as const,
          documentNumber: `AR-BULK-${i}`,
          payerType: "FINANCE_COMPANY" as const,
          sourceType: FINANCE_APPLICATION_SOURCE,
          sourceId: `bulk_${i}`,
          originalAmountMinor: 1_000,
          currency: "JOD",
          scale: 3,
          issueDate: Date.now(),
          dueDate: Date.now(),
          status: "OPEN" as const,
          createdAt: Date.now(),
          createdBy: s.userId,
        });
      }
    });

    await expect(
      s.asOwner.query(api.claims.financeCompanyReceivableTotals, { orgId: s.orgId })
    ).rejects.toThrow(/more than this view can total/i);
  });
});
