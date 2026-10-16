/**
 * SCRUM-435 - forward proof and commands, on the owner's worked example
 * (Option A): G = 12,500 approved, D = 200 deposit held, C = 1,375 dealership
 * contribution.
 *
 *   finance company -> dealership  12,500  (the FULL approved amount, no deduction)
 *   dealership      -> company      1,575  (deposit H + contribution C)
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime (no OCC, no paginated-query limit) and not production data.
 */
import {
  C, G, H, downgradeToV1, downgradeToV2, finalizeAsOwner, finalizeThenTakeForwardBack, insertReceiptBank, payForwardAsOwner, readyDeal,
  refusalDataOf, refusalMessageOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { seedBank } from "../test-utils/bankFixture";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import schema from "./schema";
import { ruleFinanceCompanyForwardPaid } from "./accounting/postingRules";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { DEAL_UNWIND_MESSAGES } from "./utils/dealUnwindMessages";
import { deriveForwardState, isReportedReturn } from "./utils/financeCompanyForward";
import { planVersionOf } from "./utils/financedSalePostingPlan";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const ALL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];
/** The default MANAGER shape: acts on the deal, holds NO view:finance. */
const MANAGER_PERMS = ALL_PERMS.filter((p) => p !== "view:finance" && p !== "manage:finance");
/** SALES: no finalization, no disbursement, no finance view. */
const SALES_PERMS = ALL_PERMS.filter(
  (p) => !["manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement", "view:finance", "manage:finance"].includes(p)
);
/** ACCOUNTANT: reads and posts finance, but does not finalize or confirm the transfer. */
const ACCOUNTANT_PERMS = ["view:finance", "manage:finance", "view:finance_applications", "view:reports"];

const FORWARD = H + C; // 1,575

async function seedDealership(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S435", vinPrefix: "VIN435",
    actors: { mgr: MANAGER_PERMS, sales: SALES_PERMS, acct: ACCOUNTANT_PERMS },
  });
  return { ...s, manager: s.actors.mgr, sales: s.actors.sales, accountant: s.actors.acct };
}
type Seeded = Awaited<ReturnType<typeof seedDealership>>;

/** SCRUM-411 P2-01: approved and ready to finalize, with nothing paid to the finance company yet. */
async function approvedDeal(tag: string) {
  const s = await seedDealership(tag);
  const { applicationId } = await readyDeal(s);
  return { s, applicationId };
}

/**
 * The deposit and contribution are paid BEFORE the sale (finalize refuses until they
 * are), so a finalized deal is SETTLED with that payment as version 1.
 */
async function finalizedDeal(tag: string) {
  const { s, applicationId } = await approvedDeal(tag);
  const forwardId = await payForwardAsOwner(s, applicationId);
  await finalizeAsOwner(s, applicationId, { payForward: false });
  return { s, applicationId, forwardId: forwardId! };
}

/**
 * A CLOSED deal whose forward is due again: paid, finalized, then the payment taken
 * back as recorded in error. Version 1 is REVERSED, so the next payment is version 2.
 */
async function dueDeal(tag: string) {
  const { s, applicationId } = await approvedDeal(tag);
  const forwardId = await finalizeThenTakeForwardBack(s, applicationId);
  return { s, applicationId, forwardId: forwardId! };
}

const record = async (
  s: Seeded,
  applicationId: Id<"financeApplications">,
  over: Partial<{
    paidAt: number; expectedAmountMinor: number; idempotencyKey: string; method: "CASH" | "BANK_TRANSFER" | "CARD" | "CHEQUE";
    /** `null` sends no bank at all; omitted = the org's seeded bank for a bank method (never for cash). */
    bankAccountId: Id<"bankAccounts"> | null;
  }> = {},
  as = s.owner.as
) => {
  const method = over.method ?? "BANK_TRANSFER";
  const bankAccountId = over.bankAccountId === undefined ? (method === "CASH" ? null : await seedBank(s.t, s.orgId)) : over.bankAccountId;
  return await as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
    orgId: s.orgId, applicationId, method, ...(bankAccountId ? { bankAccountId } : {}),
    paidAt: over.paidAt ?? Date.now(), expectedAmountMinor: over.expectedAmountMinor ?? FORWARD,
    idempotencyKey: over.idempotencyKey ?? crypto.randomUUID(),
  });
};

const confirmTransfer = (s: Seeded, applicationId: Id<"financeApplications">, amount = G) =>
  insertReceiptBank(s).then((bankAccountId) =>
    s.owner.as.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: amount, idempotencyKey: crypto.randomUUID(), bankAccountId,
    })
  );

const refusalOf = refusalMessageOf;

/** Net movement per system account across every POSTED event of a type, debit-positive. */
async function netByAccount(s: Seeded, eventType: string) {
  return await s.t.run(async (ctx) => {
    const events = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === eventType && e.status !== "REVERSED"
    );
    const net = new Map<string, number>();
    for (const event of events) {
      const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
      for (const entry of entries.filter((e) => e.accountingEventId === event._id)) {
        const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
        for (const line of lines) {
          const account = await ctx.db.get(line.accountId);
          const key = account?.systemKey ?? String(line.accountId);
          net.set(key, (net.get(key) ?? 0) + line.debitMinor - line.creditMinor);
        }
      }
    }
    return Object.fromEntries(net) as Record<string, number>;
  });
}

const proofOf = (s: Seeded, applicationId: Id<"financeApplications">) =>
  s.t.run(async (ctx) => deriveForwardState(ctx, (await ctx.db.get(applicationId))!));

