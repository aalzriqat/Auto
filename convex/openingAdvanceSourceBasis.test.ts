// @vitest-environment node
import { expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { heldRows, settleScheduledOnly, withFrozenScheduler } from "../test-utils/outboxWork";
import { api } from "./_generated/api";
import schema from "./schema";

// Characterize the existing ordinary legacy branch before adding a different,
// verified opening basis. This fixture is NOT a public opening allocation.
test.each([false, true])("a legacy advance without issuance has distinct immediate/queued prerequisites (period open=%s)", async (openInitially) => withFrozenScheduler(async () => {
  // Preload the scheduled target before its first dispatch: this harness's
  // bounded timer pump can finish before a cold Vite module import resolves.
  // No mutation is invoked here; only the native scheduled jobs do the work.
  await import("./accountingOutbox");
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST legacy advance basis", createdAt: Date.now() });
    const actorId = await ctx.db.insert("users", { clerkId: "advance-basis-owner", email: "owner@example.test" });
    const employeeId = await ctx.db.insert("users", { clerkId: "advance-basis-employee", email: "employee@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    await ctx.db.insert("memberships", { orgId, userId: actorId, roleId });
    await ctx.db.insert("memberships", { orgId, userId: employeeId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    const advanceId = await ctx.db.insert("employeeAdvances", { orgId, userId: employeeId, amountMinor: 100_000,
      recoveredMinor: 0, currency: "JOD", date: Date.now(), status: "OUTSTANDING", createdBy: actorId,
      createdAt: Date.now(), updatedAt: Date.now() });
    return { orgId, advanceId };
  });
  const owner = t.withIdentity({ subject: "advance-basis-owner" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  const year = new Date().getUTCFullYear();
  async function openPeriod() {
    await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
    const period = (await owner.query(api.accountingPeriods.list, { orgId: ids.orgId }))[0];
    if (!period) throw new Error("Missing synthetic period");
    await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  }
  if (openInitially) await openPeriod();
  // Own timers before fixture scheduling, then settle only the work it issued.
  await settleScheduledOnly(t, ids.orgId);
    const args = { orgId: ids.orgId, advanceId: ids.advanceId, amount: 40, method: "CASH" as const,
      idempotencyKey: "legacy-basis-recovery" };
    await owner.mutation(api.payroll.recoverAdvance, args);
    if (!openInitially) {
      expect(await t.run((ctx) => ctx.db.query("journalLines").collect())).toEqual([]);
      await openPeriod();
      await settleScheduledOnly(t, ids.orgId);
      const held = await heldRows(t, ids.orgId);
      expect(held).toHaveLength(1);
      expect(held[0].eventType).toBe("EMPLOYEE_ADVANCE_RECOVERED");
      expect(held[0].lastError).toContain("advance issuance");
    }
    const events = await t.run((ctx) => ctx.db.query("accountingEvents").collect());
    expect(events.map((event) => event.eventType)).toEqual(openInitially ? ["EMPLOYEE_ADVANCE_RECOVERED"] : []);
    const lines = await t.run((ctx) => ctx.db.query("journalLines").collect());
    expect(lines).toHaveLength(openInitially ? 2 : 0);
    const advance = await t.run((ctx) => ctx.db.get(ids.advanceId));
    expect(advance?.recoveredMinor).toBe(40_000);
    await owner.mutation(api.payroll.recoverAdvance, args);
    expect(await t.run((ctx) => ctx.db.query("journalLines").collect())).toEqual(lines);
    expect(await t.run((ctx) => ctx.db.query("employeeAdvanceRecoveries").collect())).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect()))
      .some((event) => event.eventType === "EMPLOYEE_ADVANCE_PAID")).toBe(false);
}));
