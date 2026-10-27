import { describe, expect, test, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createOrganizationWithDefaultRoles } from "./organizations";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS, SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";
import {
  insertSupplier,
  requireActiveSupplier,
  requireNoLegalIdentityDuplicate,
  withRegistryLock,
} from "./utils/supplierRegistry";

/**
 * SCRUM-868 S1: the supplier master, its aliases and the per-organization registry lock.
 *
 * `convex-test` serializes every call, so none of these tests can show that two concurrent
 * writers conflict. The lock is argued from the documented record-version read set
 * (https://docs.convex.dev/database/advanced/occ); what is tested here is that every write
 * path reads and bumps the one registry document, exactly once.
 */

const MODULES = import.meta.glob("./**/*.*s");

function setup() {
  return convexTestWithComponents(schema, MODULES);
}
type T = ReturnType<typeof setup>;
type Who = ReturnType<T["withIdentity"]>;
type CreateArgs = FunctionArgs<typeof api.suppliers.create>;

const FINANCE = [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.MANAGE_FINANCE];

let keySeq = 0;
const nextKey = (): string => `key-${++keySeq}`;

type Refusal = { data: unknown; code: string | undefined; payload: Record<string, unknown> };

async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: unknown }).data;
    const payload = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    return { data, payload, code: typeof payload.code === "string" ? payload.code : undefined };
  }
  throw new Error("Expected the call to be refused, but it succeeded.");
}

async function initRegistry(t: T, orgId: Id<"organizations">): Promise<void> {
  await t.mutation(internal.suppliers.initialiseRegistry, { orgId });
}

async function seedFinanceOrg(t: T, label: string) {
  const seeded = await seedOrgWithMember(t, {
    clerkId: `finance-${label}-${nextKey()}`,
    permissions: FINANCE,
    orgName: `Org ${label}`,
    roleName: "ACCOUNTANT",
  });
  await initRegistry(t, seeded.orgId);
  return { orgId: seeded.orgId, acct: seeded.identity, userId: seeded.userId };
}

async function addMember(
  t: T,
  orgId: Id<"organizations">,
  roleName: string,
  permissions: string[],
): Promise<Who> {
  const clerkId = `member-${roleName}-${nextKey()}`;
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: roleName });
    const roleId = await ctx.db.insert("roles", { orgId, name: roleName, permissions });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
  });
  return t.withIdentity({ subject: clerkId });
}

async function createSupplier(
  who: Who,
  orgId: Id<"organizations">,
  over: Partial<CreateArgs> = {},
): Promise<{ supplierId: Id<"suppliers"> }> {
  return who.mutation(api.suppliers.create, {
    orgId,
    idempotencyKey: nextKey(),
    displayName: `Supplier ${nextKey()}`,
    ...over,
  });
}

async function registryVersion(t: T, orgId: Id<"organizations">): Promise<number> {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("supplierRegistryState")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    expect(rows).toHaveLength(1);
    return rows[0].version;
  });
}

async function supplierCount(t: T, orgId: Id<"organizations">): Promise<number> {
  return t.run(async (ctx) =>
    (await ctx.db.query("suppliers").withIndex("by_org_and_status", (q) => q.eq("orgId", orgId)).collect()).length,
  );
}

async function supplierWorld(t: T, orgId: Id<"organizations">): Promise<string> {
  return t.run(async (ctx) =>
    JSON.stringify({
      suppliers: await ctx.db.query("suppliers").withIndex("by_org_and_status", (q) => q.eq("orgId", orgId)).collect(),
      aliases: await ctx.db.query("supplierAliases").withIndex("by_org_and_supplierId", (q) => q.eq("orgId", orgId)).collect(),
    }),
  );
}

async function auditActions(t: T, orgId: Id<"organizations">): Promise<string[]> {
  return t.run(async (ctx) =>
    (await ctx.db.query("adminAuditLog").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect())
      .map((row) => row.action)
      .filter((action) => action.startsWith("supplier.")),
  );
}