describe("SCRUM-435 - the worked example books what the owner ruled", () => {
  test("finalize freezes v3: due = deposit + contribution, the receivable is the FULL approved amount", async () => {
    const { s, applicationId } = await finalizedDeal("wx1");
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("CLOSED");
    expect(app?.financedSalePlanVersion).toBe(3);
    expect(app?.financeCompanyForwardDueMinor).toBe(FORWARD);
    expect(app?.financedSaleNetReceivableMinor).toBe(G);
    const proof = await proofOf(s, applicationId);
    expect(proof.state).toBe("SETTLED");
    expect(proof.dueMinor).toBe(FORWARD);
  });

  test("a finalized deal whose payment was taken back is due again for the same frozen H + C", async () => {
    const { s, applicationId } = await dueDeal("wx1b");
    const proof = await proofOf(s, applicationId);
    expect(proof.state).toBe("DUE");
    expect(proof.dueMinor).toBe(FORWARD);
    expect(proof.versions.map((v) => v.state)).toEqual(["REVERSED"]);
  });

  test("finalize is refused until the payment is on the books, and refuses nothing once it is", async () => {
    const { s, applicationId } = await approvedDeal("wx1c");
    const refusal = await refusalDataOf(
      s.owner.as.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId, idempotencyKey: crypto.randomUUID() })
    );
    expect(refusal?.code).toBe("FORWARD_FINALIZE_UNPAID");
    expect(refusal?.message).toMatch(/have not been paid yet/i);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("APPROVED");
    await payForwardAsOwner(s, applicationId);
    await finalizeAsOwner(s, applicationId, { payForward: false });
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });

  test("the sale journal balances and AP-Finance carries exactly H + C owed onward", async () => {
    const { s, applicationId } = await finalizedDeal("wx2");
    void applicationId;
    const net = await netByAccount(s, "SALE_COMPLETED");
    expect(net.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(G);
    expect(net.SALES_CONSIDERATION_REDUCTIONS).toBe(C);
    expect(net.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-FORWARD);
    expect(Object.values(net).reduce((a, b) => a + b, 0)).toBe(0);
  });

  test("paying the forward before the sale, then the sale, clears AP-Finance to zero; the transfer then settles the FULL G", async () => {
    const { s, applicationId } = await approvedDeal("wx3");
    const forwardId = await record(s, applicationId);
    expect(forwardId).toBeTruthy();
    // Before the sale: AP-Finance is debited by H + C against cash, nothing else.
    const before = await netByAccount(s, "FINANCE_COMPANY_FORWARD_PAID");
    expect(before.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(FORWARD);
    expect(await netByAccount(s, "SALE_COMPLETED")).toEqual({});
    await finalizeAsOwner(s, applicationId, { payForward: false });
    const proof = await proofOf(s, applicationId);
    expect(proof.state).toBe("SETTLED");

    const forwardNet = await netByAccount(s, "FINANCE_COMPANY_FORWARD_PAID");
    expect(forwardNet.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(FORWARD);
    expect(Object.values(forwardNet).reduce((a, b) => a + b, 0)).toBe(0);
    const saleNet = await netByAccount(s, "SALE_COMPLETED");
    expect((saleNet.ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0) + (forwardNet.ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0)).toBe(0);

    await confirmTransfer(s, applicationId, G);
    const after = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.disbursedAt).toBeDefined();
    const receipt = await netByAccount(s, "FINANCE_CASH_RECEIVED");
    expect(receipt.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(-G);
  });
});

describe("SCRUM-435 - the transfer gate follows the proof", () => {
  test("DUE: the transfer is refused, names who acts next and never echoes H or C", async () => {
    const { s, applicationId } = await dueDeal("gate1");
    const refusal = await refusalOf(confirmTransfer(s, applicationId));
    expect(refusal).toMatch(/manager or accountant records that payment/i);
    expect(refusal).not.toMatch(/200|1[,.]?375|1[,.]?575/);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.disbursedAt).toBeUndefined();
  });

  test.each([
    ["POSTING_PENDING", "PENDING", /not yet posted/i],
    ["POSTING_FAILED", "FAILED", /failed to post/i],
  ] as const)("%s: refused; POSTED: allowed", async (state, status, message) => {
    const { s, applicationId } = await finalizedDeal(`gate_${state}`);
    const eventId = await s.t.run(async (ctx) => {
      const events = await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
      const forward = events.find((e) => e.eventType === "FINANCE_COMPANY_FORWARD_PAID")!;
      await ctx.db.patch(forward._id, { status });
      return forward._id;
    });
    expect((await proofOf(s, applicationId)).state).toBe(state);
    expect(await refusalOf(confirmTransfer(s, applicationId))).toMatch(message);
    await s.t.run((ctx) => ctx.db.patch(eventId, { status: "POSTED" }));
    expect((await proofOf(s, applicationId)).state).toBe("SETTLED");
    expect(await refusalOf(confirmTransfer(s, applicationId))).toBeNull();
  });
});

