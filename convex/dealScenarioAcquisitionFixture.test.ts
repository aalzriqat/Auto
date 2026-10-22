import { describe, expect, test, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { createCostedVehicle } from "../playwright/fixtures/dealScenarios";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

describe("SCRUM-857 scenario acquisition fixture through public backend handlers", () => {
  test.each(["BANK_TRANSFER", "CHEQUE", "CARD", "CASH", "ON_ACCOUNT"] as const)(
    "%s creates the costed vehicle without bypassing purchase-bank validation",
    async (costPaidBy) => {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const orgId = await t.run(async (ctx) => {
        const orgId = await ctx.db.insert("organizations", { name: "Scenario dealer", createdAt: Date.now() });
        const userId = await ctx.db.insert("users", {
          clerkId: "scenario-owner", email: "scenario-owner@example.test", name: "Scenario owner",
        });
        const roleId = await ctx.db.insert("roles", {
          orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true,
        });
        await ctx.db.insert("memberships", { orgId, userId, roleId });
        await ctx.db.insert("subscriptions", {
          orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
        });
        return orgId;
      });
      const owner = t.withIdentity({ subject: "scenario-owner" });
      await owner.mutation(api.orgSettings.upsert, { orgId, currency: "JOD", currencySymbol: "JD" });

      // Replace only the HTTP boundary. The fixture, validators, permissions,
      // purchase-bank guard and database handlers all execute unchanged.
      const client = new ConvexHttpClient("https://fixture-test.convex.cloud");
      vi.spyOn(client, "query").mockImplementation((...args: Parameters<ConvexHttpClient["query"]>) =>
        owner.query(args[0], args[1] ?? {}),
      );
      vi.spyOn(client, "mutation").mockImplementation((...args: Parameters<ConvexHttpClient["mutation"]>) =>
        owner.mutation(args[0], args[1] ?? {}),
      );

      const vehicleId = await createCostedVehicle(client, orgId, {
        model: `SCRUM-857-${costPaidBy}`, price: 15_000, cost: 10_000, costPaidBy,
      });
      const vehicle = await t.run((ctx) => ctx.db.get(vehicleId));
      expect(vehicle).toMatchObject({ orgId, purchasePrice: 10_000, sourceType: "STOCK" });

      const banks = await owner.query(api.bankAccounts.list, { orgId });
      if (["BANK_TRANSFER", "CHEQUE", "CARD"].includes(costPaidBy)) {
        expect(banks).toEqual([expect.objectContaining({ orgId, currency: "JOD", isActive: true })]);
      } else {
        expect(banks).toEqual([]);
      }
    },
  );
});
