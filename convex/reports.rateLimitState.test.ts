/**
 * SCRUM-1003: the report queries must not read rate-limit state.
 *
 * `rateLimiter.check` inside a query is `ctx.runQuery(component.lib.checkRateLimit)`, which reads the limiter's
 * `rateLimits` row. A row in a query's read set invalidates its cached result when the row changes, so every open
 * report would re-read its whole data set on a limiter write. `check` never consumes a token in a query, and no code
 * consumes `heavyRead` (it is only declared in convex/rateLimit.ts), so the read gated nothing.
 *
 * Evidence boundary: convex-test does not expose a query's read set or the limiter component's own reads. This test
 * observes the module boundary instead: (1) the real `rateLimiter` (not mocked) is spied on and must never be asked
 * anything by a report query, and (2) with the `heavyRead` bucket genuinely exhausted through the real component, every
 * report still returns its result. It cannot prove Convex's invalidation behaviour; that is a real-backend measurement.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { rateLimiter } from "./rateLimit";

const START = Date.UTC(2026, 2, 1);
const END = Date.UTC(2026, 2, 31);

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() }));
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "user_rl1", email: "rl@test.com", name: "Reports User" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["view:reports", "view:cost_price", "view:commissions"] }),
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { t, orgId, asUser: t.withIdentity({ subject: "user_rl1" }) };
}

describe("report queries and the heavyRead rate limit (SCRUM-1003)", () => {
  test("the six report queries never read rate-limit state and are not gated by an exhausted heavyRead bucket", async () => {
    const { t, orgId, asUser } = await setup();

    // Genuinely exhaust the bucket through the real component (capacity 20), so a query that still consulted it would throw.
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i += 1) await rateLimiter.limit(ctx, "heavyRead");
    });
    const exhausted = await t.run((ctx) => rateLimiter.check(ctx, "heavyRead"));
    expect(exhausted.ok).toBe(false);

    const check = vi.spyOn(rateLimiter, "check");
    const limit = vi.spyOn(rateLimiter, "limit");
    const getValue = vi.spyOn(rateLimiter, "getValue");
    try {
      const range = { orgId, startDate: START, endDate: END };
      const results = [
        await asUser.query(api.reports.getSalesAndProfitReport, range),
        await asUser.query(api.reports.getInventoryReport, { orgId }),
        await asUser.query(api.reports.getExpensesReport, range),
        await asUser.query(api.reports.getSalespersonPerformance, range),
        await asUser.query(api.reports.getLeadConversionReport, range),
        await asUser.query(api.reports.getProfitAndLoss, range),
      ];

      expect(results).toHaveLength(6);
      for (const result of results) expect(result).not.toBeNull();
      expect(check).not.toHaveBeenCalled();
      expect(limit).not.toHaveBeenCalled();
      expect(getValue).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
      limit.mockRestore();
      getValue.mockRestore();
    }
  });
});