describe("SCRUM-435 - record: idempotency, pins, periods, tenancy", () => {
  test("an idempotent replay returns the first result and books nothing twice; the same key for another amount is refused", async () => {
    const { s, applicationId } = await approvedDeal("idem");
    const key = crypto.randomUUID();
    const paidAt = Date.now() - 1000;
    const first = await record(s, applicationId, { idempotencyKey: key, paidAt });
    const replay = await record(s, applicationId, { idempotencyKey: key, paidAt });
    expect(replay).toEqual(first);
    const rows = await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect());
    expect(rows).toHaveLength(1);
    const net = await netByAccount(s, "FINANCE_COMPANY_FORWARD_PAID");
    expect(net.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(FORWARD);
    expect(await refusalOf(record(s, applicationId, { idempotencyKey: key, expectedAmountMinor: FORWARD + 1 }))).not.toBeNull();
  });

  test("a second payment while one is on the books is refused", async () => {
    const { s, applicationId } = await approvedDeal("dup");
    await record(s, applicationId);
    expect(await refusalOf(record(s, applicationId))).toMatch(/already recorded/i);
  });

  test("the amount the payer saw is pinned: a different figure is refused and nothing is written", async () => {
    const { s, applicationId } = await approvedDeal("pin");
    expect(await refusalOf(record(s, applicationId, { expectedAmountMinor: FORWARD - 1 }))).toMatch(/changed since you opened/i);
    expect(await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).toHaveLength(0);
  });

  test("a payment dated in a CLOSED period is refused with the prior-period sentence", async () => {
    const { s, applicationId } = await approvedDeal("closed");
    const year = s.fiscalYear;
    // A second, earlier period that is closed.
    await s.owner.as.mutation(api.accountingPeriods.create, {
      orgId: s.orgId, startDate: Date.UTC(year - 1, 0, 1), endDate: Date.UTC(year - 1, 11, 31, 23, 59, 59, 999),
      fiscalYear: year - 1, periodNumber: 1,
    });
    const periods = await s.owner.as.query(api.accountingPeriods.list, { orgId: s.orgId });
    const earlier = periods.find((p: { fiscalYear: number }) => p.fiscalYear === year - 1)!;
    await s.t.run((ctx) => ctx.db.patch(earlier._id, { status: "CLOSED" }));
    const refusal = await refusalOf(record(s, applicationId, { paidAt: Date.UTC(year - 1, 5, 1) }));
    expect(refusal).toBe(
      "This payment was made in a closed accounting period. An accountant must record it as a prior-period correction."
    );
    expect(await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).toHaveLength(0);
  });

  test("an OPEN-period paidAt before the sale posts at paidAt and keeps it on the row", async () => {
    const { s, applicationId } = await approvedDeal("open");
    const paidAt = Date.UTC(s.fiscalYear, 0, 2);
    await record(s, applicationId, { paidAt });
    const event = await s.t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).find(
        (e) => e.eventType === "FINANCE_COMPANY_FORWARD_PAID"
      )
    );
    expect(event?.status).toBe("POSTED");
    expect(event?.occurredAt).toBe(paidAt);
    const row = (await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect()))[0];
    expect(row.paidAt).toBe(paidAt);
  });

  test("a future paidAt and a missing permission are refused", async () => {
    const { s, applicationId } = await approvedDeal("perm");
    expect(await refusalOf(record(s, applicationId, { paidAt: Date.now() + 86_400_000 }))).toMatch(/future/i);
    // MANAGER holds no view:finance, so cannot move the money; SALES neither.
    expect(await refusalOf(record(s, applicationId, {}, s.manager.as))).not.toBeNull();
    expect(await refusalOf(record(s, applicationId, {}, s.sales.as))).not.toBeNull();
    expect(await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).toHaveLength(0);
  });

  test("another organization cannot record, reverse or report on this deal", async () => {
    const { s, applicationId, forwardId } = await finalizedDeal("tenA");
    const other = await seedDealership("tenB");
    const asOther = other.owner.as;
    expect(
      await refusalOf(
        asOther.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
          orgId: other.orgId, applicationId, method: "BANK_TRANSFER", bankAccountId: await seedBank(other.t, other.orgId), paidAt: Date.now(),
          expectedAmountMinor: FORWARD, idempotencyKey: crypto.randomUUID(),
        })
      )
    ).toMatch(/not found/i);
    for (const command of [api.financeCompanyForward.reverseFinanceCompanyForward, api.financeCompanyForward.reportFinanceCompanyForwardReturned]) {
      expect(
        await refusalOf(
          asOther.mutation(command, { orgId: other.orgId, applicationId, forwardId, reason: "x", idempotencyKey: crypto.randomUUID() })
        )
      ).not.toBeNull();
    }
    expect((await proofOf(s, applicationId)).state).toBe("SETTLED");
  });
});

describe("SCRUM-435 - reversal and return", () => {
  test("reverse before the transfer: reason required, the proof reads REVERSED via the linked reversal event, the deal is due again", async () => {
    const { s, applicationId, forwardId } = await finalizedDeal("rev1");
    const reverse = (reason: string, key = crypto.randomUUID()) =>
      s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
        orgId: s.orgId, applicationId, forwardId, reason, idempotencyKey: key,
      });
    expect(await refusalOf(reverse("   "))).toMatch(/reason is required/i);
    expect((await proofOf(s, applicationId)).state).toBe("SETTLED");

    const key = crypto.randomUUID();
    await reverse("Paid the wrong company.", key);
    await reverse("Paid the wrong company.", key); // replay
    const proof = await proofOf(s, applicationId);
    expect(proof.state).toBe("DUE");
    expect(proof.versions[0].state).toBe("REVERSED");
    const original = await s.t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).find(
        (e) => e.eventType === "FINANCE_COMPANY_FORWARD_PAID" && e.status === "REVERSED"
      )
    );
    expect(original?.reversedByEventId).toBeDefined();
    // A replacement may now be recorded as version 2.
    await record(s, applicationId);
    const again = await proofOf(s, applicationId);
    expect(again.state).toBe("SETTLED");
    expect(again.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  test("a REVERSED original with no reversal link is NEEDS_REPAIR and blocks the transfer", async () => {
    const { s, applicationId, forwardId } = await finalizedDeal("rev2");
    await s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
      orgId: s.orgId, applicationId, forwardId, reason: "Recorded twice.", idempotencyKey: crypto.randomUUID(),
    });
    await s.t.run(async (ctx) => {
      const original = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).find(
        (e) => e.eventType === "FINANCE_COMPANY_FORWARD_PAID" && e.status === "REVERSED"
      )!;
      await ctx.db.patch(original._id, { reversedByEventId: undefined });
    });
    expect((await proofOf(s, applicationId)).state).toBe("NEEDS_REPAIR");
    expect(await refusalOf(confirmTransfer(s, applicationId))).toMatch(/does not match the books/i);
  });

  test("reverse is refused once the transfer is confirmed; the return is reported instead and the deal is due again", async () => {
    const { s, applicationId, forwardId } = await finalizedDeal("ret1");
    await confirmTransfer(s, applicationId);
    expect(
      await refusalOf(
        s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
          orgId: s.orgId, applicationId, forwardId, reason: "Too late.", idempotencyKey: crypto.randomUUID(),
        })
      )
    ).toMatch(/report it as returned/i);
    await s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
      orgId: s.orgId, applicationId, forwardId, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
    });
    const proof = await proofOf(s, applicationId);
    expect(proof.versions[0].state).toBe("RETURNED");
    expect(proof.state).toBe("DUE");
    expect(proof.returnedExceptionOpen).toBe(true);
  });
});

