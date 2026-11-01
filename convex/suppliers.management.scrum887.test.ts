import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PERMISSIONS } from "./utils/permissions";
import { snapshotSupplier } from "./utils/supplierRegistry";

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
    // A caller who is not a member of the organization gets the exact UNAUTHORIZED refusal.
    expect(await refusalCode(a.identity.query(api.suppliers.listForManagement, { orgId: b.orgId, paginationOpts: PAGE }))).toBe("UNAUTHORIZED");
    expect(await refusalCode(a.identity.query(api.suppliers.searchForManagement, { orgId: b.orgId, query: "Secret" }))).toBe("UNAUTHORIZED");
    const found = await a.identity.query(api.suppliers.searchForManagement, { orgId: a.orgId, query: "Secret B Supplier" });
    // Full text may match A's own "Supplier" word; what matters is B's row never appears.
    expect(found.rows.map((r) => r.displayName)).not.toContain("Secret B Supplier");
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
    const { aliasId } = await identity.mutation(api.suppliers.addAlias, { orgId, supplierId, alias: "GM Trading" });
    const reader = await memberWith(t, orgId, [PERMISSIONS.VIEW_FINANCE]);
    const listed = await reader.query(api.suppliers.listForManagement, { orgId, paginationOpts: PAGE });
    expect(listed.page).toHaveLength(1);
    const record = await reader.query(api.suppliers.get, { orgId, supplierId });
    expect(record).toHaveProperty("version");

    // Everything the registry stores: suppliers, aliases and the registry version.
    const registry = () =>
      t.run(async (ctx) => ({
        suppliers: await ctx.db.query("suppliers").collect(),
        aliases: await ctx.db.query("supplierAliases").collect(),
        state: await ctx.db.query("supplierRegistryState").collect(),
      }));
    const before = await registry();

    const missing = /FORBIDDEN|Missing/i;
    expect(await refusalCode(reader.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "New One" }))).toMatch(missing);
    expect(await refusalCode(reader.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: 1, legalName: "X" }))).toMatch(missing);
    expect(await refusalCode(reader.mutation(api.suppliers.deactivate, { orgId, supplierId, reason: "no" }))).toMatch(missing);
    expect(await refusalCode(reader.mutation(api.suppliers.reactivate, { orgId, supplierId }))).toMatch(missing);
    expect(await refusalCode(reader.mutation(api.suppliers.addAlias, { orgId, supplierId, alias: "GM" }))).toMatch(missing);
    expect(await refusalCode(reader.mutation(api.suppliers.retireAlias, { orgId, aliasId }))).toMatch(missing);

    // suppliers.changed: 0 - the six refused writes left every registry row exactly as it was.
    expect(await registry()).toEqual(before);
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
    expect(byName.rows.map((r) => r._id)).toEqual([gulf.supplierId]);
    const byAlias = await identity.query(api.suppliers.searchForManagement, { orgId, query: "GM Trading" });
    expect(byAlias.rows.map((r) => r._id)).toEqual([gulf.supplierId]);
    const byTax = await identity.query(api.suppliers.searchForManagement, { orgId, query: "tx777a" });
    expect(byTax.rows.map((r) => r._id)).toEqual([gulf.supplierId]);
    const inactive = await identity.query(api.suppliers.searchForManagement, { orgId, query: "Old Dealer" });
    expect(inactive.rows.map((r) => r.status)).toEqual(["INACTIVE"]);
  });

  test("the status filter excludes the other status and a retired alias finds nothing", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const old = await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Old Dealer" });
    await identity.mutation(api.suppliers.deactivate, { orgId, supplierId: old.supplierId, reason: "closed" });
    expect((await identity.query(api.suppliers.searchForManagement, { orgId, query: "Old Dealer", status: "ACTIVE" })).rows).toEqual([]);
    expect(
      (await identity.query(api.suppliers.searchForManagement, { orgId, query: "Old Dealer", status: "INACTIVE" })).rows.map((r) => r._id),
    ).toEqual([old.supplierId]);

    const alias = await identity.mutation(api.suppliers.addAlias, { orgId, supplierId: old.supplierId, alias: "Former Name" });
    await identity.mutation(api.suppliers.retireAlias, { orgId, aliasId: alias.aliasId });
    expect((await identity.query(api.suppliers.searchForManagement, { orgId, query: "Former Name" })).rows).toEqual([]);
  });

  test("blank text returns nothing and the result is capped", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Gulf Motors" });
    expect(await identity.query(api.suppliers.searchForManagement, { orgId, query: "   " })).toEqual({ rows: [], truncated: false });
    expect((await identity.query(api.suppliers.searchForManagement, { orgId, query: "Gulf", limit: 0 })).rows).toHaveLength(1);
  });
});

