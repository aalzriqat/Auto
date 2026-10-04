import { convexTestWithComponents } from "../test-utils/convexTest";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  PRE_413_OWNER_FALLBACK_PERMISSIONS,
  isSystemOwnerRole,
} from "./utils/permissions";

/**
 * SCRUM-413 PR-B (D-37), invariant: the system owner stays owner across every
 * role writer, and an OWNER-named row that does not qualify is never promoted.
 *
 * "Qualifies" means `isSystemOwnerRole` is true on the row as it was BEFORE the
 * write: an explicit flag, or (flag unset) the exact name OWNER holding the
 * frozen pre-413 permission set. An explicit `false` is a deliberate demotion
 * and is never undone.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */

const MODULES = import.meta.glob("./**/*.*s");
const FINALIZE = "finalize:financed_deal";
const CREATE_APP = PERMISSIONS.CREATE_FINANCE_APPLICATION;
const FROZEN = [...PRE_413_OWNER_FALLBACK_PERMISSIONS];

type Roles = Awaited<ReturnType<typeof seedOrg>>;

/** An org whose ONLY owner-capable seat is an UNFLAGGED row that qualifies by the frozen fallback. */
async function seedOrg(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = (await t.run((ctx: any) =>
    ctx.db.insert("organizations", { name: `S413b ${tag}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx: any) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const clerkId = `s413b_${tag}`;
  const userId = (await t.run((ctx: any) =>
    ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com` })
  )) as Id<"users">;
  const ownerRoleId = (await t.run((ctx: any) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [...FROZEN] })
  )) as Id<"roles">;
  await t.run((ctx: any) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRoleId }));
  return { t, orgId, ownerRoleId, asOwner: t.withIdentity({ subject: clerkId }) };
}

const insertRole = (s: Roles, name: string, permissions: string[], isSystemOwnerRole?: boolean) =>
  s.t.run((ctx: any) =>
    ctx.db.insert("roles", {
      orgId: s.orgId, name, permissions,
      ...(isSystemOwnerRole === undefined ? {} : { isSystemOwnerRole }),
    })
  ) as Promise<Id<"roles">>;

const roleOf = (s: Roles, roleId: Id<"roles">) => s.t.run((ctx: any) => ctx.db.get(roleId)) as Promise<any>;

const syncAudits = (s: Roles) =>
  s.t.run(async (ctx: any) =>
    (await ctx.db.query("adminAuditLog").withIndex("by_org", (q: any) => q.eq("orgId", s.orgId)).collect()).filter(
      (a: any) => a.action === "role.template_sync"
    )
  ) as Promise<any[]>;

