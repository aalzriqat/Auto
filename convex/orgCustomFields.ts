import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth, requireOwner, requireOwnedRow } from "./utils/tenancy";

const FIELD_NOT_FOUND = "Custom field not found in this organization.";

// ─── Field definitions ─────────────────────────────────────────────────────────

export const list = query({
  args: {
    orgId: v.id("organizations"),
    entityType: v.optional(
      v.union(v.literal("vehicle"), v.literal("customer"), v.literal("lead"))
    ),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);
    const fields = args.entityType
      ? await ctx.db
          .query("orgCustomFields")
          .withIndex("by_org_entity", (q) =>
            q.eq("orgId", args.orgId).eq("entityType", args.entityType!)
          )
          .collect()
      : await ctx.db
          .query("orgCustomFields")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .collect();
    return fields.sort((a, b) => a.order - b.order);
  },
});

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    entityType: v.union(v.literal("vehicle"), v.literal("customer"), v.literal("lead")),
    fieldName: v.string(),
    fieldKey: v.string(),
    fieldType: v.union(v.literal("text"), v.literal("number"), v.literal("select"), v.literal("date")),
    isRequired: v.optional(v.boolean()),
    options: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    const existing = await ctx.db
      .query("orgCustomFields")
      .withIndex("by_org_entity", (q) =>
        q.eq("orgId", args.orgId).eq("entityType", args.entityType)
      )
      .collect();
    return await ctx.db.insert("orgCustomFields", {
      orgId: args.orgId,
      entityType: args.entityType,
      fieldName: args.fieldName,
      fieldKey: args.fieldKey,
      fieldType: args.fieldType,
      isRequired: args.isRequired ?? false,
      options: args.options,
      order: existing.length,
      isActive: true,
    });
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    fieldId: v.id("orgCustomFields"),
    fieldName: v.optional(v.string()),
    isRequired: v.optional(v.boolean()),
    options: v.optional(v.array(v.string())),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    await requireOwnedRow(ctx, args.orgId, "orgCustomFields", args.fieldId, FIELD_NOT_FOUND);
    const { fieldId, orgId, ...fields } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      // Convex's argument wire protocol drops keys explicitly set to
      // undefined before the handler ever sees them, so a real caller can
      // never make this evaluate false — see the same note in orgSettings.ts.
      /* v8 ignore else */
      if (value !== undefined) patch[key] = value;
    }
    await ctx.db.patch(fieldId, patch);
  },
});

export const remove = mutation({
  args: { orgId: v.id("organizations"), fieldId: v.id("orgCustomFields") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    // Without this the delete below removes another org's field definition
    // while the value cleanup only ever touches the caller's own org, orphaning
    // the victim's value rows behind a definition that no longer exists.
    await requireOwnedRow(ctx, args.orgId, "orgCustomFields", args.fieldId, FIELD_NOT_FOUND);
    // Delete all values for this field
    const values = await ctx.db
      .query("orgCustomFieldValues")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    for (const v of values.filter((v) => v.fieldId === args.fieldId)) {
      await ctx.db.delete(v._id);
    }
    await ctx.db.delete(args.fieldId);
  },
});

// ─── Field values ──────────────────────────────────────────────────────────────

export const getValues = query({
  args: {
    orgId: v.id("organizations"),
    entityType: v.string(),
    entityId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);
    // Entity ids are caller-supplied and `by_entity` is not org-scoped, so this
    // must enter the table by org — otherwise any member of any org reads
    // another dealership's custom-field data by naming its entity id.
    return await ctx.db
      .query("orgCustomFieldValues")
      .withIndex("by_org_entity", (q) =>
        q.eq("orgId", args.orgId).eq("entityType", args.entityType).eq("entityId", args.entityId)
      )
      .collect();
  },
});

export const setValues = mutation({
  args: {
    orgId: v.id("organizations"),
    entityType: v.string(),
    entityId: v.string(),
    values: v.array(v.object({ fieldId: v.id("orgCustomFields"), value: v.string() })),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);

    // Reject the whole payload before writing anything: a field definition the
    // caller's org does not own can only have come from another dealership, and
    // accepting it would stamp this org's id onto that org's entity.
    for (const { fieldId } of args.values) {
      await requireOwnedRow(ctx, args.orgId, "orgCustomFields", fieldId, FIELD_NOT_FOUND);
    }

    // Org-scoped for the same reason as getValues — `by_entity` alone would
    // hand back another org's rows to patch and delete.
    const existing = await ctx.db
      .query("orgCustomFieldValues")
      .withIndex("by_org_entity", (q) =>
        q.eq("orgId", args.orgId).eq("entityType", args.entityType).eq("entityId", args.entityId)
      )
      .collect();

    for (const { fieldId, value } of args.values) {
      const row = existing.find((e) => e.fieldId === fieldId);
      if (row) {
        if (value === "") {
          await ctx.db.delete(row._id);
        } else {
          await ctx.db.patch(row._id, { value });
        }
      } else if (value !== "") {
        await ctx.db.insert("orgCustomFieldValues", {
          orgId: args.orgId,
          entityType: args.entityType,
          entityId: args.entityId,
          fieldId,
          value,
        });
      }
    }
  },
});