describe("SCRUM-887 suppliers.listForManagement ordering", () => {
  test("the All filter lists active suppliers before inactive ones", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const dormant = await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Dormant Co" });
    await identity.mutation(api.suppliers.deactivate, { orgId, supplierId: dormant.supplierId, reason: "closed" });
    await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Alpha Motors" });
    await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Beta Motors" });

    const all = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: PAGE });
    expect(all.page.map((r) => r.status)).toEqual(["ACTIVE", "ACTIVE", "INACTIVE"]);
  });
});

/**
 * Seat 2 finding: `numItems` was clamped to 100 but a caller-supplied `endCursor` defines the range
 * independently of `numItems`
 * (https://docs.convex.dev/api/interfaces/server.PaginationOptions), so one call with `numItems: 1`
 * and a distant `endCursor` read the whole range. The server now also passes `maximumRowsRead`, so
 * an over-wide range comes back split (`pageStatus: "SplitRequired"`) instead of oversized.
 */
describe("SCRUM-887 suppliers.listForManagement read bound", () => {
  const SEEDED = 121;

  async function seededOrg() {
    const t = setup();
    const org = await financeOrg(t, "A");
    for (let i = 0; i < SEEDED; i++) {
      await org.identity.mutation(api.suppliers.create, {
        orgId: org.orgId,
        idempotencyKey: next(),
        displayName: `Bound supplier ${String(i).padStart(3, "0")}`,
      });
    }
    return org;
  }

  test("a distant endCursor with numItems 1 never returns more than 100 rows, and the page is split", async () => {
    const { orgId, identity } = await seededOrg();
    // Cursors come from ordinary list calls: after row 100, then after row 120.
    const first = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: { numItems: 100, cursor: null } });
    const second = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: { numItems: 20, cursor: first.continueCursor } });
    expect(first.page).toHaveLength(100);
    expect(second.page).toHaveLength(20);

    const wide = await identity.query(api.suppliers.listForManagement, {
      orgId,
      paginationOpts: { numItems: 1, cursor: null, endCursor: second.continueCursor },
    });
    expect(wide.page.length).toBeLessThanOrEqual(100);
    expect(wide.pageStatus).toBe("SplitRequired");
    expect(wide.splitCursor).toBeTruthy();

    // A client that follows the split gets bounded halves that together cover the range.
    const left = await identity.query(api.suppliers.listForManagement, {
      orgId,
      paginationOpts: { numItems: 1, cursor: null, endCursor: wide.splitCursor },
    });
    const right = await identity.query(api.suppliers.listForManagement, {
      orgId,
      paginationOpts: { numItems: 1, cursor: wide.splitCursor ?? null, endCursor: second.continueCursor },
    });
    expect(left.page.length).toBeLessThanOrEqual(100);
    expect(right.page.length).toBeLessThanOrEqual(100);
    const covered = new Set([...left.page, ...right.page].map((row) => row._id));
    expect(covered.size).toBe(120);
  });

  test("a caller-supplied maximumRowsRead cannot widen the bound", async () => {
    const { orgId, identity } = await seededOrg();
    const wide = await identity.query(api.suppliers.listForManagement, {
      orgId,
      paginationOpts: { numItems: 1, cursor: null, endCursor: "_end_cursor", maximumRowsRead: 1_000_000 },
    });
    expect(wide.page.length).toBeLessThanOrEqual(100);
  });

  test("the screen's ordinary 25-row pages are not split, and a full 100-row page stays complete", async () => {
    const { orgId, identity } = await seededOrg();
    const screenPage = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: { numItems: 25, cursor: null } });
    expect(screenPage.page).toHaveLength(25);
    expect(screenPage.pageStatus ?? null).toBeNull();
    // Exactly at the bound, convex-test marks the page SplitRequired (its row counter reaches
    // maximumRowsRead on the 100th row). The page itself is complete and ordered; a client that
    // splits it only re-reads smaller halves. The real runtime's boundary rule is not source-visible.
    const full = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: { numItems: 100, cursor: null } });
    expect(full.page).toHaveLength(100);
    expect(full.page.slice(0, 25).map((row) => row._id)).toEqual(screenPage.page.map((row) => row._id));
  });

  test("a NaN numItems is bounded, not read without limit", async () => {
    const { orgId, identity } = await seededOrg();
    const page = await identity.query(api.suppliers.listForManagement, { orgId, paginationOpts: { numItems: Number.NaN, cursor: null } });
    expect(page.page.length).toBeLessThanOrEqual(100);
  });

  test("a NaN search limit falls back to the search cap", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Gulf Motors" });
    const found = await identity.query(api.suppliers.searchForManagement, { orgId, query: "Gulf Motors", limit: Number.NaN });
    expect(found.rows).toHaveLength(1);
    expect(found.truncated).toBe(false);
  });
});