describe("SCRUM-413 PR-B S413B-1 - template sync never de-owns the owner", () => {
  test("an unflagged qualifying OWNER is stamped by the sync and every owner check still recognises it", async () => {
    const s = await seedOrg("sync_owner");
    expect(isSystemOwnerRole(await roleOf(s, s.ownerRoleId))).toBe(true); // qualifies by the fallback before

    await s.asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId });

    const after = await roleOf(s, s.ownerRoleId);
    expect(after.permissions).not.toContain(FINALIZE); // the template removed it ...
    expect(after.isSystemOwnerRole).toBe(true); // ... so the flag must now carry the identity
    expect(isSystemOwnerRole(after)).toBe(true);
    // requireOwner (a second sync) and getMyMembership still accept the caller.
    const me = await s.asOwner.query(api.memberships.getMyMembership, { orgId: s.orgId });
    expect(me?.permissions).toEqual(ALL_PERMISSIONS); // getMyMembership expands only an owner to ALL_PERMISSIONS
    await expect(
      s.asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId })
    ).resolves.toEqual({ changes: [] });
  });

  test("the audit row records the flag transition; a second sync is a no-op (no patch, no new audit row)", async () => {
    const s = await seedOrg("sync_audit");
    await s.asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId });
    const audits = await syncAudits(s);
    const ownerAudit = audits.find((a) => a.targetId === s.ownerRoleId);
    expect(ownerAudit?.before).toMatchObject({ isSystemOwnerRole: null });
    expect(ownerAudit?.after).toMatchObject({ isSystemOwnerRole: true });

    const stored = await roleOf(s, s.ownerRoleId);
    const second = await s.asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId });
    expect(second).toEqual({ changes: [] });
    expect(await syncAudits(s)).toHaveLength(audits.length);
    expect(await roleOf(s, s.ownerRoleId)).toEqual(stored);
  });

  test("a fake OWNER (name OWNER, not the frozen set) is never stamped", async () => {
    const s = await seedOrg("sync_fake");
    const fake = await insertRole(s, "OWNER", [CREATE_APP]);
    await s.asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId });
    const after = await roleOf(s, fake);
    expect(after.isSystemOwnerRole).toBeUndefined();
    expect(isSystemOwnerRole(after)).toBe(false);
    // S413B-4: the template is not applied to it at all - no owner-scale permissions, no audit row.
    expect(after.permissions).toEqual([CREATE_APP]);
    expect((await syncAudits(s)).some((a) => a.targetId === fake)).toBe(false);
  });

  test("an explicit-false OWNER is never stamped and stays false", async () => {
    const s = await seedOrg("sync_false");
    const demoted = await insertRole(s, "OWNER", [...FROZEN], false);
    await s.asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId });
    const after = await roleOf(s, demoted);
    expect(after.isSystemOwnerRole).toBe(false);
    expect(isSystemOwnerRole(after)).toBe(false);
    // S413B-4: permissions are unchanged too, and nothing is audited for it.
    expect(after.permissions).toEqual(FROZEN);
    expect((await syncAudits(s)).some((a) => a.targetId === demoted)).toBe(false);
  });

  test("S413B-4 controls: a qualifying unflagged OWNER is still stamped and synced; MANAGER and SALES still sync", async () => {
    const s = await seedOrg("sync_controls");
    const manager = await insertRole(s, "MANAGER", [CREATE_APP]);
    const sales = await insertRole(s, "SALES", [FINALIZE]);
    const { changes } = await s.asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId });
    const owner = await roleOf(s, s.ownerRoleId);
    expect(owner.isSystemOwnerRole).toBe(true);
    expect(owner.permissions).not.toContain(FINALIZE);
    expect((await roleOf(s, manager)).permissions).toContain(PERMISSIONS.MANAGE_USERS);
    expect((await roleOf(s, sales)).permissions).not.toContain(FINALIZE);
    expect(changes.map((c: { roleId: Id<"roles"> }) => c.roleId).sort()).toEqual([s.ownerRoleId, manager, sales].sort());
  });
});

