/**
 * Cross-tenant regression suite for the five `org*` settings modules.
 *
 * `requireOwner(ctx, args.orgId)` only proves the caller owns the org they
 * named — it says nothing about the row id they passed alongside it. Three of
 * these modules bridged that gap by hand and two did not, and nothing in the
 * type system, lint, or the rest of the suite could tell them apart. Every
 * handler that takes an `orgId` plus a caller-supplied id gets an attack case
 * here so the omission can never ship silently again.
 *
 * Shape of each case: an OWNER of org A names org A (passing every auth guard)
 * and supplies an id belonging to org B.
 */
import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/** Creates an org whose sole member is an OWNER identified by `clerkId`. */
async function setupOrg(t: any, clerkId: string, name: string) {
  const orgId = await t.run((ctx: any) =>
    ctx.db.insert("organizations", { name, createdAt: Date.now() })
  );
  const userId = await t.run((ctx: any) =>
    ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: `${name} Owner` })
  );
  const roleId = await t.run((ctx: any) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx: any) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId, roleId };
}

/** Two fully independent orgs; the attacker owns A, the victim owns B. */
async function setupTwoOrgs(t: any, seed: string) {
  const attacker = await setupOrg(t, `attacker_${seed}`, "Attacker Motors");
  const victim = await setupOrg(t, `victim_${seed}`, "Victim Motors");
  return {
    attacker,
    victim,
    asAttacker: t.withIdentity({ subject: `attacker_${seed}` }),
  };
}

describe("orgPipelineStages cross-tenant guards", () => {
  test("update refuses a stage id belonging to another org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "ps1");

    const victimStageId = await t.run((ctx: any) =>
      ctx.db.insert("orgPipelineStages", {
        orgId: victim.orgId,
        stageKey: "NEW",
        label: "New",
        color: "#6b7280",
        order: 0,
        isActive: true,
      })
    );

    await expect(
      asAttacker.mutation(api.orgPipelineStages.update, {
        orgId: attacker.orgId,
        stageId: victimStageId,
        label: "Owned by attacker",
        isActive: false,
      })
    ).rejects.toThrow(/not found/i);

    const stage: any = await t.run((ctx: any) => ctx.db.get(victimStageId));
    expect(stage.label).toBe("New");
    expect(stage.isActive).toBe(true);
  });

  test("reorder refuses a stage id belonging to another org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "ps2");

    const victimStageId = await t.run((ctx: any) =>
      ctx.db.insert("orgPipelineStages", {
        orgId: victim.orgId,
        stageKey: "WON",
        label: "Won",
        color: "#22c55e",
        order: 6,
        isActive: true,
      })
    );

    await expect(
      asAttacker.mutation(api.orgPipelineStages.reorder, {
        orgId: attacker.orgId,
        orderedIds: [victimStageId],
      })
    ).rejects.toThrow(/not found/i);

    const stage: any = await t.run((ctx: any) => ctx.db.get(victimStageId));
    expect(stage.order).toBe(6);
  });

  test("reorder still renumbers the caller's own stages", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, asAttacker } = await setupTwoOrgs(t, "ps3");

    await asAttacker.mutation(api.orgPipelineStages.seed, { orgId: attacker.orgId });
    const stages = await asAttacker.query(api.orgPipelineStages.list, { orgId: attacker.orgId });
    const reversed = [...stages].reverse().map((s: any) => s._id);

    await asAttacker.mutation(api.orgPipelineStages.reorder, {
      orgId: attacker.orgId,
      orderedIds: reversed,
    });

    const after = await asAttacker.query(api.orgPipelineStages.list, { orgId: attacker.orgId });
    expect(after.map((s: any) => s._id)).toEqual(reversed);
  });
});

