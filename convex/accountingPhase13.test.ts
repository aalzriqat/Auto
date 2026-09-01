/**
 * Phase 13 tests — claim receivables and settlement.
 *
 * Acceptance gates: creating a claim opens a receivable; settling it records
 * a payment, allocates it, and posts DR Bank / CR Finance-company AR;
 * rejecting writes it off with a balanced entry; direct status patching is
 * gone; the Phase 6 migration CLAIM_PAYMENT skip gap is closed.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedClaimsDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase13 Dealer", createdAt: Date.now() })
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
    ctx.db.insert("users", { clerkId: "p13_owner", email: "p13owner@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asOwner = t.withIdentity({ subject: "p13_owner", clerkId: "p13_owner" });

  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, userId, asOwner };
}

type Ctx = Awaited<ReturnType<typeof seedClaimsDealer>>;

async function eventsOfType(t: Ctx["t"], orgId: Id<"organizations">, eventType: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .filter((q) => q.eq(q.field("eventType"), eventType))
      .collect()
  );
}

async function linesForEvent(t: Ctx["t"], event: { journalEntryId?: Id<"journalEntries"> }) {
  if (!event.journalEntryId) throw new Error("Event has no journalEntryId");
  const journalEntryId = event.journalEntryId;
  return await t.run((ctx) =>
    ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalEntryId)).collect()
  );
}

function totals(lines: { debitMinor: number; creditMinor: number }[]) {
  return {
    debit: lines.reduce((s, l) => s + l.debitMinor, 0),
    credit: lines.reduce((s, l) => s + l.creditMinor, 0),
  };
}

async function accountBySystemKey(t: Ctx["t"], orgId: Id<"organizations">, systemKey: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
      .unique()
  );
}

/**
 * ⚠️ SUPERSEDED BY SCRUM-51 — the Claims GL lifecycle described here no
 * longer exists.
 *
 * Four describes lived at this point: claim creation opening a
 * finance-company receivable, settlement posting DR Bank / CR Finance-company
 * AR, rejection posting a write-off, and the event-driven status rules. Every
 * one of them asserted Claims acting as a SECOND finance-company AR
 * authority, which is the defect SCRUM-51 reports: `claims.add` opened a
 * canonical receivable with no originating GL debit, while `settle` and
 * `reject` credited an AR balance that nothing had ever debited.
 *
 * Owner ruling c14514, re-scoped by c14519, resolved the model rather than
 * adding the missing debit: the Finance Application receivable is
 * authoritative, and Claims is retired to a read-only view over it.
 *
 * These tests are not deleted quietly. They are replaced by the assertion
 * that the behaviour they covered is now unreachable — otherwise the suite
 * would simply fall silent about a lifecycle it used to guard. The full
 * five-door refusal matrix, the zero-side-effect proof and the projection
 * coverage live in `claimsRetirement.test.ts`.
 *
 * Phase 13's legacy CLAIM_PAYMENT migration coverage below is untouched: it
 * concerns historical `transactions` rows, not the retired writers.
 */
describe("Phase 13 — the Claims GL lifecycle is retired (SCRUM-51)", () => {
  test("a claim can no longer open a finance-company receivable", async () => {
    const { t, orgId, asOwner } = await seedClaimsDealer();

    await expect(
      asOwner.mutation(api.claims.add, {
        orgId,
        claimDate: Date.now(),
        financingEntity: "Jordan Finance Co",
        buyerName: "Buyer X",
        claimAmountMinor: 750_000,
      })
    ).rejects.toThrow(/retired/i);

    // Asserted as an ABSENCE, not as a refusal. A door that reports failure
    // and writes anyway would satisfy the rejection above; only the empty
    // tables prove the second authority is really gone.
    const claims = await t.run((ctx) => ctx.db.query("claims").collect());
    expect(claims).toHaveLength(0);
    const receivables = await t.run((ctx) =>
      ctx.db.query("receivableDocuments").collect()
    );
    expect(receivables).toHaveLength(0);
  });
});
describe("Phase 13 — legacy migration gap", () => {
  test("CLAIM_PAYMENT legacy transactions now migrate with a balanced entry", async () => {
    const { t, orgId, asOwner } = await seedClaimsDealer();

    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId, type: "IN", amount: 400, date: Date.now(),
        category: "CLAIM_PAYMENT", description: "Legacy claim payment",
      })
    );

    const result = await asOwner.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false,
    });
    expect(result.posted).toBe(1);
    expect(result.skipped).toBe(0);

    const events = await eventsOfType(t, orgId, "CLAIM_SETTLED");
    expect(events).toHaveLength(1);

    // 400 JOD → 400_000 minor at scale 3; legacy migration settles as CASH.
    const lines = await linesForEvent(t, events[0]);
    const { debit, credit } = totals(lines);
    expect(debit).toBe(400_000);
    expect(debit).toBe(credit);
    const cash = await accountBySystemKey(t, orgId, "CASH_ON_HAND");
    expect(lines.find((l) => l.accountId === cash?._id)?.debitMinor).toBe(400_000);
  });
});
