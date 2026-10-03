/**
 * SCRUM-571 S1 (Codex N1) — sales.list must not return an empty first page while
 * live sales exist. The old convex-helpers `filter(...).paginate()` filtered AFTER
 * the page was fetched, so a first page made only of soft-deleted sales came back
 * empty (with isDone false), which a `usePaginatedQuery` caller reads as "no
 * sales". The stream-based form filters BEFORE the page is cut.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function makeWorld() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "List Dealer", createdAt: Date.now() }));
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "list_user", email: "l@example.com", name: "Lister" }));
  const otherUserId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "list_other", email: "o@example.com", name: "Other Rep" })
  );
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Admin", permissions: ["view:sales"] }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "VIN-LIST",
      make: "Honda",
      model: "Accord",
      year: 2020,
      color: "Black",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 1,
      sellingPrice: 15000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "John", lastName: "Doe", email: "c@example.com" })
  );
  return {
    t,
    orgId,
    userId,
    otherUserId,
    vehicleId,
    customerId,
    asUser: t.withIdentity({ subject: "list_user", clerkId: "list_user" }),
  };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

async function addSale(w: World, over: { isDeleted?: boolean; salespersonId?: Id<"users"> } = {}) {
  return await w.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: w.orgId,
      vehicleId: w.vehicleId,
      customerId: w.customerId,
      salespersonId: over.salespersonId ?? w.userId,
      salePrice: 1000,
      saleDate: Date.now(),
      status: "COMPLETED",
      ...(over.isDeleted ? { isDeleted: true } : {}),
    } as never)
  );
}

const list = (w: World, numItems: number, cursor: string | null = null, salespersonId?: Id<"users">) =>
  w.asUser.query(api.sales.list, {
    orgId: w.orgId,
    ...(salespersonId ? { salespersonId } : {}),
    paginationOpts: { numItems, cursor },
  });

describe("sales.list — soft-deleted rows never produce an empty first page", () => {
  test("5 soft-deleted sales then 1 live sale, numItems 5: the FIRST page contains the live sale", async () => {
    const w = await makeWorld();
    for (let i = 0; i < 5; i++) await addSale(w, { isDeleted: true });
    const live = await addSale(w);

    const first = await list(w, 5);
    expect(first.page.map((s: { _id: string }) => s._id)).toEqual([live]);
  });

  test("control: a live sale inside the first raw page is returned", async () => {
    const w = await makeWorld();
    const live = await addSale(w);
    await addSale(w, { isDeleted: true });
    const first = await list(w, 5);
    expect(first.page.map((s: { _id: string }) => s._id)).toEqual([live]);
  });

  test("salesperson index variant: same guarantee for by_org_salesperson", async () => {
    const w = await makeWorld();
    for (let i = 0; i < 5; i++) await addSale(w, { isDeleted: true });
    const live = await addSale(w);
    const someoneElse = await addSale(w, { salespersonId: w.otherUserId });

    const mine = await list(w, 5, null, w.userId);
    expect(mine.page.map((s: { _id: string }) => s._id)).toEqual([live]);
    const theirs = await list(w, 5, null, w.otherUserId);
    expect(theirs.page.map((s: { _id: string }) => s._id)).toEqual([someoneElse]);
  });

  test("cursor continuation returns every live sale exactly once, with no duplicates", async () => {
    const w = await makeWorld();
    const expected: string[] = [];
    for (let i = 0; i < 4; i++) await addSale(w, { isDeleted: true });
    for (let i = 0; i < 3; i++) {
      expected.push(await addSale(w));
      await addSale(w, { isDeleted: true });
    }
    expected.push(await addSale(w));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = await list(w, 2, cursor);
      seen.push(...page.page.map((s: { _id: string }) => s._id));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
