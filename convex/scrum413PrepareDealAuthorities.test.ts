import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_TEMPLATES,
  PERMISSIONS,
  PRE_413_OWNER_FALLBACK_PERMISSIONS,
  dealAuthorityLostAtCutover,
  isSystemOwnerRole,
  transitionalDealGrants,
} from "./utils/permissions";

/**
 * SCRUM-413 PR-A (preparation): the split deal authorities exist and are
 * granted to stored roles BEFORE any door moves off finalize:financed_deal.
 * Nothing here changes who may act today; it proves the cutover can deny no
 * one who could act before it.
 */

const MODULES = import.meta.glob("./**/*.*s");
const ROUTE = PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT;
const CANCEL_CLOSED = PERMISSIONS.CANCEL_CLOSED_DEAL;
const FINALIZE = PERMISSIONS.FINALIZE_FINANCED_DEAL;
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

describe("SCRUM-413 frozen owner fallback", () => {
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

  test("an unflagged legacy OWNER holding the pre-413 set still qualifies without the new permissions", () => {
    // Before the freeze, defining two new permissions silently de-ownered this row.
    expect(isSystemOwnerRole({ name: "OWNER", permissions: [...PRE_413_OWNER_FALLBACK_PERMISSIONS] })).toBe(true);
  });

  test("an unflagged OWNER-named row missing one pre-413 value does not qualify", () => {
    const short = PRE_413_OWNER_FALLBACK_PERMISSIONS.filter((p) => p !== FINALIZE);
    expect(isSystemOwnerRole({ name: "OWNER", permissions: short })).toBe(false);
  });
});

describe("SCRUM-413 transitionalDealGrants", () => {
  test.each([
    ["flagged owner", { name: "Boss", permissions: [], isSystemOwnerRole: true }, [ROUTE, CANCEL_CLOSED]],
    ["unflagged qualifying OWNER", { name: "OWNER", permissions: [...PRE_413_OWNER_FALLBACK_PERMISSIONS] }, [ROUTE, CANCEL_CLOSED]],
    ["MANAGER with FINALIZE and CREATE", { name: "MANAGER", permissions: [FINALIZE, CREATE_APP] }, [ROUTE, CANCEL_CLOSED]],
    ["MANAGER with FINALIZE only", { name: "MANAGER", permissions: [FINALIZE] }, [ROUTE]],
    ["MANAGER without FINALIZE", { name: "MANAGER", permissions: [CREATE_APP] }, []],
    ["lower-case custom 'manager' with both", { name: "manager", permissions: [FINALIZE, CREATE_APP] }, []],
    ["SALES with FINALIZE and CREATE", { name: "SALES", permissions: [FINALIZE, CREATE_APP] }, []],
    ["ACCOUNTANT with FINALIZE", { name: "ACCOUNTANT", permissions: [FINALIZE] }, []],
    ["deleted owner", { name: "OWNER", permissions: [], isSystemOwnerRole: true, isDeleted: true }, []],
    ["MANAGER already holding both", { name: "MANAGER", permissions: [FINALIZE, CREATE_APP, ROUTE, CANCEL_CLOSED] }, []],
  ])("%s", (_label, role, expected) => {
    expect(transitionalDealGrants(role)).toEqual(expected);
  });
});

describe("SCRUM-413 dealAuthorityLostAtCutover", () => {
  test.each([
    ["custom role with FINALIZE and CREATE", { name: "Deal Desk", permissions: [FINALIZE, CREATE_APP] }, ["route", "cancelClosed"]],
    // Sonnet NEW-1: the edit dialog used to save a stored MANAGER as its label.
    ["MANAGER renamed to its English label", { name: "Manager", permissions: [FINALIZE, CREATE_APP] }, ["route", "cancelClosed"]],
    ["MANAGER renamed to its Arabic label", { name: "المدير", permissions: [FINALIZE] }, ["route"]],
    ["custom role with FINALIZE only",{ name: "Closer", permissions: [FINALIZE] }, ["route"]],
    ["ACCOUNTANT backfilled with FINALIZE and CREATE", { name: "ACCOUNTANT", permissions: [FINALIZE, CREATE_APP] }, ["route", "cancelClosed"]],
    ["SALES with FINALIZE and CREATE", { name: "SALES", permissions: [FINALIZE, CREATE_APP] }, ["route", "cancelClosed"]],
    ["role already holding both replacements", { name: "Deal Desk", permissions: [FINALIZE, CREATE_APP, ROUTE, CANCEL_CLOSED] }, []],
    ["role holding only the route replacement", { name: "Deal Desk", permissions: [FINALIZE, CREATE_APP, ROUTE] }, ["cancelClosed"]],
    ["CREATE without FINALIZE never reached either door", { name: "Deal Desk", permissions: [CREATE_APP] }, []],
    ["owner bypasses every door", { name: "Boss", permissions: [FINALIZE], isSystemOwnerRole: true }, []],
    ["deleted role", { name: "Deal Desk", permissions: [FINALIZE, CREATE_APP], isDeleted: true }, []],
  ])("%s", (_label, role, expected) => {
    expect(dealAuthorityLostAtCutover(role)).toEqual(expected);
  });
});