describe("SCRUM-435 - cancelling a finalized v2 deal", () => {
  const cancel = (s: Seeded, applicationId: Id<"financeApplications">, as = s.owner.as) =>
    as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
    });

  test("SALES and ACCOUNTANT are refused; a MANAGER is allowed; the sales-role refusal names the manager", async () => {
    const { s, applicationId } = await dueDeal("can1");
    expect(await refusalOf(cancel(s, applicationId, s.sales.as))).not.toBeNull();
    expect(await refusalOf(cancel(s, applicationId, s.accountant.as))).not.toBeNull();
    // A user who may cancel a closed deal but not confirm the transfer is told a manager cancels.
    const finalizerOnly = ["cancel:closed_deal", "create:finance_application", "view:finance_applications"];
    const userId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "can1_fin", email: "can1.fin@example.com", name: "fin" }));
    const roleId = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "FINALIZER", permissions: finalizerOnly }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId }));
    const asFinalizer = s.t.withIdentity({ subject: "can1_fin", clerkId: "can1_fin" });
    expect(await refusalOf(cancel(s, applicationId, asFinalizer))).toBe("A manager cancels a finalized deal.");
    expect(await refusalOf(cancel(s, applicationId, s.manager.as))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });

  test("a payment on the books blocks the cancel; after a REPORTED return it is allowed", async () => {
    const { s, applicationId, forwardId } = await finalizedDeal("can2");
    expect(await refusalOf(cancel(s, applicationId))).toMatch(/already been paid to the finance company/i);
    await s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
      orgId: s.orgId, applicationId, forwardId, reason: "Returned by the company.", idempotencyKey: crypto.randomUUID(),
    });
    expect(await refusalOf(cancel(s, applicationId))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });

  test("a reversal that is still pending blocks the cancel", async () => {
    const { s, applicationId, forwardId } = await finalizedDeal("can3");
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.get(forwardId))!;
      await ctx.db.patch(forwardId, {
        reversalRequestedAt: Date.now(), reversalKind: "VOID", reverseReason: "x",
        reversalIdempotencyKey: `finance_company_forward_reversal_${row.applicationId}_v${row.version}`,
      });
      await ctx.db.insert("pendingAccountingEvents", {
        orgId: s.orgId, kind: "REVERSE", status: "PENDING",
        idempotencyKey: `finance_company_forward_reversal_${row.applicationId}_v${row.version}`,
        accountingDate: Date.now(), actorId: row.actorId, attempts: 0, createdAt: Date.now(), sourceType: "FINANCE_COMPANY_FORWARD", sourceId: String(row._id),
      } as never);
    });
    expect((await proofOf(s, applicationId)).state).toBe("REVERSAL_PENDING");
    expect(await refusalOf(cancel(s, applicationId))).toMatch(/reversal .* not yet posted/i);
  });
});

describe("SCRUM-435 - v1 deals are never recomputed", () => {
  test("a deal without the v2 marker is NOT_DUE and the gate does not apply", async () => {
    const { s, applicationId } = await finalizedDeal("v1");
    await downgradeToV1(s, applicationId);
    const proof = await proofOf(s, applicationId);
    expect(proof.state).toBe("NOT_DUE");
    expect(proof.applies).toBe(false);
  });
});

/**
 * New finalizations freeze plan v3 (SCRUM-411), but a deal closed under v2 must
 * keep every forward rule: the proof, the transfer gate, reverse and return,
 * manager-only cancel and unwind. The deal is finalized through the real
 * mutation and then re-marked v2 (version + fingerprint prefix), so this group
 * is the only one in the file that is not v3.
 */
describe("SCRUM-411 - a deal closed under plan v2 keeps the forward rules", () => {
  async function closedV2Deal(tag: string) {
    // Due again (payment taken back), the state an old v2 deal was in after finalize.
    const { s, applicationId } = await dueDeal(tag);
    await downgradeToV2(s, applicationId);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("CLOSED");
    expect(app?.financedSalePlanVersion).toBe(2);
    expect(planVersionOf(app!)).toBe(2);
    return { s, applicationId };
  }

  test("the proof applies, is DUE for the frozen H + C, and the transfer is gated until it is paid", async () => {
    const { s, applicationId } = await closedV2Deal("v2fwd");
    const proof = await proofOf(s, applicationId);
    expect(proof.applies).toBe(true);
    expect(proof.state).toBe("DUE");
    expect(proof.dueMinor).toBe(FORWARD);
    expect(await refusalOf(confirmTransfer(s, applicationId))).toMatch(/manager or accountant records that payment/i);

    await record(s, applicationId);
    expect((await proofOf(s, applicationId)).state).toBe("SETTLED");
    const forwardNet = await netByAccount(s, "FINANCE_COMPANY_FORWARD_PAID");
    expect(forwardNet.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(FORWARD);
    expect(await refusalOf(confirmTransfer(s, applicationId, G))).toBeNull();
    expect((await netByAccount(s, "FINANCE_CASH_RECEIVED")).ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(-G);
  });

  test("reverse before the transfer makes it due again; after the transfer only a reported return does", async () => {
    const { s, applicationId } = await closedV2Deal("v2rev");
    const forwardId = await record(s, applicationId);
    const reverse = (reason: string) =>
      s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
        orgId: s.orgId, applicationId, forwardId, reason, idempotencyKey: crypto.randomUUID(),
      });
    await reverse("Paid the wrong company.");
    const reversed = await proofOf(s, applicationId);
    expect(reversed.state).toBe("DUE");
    expect(reversed.versions[0].state).toBe("REVERSED");

    const replacementId = await record(s, applicationId);
    await confirmTransfer(s, applicationId);
    expect(
      await refusalOf(
        s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
          orgId: s.orgId, applicationId, forwardId: replacementId, reason: "Too late.", idempotencyKey: crypto.randomUUID(),
        })
      )
    ).toMatch(/report it as returned/i);
    await s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
      orgId: s.orgId, applicationId, forwardId: replacementId, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
    });
    const returned = await proofOf(s, applicationId);
    expect(returned.state).toBe("DUE");
    expect(returned.returnedExceptionOpen).toBe(true);
  });

  test("only a manager cancels it: SALES and ACCOUNTANT are refused, a cancel-only role is told a manager cancels", async () => {
    const { s, applicationId } = await closedV2Deal("v2can");
    const cancel = (as = s.owner.as) =>
      as.mutation(api.applications.cancelApplication, {
        orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
      });
    expect(await refusalOf(cancel(s.sales.as))).not.toBeNull();
    expect(await refusalOf(cancel(s.accountant.as))).not.toBeNull();
    const userId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "v2can_fin", email: "v2can.fin@example.com", name: "fin" }));
    const roleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId: s.orgId, name: "FINALIZER",
        permissions: ["cancel:closed_deal", "create:finance_application", "view:finance_applications"],
      })
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId }));
    const asFinalizer = s.t.withIdentity({ subject: "v2can_fin", clerkId: "v2can_fin" });
    expect(await refusalOf(cancel(asFinalizer))).toBe("A manager cancels a finalized deal.");
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
    expect(await refusalOf(cancel(s.manager.as))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });

  test("a paid v2 deal is eligible for unwind, while the same paid deal marked v1 is not", async () => {
    const paid = async (tag: string) => {
      const { s, applicationId } = await closedV2Deal(tag);
      await record(s, applicationId);
      await confirmTransfer(s, applicationId);
      return { s, applicationId };
    };
    const start = (s: Seeded, applicationId: Id<"financeApplications">) =>
      s.owner.as.mutation(api.dealUnwind.startDealUnwind, {
        orgId: s.orgId, applicationId, reason: "Customer returned the car.", idempotencyKey: crypto.randomUUID(),
      });

    const v2 = await paid("v2unw");
    const unwindId = await start(v2.s, v2.applicationId);
    expect(await v2.s.t.run((ctx) => ctx.db.get(unwindId))).not.toBeNull();

    const v1 = await paid("v1unw");
    await downgradeToV1(v1.s, v1.applicationId);
    expect(await refusalOf(start(v1.s, v1.applicationId))).toBe(DEAL_UNWIND_MESSAGES.DEAL_UNWIND_NOT_ELIGIBLE);
  });
});