describe("supplier master: tenancy", () => {
  test("org isolation: another org's supplier id is refused exactly like a missing id on get, update, deactivate, addAlias and reads", async () => {
    const t = setup();
    const a = await seedFinanceOrg(t, "A");
    const b = await seedFinanceOrg(t, "B");
    const { supplierId: foreign } = await createSupplier(b.acct, b.orgId, { displayName: "Org B Only Supplier" });
    const { supplierId: missing } = await createSupplier(a.acct, a.orgId, { displayName: "Removed Supplier" });
    // Test-only removal to get a well-formed id that no longer exists. No convex/ function deletes a supplier.
    await t.run(async (ctx) => ctx.db.delete(missing));

    const calls: Record<string, (id: Id<"suppliers">) => Promise<unknown>> = {
      get: (id) => a.acct.query(api.suppliers.get, { orgId: a.orgId, supplierId: id }),
      update: (id) =>
        a.acct.mutation(api.suppliers.update, { orgId: a.orgId, supplierId: id, expectedVersion: 1, legalName: "Hijack Ltd" }),
      deactivate: (id) => a.acct.mutation(api.suppliers.deactivate, { orgId: a.orgId, supplierId: id, reason: "hijack" }),
      reactivate: (id) => a.acct.mutation(api.suppliers.reactivate, { orgId: a.orgId, supplierId: id }),
      addAlias: (id) => a.acct.mutation(api.suppliers.addAlias, { orgId: a.orgId, supplierId: id, alias: "Hijack Alias" }),
    };

    const worldB = await supplierWorld(t, b.orgId);
    const versionA = await registryVersion(t, a.orgId);
    for (const [name, call] of Object.entries(calls)) {
      const foreignRefusal = await refusal(call(foreign));
      const missingRefusal = await refusal(call(missing));
      expect(foreignRefusal.data, name).toEqual(missingRefusal.data);
      expect(foreignRefusal.data, name).toBe("Supplier not found.");
    }
    expect(await supplierWorld(t, b.orgId)).toBe(worldB);
    expect(await registryVersion(t, a.orgId)).toBe(versionA);

    // A foreign alias id is refused the same way, and org A's reads never show org B's rows.
    const { aliasId } = await b.acct.mutation(api.suppliers.addAlias, { orgId: b.orgId, supplierId: foreign, alias: "B Alias" });
    const aliasRefusal = await refusal(a.acct.mutation(api.suppliers.retireAlias, { orgId: a.orgId, aliasId }));
    expect(aliasRefusal.data).toBe("Supplier alias not found.");
    const listed = await a.acct.query(api.suppliers.list, { orgId: a.orgId, paginationOpts: { numItems: 50, cursor: null } });
    expect(listed.page.map((row) => row._id)).not.toContain(foreign);
    expect(await a.acct.query(api.suppliers.search, { orgId: a.orgId, query: "Org B Only" })).toEqual([]);
    expect(await a.acct.query(api.suppliers.search, { orgId: a.orgId, query: "B Alias" })).toEqual([]);

    // A member of org A is not a member of org B, so naming org B is refused outright.
    const outsider = await refusal(a.acct.mutation(api.suppliers.create, { orgId: b.orgId, idempotencyKey: nextKey(), displayName: "Smuggled" }));
    expect(outsider.code).toBe("UNAUTHORIZED");
    expect(await supplierCount(t, b.orgId)).toBe(1);
  });
});