describe("SCRUM-413 PR-B S413B-3 - the backfills stamp only a row that qualified BEFORE the write", () => {
  // Frozen minus one value a backfill would add: if the backfill added it first,
  // the row would CROSS the fallback threshold and be promoted by the write.
  const NEAR_MISS = FROZEN.filter((p) => p !== PERMISSIONS.VERIFY_FINANCE_DOCUMENTS);

  test("migrateRoles.patchRoleIfNeeded: a qualifying unflagged OWNER is stamped", async () => {
    const s = await seedOrg("bf_ok");
    await s.t.mutation(internal.migrateRoles.backfillFinanceApplicationPermissions, {});
    expect((await roleOf(s, s.ownerRoleId)).isSystemOwnerRole).toBe(true);
  });

  test("migrateRoles.patchRoleIfNeeded: a fake OWNER is untouched - no stamp, no permission added, never promoted", async () => {
    const s = await seedOrg("bf_fake");
    const fake = await insertRole(s, "OWNER", [CREATE_APP]);
    const nearMiss = await insertRole(s, "OWNER", NEAR_MISS);
    await s.t.mutation(internal.migrateRoles.backfillFinanceApplicationPermissions, {});
    expect(await roleOf(s, fake)).toMatchObject({ permissions: [CREATE_APP] });
    expect((await roleOf(s, fake)).isSystemOwnerRole).toBeUndefined();
    const near = await roleOf(s, nearMiss);
    expect(near.permissions).toEqual(NEAR_MISS);
    expect(near.isSystemOwnerRole).toBeUndefined();
    expect(isSystemOwnerRole(near)).toBe(false);
  });

  test("migrateRoles.patchRoleIfNeeded: an explicit-false OWNER stays false", async () => {
    const s = await seedOrg("bf_false");
    const demoted = await insertRole(s, "OWNER", [...FROZEN], false);
    await s.t.mutation(internal.migrateRoles.backfillFinanceApplicationPermissions, {});
    expect((await roleOf(s, demoted)).isSystemOwnerRole).toBe(false);
  });

  test("migrations.backfillPermissions: a qualifying OWNER is stamped and gets every permission", async () => {
    const s = await seedOrg("bp_ok");
    await s.t.mutation(internal.migrations.backfillPermissions, {});
    const after = await roleOf(s, s.ownerRoleId);
    expect(after.isSystemOwnerRole).toBe(true);
    expect(after.permissions).toEqual(ALL_PERMISSIONS);
  });

  test("migrations.backfillPermissions: a fake or explicit-false OWNER is not promoted (no stamp, no all-permission grant)", async () => {
    const s = await seedOrg("bp_fake");
    const fake = await insertRole(s, "OWNER", [CREATE_APP]);
    const demoted = await insertRole(s, "OWNER", [...FROZEN], false);
    await s.t.mutation(internal.migrations.backfillPermissions, {});
    const f = await roleOf(s, fake);
    expect(f.permissions).toEqual([CREATE_APP]);
    expect(f.isSystemOwnerRole).toBeUndefined();
    const d = await roleOf(s, demoted);
    expect(d.permissions).toEqual(FROZEN);
    expect(d.isSystemOwnerRole).toBe(false);
  });

  test("migrateRoles.fixExistingRoles: an OWNER-named row one value short of the frozen set is not pushed over it", async () => {
    const s = await seedOrg("fx_near");
    const nearMiss = await insertRole(s, "OWNER", FROZEN.filter((p) => p !== PERMISSIONS.VIEW_USERS));
    await s.t.mutation(internal.migrateRoles.fixExistingRoles, {});
    expect(isSystemOwnerRole(await roleOf(s, nearMiss))).toBe(false);
  });
});

