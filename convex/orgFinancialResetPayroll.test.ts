import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

// SCRUM-565: opens the destructive-reset gate for THIS file only (the gate itself is proven unmocked in
// orgFinancialReset.scrum565gate.test.ts).
vi.mock("./utils/resetProtocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/resetProtocol")>()),
  RESET_PROTOCOL_COMPLETE: true,
}));

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

/**
 * SCRUM-534 — a pass of the reset must not delete a sale while a surviving
 * payrollItems row still lists it in `commissionSaleIds`.
 */
describe("resetOrgFinancialData never strands a payroll item's commissionSaleIds", () => {
  test("a partial pass keeps the sale while a payroll item still lists it", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Payroll Order Motors", createdAt: Date.now(), suspended: true })
    );

    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "reset_u534p", email: "u534p@x.com" });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, vin: "VINRESET534P", make: "Kia", model: "Rio", year: 2024, mileage: 10,
        color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 15000,
        status: "AVAILABLE",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId, firstName: "Payroll", lastName: "Customer",
      });
      const saleId = await ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId, salePrice: 15000,
        saleDate: Date.now(), status: "COMPLETED" as const,
      });
      const runId = await ctx.db.insert("payrollRuns", {
        orgId, periodYear: 2026, periodMonth: 9, currency: "JOD", status: "DRAFT" as const,
        totalGrossMinor: 0, totalNetMinor: 0, createdAt: Date.now(), updatedAt: Date.now(),
      });
      // Insert order matters: the sale is listed only by the SECOND item, so a
      // batchSize-1 pass drains the first item while the second still holds it.
      for (const commissionSaleIds of [[], [saleId]]) {
        await ctx.db.insert("payrollItems", {
          orgId, runId, userId, baseSalaryMinor: 0, commissionMinor: 0,
          otherEarningsMinor: 0, advanceDeductionMinor: 0, otherDeductionMinor: 0,
          grossMinor: 0, netMinor: 0, currency: "JOD", commissionSaleIds,
          createdAt: Date.now(),
        });
      }
      return { saleId };
    });

    let remaining = Number.POSITIVE_INFINITY;
    for (let pass = 0; pass < 12 && remaining > 0; pass += 1) {
      const res = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
        orgId, dryRun: false, batchSize: 1,
      });
      remaining = res.remaining;
      await t.run(async (ctx) => {
        const items = await ctx.db.query("payrollItems").collect();
        for (const item of items) {
          for (const saleId of item.commissionSaleIds) {
            expect(await ctx.db.get(saleId), `pass ${pass}: payrollItem.commissionSaleIds`).not.toBeNull();
          }
        }
        if (pass === 0) {
          // Explicit, ordering-independent precondition (SCRUM-546 c21549): the
          // item holding the sale id MUST still exist after pass 0, otherwise
          // the loop above would pass vacuously.
          const holders = items.filter((item) => item.commissionSaleIds.includes(ids.saleId));
          expect(holders, "pass 0: the payroll item holding the sale id survives").toHaveLength(1);
          expect(await ctx.db.get(ids.saleId), "pass 0: the sale survives").not.toBeNull();
        }
      });
    }

    expect(remaining).toBe(0);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(ids.saleId)).toBeNull();
      expect(await ctx.db.query("payrollItems").collect()).toHaveLength(0);
      expect(await ctx.db.query("payrollRuns").collect()).toHaveLength(0);
    });
  });
});
