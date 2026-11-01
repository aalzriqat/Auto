import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PERMISSIONS } from "./utils/permissions";

/**
 * SCRUM-887 slice A: the management reads behind the Suppliers screen.
 *
 * Proves: VIEW_FINANCE is required (VIEW_VEHICLES alone is refused, and the picker projection is
 * unchanged for that role), another organization's suppliers never appear, inactive suppliers are
 * listed and searchable, the page size is clamped, and search finds a supplier by name, alias and
 * tax id.
 */

const MODULES = import.meta.glob("./**/*.*s");
const setup = () => convexTestWithComponents(schema, MODULES);
type T = ReturnType<typeof setup>;

let seq = 0;
const next = (): string => `s887-${++seq}`;

async function financeOrg(t: T, label: string, permissions: string[] = [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.MANAGE_FINANCE]) {
  const seeded = await seedOrgWithMember(t, {
    clerkId: `fin-${label}-${next()}`,
    permissions,
    orgName: `Org ${label}`,
    roleName: "ACCOUNTANT",
  });
  await t.mutation(internal.suppliers.initialiseRegistry, { orgId: seeded.orgId });
  return seeded;
}

async function memberWith(t: T, orgId: Id<"organizations">, permissions: string[]) {
  const clerkId = `member-${next()}`;
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: clerkId });
    const roleId = await ctx.db.insert("roles", { orgId, name: clerkId, permissions });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
  });
  return t.withIdentity({ subject: clerkId });
}

async function refusalCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: { code?: string } }).data;
    return data?.code ?? String((error as Error).message);
  }
  throw new Error("Expected the call to be refused.");
}

const PAGE = { numItems: 50, cursor: null as string | null };

describe("SCRUM-887 suppliers.listForManagement", () => {
  test("lists active and inactive rows with the management fields, and no contact data", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const active = await identity.mutation(api.suppliers.create, {
      orgId,
      idempotencyKey: next(),
      displayName: "Gulf Motors",
      legalName: "Gulf Motors LLC",
      contact: { phone: "0790000000" },
      taxId: "123-456",
      taxJurisdiction: "JO",
    });
    const dormant = await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Dormant Co" });
    await identity.mutation(api.suppliers.deactivate, { orgId, supplierId: dormant.supplierId, reason: "closed" });

    const all = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: PAGE });
    expect(all.page.map((r) => r.displayName).sort()).toEqual(["Dormant Co", "Gulf Motors"]);
    const gulf = all.page.find((r) => r._id === active.supplierId)!;
    expect(gulf).toMatchObject({ legalName: "Gulf Motors LLC", taxId: "123-456", taxJurisdiction: "JO", status: "ACTIVE", version: 1 });
    expect(JSON.stringify(all.page)).not.toContain("0790000000");

    const inactive = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: PAGE, status: "INACTIVE" });
    expect(inactive.page.map((r) => r.displayName)).toEqual(["Dormant Co"]);
    const onlyActive = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: PAGE, status: "ACTIVE" });
    expect(onlyActive.page.map((r) => r.displayName)).toEqual(["Gulf Motors"]);
  });

  test("paginates and clamps an oversized page", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    for (let i = 0; i < 3; i++) {
      await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: `Supplier number ${i} xq` });
    }
    const first = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: { numItems: 2, cursor: null } });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const second = await identity.query(api.suppliers.listForManagement, {
      orgId,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);
    // A huge request is clamped rather than refused or served unbounded.
    const huge = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: { numItems: 100000, cursor: null } });
    expect(huge.page).toHaveLength(3);
  });

  test("never returns another organization's suppliers", async () => {
    const t = setup();
    const a = await financeOrg(t, "A");
    const b = await financeOrg(t, "B");
    await b.identity.mutation(api.suppliers.create, { orgId: b.orgId, idempotencyKey: next(), displayName: "Secret B Supplier" });
    await a.identity.mutation(api.suppliers.create, { orgId: a.orgId, idempotencyKey: next(), displayName: "A Supplier" });

    const listed = await a.identity.query(api.suppliers.listForManagement, { orgId: a.orgId, paginationOpts: PAGE });
    expect(listed.page.map((r) => r.displayName)).toEqual(["A Supplier"]);
    // Asking for the other organization's data is refused outright.
    expect(await refusalCode(a.identity.query(api.suppliers.listForManagement, { orgId: b.orgId, paginationOpts: PAGE }))).toMatch(
      /UNAUTHORIZED|FORBIDDEN|member/i,
    );
    expect(await refusalCode(a.identity.query(api.suppliers.searchForManagement, { orgId: b.orgId, query: "Secret" }))).toMatch(
      /UNAUTHORIZED|FORBIDDEN|member/i,
    );
    const found = await a.identity.query(api.suppliers.searchForManagement, { orgId: a.orgId, query: "Secret B Supplier" });
    // Full text may match A's own "Supplier" word; what matters is B's row never appears.
    expect(found.map((r) => r.displayName)).not.toContain("Secret B Supplier");
  });

  test("VIEW_VEHICLES alone is refused, and the picker projection stays narrow for it", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    await identity.mutation(api.suppliers.create, {
      orgId,
      idempotencyKey: next(),
      displayName: "Gulf Motors",
      taxId: "TX-9",
      taxJurisdiction: "JO",
    });
    const vehicles = await memberWith(t, orgId, [PERMISSIONS.VIEW_VEHICLES]);
    expect(await refusalCode(vehicles.query(api.suppliers.listForManagement, { orgId, paginationOpts: PAGE }))).toMatch(/FORBIDDEN|Missing/i);
    expect(await refusalCode(vehicles.query(api.suppliers.searchForManagement, { orgId, query: "Gulf" }))).toMatch(/FORBIDDEN|Missing/i);
    // The picker read is unchanged: id, name and status only.
    const picker = await vehicles.query(api.suppliers.list, { orgId, paginationOpts: PAGE });
    expect(Object.keys(picker.page[0]).sort()).toEqual(["_id", "displayName", "status"]);
  });

  test("VIEW_FINANCE without MANAGE_FINANCE reads, and every write is refused by the server", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const { supplierId } = await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Gulf Motors" });
    const reader = await memberWith(t, orgId, [PERMISSIONS.VIEW_FINANCE]);
    const listed = await reader.query(api.suppliers.listForManagement, { orgId, paginationOpts: PAGE });
    expect(listed.page).toHaveLength(1);
    const record = await reader.query(api.suppliers.get, { orgId, supplierId });
    expect(record).toHaveProperty("version");

    const missing = /FORBIDDEN|Missing/i;
    expect(await refusalCode(reader.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "New One" }))).toMatch(missing);
    expect(await refusalCode(reader.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: 1, legalName: "X" }))).toMatch(missing);
    expect(await refusalCode(reader.mutation(api.suppliers.deactivate, { orgId, supplierId, reason: "no" }))).toMatch(missing);
    expect(await refusalCode(reader.mutation(api.suppliers.reactivate, { orgId, supplierId }))).toMatch(missing);
    expect(await refusalCode(reader.mutation(api.suppliers.addAlias, { orgId, supplierId, alias: "GM" }))).toMatch(missing);
  });
});