describe("SCRUM-435 - the cockpit shows the same proof, tiered by permission", () => {
  test("MANAGER sees status only (no amount anywhere); the finance tier sees the split; the rail names the dealership", async () => {
    const { s, applicationId } = await dueDeal("cock");
    const asManager = await s.manager.as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    expect(asManager?.forward.state).toBe("DUE");
    expect(asManager?.forward.mayCancelFinalized).toBe(true);
    expect(asManager?.forward.mayRecord).toBe(false);
    expect(asManager?.money).toBeNull();
    const serialized = JSON.stringify(asManager);
    for (const figure of ["1575000", "1375000", "200000"]) expect(serialized).not.toContain(figure);
    const disb = asManager?.stages.find((stage: { key: string }) => stage.key === "DISBURSEMENT");
    expect(disb).toMatchObject({ state: "BLOCKED", blocker: "AwaitingForwardToFinanceCompany", authority: "DEALER" });

    const asFinance = await s.owner.as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    expect(asFinance?.forward.mayRecord).toBe(true);
    expect(asFinance?.money?.forward).toMatchObject({ dueMinor: FORWARD, depositMinor: H, contributionMinor: C, onBooksMinor: 0 });

    await record(s, applicationId);
    const after = await s.owner.as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    expect(after?.forward.state).toBe("SETTLED");
    expect(after?.money?.forward.onBooksMinor).toBe(FORWARD);
    const railAfter = after?.stages.find((stage: { key: string }) => stage.key === "DISBURSEMENT");
    expect(railAfter?.blocker).not.toBe("AwaitingForwardToFinanceCompany");
  });

  test("SALES cannot cancel a finalized deal and the cockpit does not offer it", async () => {
    const { s, applicationId } = await dueDeal("cock2");
    const asSales = await s.sales.as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    expect(asSales?.forward.mayCancelFinalized).toBe(false);
  });

  test("SCRUM-413: a role that may cancel closed deals and confirm, WITHOUT create-application, is offered and accepted", async () => {
    // Reversing a CLOSED deal is its own authority (cancel:closed_deal) and no longer needs
    // CREATE_FINANCE_APPLICATION, so the cockpit offers it and the server accepts it.
    const { s, applicationId } = await dueDeal("cock3");
    const perms = ["cancel:closed_deal", "confirm:finance_disbursement", "view:finance_applications", "view:sales", "edit:sales", "view:vehicles", "view:customers", "approve:requests"];
    const userId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "cock3_fc", email: "cock3.fc@example.com", name: "fc" }));
    const roleId = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "FIN_CONFIRM", permissions: perms }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId }));
    const asRole = s.t.withIdentity({ subject: "cock3_fc", clerkId: "cock3_fc" });
    const cockpit = await asRole.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    expect(cockpit?.forward.mayCancelFinalized).toBe(true);
    // Both sides of "the cockpit offers exactly what the server accepts".
    const refusal = await refusalOf(
      asRole.mutation(api.applications.cancelApplication, {
        orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
      })
    );
    expect(refusal).toBeNull();
  });
});

describe("SCRUM-435 - replacement eligibility follows the same proof", () => {
  test("a replacement payment is refused while the earlier one is on the books or its reversal is pending", async () => {
    const { s, applicationId, forwardId } = await finalizedDeal("repl");
    expect(await refusalOf(record(s, applicationId))).toMatch(/already recorded/i);
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.get(forwardId))!;
      const key = `finance_company_forward_reversal_${row.applicationId}_v${row.version}`;
      await ctx.db.patch(forwardId, { reversalRequestedAt: Date.now(), reversalKind: "VOID", reverseReason: "x", reversalIdempotencyKey: key });
      await ctx.db.insert("pendingAccountingEvents", {
        orgId: s.orgId, kind: "REVERSE", status: "PENDING", idempotencyKey: key, accountingDate: Date.now(),
        actorId: row.actorId, attempts: 0, createdAt: Date.now(), sourceType: "FINANCE_COMPANY_FORWARD", sourceId: String(row._id),
      } as never);
    });
    expect((await proofOf(s, applicationId)).state).toBe("REVERSAL_PENDING");
    expect(await refusalOf(record(s, applicationId))).not.toBeNull();
    expect(await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).toHaveLength(1);
  });
});

/**
 * The finance company can send the dealership's payment back AFTER it confirmed
 * the transfer. The amount owed is due again, and the replacement payment must be
 * recordable (no dead end), on the same one proof, with a balanced ledger.
 */