describe("supplier master: legal identity", () => {
  test("same jurisdiction and tax key is refused with the existing id, whatever the formatting or name", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "legal-hard");
    const first = await createSupplier(acct, orgId, { displayName: "Gulf Parts", taxId: "123-456", taxJurisdiction: "JO" });
    const versionBefore = await registryVersion(t, orgId);

    const clash = await refusal(
      createSupplier(acct, orgId, { displayName: "Completely Other Name", taxId: "123456", taxJurisdiction: " jo " }),
    );
    expect(clash.code).toBe("SUPPLIER_LEGAL_IDENTITY_EXISTS");
    expect(clash.payload.existingSupplierId).toBe(first.supplierId);
    expect(await supplierCount(t, orgId)).toBe(1);
    expect(await registryVersion(t, orgId)).toBe(versionBefore);

    // The same door guards edits: moving another supplier onto the identity is refused.
    const other = await createSupplier(acct, orgId, { displayName: "Unrelated Trading", taxId: "999", taxJurisdiction: "JO" });
    const moved = await refusal(
      acct.mutation(api.suppliers.update, { orgId, supplierId: other.supplierId, expectedVersion: 1, taxId: "123 456" }),
    );
    expect(moved.code).toBe("SUPPLIER_LEGAL_IDENTITY_EXISTS");
    expect(moved.payload.existingSupplierId).toBe(first.supplierId);
  });

  test("the same tax key with no jurisdiction or another jurisdiction is a soft candidate, not a refusal of the legal identity", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "legal-soft");
    const first = await createSupplier(acct, orgId, { displayName: "Gulf Parts", taxId: "123456", taxJurisdiction: "JO" });

    const noJurisdiction = await refusal(createSupplier(acct, orgId, { displayName: "Other Co", taxId: "123-456" }));
    expect(noJurisdiction.code).toBe("SUPPLIER_DUPLICATE_CANDIDATES");
    const candidates = noJurisdiction.payload.candidates as { supplierId: Id<"suppliers">; reasons: string[] }[];
    expect(candidates.map((c) => c.supplierId)).toEqual([first.supplierId]);
    expect(candidates[0].reasons).toContain("TAX_ID");

    const second = await createSupplier(acct, orgId, {
      displayName: "Other Co",
      taxId: "123-456",
      confirmDistinctFrom: [first.supplierId],
    });
    const otherJurisdiction = await refusal(createSupplier(acct, orgId, { displayName: "Saudi Co", taxId: "123456", taxJurisdiction: "SA" }));
    expect(otherJurisdiction.code).toBe("SUPPLIER_DUPLICATE_CANDIDATES");
    const ids = (otherJurisdiction.payload.candidates as { supplierId: Id<"suppliers"> }[]).map((c) => c.supplierId);
    expect(new Set(ids)).toEqual(new Set([first.supplierId, second.supplierId]));
    await createSupplier(acct, orgId, { displayName: "Saudi Co", taxId: "123456", taxJurisdiction: "SA", confirmDistinctFrom: ids });
    expect(await supplierCount(t, orgId)).toBe(3);
  });

  test("sharedLegalIdentityOf with a reason allows a second branch; a missing reason or a different identity is refused", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "legal-shared");
    const head = await createSupplier(acct, orgId, { displayName: "Gulf Parts", taxId: "123456", taxJurisdiction: "JO" });
    const unrelated = await createSupplier(acct, orgId, { displayName: "Unrelated Trading", taxId: "777", taxJurisdiction: "JO" });
    const branchArgs = { displayName: "Amman Branch", taxId: "123456", taxJurisdiction: "JO" };

    const noReason = await refusal(createSupplier(acct, orgId, { ...branchArgs, sharedLegalIdentityOf: head.supplierId }));
    expect(noReason.code).toBe("SUPPLIER_REASON_REQUIRED");

    const mismatch = await refusal(
      createSupplier(acct, orgId, {
        ...branchArgs,
        sharedLegalIdentityOf: unrelated.supplierId,
        sharedLegalIdentityReason: "Second branch of the same company",
      }),
    );
    expect(mismatch.code).toBe("SUPPLIER_SHARED_IDENTITY_MISMATCH");

    const { supplierId: foreignId } = await (async () => {
      const other = await seedFinanceOrg(t, "legal-shared-other");
      return createSupplier(other.acct, other.orgId, { displayName: "Foreign", taxId: "123456", taxJurisdiction: "JO" });
    })();
    const foreign = await refusal(
      createSupplier(acct, orgId, { ...branchArgs, sharedLegalIdentityOf: foreignId, sharedLegalIdentityReason: "Branch" }),
    );
    expect(foreign.data).toBe("Supplier not found.");

    const branch = await createSupplier(acct, orgId, {
      ...branchArgs,
      sharedLegalIdentityOf: head.supplierId,
      sharedLegalIdentityReason: "Second branch of the same company",
    });
    const stored = await acct.query(api.suppliers.get, { orgId, supplierId: branch.supplierId });
    expect(stored).toMatchObject({
      sharedLegalIdentityOf: head.supplierId,
      sharedLegalIdentityReason: "Second branch of the same company",
    });
    expect(await supplierCount(t, orgId)).toBe(3);

    // The same declaration is honoured on an edit that moves a supplier onto the shared identity.
    const mover = await createSupplier(acct, orgId, { displayName: "Irbid Branch", taxId: "888", taxJurisdiction: "JO" });
    await acct.mutation(api.suppliers.update, {
      orgId,
      supplierId: mover.supplierId,
      expectedVersion: 1,
      taxId: "123456",
      sharedLegalIdentityOf: head.supplierId,
      sharedLegalIdentityReason: "Third branch of the same company",
    });
    expect(await acct.query(api.suppliers.get, { orgId, supplierId: mover.supplierId })).toMatchObject({
      taxId: "123456",
      sharedLegalIdentityOf: head.supplierId,
    });
  });

  test("the legal-identity check skips the supplier being edited and reads nothing for an incomplete identity", async () => {
    const t = setup();
    const { orgId, acct, userId } = await seedFinanceOrg(t, "legal-exclude");
    const head = await createSupplier(acct, orgId, { displayName: "Gulf Parts", taxId: "123456", taxJurisdiction: "JO" });
    const identity = { taxIdKey: "123456", taxJurisdiction: "JO" };
    // A row that has a tax id key but no jurisdiction: an incomplete identity must not match it.
    await t.run(async (ctx) =>
      withRegistryLock(ctx, orgId, async (lock) =>
        insertSupplier(ctx, lock, {
          orgId,
          displayName: "No Jurisdiction",
          displayNameKey: "no jurisdiction",
          taxIdKey: "999",
          status: "ACTIVE",
          version: 1,
          origin: "MANUAL",
          createdBy: userId,
          createdAt: 1,
          updatedBy: userId,
          updatedAt: 1,
        }),
      ),
    );
    await t.run(async (ctx) => {
      await requireNoLegalIdentityDuplicate(ctx, orgId, identity, head.supplierId);
      await requireNoLegalIdentityDuplicate(ctx, orgId, { taxIdKey: "999" });
      await requireNoLegalIdentityDuplicate(ctx, orgId, { taxJurisdiction: "JO" });
    });
    const refused = await refusal(t.run((ctx) => requireNoLegalIdentityDuplicate(ctx, orgId, identity)));
    expect(refused.code).toBe("SUPPLIER_LEGAL_IDENTITY_EXISTS");
    expect(refused.payload.existingSupplierId).toBe(head.supplierId);
  });
});