describe("orgCustomFields cross-tenant guards", () => {
  /** A custom field definition plus one stored value, both owned by `orgId`. */
  async function seedFieldWithValue(t: any, orgId: string, entityId: string) {
    const fieldId = await t.run((ctx: any) =>
      ctx.db.insert("orgCustomFields", {
        orgId,
        entityType: "vehicle" as const,
        fieldName: "Engine No.",
        fieldKey: "engine_no",
        fieldType: "text" as const,
        isRequired: false,
        order: 0,
        isActive: true,
      })
    );
    const valueId = await t.run((ctx: any) =>
      ctx.db.insert("orgCustomFieldValues", {
        orgId,
        entityType: "vehicle",
        entityId,
        fieldId,
        value: "SECRET-ENGINE-123",
      })
    );
    return { fieldId, valueId };
  }

  test("update refuses a field id belonging to another org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "cf1");
    const { fieldId } = await seedFieldWithValue(t, victim.orgId, "veh_victim");

    await expect(
      asAttacker.mutation(api.orgCustomFields.update, {
        orgId: attacker.orgId,
        fieldId,
        fieldName: "Renamed by attacker",
        isActive: false,
      })
    ).rejects.toThrow(/not found/i);

    const field: any = await t.run((ctx: any) => ctx.db.get(fieldId));
    expect(field.fieldName).toBe("Engine No.");
    expect(field.isActive).toBe(true);
  });

  test("remove refuses a field id belonging to another org and leaves no orphans", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "cf2");
    const { fieldId, valueId } = await seedFieldWithValue(t, victim.orgId, "veh_victim");

    await expect(
      asAttacker.mutation(api.orgCustomFields.remove, {
        orgId: attacker.orgId,
        fieldId,
      })
    ).rejects.toThrow(/not found/i);

    expect(await t.run((ctx: any) => ctx.db.get(fieldId))).not.toBeNull();
    expect(await t.run((ctx: any) => ctx.db.get(valueId))).not.toBeNull();
  });

  test("getValues never returns another org's values", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "cf3");
    await seedFieldWithValue(t, victim.orgId, "veh_shared_id");

    const leaked = await asAttacker.query(api.orgCustomFields.getValues, {
      orgId: attacker.orgId,
      entityType: "vehicle",
      entityId: "veh_shared_id",
    });

    expect(leaked).toEqual([]);
  });

  test("setValues cannot patch or delete another org's values", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "cf4");
    const { fieldId, valueId } = await seedFieldWithValue(t, victim.orgId, "veh_shared_id");

    await expect(
      asAttacker.mutation(api.orgCustomFields.setValues, {
        orgId: attacker.orgId,
        entityType: "vehicle",
        entityId: "veh_shared_id",
        values: [{ fieldId, value: "OVERWRITTEN" }],
      })
    ).rejects.toThrow(/not found/i);

    const row: any = await t.run((ctx: any) => ctx.db.get(valueId));
    expect(row).not.toBeNull();
    expect(row.value).toBe("SECRET-ENGINE-123");
  });

  test("setValues cannot blank out another org's value", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "cf5");
    const { fieldId, valueId } = await seedFieldWithValue(t, victim.orgId, "veh_shared_id");

    await expect(
      asAttacker.mutation(api.orgCustomFields.setValues, {
        orgId: attacker.orgId,
        entityType: "vehicle",
        entityId: "veh_shared_id",
        values: [{ fieldId, value: "" }],
      })
    ).rejects.toThrow(/not found/i);

    expect(await t.run((ctx: any) => ctx.db.get(valueId))).not.toBeNull();
  });

  test("owner can still read and write their own custom field values", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, asAttacker } = await setupTwoOrgs(t, "cf6");

    const fieldId = await asAttacker.mutation(api.orgCustomFields.create, {
      orgId: attacker.orgId,
      entityType: "vehicle",
      fieldName: "Engine No.",
      fieldKey: "engine_no",
      fieldType: "text",
    });

    await asAttacker.mutation(api.orgCustomFields.setValues, {
      orgId: attacker.orgId,
      entityType: "vehicle",
      entityId: "veh_own",
      values: [{ fieldId, value: "ABC-1" }],
    });

    let values = await asAttacker.query(api.orgCustomFields.getValues, {
      orgId: attacker.orgId,
      entityType: "vehicle",
      entityId: "veh_own",
    });
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe("ABC-1");

    // Update in place, then clear.
    await asAttacker.mutation(api.orgCustomFields.setValues, {
      orgId: attacker.orgId,
      entityType: "vehicle",
      entityId: "veh_own",
      values: [{ fieldId, value: "ABC-2" }],
    });
    values = await asAttacker.query(api.orgCustomFields.getValues, {
      orgId: attacker.orgId,
      entityType: "vehicle",
      entityId: "veh_own",
    });
    expect(values[0].value).toBe("ABC-2");

    await asAttacker.mutation(api.orgCustomFields.setValues, {
      orgId: attacker.orgId,
      entityType: "vehicle",
      entityId: "veh_own",
      values: [{ fieldId, value: "" }],
    });
    values = await asAttacker.query(api.orgCustomFields.getValues, {
      orgId: attacker.orgId,
      entityType: "vehicle",
      entityId: "veh_own",
    });
    expect(values).toEqual([]);

    // Removing the definition also removes its remaining values.
    await asAttacker.mutation(api.orgCustomFields.remove, {
      orgId: attacker.orgId,
      fieldId,
    });
    expect(await t.run((ctx: any) => ctx.db.get(fieldId))).toBeNull();
  });
});