describe("SCRUM-435 - returned after the transfer: the replacement payment is recordable", () => {
  const ledger = (s: Seeded) =>
    s.t.run(async (ctx) => {
      const lines = await ctx.db.query("journalLines").collect();
      let debit = 0;
      let credit = 0;
      let apFinance = 0;
      for (const line of lines) {
        if (line.orgId !== s.orgId) continue;
        debit += line.debitMinor;
        credit += line.creditMinor;
        const account = await ctx.db.get(line.accountId);
        if (account?.systemKey === "ACCOUNTS_PAYABLE_FINANCE_COMPANIES") apFinance += line.debitMinor - line.creditMinor;
      }
      return { debit, credit, apFinance };
    });
  const reportReturned = (s: Seeded, applicationId: Id<"financeApplications">, forwardId: Id<"financeCompanyForwards">) =>
    s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
      orgId: s.orgId, applicationId, forwardId, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
    });
  const railOf = async (s: Seeded, applicationId: Id<"financeApplications">) =>
    (await s.owner.as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId }))!;

  test("record -> transfer -> returned -> replacement succeeds; SETTLED, ledger balanced, AP-Finance nets to zero", async () => {
    const { s, applicationId, forwardId: first } = await finalizedDeal("rat1");
    await confirmTransfer(s, applicationId);
    await reportReturned(s, applicationId, first);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.disbursedAt).toBeDefined();
    const returned = await proofOf(s, applicationId);
    expect(returned.state).toBe("DUE");
    expect(returned.returnedExceptionOpen).toBe(true);
    expect((await ledger(s)).apFinance).toBe(-FORWARD);

    const cockpitReturned = await railOf(s, applicationId);
    expect(cockpitReturned.forward).toMatchObject({ state: "DUE", returnedExceptionOpen: true, transferConfirmed: true });
    const stageOpen = cockpitReturned.stages.find((stage: { key: string }) => stage.key === "DISBURSEMENT");
    expect(stageOpen?.state).not.toBe("COMPLETE");
    expect(stageOpen?.blocker).toBe("AwaitingForwardToFinanceCompany");

    const replacement = await record(s, applicationId);
    expect(replacement).not.toBe(first);
    const settled = await proofOf(s, applicationId);
    expect(settled.state).toBe("SETTLED");
    expect(settled.returnedExceptionOpen).toBe(false);
    expect(settled.versions.map((v) => v.state)).toEqual(["RETURNED", "ON_BOOKS"]);
    const books = await ledger(s);
    expect(books.debit).toBe(books.credit);
    expect(books.apFinance).toBe(0);

    const stageClosed = (await railOf(s, applicationId)).stages.find((stage: { key: string }) => stage.key === "DISBURSEMENT");
    expect(stageClosed?.state).toBe("COMPLETE");
  });

  test("replay of the replacement (same key) books one row and one entry", async () => {
    const { s, applicationId, forwardId: first } = await finalizedDeal("rat2");
    await confirmTransfer(s, applicationId);
    await reportReturned(s, applicationId, first);
    const key = crypto.randomUUID();
    const paidAt = Date.now() - 1000;
    const one = await record(s, applicationId, { idempotencyKey: key, paidAt });
    const two = await record(s, applicationId, { idempotencyKey: key, paidAt });
    expect(two).toEqual(one);
    expect(await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).toHaveLength(2);
    expect((await ledger(s)).apFinance).toBe(0);
  });

  test("control: after the transfer with the forward SETTLED (nothing returned) the record is refused", async () => {
    const { s, applicationId } = await finalizedDeal("rat3");
    await confirmTransfer(s, applicationId);
    expect(await refusalOf(record(s, applicationId))).toMatch(/transfer is already confirmed/i);
    expect(await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).toHaveLength(1);
  });

  test("control: after the transfer with the forward ON_BOOKS again a second record is refused", async () => {
    const { s, applicationId, forwardId: first } = await finalizedDeal("rat4");
    await confirmTransfer(s, applicationId);
    await reportReturned(s, applicationId, first);
    await record(s, applicationId);
    expect(await refusalOf(record(s, applicationId))).toMatch(/transfer is already confirmed/i);
    expect(await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).toHaveLength(2);
  });

  test("the replacement after the transfer still pins the amount and needs the permission", async () => {
    const { s, applicationId, forwardId: first } = await finalizedDeal("rat5");
    await confirmTransfer(s, applicationId);
    await reportReturned(s, applicationId, first);
    expect(await refusalOf(record(s, applicationId, { expectedAmountMinor: FORWARD - 1 }))).toMatch(/changed since you opened/i);
    expect(await refusalOf(record(s, applicationId, {}, s.sales.as))).not.toBeNull();
    expect(await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).toHaveLength(1);
  });
});

/**
 * F2: a return reported while no period is open queues its reversal (or the
 * queued reversal fails). The money is owed again from the moment the return is
 * REPORTED, so the exception must be open in those states too - otherwise the
 * stage rail shows COMPLETE while the finance company holds the money.
 */