describe("SCRUM-887 suppliers.searchForManagement truncation", () => {
  test("26 suppliers sharing an alias: 25 rows come back and the answer says more exist", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const aliasIds: Array<Id<"supplierAliases">> = [];
    for (let i = 0; i < 26; i++) {
      const { supplierId } = await identity.mutation(api.suppliers.create, {
        orgId,
        idempotencyKey: next(),
        displayName: `Branch supplier ${String(i).padStart(2, "0")}`,
      });
      const { aliasId } = await identity.mutation(api.suppliers.addAlias, { orgId, supplierId, alias: "Shared Trading" });
      aliasIds.push(aliasId);
    }

    const capped = await identity.query(api.suppliers.searchForManagement, { orgId, query: "Shared Trading" });
    expect(capped.rows).toHaveLength(25);
    expect(capped.truncated).toBe(true);

    // Exactly 25 matches is a complete answer, not a truncated one.
    await identity.mutation(api.suppliers.retireAlias, { orgId, aliasId: aliasIds[0] });
    const exact = await identity.query(api.suppliers.searchForManagement, { orgId, query: "Shared Trading" });
    expect(exact.rows).toHaveLength(25);
    expect(exact.truncated).toBe(false);

    // A smaller caller limit truncates at that limit.
    const small = await identity.query(api.suppliers.searchForManagement, { orgId, query: "Shared Trading", limit: 3 });
    expect(small.rows).toHaveLength(3);
    expect(small.truncated).toBe(true);
  });

  test("a search with few matches is never marked truncated", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Gulf Motors" });
    const result = await identity.query(api.suppliers.searchForManagement, { orgId, query: "Gulf Motors" });
    expect(result).toMatchObject({ truncated: false });
    expect(result.rows).toHaveLength(1);
  });
});

/**
 * The edit token a reader holds: `revision` once the server exposes it. The fallback to `version`
 * is what a client without the revision would send, so these tests fail for the right reason
 * (the lost update) before the revision exists.
 */
function editToken(record: unknown): number {
  const row = record as { revision?: number; version: number };
  return row.revision ?? row.version;
}