describe("SCRUM-413 default templates", () => {
  const template = (name: string) => DEFAULT_ROLE_TEMPLATES.find((r) => r.name === name)?.permissions ?? [];

  test("MANAGER gets both new authorities and keeps FINALIZE until cutover", () => {
    expect(template("MANAGER")).toEqual(expect.arrayContaining([ROUTE, CANCEL_CLOSED, FINALIZE]));
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

describe("SCRUM-413 prepareSplitDealAuthorities", () => {
  async function seed(t: any) {
    const orgId = await t.run((ctx: any) =>
      ctx.db.insert("organizations", { name: "Migration Dealer", createdAt: Date.now() })
    ) as Id<"organizations">;
    return {
      legacyOwner: await insertRole(t, orgId, "OWNER", [...PRE_413_OWNER_FALLBACK_PERMISSIONS]),
      fakeOwner: await insertRole(t, orgId, "OWNER", [FINALIZE]),
      manager: await insertRole(t, orgId, "MANAGER", [FINALIZE, CREATE_APP]),
      sales: await insertRole(t, orgId, "SALES", [FINALIZE, CREATE_APP]),
      accountant: await insertRole(t, orgId, "ACCOUNTANT", [PERMISSIONS.VIEW_FINANCE]),
      dealDesk: await insertRole(t, orgId, "Deal Desk", [FINALIZE, CREATE_APP]),
    };
  }

  test("dry-run reports and writes nothing", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const ids = await seed(t);
    const before = await t.run((ctx: any) => ctx.db.query("roles").collect());

    const result = await t.mutation(internal.migrateRoles.prepareSplitDealAuthorities, {});

    expect(result.apply).toBe(false);
    expect(result.pending).toBe(2);
    expect(await t.run((ctx: any) => ctx.db.query("roles").collect())).toEqual(before);
    const byId = new Map<string, any>(result.records.map((r: any) => [r.roleId, r]));
    expect(byId.get(ids.manager)).toMatchObject({ added: [ROUTE, CANCEL_CLOSED], priorRoute: true, priorCancelClosed: true });
    expect(byId.get(ids.legacyOwner)).toMatchObject({ stampOwnerFlag: true, added: [ROUTE, CANCEL_CLOSED] });
    expect(byId.get(ids.fakeOwner)).toMatchObject({ ownerFlagSkipped: true, stampOwnerFlag: false, added: [] });
    expect(byId.get(ids.accountant)).toMatchObject({ pendingOwnerAction: true, added: [], lostAtCutover: [] });
    expect(byId.get(ids.manager)).toMatchObject({ lostAtCutover: [] });
    // SCRUM-413-A1: a role that would lose an old door is never dropped from the report.
    expect(byId.get(ids.dealDesk)).toMatchObject({
      added: [], priorRoute: true, priorCancelClosed: true,
      lostAtCutover: ["route", "cancelClosed"], lossRuledByOwner: false,
    });
    expect(byId.get(ids.sales)).toMatchObject({ added: [], lostAtCutover: ["route", "cancelClosed"], lossRuledByOwner: true });
    expect(byId.get(ids.fakeOwner)).toMatchObject({ lostAtCutover: ["route"], lossRuledByOwner: false });
    expect(result.unresolved).toBe(2);
    expect(result.ready).toBe(false);
  });

  test("apply grants preserved authority only, then a re-run has nothing pending", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const ids = await seed(t);

    const applied = await t.mutation(internal.migrateRoles.prepareSplitDealAuthorities, { apply: true });
    expect(applied.pending).toBe(2);

    const role = (id: Id<"roles">) => t.run((ctx: any) => ctx.db.get(id)) as Promise<any>;
    expect((await role(ids.manager))?.permissions).toEqual([FINALIZE, CREATE_APP, ROUTE, CANCEL_CLOSED]);
    const owner = await role(ids.legacyOwner);
    expect(owner?.isSystemOwnerRole).toBe(true);
    expect(owner?.permissions).toEqual(expect.arrayContaining([ROUTE, CANCEL_CLOSED]));
    const fake = await role(ids.fakeOwner);
    expect(fake?.isSystemOwnerRole).toBeUndefined();
    expect(fake?.permissions).toEqual([FINALIZE]);
    expect((await role(ids.sales))?.permissions).toEqual([FINALIZE, CREATE_APP]);
    expect((await role(ids.accountant))?.permissions).toEqual([PERMISSIONS.VIEW_FINANCE]);

    const rerun = await t.mutation(internal.migrateRoles.prepareSplitDealAuthorities, { apply: true });
    expect(rerun.pending).toBe(0);
    expect(rerun.records.every((r: any) => r.added.length === 0 && !r.stampOwnerFlag)).toBe(true);
    // The accountant stays listed for the owner: the migration never grants it.
    expect(rerun.records.map((r: any) => r.roleId)).toContain(ids.accountant);
    // Nothing pending to write is NOT readiness: the losses still await the owner.
    expect(rerun.unresolved).toBe(2);
    expect(rerun.ready).toBe(false);
  });

  test("ready only once every loss is resolved, and a later edit that re-creates one is caught", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, asOwner } = await setupOwnerOrg(t, "scrum413_ready_owner");
    const dealDesk = await insertRole(t, orgId, "Deal Desk", [FINALIZE, CREATE_APP]);
    await insertRole(t, orgId, "SALES", [FINALIZE]);
    const dryRun = () => t.mutation(internal.migrateRoles.prepareSplitDealAuthorities, {});

    expect(await dryRun()).toMatchObject({ pending: 0, unresolved: 1, ready: false });

    // The owner resolves the loss by granting the replacements explicitly.
    await asOwner.mutation(api.roles.update, { orgId, roleId: dealDesk, permissions: [FINALIZE, CREATE_APP, ROUTE, CANCEL_CLOSED] });
    expect(await dryRun()).toMatchObject({ pending: 0, unresolved: 0, ready: true });

    // After readiness, an owner edit that adds the old authority to another role reopens it.
    const closer = await insertRole(t, orgId, "Closer", [CREATE_APP]);
    await asOwner.mutation(api.roles.update, { orgId, roleId: closer, permissions: [CREATE_APP, FINALIZE] });
    const reopened = await dryRun();
    expect(reopened).toMatchObject({ unresolved: 1, ready: false });
    expect(reopened.records.find((r: any) => r.roleId === closer)?.lostAtCutover).toEqual(["route", "cancelClosed"]);
  });
});

