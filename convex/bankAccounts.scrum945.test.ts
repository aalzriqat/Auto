/**
 * SCRUM-945 — a finance manager edits a bank's STATED opening balance and date.
 *
 * Invariant under test: `openingBalanceMinor` / `openingBalanceDate` are reference
 * metadata. Editing them never changes any balance (getBookBalance is identical
 * before and after) and always leaves exactly one audit trace (UPDATE_BANK_OPENING_REFERENCE)
 * when a value really changes. Validation is shared by create and update.
 *
 * Harness note: convex-test proves the code runs in the harness, not on the platform.
 * Reconciliation reads here use the NO_OPENING path (no posted opening journal is seeded),
 * so `referenceOpeningMinor` is asserted; the posted-opening difference is not.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const ACTION = "UPDATE_BANK_OPENING_REFERENCE";
const MAX_DATE_MS = 8.64e15;

async function seed() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  async function makeOrg(name: string) {
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name, createdAt: Date.now() }));
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
    );
    return orgId;
  }
  async function makeMember(orgId: Id<"organizations">, clerkId: string, permissions: string[]) {
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@example.com`, name: clerkId }));
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: `role-${clerkId}`, permissions, isSystemOwnerRole: false })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return { userId, as: t.withIdentity({ subject: clerkId, clerkId }) };
  }
  const orgId = await makeOrg("SCRUM945 Dealer");
  const otherOrgId = await makeOrg("SCRUM945 Other Dealer");
  const manager = await makeMember(orgId, "s945_manager", ["view:finance", "manage:finance"]);
  const viewer = await makeMember(orgId, "s945_viewer", ["view:finance"]);
  const otherManager = await makeMember(otherOrgId, "s945_other", ["view:finance", "manage:finance"]);
  return { t, orgId, otherOrgId, manager, viewer, otherManager };
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function createBank(s: Seed, overrides: Record<string, unknown> = {}) {
  return await s.manager.as.mutation(api.bankAccounts.create, {
    orgId: s.orgId,
    name: "Operating JOD",
    currency: "JOD",
    openingBalanceMinor: 1_000_000,
    openingBalanceDate: Date.UTC(2026, 0, 1),
    isReconciliationTarget: true,
    ...overrides,
  } as never);
}

const auditRows = (s: Seed) =>
  s.t.run(async (ctx) => {
    const rows = await ctx.db.query("financialAuditLog").take(100);
    return rows.filter((r) => r.actionType === (ACTION as never));
  });

const loadBank = (s: Seed, id: Id<"bankAccounts">) => s.t.run((ctx) => ctx.db.get(id));

describe("bankAccounts.update stated opening reference (SCRUM-945)", () => {
  test("changes the stated opening and date, and the opening reconciliation reports the new reference", async () => {
    const s = await seed();
    const bankAccountId = await createBank(s);
    const newDate = Date.UTC(2026, 2, 15);

    await s.manager.as.mutation(api.bankAccounts.update, {
      orgId: s.orgId, bankAccountId, openingBalanceMinor: 2_500_000, openingBalanceDate: newDate,
    });

    const bank = await loadBank(s, bankAccountId);
    expect(bank?.openingBalanceMinor).toBe(2_500_000);
    expect(bank?.openingBalanceDate).toBe(newDate);
    const reconciliation = await s.manager.as.query(api.bankAccounts.openingReconciliation, { orgId: s.orgId });
    expect(reconciliation.status).toBe("NO_OPENING");
    expect(reconciliation.banks.find((b) => b.bankAccountId === bankAccountId)?.referenceOpeningMinor).toBe(2_500_000);
  });

  test("writes exactly one audit row with before/after and actor; identical resave and name-only patch write none", async () => {
    const s = await seed();
    const bankAccountId = await createBank(s);
    const oldDate = Date.UTC(2026, 0, 1);
    const newDate = Date.UTC(2026, 2, 15);

    await s.manager.as.mutation(api.bankAccounts.update, {
      orgId: s.orgId, bankAccountId, openingBalanceMinor: 2_500_000, openingBalanceDate: newDate,
    });
    const rows = await auditRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: s.orgId,
      actorId: s.manager.userId,
      actionType: ACTION,
      resourceType: "bankAccounts",
      resourceId: bankAccountId.toString(),
      before: { openingBalanceMinor: 1_000_000, openingBalanceDate: oldDate },
      after: { openingBalanceMinor: 2_500_000, openingBalanceDate: newDate },
    });
    expect(rows[0].description).toContain("Operating JOD");

    // Same values resubmitted: no new row.
    await s.manager.as.mutation(api.bankAccounts.update, {
      orgId: s.orgId, bankAccountId, openingBalanceMinor: 2_500_000, openingBalanceDate: newDate,
    });
    // Name-only patch: no new row.
    await s.manager.as.mutation(api.bankAccounts.update, { orgId: s.orgId, bankAccountId, name: "Renamed" });
    expect(await auditRows(s)).toHaveLength(1);

    // Only the date changes: one more row.
    await s.manager.as.mutation(api.bankAccounts.update, {
      orgId: s.orgId, bankAccountId, openingBalanceDate: Date.UTC(2026, 3, 1),
    });
    expect(await auditRows(s)).toHaveLength(2);
  });

  test("a member without manage:finance is refused; the bank is unchanged and nothing is audited", async () => {
    const s = await seed();
    const bankAccountId = await createBank(s);
    const before = await loadBank(s, bankAccountId);

    await expect(
      s.viewer.as.mutation(api.bankAccounts.update, { orgId: s.orgId, bankAccountId, openingBalanceMinor: 9_999 })
    ).rejects.toThrow();

    expect(await loadBank(s, bankAccountId)).toEqual(before);
    expect(await auditRows(s)).toHaveLength(0);
  });

  const BAD_AMOUNTS: Array<[string, number]> = [
    ["a fractional amount (1.5)", 1.5],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];
  const BAD_DATES: Array<[string, number]> = [
    ["a fractional date", 1_700_000_000_000.5],
    ["a date beyond the ECMAScript range", MAX_DATE_MS + 1],
    ["a date before the ECMAScript range", -MAX_DATE_MS - 1],
    ["NaN", Number.NaN],
  ];

  test.each(BAD_AMOUNTS)("update refuses %s as the amount and writes nothing", async (_label, amount) => {
    const s = await seed();
    const bankAccountId = await createBank(s);
    const before = await loadBank(s, bankAccountId);
    await expect(
      s.manager.as.mutation(api.bankAccounts.update, { orgId: s.orgId, bankAccountId, openingBalanceMinor: amount })
    ).rejects.toThrow();
    expect(await loadBank(s, bankAccountId)).toEqual(before);
    expect(await auditRows(s)).toHaveLength(0);
  });

  test.each(BAD_DATES)("update refuses %s as the date and writes nothing", async (_label, date) => {
    const s = await seed();
    const bankAccountId = await createBank(s);
    const before = await loadBank(s, bankAccountId);
    await expect(
      s.manager.as.mutation(api.bankAccounts.update, { orgId: s.orgId, bankAccountId, openingBalanceDate: date })
    ).rejects.toThrow();
    expect(await loadBank(s, bankAccountId)).toEqual(before);
    expect(await auditRows(s)).toHaveLength(0);
  });

  test.each(BAD_AMOUNTS)("create refuses %s as the amount", async (_label, amount) => {
    const s = await seed();
    await expect(createBank(s, { openingBalanceMinor: amount })).rejects.toThrow();
    expect(await s.t.run((ctx) => ctx.db.query("bankAccounts").take(100))).toHaveLength(0);
  });

  test.each(BAD_DATES)("create refuses %s as the date", async (_label, date) => {
    const s = await seed();
    await expect(createBank(s, { openingBalanceDate: date })).rejects.toThrow();
    expect(await s.t.run((ctx) => ctx.db.query("bankAccounts").take(100))).toHaveLength(0);
  });

  test("a negative safe integer is accepted (an overdrawn stated opening) on update and create", async () => {
    const s = await seed();
    const bankAccountId = await createBank(s, { openingBalanceMinor: -250_000 });
    expect((await loadBank(s, bankAccountId))?.openingBalanceMinor).toBe(-250_000);

    await s.manager.as.mutation(api.bankAccounts.update, { orgId: s.orgId, bankAccountId, openingBalanceMinor: -1 });
    expect((await loadBank(s, bankAccountId))?.openingBalanceMinor).toBe(-1);
    expect(await auditRows(s)).toHaveLength(1);
  });

  test("invariant: getBookBalance is identical before and after an edit", async () => {
    const s = await seed();
    const bankAccountId = await createBank(s);
    const asOf = Date.UTC(2026, 5, 1);
    const before = await s.manager.as.query(api.bankAccounts.getBookBalance, { orgId: s.orgId, asOf });

    await s.manager.as.mutation(api.bankAccounts.update, {
      orgId: s.orgId, bankAccountId, openingBalanceMinor: 7_777_777, openingBalanceDate: Date.UTC(2025, 11, 31),
    });

    expect(await s.manager.as.query(api.bankAccounts.getBookBalance, { orgId: s.orgId, asOf })).toEqual(before);
  });

  test("another organization's bank is refused and untouched", async () => {
    const s = await seed();
    const bankAccountId = await createBank(s);
    const before = await loadBank(s, bankAccountId);

    // Foreign member naming their own org but this org's bank id.
    await expect(
      s.otherManager.as.mutation(api.bankAccounts.update, { orgId: s.otherOrgId, bankAccountId, openingBalanceMinor: 5 })
    ).rejects.toThrow(/not found/i);
    // Foreign member naming this org.
    await expect(
      s.otherManager.as.mutation(api.bankAccounts.update, { orgId: s.orgId, bankAccountId, openingBalanceMinor: 5 })
    ).rejects.toThrow();

    expect(await loadBank(s, bankAccountId)).toEqual(before);
    expect(await auditRows(s)).toHaveLength(0);
  });
});
