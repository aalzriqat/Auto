import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_TEMPLATES,
  LEGACY_PERMISSIONS,
  PERMISSIONS,
  PRE_413_OWNER_FALLBACK_PERMISSIONS,
  getInvalidPermissions,
  isSystemOwnerRole,
  newlyAddedLegacyPermissions,
} from "./utils/permissions";

/**
 * SCRUM-413 PR-B: finalize:financed_deal is retired. The split authorities
 * (route, cancel-closed) are the only active ones; the old string is a legacy
 * value that validates on a stored row but mints nothing, is in no template,
 * and can never be newly added. Editing or renaming a role grants nothing the
 * caller did not send, and the migration read-back is diagnostic-only.
 */

const MODULES = import.meta.glob("./**/*.*s");
const ROUTE = PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT;
const CANCEL_CLOSED = PERMISSIONS.CANCEL_CLOSED_DEAL;
// A string literal: the constant left PERMISSIONS when the permission retired.
const FINALIZE = "finalize:financed_deal";
const CREATE_APP = PERMISSIONS.CREATE_FINANCE_APPLICATION;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function setupOwnerOrg(t: any, clerkId: string) {
  const orgId = await t.run((ctx: any) =>
    ctx.db.insert("organizations", { name: "SCRUM-413 Dealer", createdAt: Date.now() })
  ) as Id<"organizations">;
  await t.run((ctx: any) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx: any) =>
    ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com` })
  ) as Id<"users">;
  const ownerRoleId = await t.run((ctx: any) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  ) as Id<"roles">;
  await t.run((ctx: any) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRoleId }));
  return { orgId, asOwner: t.withIdentity({ subject: clerkId }) };
}

function insertRole(t: any, orgId: Id<"organizations">, name: string, permissions: string[]) {
  return t.run((ctx: any) => ctx.db.insert("roles", { orgId, name, permissions })) as Promise<Id<"roles">>;
}

describe("SCRUM-413 frozen owner fallback (unchanged by the retirement)", () => {
  test("the frozen set is pinned: 77 pre-413 values, frozen, unchanged", async () => {
    expect(PRE_413_OWNER_FALLBACK_PERMISSIONS).toHaveLength(77);
    expect(Object.isFrozen(PRE_413_OWNER_FALLBACK_PERMISSIONS)).toBe(true);
    expect(PRE_413_OWNER_FALLBACK_PERMISSIONS).toContain(FINALIZE);
    expect(PRE_413_OWNER_FALLBACK_PERMISSIONS).not.toContain(ROUTE);
    expect(PRE_413_OWNER_FALLBACK_PERMISSIONS).not.toContain(CANCEL_CLOSED);
    expect(await sha256Hex([...PRE_413_OWNER_FALLBACK_PERMISSIONS].sort().join("\n"))).toBe(
      "7e927cf0b79a5bf282019b1517e315f74ea7dde205f11b47da7ee47657213564"
    );
  });

  test("an unflagged legacy OWNER holding the pre-413 set still qualifies", () => {
    expect(isSystemOwnerRole({ name: "OWNER", permissions: [...PRE_413_OWNER_FALLBACK_PERMISSIONS] })).toBe(true);
  });

  test("an unflagged OWNER-named row missing one pre-413 value does not qualify", () => {
    const short = PRE_413_OWNER_FALLBACK_PERMISSIONS.filter((p) => p !== FINALIZE);
    expect(isSystemOwnerRole({ name: "OWNER", permissions: short })).toBe(false);
  });
});

describe("SCRUM-413 retired permission", () => {
  test("finalize:financed_deal is legacy: validates on a stored row, is not an active permission", () => {
    expect(LEGACY_PERMISSIONS).toContain(FINALIZE);
    expect((ALL_PERMISSIONS as string[]).includes(FINALIZE)).toBe(false);
    expect(getInvalidPermissions([FINALIZE, ROUTE])).toEqual([]);
    expect(getInvalidPermissions(["finalize:nonsense"])).toEqual(["finalize:nonsense"]);
  });

  test("only a NEWLY added legacy value is reported", () => {
    expect(newlyAddedLegacyPermissions([FINALIZE], [])).toEqual([FINALIZE]);
    expect(newlyAddedLegacyPermissions([FINALIZE, CREATE_APP], [FINALIZE])).toEqual([]);
    expect(newlyAddedLegacyPermissions([CREATE_APP], [FINALIZE])).toEqual([]);
  });
});

describe("SCRUM-413 default templates", () => {
  const template = (name: string) => DEFAULT_ROLE_TEMPLATES.find((r) => r.name === name)?.permissions ?? [];

  test("no template carries the retired permission", () => {
    for (const { name, permissions } of DEFAULT_ROLE_TEMPLATES) {
      expect(permissions as string[], name).not.toContain(FINALIZE);
    }
  });

  test("MANAGER gets both new authorities", () => {
    expect(template("MANAGER")).toEqual(expect.arrayContaining([ROUTE, CANCEL_CLOSED]));
  });

  test("accountants get the route authority only; SALES gets neither", () => {
    for (const name of ["ACCOUNTANT", "SENIOR_ACCOUNTANT"]) {
      expect(template(name)).toContain(ROUTE);
      expect(template(name)).not.toContain(CANCEL_CLOSED);
    }
    expect(template("SALES")).not.toContain(ROUTE);
    expect(template("SALES")).not.toContain(CANCEL_CLOSED);
  });
});

describe("SCRUM-413 prepareSplitDealAuthorities is diagnostic-only", () => {
  test("it writes nothing and reports retired carriers and new-authority holders", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx: any) =>
      ctx.db.insert("organizations", { name: "Migration Dealer", createdAt: Date.now() })
    ) as Id<"organizations">;
    const legacyOwner = await insertRole(t, orgId, "OWNER", [...PRE_413_OWNER_FALLBACK_PERMISSIONS]);
    const fakeOwner = await insertRole(t, orgId, "OWNER", [FINALIZE]);
    const manager = await insertRole(t, orgId, "MANAGER", [FINALIZE, CREATE_APP]);
    const accountant = await insertRole(t, orgId, "ACCOUNTANT", [ROUTE]);
    const plain = await insertRole(t, orgId, "Showroom", [CREATE_APP]);
    const before = await t.run((ctx: any) => ctx.db.query("roles").collect());

    const result = await t.mutation(internal.migrateRoles.prepareSplitDealAuthorities, {});

    expect(await t.run((ctx: any) => ctx.db.query("roles").collect())).toEqual(before);
    const byId = new Map<string, any>(result.records.map((r: any) => [r.roleId, r]));
    expect(byId.get(manager)).toMatchObject({ carriesRetiredPermission: true, holdsRoute: false, holdsCancelClosed: false });
    expect(byId.get(legacyOwner)).toMatchObject({ stampOwnerFlag: true, carriesRetiredPermission: true });
    expect(byId.get(fakeOwner)).toMatchObject({ ownerFlagSkipped: true, stampOwnerFlag: false });
    expect(byId.get(accountant)).toMatchObject({ carriesRetiredPermission: false, holdsRoute: true });
    expect(byId.has(plain)).toBe(false);
    expect(result.retiredCarriers).toBe(3);
    expect(result.ready).toBe(false);
  });

  test("it takes no apply argument, and nothing grants the old roles new authority", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx: any) =>
      ctx.db.insert("organizations", { name: "Migration Dealer", createdAt: Date.now() })
    ) as Id<"organizations">;
    const manager = await insertRole(t, orgId, "MANAGER", [FINALIZE, CREATE_APP]);
    await expect(
      (t.mutation as any)(internal.migrateRoles.prepareSplitDealAuthorities, { apply: true })
    ).rejects.toThrow();
    const role = await t.run((ctx: any) => ctx.db.get(manager)) as any;
    expect(role?.permissions).toEqual([FINALIZE, CREATE_APP]);
  });

  test("ready once no stored role carries the retired string", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId } = await setupOwnerOrg(t, "scrum413_ready_owner");
    await insertRole(t, orgId, "MANAGER", [CREATE_APP, ROUTE, CANCEL_CLOSED]);
    const result = await t.mutation(internal.migrateRoles.prepareSplitDealAuthorities, {});
    expect(result).toMatchObject({ ready: true, retiredCarriers: 0 });
  });
});

describe("SCRUM-413 role writers", () => {
  test("roles.create refuses the retired finalize:financed_deal", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, asOwner } = await setupOwnerOrg(t, "scrum413_create_owner");

    await expect(
      asOwner.mutation(api.roles.create, { orgId, name: "Closer", permissions: [FINALIZE] })
    ).rejects.toThrow(/finalize:financed_deal is being retired/);
  });

  test("roles.update refuses a NEWLY added finalize:financed_deal", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, asOwner } = await setupOwnerOrg(t, "scrum413_update_add_owner");
    const roleId = await insertRole(t, orgId, "SALES", [CREATE_APP]);

    await expect(
      asOwner.mutation(api.roles.update, { orgId, roleId, permissions: [CREATE_APP, FINALIZE] })
    ).rejects.toThrow(/finalize:financed_deal is being retired/);
    const role = await t.run((ctx: any) => ctx.db.get(roleId)) as any;
    expect(role?.permissions).toEqual([CREATE_APP]);
  });

  test("roles.update lets an already-stored legacy value round-trip, and grants nothing extra", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, asOwner } = await setupOwnerOrg(t, "scrum413_roundtrip_owner");
    const roleId = await insertRole(t, orgId, "Deal Desk", [FINALIZE, CREATE_APP]);

    await asOwner.mutation(api.roles.update, { orgId, roleId, permissions: [FINALIZE, CREATE_APP, PERMISSIONS.VIEW_SALES] });

    const role = await t.run((ctx: any) => ctx.db.get(roleId)) as any;
    expect(role?.permissions).toEqual([FINALIZE, CREATE_APP, PERMISSIONS.VIEW_SALES]);
  });

  // Failing-first against the PR-A code: editing or renaming a role used to
  // append the route and cancel-closed authorities for it.
  test("editing a role stored as MANAGER does NOT auto-grant deal authorities", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, asOwner } = await setupOwnerOrg(t, "scrum413_mgr_edit_owner");
    const roleId = await insertRole(t, orgId, "MANAGER", [FINALIZE]);

    await asOwner.mutation(api.roles.update, { orgId, roleId, permissions: [FINALIZE, CREATE_APP] });

    const role = await t.run((ctx: any) => ctx.db.get(roleId)) as any;
    expect(role?.name).toBe("MANAGER");
    expect(role?.permissions).toEqual([FINALIZE, CREATE_APP]);
  });

  test("renaming a role to MANAGER does NOT auto-grant deal authorities", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, asOwner } = await setupOwnerOrg(t, "scrum413_rename_owner");
    const roleId = await insertRole(t, orgId, "Deal Desk", [FINALIZE, CREATE_APP]);

    await asOwner.mutation(api.roles.update, { orgId, roleId, name: "MANAGER" });

    const role = await t.run((ctx: any) => ctx.db.get(roleId)) as any;
    expect(role?.permissions).toEqual([FINALIZE, CREATE_APP]);
  });

  test("template sync returns the per-role diff and audits each changed role once", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, asOwner } = await setupOwnerOrg(t, "scrum413_sync_owner");
    const accountantId = await insertRole(t, orgId, "ACCOUNTANT", [PERMISSIONS.VIEW_FINANCE]);
    await insertRole(t, orgId, "Custom Desk", [FINALIZE]);
    const syncAudits = () =>
      t.run(async (ctx: any) =>
        (await ctx.db.query("adminAuditLog").withIndex("by_org", (q: any) => q.eq("orgId", orgId)).collect())
          .filter((a: any) => a.action === "role.template_sync")
      ) as Promise<any[]>;

    const first = await asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId });

    expect(first.changes.find((c: any) => c.roleId === accountantId)?.added).toContain(ROUTE);
    expect(first.changes.map((c: any) => c.name)).not.toContain("Custom Desk");
    const audits = await syncAudits();
    expect(audits).toHaveLength(first.changes.length);
    const accountantAudit = audits.find((a) => a.targetId === accountantId);
    expect(accountantAudit?.before).toEqual({ permissions: [PERMISSIONS.VIEW_FINANCE] });
    expect(accountantAudit?.after.permissions).toContain(ROUTE);

    const second = await asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId });
    expect(second).toEqual({ changes: [] });
    expect(await syncAudits()).toHaveLength(audits.length);
  });
});