describe("supplier master: duplicate candidates", () => {
  test("a same-name create is refused until confirmDistinctFrom covers exactly the candidates found in the transaction", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "candidates");
    const s1 = await createSupplier(acct, orgId, { displayName: "Nile Auto" });
    const unrelated = await createSupplier(acct, orgId, { displayName: "Zed Cars" });

    const first = await refusal(createSupplier(acct, orgId, { displayName: "nile  AUTO" }));
    expect(first.code).toBe("SUPPLIER_DUPLICATE_CANDIDATES");
    const listed = first.payload.candidates as { supplierId: Id<"suppliers">; displayName: string; reasons: string[] }[];
    expect(listed.map((c) => c.supplierId)).toEqual([s1.supplierId]);
    expect(listed[0].reasons).toContain("SAME_NAME");

    // An explicit empty list does not skip the check.
    expect((await refusal(createSupplier(acct, orgId, { displayName: "Nile Auto", confirmDistinctFrom: [] }))).code).toBe(
      "SUPPLIER_DUPLICATE_CANDIDATES",
    );

    const s2 = await createSupplier(acct, orgId, { displayName: "Nile Auto", confirmDistinctFrom: [s1.supplierId] });

    // A partial (stale) list is refused, and the answer carries the true list.
    const partial = await refusal(createSupplier(acct, orgId, { displayName: "Nile Auto", confirmDistinctFrom: [s1.supplierId] }));
    expect(partial.code).toBe("SUPPLIER_DUPLICATE_CANDIDATES");
    expect(new Set((partial.payload.candidates as { supplierId: string }[]).map((c) => c.supplierId))).toEqual(
      new Set([s1.supplierId, s2.supplierId]),
    );

    // An over-long list (a row that is not a candidate) is not "exactly the candidates" either.
    const extra = await refusal(
      createSupplier(acct, orgId, { displayName: "Nile Auto", confirmDistinctFrom: [s1.supplierId, s2.supplierId, unrelated.supplierId] }),
    );
    expect(extra.code).toBe("SUPPLIER_DUPLICATE_CANDIDATES");

    await createSupplier(acct, orgId, { displayName: "Nile Auto", confirmDistinctFrom: [s2.supplierId, s1.supplierId] });
    expect(await supplierCount(t, orgId)).toBe(4);
  });

  test("an active alias and a close name are candidates; a retired alias and an unrelated name are not", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "alias-close");
    const motors = await createSupplier(acct, orgId, { displayName: "Al Nour Motors" });
    const gulf = await createSupplier(acct, orgId, { displayName: "Gulf Parts" });
    const { aliasId } = await acct.mutation(api.suppliers.addAlias, { orgId, supplierId: gulf.supplierId, alias: "Gulf Trading" });

    const viaAlias = await refusal(createSupplier(acct, orgId, { displayName: "gulf  trading" }));
    expect(viaAlias.code).toBe("SUPPLIER_DUPLICATE_CANDIDATES");
    expect(viaAlias.payload.candidates).toMatchObject([{ supplierId: gulf.supplierId, reasons: ["ALIAS"] }]);

    await acct.mutation(api.suppliers.retireAlias, { orgId, aliasId });
    await createSupplier(acct, orgId, { displayName: "gulf  trading" });

    const shorter = await refusal(createSupplier(acct, orgId, { displayName: "Al Nour" }));
    expect(shorter.code).toBe("SUPPLIER_DUPLICATE_CANDIDATES");
    expect(shorter.payload.candidates).toMatchObject([{ supplierId: motors.supplierId, reasons: ["CLOSE_NAME"] }]);
    const longer = await refusal(createSupplier(acct, orgId, { displayName: "Al Nour Motors Trading" }));
    expect(longer.payload.candidates).toMatchObject([{ supplierId: motors.supplierId, reasons: ["CLOSE_NAME"] }]);

    const preview = await acct.query(api.suppliers.candidatesFor, { orgId, displayName: "Al Nour" });
    expect(preview.map((c) => c.supplierId)).toEqual([motors.supplierId]);
    await createSupplier(acct, orgId, { displayName: "Zed Cars" });
  });

  test("same display name distinct: two masters keep two ids and stay separate (I4)", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "same-name");
    const one = await createSupplier(acct, orgId, { displayName: "Sahara Motors" });
    const two = await createSupplier(acct, orgId, { displayName: "Sahara Motors", confirmDistinctFrom: [one.supplierId] });
    expect(two.supplierId).not.toBe(one.supplierId);

    const listed = await acct.query(api.suppliers.list, { orgId, paginationOpts: { numItems: 50, cursor: null } });
    expect(listed.page.filter((row) => row.displayName === "Sahara Motors").map((row) => row._id).sort()).toEqual(
      [one.supplierId, two.supplierId].sort(),
    );
    const rows = await t.run(async (ctx) => [await ctx.db.get(one.supplierId), await ctx.db.get(two.supplierId)]);
    expect(rows[0]?.displayNameKey).toBe(rows[1]?.displayNameKey);
    expect(rows.map((row) => row?.status)).toEqual(["ACTIVE", "ACTIVE"]);
  });
});

describe("supplier master: idempotent create", () => {
  test("the same key twice yields one supplier; the same key with a different payload conflicts (I10)", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "idem");
    const other = await seedFinanceOrg(t, "idem-other");
    const args = { orgId, idempotencyKey: "create-once", displayName: "Idempotent Co", taxId: "55", taxJurisdiction: "JO" };

    const first = await acct.mutation(api.suppliers.create, args);
    const replay = await acct.mutation(api.suppliers.create, args);
    expect(replay).toEqual(first);
    expect(await supplierCount(t, orgId)).toBe(1);
    expect(await registryVersion(t, orgId)).toBe(1);
    expect(await auditActions(t, orgId)).toEqual(["supplier.create"]);

    const conflict = await refusal(acct.mutation(api.suppliers.create, { ...args, displayName: "Different Co" }));
    expect(conflict.code).toBe("SUPPLIER_IDEMPOTENCY_CONFLICT");
    expect(await supplierCount(t, orgId)).toBe(1);

    // The key is scoped to the organization.
    const sameKeyElsewhere = await other.acct.mutation(api.suppliers.create, { ...args, orgId: other.orgId });
    expect(sameKeyElsewhere.supplierId).not.toBe(first.supplierId);
  });
});