describe("SCRUM-887 suppliers.update: expectedVersion protects every edited field", () => {
  test("two editors who loaded the same record cannot overwrite each other's contact edits", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const { supplierId } = await identity.mutation(api.suppliers.create, {
      orgId,
      idempotencyKey: next(),
      displayName: "Gulf Motors",
      contact: { phone: "111" },
    });
    const loadedByA = await identity.query(api.suppliers.get, { orgId, supplierId });
    const loadedByB = await identity.query(api.suppliers.get, { orgId, supplierId });

    await identity.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: editToken(loadedByA), contact: { phone: "222" } });

    // B's form still holds phone 111 and adds an email; it sends the whole contact object.
    const second = await refusalCode(
      identity.mutation(api.suppliers.update, {
        orgId,
        supplierId,
        expectedVersion: editToken(loadedByB),
        contact: { phone: "111", email: "b@example.com" },
      }),
    );
    expect(second).toBe("SUPPLIER_VERSION_CONFLICT");

    const stored = await identity.query(api.suppliers.get, { orgId, supplierId });
    expect(stored).toMatchObject({ contact: { phone: "222" } });
    expect((stored as { contact?: { email?: string } }).contact?.email).toBeUndefined();
  });

  test("the same editor can save again after reading the result of the last save", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const { supplierId } = await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Gulf Motors" });
    const loaded = await identity.query(api.suppliers.get, { orgId, supplierId });

    const first = await identity.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: editToken(loaded), contact: { phone: "222" } });
    const second = await identity.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: editToken(first), contact: { phone: "333" } });
    // Each save moves the token forward, so a repeat of the same request cannot apply twice.
    expect(editToken(second)).toBeGreaterThan(editToken(first));
    expect(editToken(first)).toBeGreaterThan(editToken(loaded));
    expect(editToken(await identity.query(api.suppliers.get, { orgId, supplierId }))).toBe(editToken(second));
    expect(await refusalCode(identity.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: editToken(first), contact: { phone: "444" } }))).toBe(
      "SUPPLIER_VERSION_CONFLICT",
    );
  });

  test("a row stored before the revision existed is edited with its version, and the version stays a snapshot version", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const { supplierId } = await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Gulf Motors" });
    await t.run(async (ctx) => {
      await ctx.db.patch("suppliers", supplierId, { version: 3 });
    });
    const legacy = await identity.query(api.suppliers.get, { orgId, supplierId });
    expect(editToken(legacy)).toBe(3);
    await identity.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: 3, contact: { phone: "222" } });
    const after = await identity.query(api.suppliers.get, { orgId, supplierId });
    expect(editToken(after)).toBe(4);
    expect(after).toMatchObject({ version: 3 });
  });

  test("snapshot consumers are unchanged: contact edits leave `version` alone, a snapshot-field edit raises it by exactly one", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const { supplierId } = await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Gulf Motors" });
    const recorded = await t.run((ctx) => snapshotSupplier(ctx, orgId, supplierId));
    expect(recorded.version).toBe(1);

    let token = editToken(await identity.query(api.suppliers.get, { orgId, supplierId }));
    for (const phone of ["222", "333", "444"]) {
      const saved = await identity.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: token, contact: { phone } });
      token = editToken(saved);
    }
    // A payable that recorded version 1 still matches the master: nothing it snapshots has moved.
    const afterContact = await t.run((ctx) => snapshotSupplier(ctx, orgId, supplierId));
    expect(afterContact).toEqual(recorded);

    await identity.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: token, displayName: "Gulf Motors Group", reason: "Rebranded" });
    const afterName = await t.run((ctx) => snapshotSupplier(ctx, orgId, supplierId));
    expect(afterName.version).toBe(2);
    expect(afterName.version).toBeGreaterThanOrEqual(recorded.version);
    expect(afterName.name).toBe("Gulf Motors Group");
  });

  test("a refused update does not move the token", async () => {
    const t = setup();
    const { orgId, identity } = await financeOrg(t, "A");
    const { supplierId } = await identity.mutation(api.suppliers.create, { orgId, idempotencyKey: next(), displayName: "Gulf Motors" });
    const loaded = await identity.query(api.suppliers.get, { orgId, supplierId });
    expect(await refusalCode(identity.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: editToken(loaded) }))).toBe("SUPPLIER_NO_CHANGE");
    expect(editToken(await identity.query(api.suppliers.get, { orgId, supplierId }))).toBe(editToken(loaded));
  });
});