describe("orgLeadSources cross-tenant guards", () => {
  test("update and remove refuse a source id belonging to another org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "ls1");

    const sourceId = await t.run((ctx: any) =>
      ctx.db.insert("orgLeadSources", {
        orgId: victim.orgId,
        label: "Walk-in",
        isActive: true,
        order: 0,
      })
    );

    await expect(
      asAttacker.mutation(api.orgLeadSources.update, {
        orgId: attacker.orgId,
        sourceId,
        label: "Hijacked",
      })
    ).rejects.toThrow(/not found/i);

    await expect(
      asAttacker.mutation(api.orgLeadSources.remove, { orgId: attacker.orgId, sourceId })
    ).rejects.toThrow(/not found/i);

    await expect(
      asAttacker.mutation(api.orgLeadSources.reorder, {
        orgId: attacker.orgId,
        orderedIds: [sourceId],
      })
    ).rejects.toThrow(/not found/i);

    const source: any = await t.run((ctx: any) => ctx.db.get(sourceId));
    expect(source.label).toBe("Walk-in");
  });
});

describe("orgCustomerStatuses cross-tenant guards", () => {
  test("update, remove and reorder refuse a status id belonging to another org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "cs1");

    const statusId = await t.run((ctx: any) =>
      ctx.db.insert("orgCustomerStatuses", {
        orgId: victim.orgId,
        label: "Salary Slip",
        isActive: true,
        order: 0,
      })
    );

    await expect(
      asAttacker.mutation(api.orgCustomerStatuses.update, {
        orgId: attacker.orgId,
        statusId,
        label: "Hijacked",
      })
    ).rejects.toThrow(/not found/i);

    await expect(
      asAttacker.mutation(api.orgCustomerStatuses.remove, { orgId: attacker.orgId, statusId })
    ).rejects.toThrow(/not found/i);

    await expect(
      asAttacker.mutation(api.orgCustomerStatuses.reorder, {
        orgId: attacker.orgId,
        orderedIds: [statusId],
      })
    ).rejects.toThrow(/not found/i);

    const status: any = await t.run((ctx: any) => ctx.db.get(statusId));
    expect(status.label).toBe("Salary Slip");
  });
});

// Found by scripts/tenantWriteGuard.ts, not by review — the identical shape,
// in a module nobody thought to check alongside the org* family.
describe("feedback cross-tenant guards", () => {
  test("setStatus refuses a feedback id belonging to another org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "fb1");

    const feedbackId = await t.run((ctx: any) =>
      ctx.db.insert("feedback", {
        orgId: victim.orgId,
        userId: victim.userId,
        type: "BUG" as const,
        title: "Victim's private bug report",
        status: "OPEN" as const,
        createdAt: Date.now(),
      })
    );

    await expect(
      asAttacker.mutation(api.feedback.setStatus, {
        orgId: attacker.orgId,
        feedbackId,
        status: "CLOSED",
      })
    ).rejects.toThrow(/not found/i);

    const row: any = await t.run((ctx: any) => ctx.db.get(feedbackId));
    expect(row.status).toBe("OPEN");
    expect(row.resolvedAt).toBeUndefined();
  });

  test("an owner can still close their own org's feedback", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, asAttacker } = await setupTwoOrgs(t, "fb2");

    const feedbackId = await t.run((ctx: any) =>
      ctx.db.insert("feedback", {
        orgId: attacker.orgId,
        userId: attacker.userId,
        type: "FEATURE" as const,
        title: "Own request",
        status: "OPEN" as const,
        createdAt: Date.now(),
      })
    );

    await asAttacker.mutation(api.feedback.setStatus, {
      orgId: attacker.orgId,
      feedbackId,
      status: "CLOSED",
    });

    const row: any = await t.run((ctx: any) => ctx.db.get(feedbackId));
    expect(row.status).toBe("CLOSED");
    expect(row.resolvedAt).toBeTypeOf("number");
  });
});

describe("orgValuationCompanies cross-tenant guards", () => {
  test("update and remove refuse a company id belonging to another org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { attacker, victim, asAttacker } = await setupTwoOrgs(t, "vc1");

    const companyId = await t.run((ctx: any) =>
      ctx.db.insert("orgValuationCompanies", {
        orgId: victim.orgId,
        name: "بندار",
        isActive: true,
        order: 0,
      })
    );

    await expect(
      asAttacker.mutation(api.orgValuationCompanies.update, {
        orgId: attacker.orgId,
        companyId,
        name: "Hijacked",
      })
    ).rejects.toThrow(/not found/i);

    await expect(
      asAttacker.mutation(api.orgValuationCompanies.remove, { orgId: attacker.orgId, companyId })
    ).rejects.toThrow(/not found/i);

    const company: any = await t.run((ctx: any) => ctx.db.get(companyId));
    expect(company.name).toBe("بندار");
  });
});