describe("SCRUM-435 - a reported return with an unposted reversal keeps the exception open", () => {
  const setPeriods = (s: Seeded, status: "OPEN" | "CLOSED") =>
    s.t.run(async (ctx) => {
      for (const period of await ctx.db.query("accountingPeriods").collect()) {
        if (period.orgId === s.orgId) await ctx.db.patch(period._id, { status });
      }
    });
  const drainOutbox = async (s: Seeded) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await s.t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId: s.orgId });
      for (let pass = 0; pass < 10; pass += 1) {
        await s.t.finishAllScheduledFunctions(vi.runAllTimers);
        const queued = (await s.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
          (f) => f.state.kind === "pending" || f.state.kind === "inProgress"
        ).length;
        if (queued === 0) break;
      }
    } finally {
      vi.useRealTimers();
    }
  };
  const cockpitOf = async (s: Seeded, applicationId: Id<"financeApplications">) =>
    (await s.owner.as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId }))!;
  const disbursementOf = async (s: Seeded, applicationId: Id<"financeApplications">) =>
    (await cockpitOf(s, applicationId)).stages.find((stage: { key: string }) => stage.key === "DISBURSEMENT");
  const reportReturned = (s: Seeded, applicationId: Id<"financeApplications">, forwardId: Id<"financeCompanyForwards">) =>
    s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
      orgId: s.orgId, applicationId, forwardId, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
    });

  test("no period open: REVERSAL_PENDING keeps the exception and DISBURSEMENT live; replacement refused until the reversal posts", async () => {
    const { s, applicationId, forwardId: first } = await finalizedDeal("f2a");
    await confirmTransfer(s, applicationId);
    await setPeriods(s, "CLOSED");
    await reportReturned(s, applicationId, first);

    const pending = await proofOf(s, applicationId);
    expect(pending.state).toBe("REVERSAL_PENDING");
    expect(pending.versions[0].state).toBe("REVERSAL_PENDING");
    expect(pending.returnedExceptionOpen).toBe(true);
    const cockpit = await cockpitOf(s, applicationId);
    expect(cockpit.forward).toMatchObject({ state: "REVERSAL_PENDING", returnedExceptionOpen: true, transferConfirmed: true });
    const stage = await disbursementOf(s, applicationId);
    expect(stage?.state).not.toBe("COMPLETE");
    expect(stage?.blocker).toBe("ForwardNotSettled");
    expect(await refusalOf(record(s, applicationId))).toMatch(/transfer is already confirmed/i);
    expect(await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).toHaveLength(1);

    await setPeriods(s, "OPEN");
    await drainOutbox(s);
    const drained = await proofOf(s, applicationId);
    expect(drained.versions[0].state).toBe("RETURNED");
    expect(drained.state).toBe("DUE");
    expect(drained.returnedExceptionOpen).toBe(true);
    expect((await disbursementOf(s, applicationId))?.blocker).toBe("AwaitingForwardToFinanceCompany");

    await record(s, applicationId);
    const settled = await proofOf(s, applicationId);
    expect(settled.state).toBe("SETTLED");
    expect(settled.returnedExceptionOpen).toBe(false);
    expect((await disbursementOf(s, applicationId))?.state).toBe("COMPLETE");
  });

  test("a failed queued return reversal is NEEDS_REPAIR and keeps the exception open", async () => {
    const { s, applicationId, forwardId: first } = await finalizedDeal("f2b");
    await confirmTransfer(s, applicationId);
    await setPeriods(s, "CLOSED");
    await reportReturned(s, applicationId, first);
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("pendingAccountingEvents").collect()).find((r) => r.kind === "REVERSE" && r.orgId === s.orgId)!;
      await ctx.db.patch(row._id, { status: "FAILED" });
    });
    const proof = await proofOf(s, applicationId);
    expect(proof.state).toBe("NEEDS_REPAIR");
    expect(proof.returnedExceptionOpen).toBe(true);
    const stage = await disbursementOf(s, applicationId);
    expect(stage?.state).not.toBe("COMPLETE");
    expect(stage?.blocker).toBe("ForwardNotSettled");
  });

  test("control: a take-back BEFORE the transfer with a queued reversal does not open the exception", async () => {
    const { s, applicationId, forwardId } = await finalizedDeal("f2c");
    await setPeriods(s, "CLOSED");
    await s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
      orgId: s.orgId, applicationId, forwardId, reason: "Recorded in error.", idempotencyKey: crypto.randomUUID(),
    });
    const proof = await proofOf(s, applicationId);
    expect(proof.state).toBe("REVERSAL_PENDING");
    expect(proof.returnedExceptionOpen).toBe(false);
  });

  test("control: an open-period return is RETURNED / DUE with the exception open", async () => {
    const { s, applicationId, forwardId: first } = await finalizedDeal("f2d");
    await confirmTransfer(s, applicationId);
    await reportReturned(s, applicationId, first);
    const proof = await proofOf(s, applicationId);
    expect(proof.versions[0].state).toBe("RETURNED");
    expect(proof.state).toBe("DUE");
    expect(proof.returnedExceptionOpen).toBe(true);
  });
});
describe("SCRUM-54 - the forward names the physical bank it left", () => {
  const NOT_FOUND = "The selected bank account was not found in this organization.";
  const insertBank = (s: Seeded, orgId: Id<"organizations">, over: { currency?: string; isActive?: boolean; isDeleted?: boolean } = {}) =>
    s.t.run((ctx) =>
      ctx.db.insert("bankAccounts", {
        orgId, name: "Bank", currency: over.currency ?? "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(),
        isActive: over.isActive ?? true, isReconciliationTarget: false, createdBy: s.owner.userId,
        createdAt: Date.now(), updatedAt: Date.now(), isDeleted: over.isDeleted,
      })
    );
  /** The journal lines of every forward payment event, with the account each hit and the bank it names. */
  const forwardLines = (s: Seeded) =>
    s.t.run(async (ctx) => {
      const events = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
        (e) => e.eventType === "FINANCE_COMPANY_FORWARD_PAID"
      );
      const out: Array<{ systemKey: string | undefined; debitMinor: number; creditMinor: number; bankAccountId: Id<"bankAccounts"> | undefined }> = [];
      const orgEntries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
      for (const event of events) {
        for (const entry of orgEntries.filter((e) => e.accountingEventId === event._id)) {
          const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
          for (const l of lines) {
            out.push({
              systemKey: (await ctx.db.get(l.accountId))?.systemKey,
              debitMinor: l.debitMinor, creditMinor: l.creditMinor, bankAccountId: l.bankAccountId,
            });
          }
        }
      }
      return { events, lines: out };
    });
  const everything = (s: Seeded) => dbSnapshot(s.t, Object.keys(schema.tables));

  test.each([
    ["foreign organization", NOT_FOUND],
    ["deleted", NOT_FOUND],
    ["inactive", "The selected bank account is inactive."],
    ["wrong currency", "denominated in USD"],
  ] as const)("a %s bank is refused and nothing is written", async (kind, message) => {
    const { s, applicationId } = await approvedDeal(`bad-${kind.replace(" ", "-")}`);
    const foreignOrg = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Foreign", createdAt: Date.now() }));
    const bankAccountId =
      kind === "foreign organization" ? await insertBank(s, foreignOrg)
      : kind === "deleted" ? await insertBank(s, s.orgId, { isDeleted: true })
      : kind === "inactive" ? await insertBank(s, s.orgId, { isActive: false })
      : await insertBank(s, s.orgId, { currency: "USD" });
    const before = await everything(s);
    expect(await refusalOf(record(s, applicationId, { bankAccountId }))).toContain(message);
    expect(await everything(s)).toEqual(before);
    expect((await forwardLines(s)).events).toHaveLength(0);
  });

  test.each(["BANK_TRANSFER", "CARD", "CHEQUE"] as const)("%s without a bank is refused and nothing is written", async (method) => {
    const { s, applicationId } = await approvedDeal(`none-${method}`);
    await seedBank(s.t, s.orgId); // a bank exists: it must still be CHOSEN, never defaulted
    const before = await everything(s);
    expect(await refusalOf(record(s, applicationId, { method, bankAccountId: null }))).toContain("Select the bank account");
    expect(await everything(s)).toEqual(before);
  });

  test("CASH with a bank is refused and nothing is written; CASH alone credits the cash drawer and names no bank", async () => {
    const { s, applicationId } = await approvedDeal("cash");
    const bankAccountId = await seedBank(s.t, s.orgId);
    const before = await everything(s);
    expect(await refusalOf(record(s, applicationId, { method: "CASH", bankAccountId }))).toContain("applies only to a bank transfer, card or cheque");
    expect(await everything(s)).toEqual(before);

    await record(s, applicationId, { method: "CASH" });
    const { lines, events } = await forwardLines(s);
    expect(lines.find((l) => l.systemKey === SYSTEM_KEYS.CASH_ON_HAND)).toMatchObject({ creditMinor: FORWARD });
    expect(lines.some((l) => l.systemKey === SYSTEM_KEYS.BANK_ACCOUNT)).toBe(false);
    expect(lines.filter((l) => l.bankAccountId !== undefined)).toEqual([]);
    expect(events[0].payload).not.toHaveProperty("bankAccountId");
  });

  test("a valid Bank A is named on the BANK_ACCOUNT credit only - Bank B is never attributed", async () => {
    const { s, applicationId } = await approvedDeal("attrib");
    const bankA = await insertBank(s, s.orgId);
    const bankB = await insertBank(s, s.orgId);
    await record(s, applicationId, { bankAccountId: bankA });
    const { lines, events } = await forwardLines(s);
    const named = lines.filter((l) => l.bankAccountId !== undefined);
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ systemKey: SYSTEM_KEYS.BANK_ACCOUNT, creditMinor: FORWARD, debitMinor: 0, bankAccountId: bankA });
    expect(lines.some((l) => l.bankAccountId === bankB)).toBe(false);
    expect(lines.find((l) => l.systemKey === SYSTEM_KEYS.ACCOUNTS_PAYABLE_FINANCE_COMPANIES)?.bankAccountId).toBeUndefined();
    expect(events[0].payload).toMatchObject({ bankAccountId: String(bankA) });
  });

  test("the same key with a different bank is a different instruction, not a replay; the same bank replays", async () => {
    const { s, applicationId } = await approvedDeal("replay");
    const bankA = await insertBank(s, s.orgId);
    const bankB = await insertBank(s, s.orgId);
    const key = crypto.randomUUID();
    const paidAt = Date.now() - 1000;
    const first = await record(s, applicationId, { idempotencyKey: key, paidAt, bankAccountId: bankA });
    expect(await refusalOf(record(s, applicationId, { idempotencyKey: key, paidAt, bankAccountId: bankB }))).toContain(
      "Idempotency key reused with different request content."
    );
    expect(await record(s, applicationId, { idempotencyKey: key, paidAt, bankAccountId: bankA })).toEqual(first);
    const { lines } = await forwardLines(s);
    expect(lines.filter((l) => l.bankAccountId !== undefined)).toHaveLength(1);
  });

  test("an event queued BEFORE the bank existed still drains: it posts the credit unnamed (the book balance withholds on it)", () => {
    // A finance-company posting always names its payer; a queued event carried one and simply no bank.
    const legacy = ruleFinanceCompanyForwardPaid({
      forwardId: "f", applicationId: "a", payerNameSnapshot: "Legacy Finance Co", amountMinor: FORWARD, currency: "JOD", paymentMethod: "BANK_TRANSFER",
    });
    const credit = legacy.lines.find((l) => l.accountSystemKey === SYSTEM_KEYS.BANK_ACCOUNT);
    expect(credit).toMatchObject({ creditMinor: FORWARD, debitMinor: 0 });
    expect(credit?.bankAccountId).toBeUndefined();
    expect(legacy.lines.filter((l) => l.bankAccountId !== undefined)).toEqual([]);
    // Cash never carries a bank, even if a payload did.
    const cash = ruleFinanceCompanyForwardPaid({
      forwardId: "f", applicationId: "a", payerNameSnapshot: "Legacy Finance Co", amountMinor: FORWARD, currency: "JOD", paymentMethod: "CASH", bankAccountId: "stray",
    });
    expect(cash.lines.filter((l) => l.bankAccountId !== undefined)).toEqual([]);
  });

  test("the bank list is served to the forward's own permission pair and to nobody without it", async () => {
    const { s } = await approvedDeal("list");
    const bank = await insertBank(s, s.orgId);
    await insertBank(s, s.orgId, { currency: "USD" });
    const owner = await s.owner.as.query(api.financeCompanyForward.listForwardBankOptions, { orgId: s.orgId, currency: "JOD" });
    expect(owner.banks.map((b: { _id: Id<"bankAccounts"> }) => b._id)).toEqual([bank]);
    // The default manager holds neither view:finance nor manage:finance: it cannot read the list or create a bank.
    expect(await refusalOf(s.manager.as.query(api.financeCompanyForward.listForwardBankOptions, { orgId: s.orgId, currency: "JOD" }))).not.toBeNull();
    expect(await refusalOf(s.sales.as.query(api.financeCompanyForward.listForwardBankOptions, { orgId: s.orgId, currency: "JOD" }))).not.toBeNull();
  });
});

describe("SCRUM-435 - isReportedReturn (pure)", () => {
  test("a RETURNED intent counts in every unposted-or-posted state, never once settled or absent", () => {
    for (const state of ["RETURNED", "REVERSAL_PENDING", "NEEDS_REPAIR"] as const) {
      expect(isReportedReturn({ state, reversalKind: "RETURNED" })).toBe(true);
      expect(isReportedReturn({ state, reversalKind: "VOID" })).toBe(false);
      expect(isReportedReturn({ state, reversalKind: undefined })).toBe(false);
    }
    for (const state of ["ON_BOOKS", "REVERSED", "POSTING_PENDING", "POSTING_FAILED"] as const) {
      expect(isReportedReturn({ state, reversalKind: "RETURNED" })).toBe(false);
    }
  });
});