describe("SCRUM-413 role writers", () => {
  test("roles.create refuses the retiring finalize:financed_deal", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, asOwner } = await setupOwnerOrg(t, "scrum413_create_owner");

    await expect(
      asOwner.mutation(api.roles.create, { orgId, name: "Closer", permissions: [FINALIZE] })
    ).rejects.toThrow(/finalize:financed_deal is being retired/);
  });

  test("renaming a role that holds the old authority to MANAGER grants the matching split authority", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, asOwner } = await setupOwnerOrg(t, "scrum413_rename_owner");
    const roleId = await insertRole(t, orgId, "Deal Desk", [FINALIZE, CREATE_APP]);

    await asOwner.mutation(api.roles.update, { orgId, roleId, name: "MANAGER" });

    const role = await t.run((ctx: any) => ctx.db.get(roleId)) as any;
    expect(role?.permissions).toEqual([FINALIZE, CREATE_APP, ROUTE, CANCEL_CLOSED]);
  });

  test("editing a non-MANAGER role grants nothing extra", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { orgId, asOwner } = await setupOwnerOrg(t, "scrum413_edit_owner");
    const roleId = await insertRole(t, orgId, "SALES", [CREATE_APP]);

    await asOwner.mutation(api.roles.update, { orgId, roleId, permissions: [CREATE_APP, FINALIZE] });

    const role = await t.run((ctx: any) => ctx.db.get(roleId)) as any;
    expect(role?.permissions).toEqual([CREATE_APP, FINALIZE]);
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