describe("SCRUM-887 suppliers.searchForManagement", () => {
  test("finds a supplier by name, active alias and tax id, including an inactive one", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const gulf = await identity.mutation(api.suppliers.create, {
      orgId,
      idempotencyKey: next(),
      displayName: "Gulf Motors",
      taxId: "TX-777-A",
      taxJurisdiction: "JO",
    });
    await identity.mutation(api.suppliers.addAlias, { orgId, supplierId: gulf.supplierId, alias: "GM Trading" });
    const old = await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Old Dealer" });
    await identity.mutation(api.suppliers.deactivate, { orgId, supplierId: old.supplierId, reason: "closed" });

    const byName = await identity.query(api.suppliers.searchForManagement, { orgId, query: "gulf motors" });
    expect(byName.map((r) => r._id)).toEqual([gulf.supplierId]);
    const byAlias = await identity.query(api.suppliers.searchForManagement, { orgId, query: "GM Trading" });
    expect(byAlias.map((r) => r._id)).toEqual([gulf.supplierId]);
    const byTax = await identity.query(api.suppliers.searchForManagement, { orgId, query: "tx777a" });
    expect(byTax.map((r) => r._id)).toEqual([gulf.supplierId]);
    const inactive = await identity.query(api.suppliers.searchForManagement, { orgId, query: "Old Dealer" });
    expect(inactive.map((r) => r.status)).toEqual(["INACTIVE"]);
  });

  test("the status filter excludes the other status and a retired alias finds nothing", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const old = await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Old Dealer" });
    await identity.mutation(api.suppliers.deactivate, { orgId, supplierId: old.supplierId, reason: "closed" });
    expect(await identity.query(api.suppliers.searchForManagement, { orgId, query: "Old Dealer", status: "ACTIVE" })).toEqual([]);
    expect(
      (await identity.query(api.suppliers.searchForManagement, { orgId, query: "Old Dealer", status: "INACTIVE" })).map((r) => r._id),
    ).toEqual([old.supplierId]);

    const alias = await identity.mutation(api.suppliers.addAlias, { orgId, supplierId: old.supplierId, alias: "Former Name" });
    await identity.mutation(api.suppliers.retireAlias, { orgId, aliasId: alias.aliasId });
    expect(await identity.query(api.suppliers.searchForManagement, { orgId, query: "Former Name" })).toEqual([]);
  });

  test("blank text returns nothing and the result is capped", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Gulf Motors" });
    expect(await identity.query(api.suppliers.searchForManagement, { orgId, query: "   " })).toEqual([]);
    expect(await identity.query(api.suppliers.searchForManagement, { orgId, query: "Gulf", limit: 0 })).toHaveLength(1);
  });
});