describe("supplier master: registry lock", () => {
  test("every write bumps the registry version exactly once, and a refused write bumps nothing", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "lock");
    let expected = await registryVersion(t, orgId);
    expect(expected).toBe(0);
    const expectBump = async (label: string) => {
      expected += 1;
      expect(await registryVersion(t, orgId), label).toBe(expected);
    };

    const { supplierId } = await createSupplier(acct, orgId, { displayName: "Lock Co" });
    await expectBump("create");
    await acct.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: 1, legalName: "Lock Company Ltd" });
    await expectBump("update");
    const { aliasId } = await acct.mutation(api.suppliers.addAlias, { orgId, supplierId, alias: "Lock Trading" });
    await expectBump("addAlias");
    await acct.mutation(api.suppliers.retireAlias, { orgId, aliasId });
    await expectBump("retireAlias");
    await acct.mutation(api.suppliers.deactivate, { orgId, supplierId, reason: "Closed down" });
    await expectBump("deactivate");
    await acct.mutation(api.suppliers.reactivate, { orgId, supplierId });
    await expectBump("reactivate");

    const world = await supplierWorld(t, orgId);
    await refusal(createSupplier(acct, orgId, { displayName: "Lock Co" }));
    await refusal(acct.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: 1, legalName: "Stale" }));
    expect(await registryVersion(t, orgId)).toBe(expected);
    expect(await supplierWorld(t, orgId)).toBe(world);
  });

  test("a write is refused REGISTRY_NOT_INITIALISED when the org has no registry document, and reads still work", async () => {
    const t = setup();
    const seeded = await seedOrgWithMember(t, { clerkId: "no-registry", permissions: FINANCE, roleName: "ACCOUNTANT" });
    const refused = await refusal(createSupplier(seeded.identity, seeded.orgId, { displayName: "Never Created" }));
    expect(refused.code).toBe("REGISTRY_NOT_INITIALISED");
    expect(await supplierCount(t, seeded.orgId)).toBe(0);
    const listed = await seeded.identity.query(api.suppliers.list, { orgId: seeded.orgId, paginationOpts: { numItems: 10, cursor: null } });
    expect(listed.page).toEqual([]);
  });

  test("two registry documents for one org fail closed: every write is refused REGISTRY_CORRUPT and changes nothing", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "corrupt");
    await t.run((ctx) => ctx.db.insert("supplierRegistryState", { orgId, version: 0 }));
    const refused = await refusal(createSupplier(acct, orgId, { displayName: "Corrupt Co" }));
    expect(refused.code).toBe("REGISTRY_CORRUPT");
    expect(await supplierCount(t, orgId)).toBe(0);
  });

  test("a registry lock for one organization cannot write another organization's supplier", async () => {
    const t = setup();
    const a = await seedFinanceOrg(t, "lock-a");
    const b = await seedFinanceOrg(t, "lock-b");
    const forged = t.run(async (ctx) =>
      withRegistryLock(ctx, a.orgId, async (lock) =>
        insertSupplier(ctx, lock, {
          orgId: b.orgId,
          displayName: "Cross Org",
          displayNameKey: "cross org",
          status: "ACTIVE",
          version: 1,
          origin: "MANUAL",
          createdBy: b.userId,
          createdAt: 1,
          updatedBy: b.userId,
          updatedAt: 1,
        }),
      ),
    );
    expect((await refusal(forged)).code).toBe("SUPPLIER_INVALID_INPUT");
    expect(await supplierCount(t, a.orgId)).toBe(0);
    expect(await supplierCount(t, b.orgId)).toBe(0);
  });
});

