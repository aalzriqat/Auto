/**
 * The payroll settlement guard must fail CLOSED.
 *
 * `payrollPaidBlockedReason` decides whether a queued PAYROLL_PAID event may
 * credit Salaries/Commission Payable and Employee Advances. Returning null means
 * "not blocked" — the credits post. Every path that cannot *prove* the matching
 * accruals are already on the books must therefore return a reason, not null:
 * an unverifiable payslip reference is exactly the case where the prerequisite
 * cannot be checked at all.
 */
import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../schema";
import { payrollPostingBlockedReason } from "./payrollSourceLedger";

async function seed(t: any, suffix: string) {
  return await t.run(async (ctx: any) => {
    const orgId = await ctx.db.insert("organizations", {
      name: `Payroll ${suffix}`,
      createdAt: Date.now(),
    });
    const otherOrgId = await ctx.db.insert("organizations", {
      name: `Other ${suffix}`,
      createdAt: Date.now(),
    });
    const userId = await ctx.db.insert("users", {
      clerkId: `psl_${suffix}`,
      email: `${suffix}@psl.example.com`,
      name: "Employee",
    });
    const runId = await ctx.db.insert("payrollRuns", {
      orgId,
      periodYear: 2026,
      periodMonth: 7,
      status: "APPROVED",
      currency: "JOD",
      totalGrossMinor: 10000,
      totalNetMinor: 10000,
      createdBy: userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const makeItem = async (owner: any) =>
      await ctx.db.insert("payrollItems", {
        orgId: owner,
        runId,
        userId,
        baseSalaryMinor: 0,
        commissionMinor: 10000,
        otherEarningsMinor: 0,
        advanceDeductionMinor: 0,
        otherDeductionMinor: 0,
        grossMinor: 10000,
        netMinor: 10000,
        currency: "JOD",
        commissionSaleIds: [],
        createdAt: Date.now(),
      });
    return {
      orgId,
      otherOrgId,
      userId,
      ownItemId: await makeItem(orgId),
      foreignItemId: await makeItem(otherOrgId),
    };
  });
}

function paidEntry(orgId: any, payload: Record<string, unknown>) {
  return { orgId, eventType: "PAYROLL_PAID", payload };
}

describe("payrollPaidBlockedReason fails closed", () => {
  test("blocks a commission settlement whose payslip reference does not resolve", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId } = await seed(t, "unresolvable");

    const reason = await t.run((ctx: any) =>
      payrollPostingBlockedReason(
        ctx,
        paidEntry(orgId, { itemId: "not-a-real-convex-id", commissionMinor: 10000 })
      )
    );

    expect(reason).toMatch(/could not be resolved/i);
  });

  test("blocks a commission settlement whose payslip belongs to another org", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, foreignItemId } = await seed(t, "crossorg");

    const reason = await t.run((ctx: any) =>
      payrollPostingBlockedReason(
        ctx,
        paidEntry(orgId, { itemId: foreignItemId, commissionMinor: 10000 })
      )
    );

    expect(reason).toMatch(/could not be resolved/i);
  });

  test("blocks an advance recovery whose payslip reference does not resolve", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId } = await seed(t, "advunres");

    const reason = await t.run((ctx: any) =>
      payrollPostingBlockedReason(
        ctx,
        paidEntry(orgId, { itemId: "not-a-real-convex-id", advanceRecoveredMinor: 5000 })
      )
    );

    expect(reason).toMatch(/could not be resolved/i);
  });

  test("blocks an advance recovery whose payslip belongs to another org", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, foreignItemId } = await seed(t, "advcross");

    const reason = await t.run((ctx: any) =>
      payrollPostingBlockedReason(
        ctx,
        paidEntry(orgId, { itemId: foreignItemId, advanceRecoveredMinor: 5000 })
      )
    );

    expect(reason).toMatch(/could not be resolved/i);
  });

  test("allows a settlement whose payslip resolves in-org with no outstanding accruals", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownItemId } = await seed(t, "happy");

    const reason = await t.run((ctx: any) =>
      payrollPostingBlockedReason(
        ctx,
        paidEntry(orgId, { itemId: ownItemId, commissionMinor: 10000, advanceRecoveredMinor: 5000 })
      )
    );

    expect(reason).toBeNull();
  });

  test("still ignores events that are not payroll settlements", async () => {
    const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
    const { orgId } = await seed(t, "other");

    const reason = await t.run((ctx: any) =>
      payrollPostingBlockedReason(ctx, {
        orgId,
        eventType: "SALE_COMPLETED",
        payload: { itemId: "not-a-real-convex-id", commissionMinor: 10000 },
      })
    );

    expect(reason).toBeNull();
  });
});
