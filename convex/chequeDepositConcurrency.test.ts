import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function setupChequeTest() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);

  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Primary Dealership", createdAt: Date.now() })
  )) as Id<"organizations">;

  const otherOrgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Foreign Dealership", createdAt: Date.now() })
  )) as Id<"organizations">;

  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    await ctx.db.insert("subscriptions", {
      orgId: otherOrgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    });
  });

  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_finance", email: "finance@dealer.com", name: "Finance Manager" })
  )) as Id<"users">;

  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "FINANCE",
      permissions: ["view:finance", "manage:finance"],
    })
  );

  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asFinance = t.withIdentity({ subject: "user_finance" });

  const customerId = (await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Ahmad", lastName: "Zaid" })
  )) as Id<"customers">;

  const createCheque = async (overrides: Partial<Doc<"postDatedCheques">> = {}) => {
    return (await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId,
        customerId,
        bank: "Arab Bank",
        chequeNumber: `CHK-${Math.random().toString().slice(2, 8)}`,
        chequeDate: Date.now() + 7 * 86_400_000,
        amount: 1500,
        status: "HELD",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides,
      })
    )) as Id<"postDatedCheques">;
  };

  return { t, orgId, otherOrgId, userId, customerId, asFinance, createCheque };
}

describe("Cheque Deposit Concurrency, State Transition & OCC Semantics (BLOCKER 7)", () => {
  test("1. Rapid duplicate deposit / concurrent-equivalent calls: only one succeeds, second rejects under OCC/state guard", async () => {
    const { orgId, asFinance, createCheque, t } = await setupChequeTest();
    const chequeId = await createCheque();

    // Two concurrent calls dispatching depositCheque
    const results = await Promise.allSettled([
      asFinance.mutation(api.collections.depositCheque, { orgId, chequeId }),
      asFinance.mutation(api.collections.depositCheque, { orgId, chequeId }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one call succeeds
    expect(fulfilled).toHaveLength(1);
    // Exactly one call fails because the cheque is no longer in HELD status
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === "rejected") {
      expect(rejected[0].reason.message).toMatch(/Only held cheques can be deposited/i);
    }

    // Database state is DEPOSITED
    const finalCheque = await t.run((ctx) => ctx.db.get(chequeId));
    expect(finalCheque?.status).toBe("DEPOSITED");
  });

  test("2. Deposit after successful deposit: second call is rejected because cheque is non-HELD", async () => {
    const { orgId, asFinance, createCheque, t } = await setupChequeTest();
    const chequeId = await createCheque();

    // First deposit succeeds
    await asFinance.mutation(api.collections.depositCheque, { orgId, chequeId });

    // Second sequential deposit fails
    await expect(
      asFinance.mutation(api.collections.depositCheque, { orgId, chequeId })
    ).rejects.toThrow(/Only held cheques can be deposited/i);

    const finalCheque = await t.run((ctx) => ctx.db.get(chequeId));
    expect(finalCheque?.status).toBe("DEPOSITED");
  });

  test("3. Response-loss / retry scenario: depositCheque has no replay cache, client retry receives non-HELD refusal", async () => {
    const { orgId, asFinance, createCheque } = await setupChequeTest();
    const chequeId = await createCheque();

    // Initial attempt succeeds on server
    await asFinance.mutation(api.collections.depositCheque, { orgId, chequeId });

    // Client didn't receive acknowledgment (network timeout / response drop) and retries:
    // Because depositCheque does NOT accept an idempotency key or use runWithIdempotency,
    // it does NOT return a cached successful result. Instead, it re-evaluates the precondition
    // and refuses with ConvexError("Only held cheques can be deposited.").
    await expect(
      asFinance.mutation(api.collections.depositCheque, { orgId, chequeId })
    ).rejects.toThrow(/Only held cheques can be deposited/i);
  });

  test("4. Soft-deleted cheque: refused with 'Cheque not found' error", async () => {
    const { orgId, asFinance, createCheque } = await setupChequeTest();
    const chequeId = await createCheque({ isDeleted: true });

    await expect(
      asFinance.mutation(api.collections.depositCheque, { orgId, chequeId })
    ).rejects.toThrow(/Cheque not found/i);
  });

  test("5. Cross-tenant cheque: refused with 'Cheque not found' error across org boundaries", async () => {
    const { orgId, otherOrgId, asFinance, createCheque } = await setupChequeTest();
    // Cheque belongs to foreign org
    const foreignChequeId = await createCheque({ orgId: otherOrgId });

    // Primary org tries to deposit foreign cheque
    await expect(
      asFinance.mutation(api.collections.depositCheque, { orgId, chequeId: foreignChequeId })
    ).rejects.toThrow(/Cheque not found/i);
  });
});