describe("supplier master: update, deactivate, no delete", () => {
  test("a display-name change needs a reason and bumps the version; a stale expectedVersion is refused; contact edits keep the version", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "update");
    const { supplierId } = await createSupplier(acct, orgId, { displayName: "Old Name" });

    expect((await refusal(acct.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: 1, displayName: "New Name" }))).code).toBe(
      "SUPPLIER_REASON_REQUIRED",
    );
    await acct.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: 1, displayName: "New Name", reason: "Rebranded" });
    expect(await acct.query(api.suppliers.get, { orgId, supplierId })).toMatchObject({ displayName: "New Name", version: 2 });

    const stale = await refusal(acct.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: 1, legalName: "Late" }));
    expect(stale.code).toBe("SUPPLIER_VERSION_CONFLICT");

    await acct.mutation(api.suppliers.update, { orgId, supplierId, expectedVersion: 2, contact: { phone: "+962 6 000 0000" } });
    expect(await acct.query(api.suppliers.get, { orgId, supplierId })).toMatchObject({
      version: 2,
      contact: { phone: "+962 6 000 0000" },
    });
    // The name key follows the name, so the old spelling is free again.
    await createSupplier(acct, orgId, { displayName: "Old Name" });
  });

  test("no delete (I1): a deactivated supplier still reads, and requireActiveSupplier refuses it", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "deactivate");
    const other = await seedFinanceOrg(t, "deactivate-other");
    const { supplierId } = await createSupplier(acct, orgId, { displayName: "Retiring Co" });

    expect((await refusal(acct.mutation(api.suppliers.deactivate, { orgId, supplierId, reason: "  " }))).code).toBe(
      "SUPPLIER_REASON_REQUIRED",
    );
    await acct.mutation(api.suppliers.deactivate, { orgId, supplierId, reason: "Closed down" });
    expect((await refusal(acct.mutation(api.suppliers.deactivate, { orgId, supplierId, reason: "Again" }))).code).toBe(
      "SUPPLIER_ALREADY_INACTIVE",
    );

    expect(await acct.query(api.suppliers.get, { orgId, supplierId })).toMatchObject({
      status: "INACTIVE",
      deactivatedReason: "Closed down",
    });
    const listed = await acct.query(api.suppliers.list, { orgId, paginationOpts: { numItems: 10, cursor: null } });
    expect(listed.page).toEqual([{ _id: supplierId, displayName: "Retiring Co", status: "INACTIVE" }]);

    const inactive = await refusal(t.run((ctx) => requireActiveSupplier(ctx, orgId, supplierId)));
    expect(inactive.code).toBe("SUPPLIER_INACTIVE");
    const foreign = await refusal(t.run((ctx) => requireActiveSupplier(ctx, other.orgId, supplierId)));
    expect(foreign.data).toBe("Supplier not found.");

    await acct.mutation(api.suppliers.reactivate, { orgId, supplierId });
    expect((await refusal(acct.mutation(api.suppliers.reactivate, { orgId, supplierId }))).code).toBe("SUPPLIER_ALREADY_ACTIVE");
    const active = await t.run((ctx) => requireActiveSupplier(ctx, orgId, supplierId));
    expect(active._id).toBe(supplierId);
  });

  test("search finds a supplier by name fragment and by alias, never past the limit", async () => {
    const t = setup();
    const { orgId, acct } = await seedFinanceOrg(t, "search");
    const gulf = await createSupplier(acct, orgId, { displayName: "Gulf Parts Trading" });
    await acct.mutation(api.suppliers.addAlias, { orgId, supplierId: gulf.supplierId, alias: "Khaleej Spares" });
    await createSupplier(acct, orgId, { displayName: "Nile Auto" });

    const byName = await acct.query(api.suppliers.search, { orgId, query: "Gulf Parts" });
    expect(byName.map((row) => row._id)).toEqual([gulf.supplierId]);
    const byAlias = await acct.query(api.suppliers.search, { orgId, query: "khaleej  spares" });
    expect(byAlias.map((row) => row._id)).toEqual([gulf.supplierId]);
    expect(Object.keys(byAlias[0]).sort()).toEqual(["_id", "displayName", "status"]);
    expect(await acct.query(api.suppliers.search, { orgId, query: "Auto", limit: 1 })).toHaveLength(1);
  });
});