describe("SCRUM-413 PR-B S413B-2 - prepareSplitDealAuthorities readiness covers owner identity", () => {
  test("an unstamped qualifying owner is counted separately and keeps ready=false; a stamped one does not", async () => {
    const s = await seedOrg("diag_unstamped");
    const result = await s.t.query(internal.migrateRoles.prepareSplitDealAuthorities, {});
    expect(result).toMatchObject({ ready: false, unstampedOwners: 1, retiredCarriers: 1 });
    expect(result.records.find((r: any) => r.roleId === s.ownerRoleId)).toMatchObject({ stampOwnerFlag: true });

    await s.asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId });
    expect(await s.t.query(internal.migrateRoles.prepareSplitDealAuthorities, {})).toMatchObject({
      ready: true, unstampedOwners: 0, retiredCarriers: 0, unqualifiedOwnerNamed: 0,
    });
  });

  // The frozen set CONTAINS the retired string, so today a qualifying unflagged
  // row always carries it and the stamp-only branch (no retired string) cannot
  // be built from real data. Pin what is observable: the stamp count is its own
  // number, independent of the carrier count, and blocks `ready` by itself.
  test("the stamp count is independent of the carrier count and blocks ready on its own", async () => {
    const s = await seedOrg("diag_stamp_only");
    const result = await s.t.query(internal.migrateRoles.prepareSplitDealAuthorities, {});
    expect(result.unstampedOwners).toBe(1);
    expect(result.ready).toBe(false);
    const record = result.records.find((r: any) => r.roleId === s.ownerRoleId);
    expect(record).toMatchObject({ stampOwnerFlag: true, ownerFlagSkipped: false });
  });

  test("an unqualified OWNER-named row blocks ready and is counted separately", async () => {
    const s = await seedOrg("diag_fake");
    await s.asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId });
    await insertRole(s, "OWNER", [CREATE_APP]);
    const result = await s.t.query(internal.migrateRoles.prepareSplitDealAuthorities, {});
    expect(result).toMatchObject({ unqualifiedOwnerNamed: 1, retiredCarriers: 0, ready: false });
  });

  // D-37: an OWNER-named row with an explicit `false` is unqualified. It is an
  // owner-review item (counted, ready=false) and is never stamped.
  test("an explicit-false OWNER-named row is counted in unqualifiedOwnerNamed and blocks ready", async () => {
    const s = await seedOrg("diag_explicit_false");
    await s.asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId });
    const falseId = await insertRole(s, "OWNER", [CREATE_APP], false);
    const result = await s.t.query(internal.migrateRoles.prepareSplitDealAuthorities, {});
    expect(result).toMatchObject({ unqualifiedOwnerNamed: 1, unstampedOwners: 0, retiredCarriers: 0, ready: false });
    expect(result.records.find((r: any) => r.roleId === falseId)).toMatchObject({
      ownerFlagSkipped: true, stampOwnerFlag: false, ownerQualified: false,
    });
    expect((await roleOf(s, falseId)).isSystemOwnerRole).toBe(false);
  });
});

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code?: unknown })?.code;
    throw error;
  }
  return undefined;
}

describe("SCRUM-413 PR-B L-2 - roles.update never lifts an unqualified OWNER-named row to the frozen set", () => {
  test("editing a fake OWNER (finalize + near-miss) to the full frozen set is refused and the row stays non-owner", async () => {
    const s = await seedOrg("l2_fake");
    const dropped = FROZEN.find((p) => p !== FINALIZE);
    const fake = await insertRole(s, "OWNER", FROZEN.filter((p) => p !== dropped)); // finalize + all but one
    expect(fake).toBeDefined();
    expect(isSystemOwnerRole(await roleOf(s, fake))).toBe(false);

    expect(
      await codeOf(s.asOwner.mutation(api.roles.update, { orgId: s.orgId, roleId: fake, permissions: FROZEN }))
    ).toBe("OWNER_NAMED_ROLE_LOCKED");
    const after = await roleOf(s, fake);
    expect(isSystemOwnerRole(after)).toBe(false);
    expect(after.permissions).not.toEqual(expect.arrayContaining(FROZEN));
  });

  test("an explicit-false OWNER is refused the same way", async () => {
    const s = await seedOrg("l2_false");
    const demoted = await insertRole(s, "OWNER", [CREATE_APP], false);
    expect(
      await codeOf(s.asOwner.mutation(api.roles.update, { orgId: s.orgId, roleId: demoted, permissions: FROZEN }))
    ).toBe("OWNER_NAMED_ROLE_LOCKED");
    expect((await roleOf(s, demoted)).permissions).toEqual([CREATE_APP]);
  });

  test("control: editing a normal custom role still works", async () => {
    const s = await seedOrg("l2_control");
    const custom = await insertRole(s, "Closer", [CREATE_APP]);
    await s.asOwner.mutation(api.roles.update, {
      orgId: s.orgId, roleId: custom, permissions: [CREATE_APP, PERMISSIONS.VIEW_USERS],
    });
    expect((await roleOf(s, custom)).permissions).toEqual([CREATE_APP, PERMISSIONS.VIEW_USERS]);
  });
});
