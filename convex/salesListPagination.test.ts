/**
 * SCRUM-571 S1 — sales.list must not return an empty first page while live sales
 * exist. The current implementation is a native `.paginate()` over the
 * `by_org_deleted` / `by_org_salesperson_deleted` indexes with
 * `.lt("isDeleted", true)` (D-23 Q2), so soft-deleted rows are excluded by the
 * index range BEFORE the page is cut. History: Codex N1 found that the earlier
 * convex-helpers `filter(...).paginate()` filtered after the page was fetched
 * and could return an empty first page with isDone false.
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
      // undefined = field unset; true/false are written explicitly.
      ...(over.isDeleted === undefined ? {} : { isDeleted: over.isDeleted }),
    } as never)
  );
}

const ids = (r: { page: Array<{ _id: string }> }) => r.page.map((s) => s._id);

async function walk(w: World, numItems: number, salespersonId?: Id<"users">) {
  const seen: string[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const page: Awaited<ReturnType<typeof list>> = await list(w, numItems, cursor, salespersonId);
    seen.push(...ids(page));
    sizes.push(page.page.length);
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return { seen, sizes };
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
    // Newest first (SCRUM-603).
    expect(seen).toEqual([...expected].reverse());
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("sales.list — newest first (SCRUM-603)", () => {
  test.each([
    ["org branch", false],
    ["salesperson branch", true],
  ])("%s: page 1 (numItems 1) is the NEWEST live sale; soft-deleted and other reps never appear", async (_name, withRep) => {
    const w = await makeWorld();
    const rep = withRep ? w.userId : undefined;
    const oldest = await addSale(w);
    await addSale(w, { isDeleted: true });
    const middle = await addSale(w);
    const otherRep = await addSale(w, { salespersonId: w.otherUserId });
    const newest = await addSale(w);
    const newestDeleted = await addSale(w, { isDeleted: true });

    const first = await list(w, 1, null, rep);
    expect(ids(first)).toEqual([newest]);

    const { seen } = await walk(w, 1, rep);
    expect(seen).not.toContain(newestDeleted);
    expect(seen).toEqual(withRep ? [newest, middle, oldest] : [newest, otherRep, middle, oldest]);
  });
});

describe("sales.list — native isDeleted-index pagination (D-23 Q2)", () => {
  test.each([
    ["org branch", false],
    ["salesperson branch", true],
  ])("%s: every page is full past soft-deleted rows, and a walk returns each live sale once", async (_name, withRep) => {
    const w = await makeWorld();
    const rep = withRep ? w.userId : undefined;
    const live: string[] = [];
    // Deleted runs longer than a page, interleaved with live rows.
    for (let i = 0; i < 6; i++) await addSale(w, { isDeleted: true });
    for (let i = 0; i < 3; i++) live.push(await addSale(w));
    for (let i = 0; i < 5; i++) await addSale(w, { isDeleted: true });
    for (let i = 0; i < 4; i++) live.push(await addSale(w));
    // A different rep's sales must not leak into the salesperson branch.
    if (withRep) await addSale(w, { salespersonId: w.otherUserId });
    const deleted = await addSale(w, { isDeleted: true });

    const first = await list(w, 3, null, rep);
    expect(first.page).toHaveLength(3);

    const { seen, sizes } = await walk(w, 3, rep);
    // Newest first (SCRUM-603).
    expect(seen).toEqual([...live].reverse());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(deleted);
    // Every page except the last is full: no short pages caused by deleted rows.
    expect(sizes.slice(0, -1).every((n) => n === 3)).toBe(true);
  });

  // SCRUM-571-S1-ORDER-1 / D-28: the schema makes `isDeleted: false`
  // unrepresentable (`v.optional(v.literal(true))`), so the isDeleted index can
  // only hold unset (live) and true (soft-deleted) and descending index order is
  // creation order. The fixtures cast `as never`, so these assert the RUNTIME
  // schema rejection, not just the type.
  test("schema rejects inserting a sale with isDeleted:false", async () => {
    const w = await makeWorld();
    await expect(addSale(w, { isDeleted: false })).rejects.toThrow();
    // Control: unset and true are still accepted.
    await expect(addSale(w)).resolves.toBeTruthy();
    await expect(addSale(w, { isDeleted: true })).resolves.toBeTruthy();
  });

  test("schema rejects patching a live sale to isDeleted:false", async () => {
    const w = await makeWorld();
    const live = await addSale(w);
    await expect(w.t.run((ctx) => ctx.db.patch(live, { isDeleted: false } as never))).rejects.toThrow();
    // The row is untouched: still listed, still unset.
    const row = await w.t.run((ctx) => ctx.db.get(live));
    expect(row?.isDeleted).toBeUndefined();
    expect(ids(await list(w, 5))).toEqual([live]);
  });

  test("endCursor pins the page end: a re-run with endCursor ignores sales added after page 1", async () => {
    const w = await makeWorld();
    for (let i = 0; i < 5; i++) await addSale(w);
    // Newest first: a sale added later lands at the TOP, so the pinned range
    // is page 2 (the older rows), not page 1.
    const page1 = await list(w, 2);
    const page2 = await list(w, 2, page1.continueCursor);
    expect(page2.page).toHaveLength(2);
    await addSale(w);

    // numItems is larger than the pinned range, so only endCursor can bound it.
    const pinned = await w.asUser.query(api.sales.list, {
      orgId: w.orgId,
      paginationOpts: { numItems: 10, cursor: page1.continueCursor, endCursor: page2.continueCursor },
    });
    expect(ids(pinned)).toEqual(ids(page2));

    // Control: without endCursor the same call returns every remaining sale.
    const unpinned = await w.asUser.query(api.sales.list, {
      orgId: w.orgId,
      paginationOpts: { numItems: 10, cursor: page1.continueCursor },
    });
    expect(unpinned.page).toHaveLength(3);
  });
});