describe("supplier master: role matrix", () => {
  // Hard-coded on purpose: the expectation is written down per role, not derived from the same
  // permission strings the code reads. A new default role fails the coverage assertion below.
  const EXPECTED: Record<string, { write: boolean; picker: boolean; full: boolean }> = {
    [SYSTEM_OWNER_ROLE_NAME]: { write: true, picker: true, full: true },
    MANAGER: { write: false, picker: true, full: false },
    SALES: { write: false, picker: true, full: false },
    RECEPTION: { write: false, picker: true, full: false },
    ACCOUNTANT: { write: true, picker: true, full: true },
    SENIOR_ACCOUNTANT: { write: true, picker: true, full: true },
  };

  async function seedRoleCase(t: T, roleName: string, permissions: string[]) {
    const base = await seedFinanceOrg(t, `role-${roleName}`);
    const s0 = await createSupplier(base.acct, base.orgId, {
      displayName: "Baseline One",
      taxId: "TX-1",
      taxJurisdiction: "JO",
      contact: { phone: "111" },
    });
    const s1 = await createSupplier(base.acct, base.orgId, { displayName: "Baseline Two" });
    const { aliasId } = await base.acct.mutation(api.suppliers.addAlias, {
      orgId: base.orgId,
      supplierId: s0.supplierId,
      alias: "Baseline Alias",
    });
    const actor = await addMember(t, base.orgId, roleName, permissions);
    return { ...base, actor, s0: s0.supplierId, s1: s1.supplierId, aliasId };
  }

  test("the table covers every default role template and agrees with its permission strings", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(DEFAULT_ROLE_TEMPLATES.map((role) => role.name).sort());
    for (const role of DEFAULT_ROLE_TEMPLATES) {
      const isOwner = role.name === SYSTEM_OWNER_ROLE_NAME;
      expect(EXPECTED[role.name].write, role.name).toBe(isOwner || role.permissions.includes(PERMISSIONS.MANAGE_FINANCE));
      expect(EXPECTED[role.name].full, role.name).toBe(isOwner || role.permissions.includes(PERMISSIONS.VIEW_FINANCE));
      expect(EXPECTED[role.name].picker, role.name).toBe(
        isOwner || role.permissions.includes(PERMISSIONS.VIEW_VEHICLES) || role.permissions.includes(PERMISSIONS.VIEW_FINANCE),
      );
    }
  });

  for (const role of DEFAULT_ROLE_TEMPLATES) {
    test(`role ${role.name}: writes need manage:finance, picker needs view:vehicles or view:finance, the full record needs view:finance, every write is audited`, async () => {
      const t = setup();
      const c = await seedRoleCase(t, role.name, role.permissions);
      const want = EXPECTED[role.name];
      const { orgId, actor } = c;

      // Reads.
      const pickerRead = actor.query(api.suppliers.list, { orgId, paginationOpts: { numItems: 50, cursor: null } });
      const fullRead = actor.query(api.suppliers.get, { orgId, supplierId: c.s0 });
      if (want.picker) {
        const page = (await pickerRead).page;
        expect(page.length).toBe(2);
        for (const row of page) expect(Object.keys(row).sort()).toEqual(["_id", "displayName", "status"]);
        const record = await fullRead;
        if (want.full) {
          expect(record).toMatchObject({ taxId: "TX-1", taxJurisdiction: "JO", contact: { phone: "111" }, version: 1 });
          expect(record).toHaveProperty("aliases");
          for (const hidden of ["displayNameKey", "taxIdKey", "createdBy", "updatedBy"]) expect(record).not.toHaveProperty(hidden);
        } else {
          expect(Object.keys(record).sort()).toEqual(["_id", "displayName", "status"]);
        }
      } else {
        expect((await refusal(pickerRead)).code).toBe("FORBIDDEN");
        expect((await refusal(fullRead)).code).toBe("FORBIDDEN");
      }

      // Writes.
      const auditBefore = (await auditActions(t, orgId)).length;
      const versionBefore = await registryVersion(t, orgId);
      const worldBefore = await supplierWorld(t, orgId);
      const writes: Array<() => Promise<unknown>> = [
        () => createSupplier(actor, orgId, { displayName: `Created by ${role.name}` }),
        () => actor.mutation(api.suppliers.update, { orgId, supplierId: c.s0, expectedVersion: 1, contact: { phone: "222" } }),
        () => actor.mutation(api.suppliers.addAlias, { orgId, supplierId: c.s0, alias: `Alias by ${role.name}` }),
        () => actor.mutation(api.suppliers.retireAlias, { orgId, aliasId: c.aliasId }),
        () => actor.mutation(api.suppliers.deactivate, { orgId, supplierId: c.s1, reason: "Closed" }),
        () => actor.mutation(api.suppliers.reactivate, { orgId, supplierId: c.s1 }),
      ];
      if (want.write) {
        for (const write of writes) await write();
        expect((await auditActions(t, orgId)).slice(auditBefore).sort()).toEqual(
          [
            "supplier.create",
            "supplier.update",
            "supplier.alias.add",
            "supplier.alias.retire",
            "supplier.deactivate",
            "supplier.reactivate",
          ].sort(),
        );
        expect(await registryVersion(t, orgId)).toBe(versionBefore + writes.length);
        const rows = await t.run(async (ctx) =>
          (await ctx.db.query("adminAuditLog").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()).filter((r) =>
            r.action.startsWith("supplier."),
          ),
        );
        for (const row of rows) {
          expect(row.actorEmail).toContain("@test.com");
          expect(row.targetTable === "suppliers" || row.targetTable === "supplierAliases").toBe(true);
        }
      } else {
        for (const write of writes) expect((await refusal(write())).code).toBe("FORBIDDEN");
        expect(await supplierWorld(t, orgId)).toBe(worldBefore);
        expect(await registryVersion(t, orgId)).toBe(versionBefore);
        expect((await auditActions(t, orgId)).length).toBe(auditBefore);
      }
    });
  }

  test("a role holding only :request permissions can neither read nor write suppliers", async () => {
    const t = setup();
    const requestOnly = [
      PERMISSIONS.CREATE_VEHICLES_REQUEST,
      PERMISSIONS.EDIT_VEHICLES_REQUEST,
      PERMISSIONS.CREATE_EXPENSES_REQUEST,
      PERMISSIONS.EDIT_EXPENSES_REQUEST,
    ];
    const c = await seedRoleCase(t, "REQUESTER", requestOnly);
    const worldBefore = await supplierWorld(t, c.orgId);
    const attempts: Array<Promise<unknown>> = [
      c.actor.query(api.suppliers.list, { orgId: c.orgId, paginationOpts: { numItems: 5, cursor: null } }),
      c.actor.query(api.suppliers.get, { orgId: c.orgId, supplierId: c.s0 }),
      c.actor.query(api.suppliers.search, { orgId: c.orgId, query: "Baseline" }),
      c.actor.query(api.suppliers.candidatesFor, { orgId: c.orgId, displayName: "Baseline One" }),
      createSupplier(c.actor, c.orgId, { displayName: "Requested" }),
    ];
    for (const attempt of attempts) expect((await refusal(attempt)).code).toBe("FORBIDDEN");
    expect(await supplierWorld(t, c.orgId)).toBe(worldBefore);
  });

  test("a member without manage:finance cannot create a supplier, and nothing is written", async () => {
    const t = setup();
    const c = await seedRoleCase(t, "VIEW_ONLY", [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.VIEW_VEHICLES]);
    const worldBefore = await supplierWorld(t, c.orgId);
    const versionBefore = await registryVersion(t, c.orgId);
    const auditBefore = (await auditActions(t, c.orgId)).length;
    const refused = await refusal(createSupplier(c.actor, c.orgId, { displayName: "Not Allowed Supplier" }));
    expect(refused.code).toBe("FORBIDDEN");
    expect(await supplierWorld(t, c.orgId)).toBe(worldBefore);
    expect(await registryVersion(t, c.orgId)).toBe(versionBefore);
    expect((await auditActions(t, c.orgId)).length).toBe(auditBefore);
  });

  test("manage:finance without view:finance can write but the full record stays closed", async () => {
    const t = setup();
    const c = await seedRoleCase(t, "WRITE_ONLY", [PERMISSIONS.MANAGE_FINANCE, PERMISSIONS.VIEW_VEHICLES]);
    await createSupplier(c.actor, c.orgId, { displayName: "Write Only Created" });
    const record = await c.actor.query(api.suppliers.get, { orgId: c.orgId, supplierId: c.s0 });
    expect(Object.keys(record).sort()).toEqual(["_id", "displayName", "status"]);
  });
});

describe("supplier registry: bootstrap and backfill", () => {
  test("initialiseRegistry twice leaves exactly one document per org and does not touch its version", async () => {
    const t = setup();
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Registry Twice", createdAt: 1 }));
    await initRegistry(t, orgId);
    await initRegistry(t, orgId);
    expect(await registryVersion(t, orgId)).toBe(0);
    await t.run(async (ctx) => {
      const state = await ctx.db.query("supplierRegistryState").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
      await ctx.db.patch("supplierRegistryState", state!._id, { version: 7 });
    });
    await initRegistry(t, orgId);
    expect(await registryVersion(t, orgId)).toBe(7);
  });

  test("the organization bootstrap creates the registry document", async () => {
    const t = setup();
    const orgId = await t.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", { clerkId: "boot-owner", email: "boot@test.com", name: "Owner" });
      return createOrganizationWithDefaultRoles(ctx, { name: "Bootstrapped Dealer", ownerUserId });
    });
    expect(await registryVersion(t, orgId)).toBe(0);
  });

  test("the paginated backfill covers every organization, resumes after interruption and is idempotent", async () => {
    const t = setup();
    const orgIds = await t.run(async (ctx) => {
      const ids: Id<"organizations">[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await ctx.db.insert("organizations", { name: `Backfill ${i}`, createdAt: i }));
      return ids;
    });
    // One organization already has its document: the backfill must neither duplicate nor reset it.
    await initRegistry(t, orgIds[0]);
    await t.run(async (ctx) => {
      const state = await ctx.db.query("supplierRegistryState").withIndex("by_org", (q) => q.eq("orgId", orgIds[0])).unique();
      await ctx.db.patch("supplierRegistryState", state!._id, { version: 3 });
    });
    const countStates = () =>
      t.run(async (ctx) => (await ctx.db.query("supplierRegistryState").take(100)).length);

    const first = await t.mutation(internal.suppliers.backfillRegistry, { batchSize: 2, continueAutomatically: false });
    expect(first.isDone).toBe(false);
    expect(first.migrated).toBeLessThanOrEqual(2);
    const afterFirst = await countStates();
    expect(afterFirst).toBeLessThan(5);

    // "Interrupted": resume from the cursor the first batch returned.
    let cursor: string | null = first.continueCursor;
    let done = first.isDone;
    let guard = 0;
    while (!done && guard++ < 10) {
      const next = await t.mutation(internal.suppliers.backfillRegistry, { cursor, batchSize: 2, continueAutomatically: false });
      cursor = next.continueCursor;
      done = next.isDone;
    }
    expect(done).toBe(true);
    expect(await countStates()).toBe(5);
    for (const orgId of orgIds) await registryVersion(t, orgId);
    expect(await registryVersion(t, orgIds[0])).toBe(3);

    const rerun = await t.mutation(internal.suppliers.backfillRegistry, { batchSize: 50, continueAutomatically: false });
    expect(rerun).toMatchObject({ migrated: 0, isDone: true });
    expect(await countStates()).toBe(5);
  });

  test("the backfill reschedules itself from the returned cursor until every organization is covered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const t = setup();
      await t.run(async (ctx) => {
        for (let i = 0; i < 5; i += 1) await ctx.db.insert("organizations", { name: `Chain ${i}`, createdAt: i });
      });
      const first = await t.mutation(internal.suppliers.backfillRegistry, { batchSize: 2 });
      expect(first.isDone).toBe(false);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const states = await t.run(async (ctx) => (await ctx.db.query("supplierRegistryState").take(100)).length);
      expect(states).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
