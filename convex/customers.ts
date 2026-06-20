import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { rateLimiter } from "./rateLimit";
import { validateInput } from "./utils/validation";
import { CreateCustomerSchema, UpdateCustomerSchema } from "./validations/customers";
import { normalizePhone, namesSimilar } from "./utils/dedup";
import { CUSTOMER_REFERENCING_TABLES } from "./utils/mergeHelpers";

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Lists all customers for an organization.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);

    return await ctx.db
      .query("customers")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .paginate(args.paginationOpts);
  },
});

/**
 * Gets a single customer by ID. Verifies they belong to the caller's org.
 */
export const get = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.isDeleted || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    return customer;
  },
});

/**
 * Searches for a customer by email within the organization.
 */
export const getByEmail = query({
  args: {
    orgId: v.id("organizations"),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);

    return await ctx.db
      .query("customers")
      .withIndex("by_org_email", (q) =>
        q.eq("orgId", args.orgId).eq("email", args.email.toLowerCase().trim())
      )
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .unique();
  },
});

/**
 * Pre-submit duplicate check for the customer create/edit form. Returns
 * exact phone/email matches (the same conditions `create`/`update` hard-block
 * on) plus non-blocking possible name matches, so the UI can warn before
 * the user even submits. This is advisory only — `create`/`update` remain
 * the authoritative server-side guard.
 */
export const checkDuplicates = query({
  args: {
    orgId: v.id("organizations"),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    excludeCustomerId: v.optional(v.id("customers")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);

    const normalizedPhone = args.phone?.trim() ? normalizePhone(args.phone) : undefined;
    const normalizedEmail = args.email?.toLowerCase().trim() || undefined;

    let exactPhoneMatch = null;
    if (normalizedPhone) {
      const match = await ctx.db
        .query("customers")
        .withIndex("by_org_phone", (q) => q.eq("orgId", args.orgId).eq("phone", normalizedPhone))
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .unique();
      if (match && match._id !== args.excludeCustomerId) exactPhoneMatch = match;
    }

    let exactEmailMatch = null;
    if (normalizedEmail) {
      const match = await ctx.db
        .query("customers")
        .withIndex("by_org_email", (q) => q.eq("orgId", args.orgId).eq("email", normalizedEmail))
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .unique();
      if (match && match._id !== args.excludeCustomerId) exactEmailMatch = match;
    }

    let possibleNameMatches: Doc<"customers">[] = [];
    if (args.firstName?.trim() && args.lastName?.trim()) {
      const candidates = await ctx.db
        .query("customers")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .take(50);
      possibleNameMatches = candidates.filter(
        (c) =>
          c._id !== args.excludeCustomerId &&
          namesSimilar(c.firstName, args.firstName!) &&
          namesSimilar(c.lastName, args.lastName!)
      );
    }

    return { exactPhoneMatch, exactEmailMatch, possibleNameMatches };
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Creates a new customer record in the organization.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    firstName: v.string(),
    lastName: v.string(),
    phone: v.optional(v.string()),
    whatsapp: v.optional(v.string()),
    email: v.optional(v.string()),
    nationalId: v.optional(v.string()),
    address: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const statusLimit = await rateLimiter.limit(ctx, "create");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_CUSTOMERS]);

    validateInput(CreateCustomerSchema, args);

    const normalizedEmail = args.email?.toLowerCase().trim() || undefined;
    const normalizedPhone = args.phone?.trim() ? normalizePhone(args.phone) : undefined;

    // If email is provided, check for duplicates within the org
    if (normalizedEmail) {
      const existing = await ctx.db
        .query("customers")
        .withIndex("by_org_email", (q) =>
          q.eq("orgId", args.orgId).eq("email", normalizedEmail)
        )
        .unique();

      if (existing) {
        throw new ConvexError(
          `A customer with email "${normalizedEmail}" already exists in this organization.`
        );
      }
    }

    // If phone is provided, check for duplicates within the org (phone is the
    // more reliable identifier in this market, so it gets the same hard block as email)
    if (normalizedPhone) {
      const existingByPhone = await ctx.db
        .query("customers")
        .withIndex("by_org_phone", (q) =>
          q.eq("orgId", args.orgId).eq("phone", normalizedPhone)
        )
        .unique();

      if (existingByPhone) {
        throw new ConvexError(
          `A customer with phone "${normalizedPhone}" already exists in this organization.`
        );
      }
    }

    const id = await ctx.db.insert("customers", {
      orgId: args.orgId,
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      phone: normalizedPhone,
      whatsapp: args.whatsapp?.trim(),
      email: normalizedEmail,
      nationalId: args.nationalId?.trim(),
      address: args.address?.trim(),
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "New Customer Added",
      `${actorName} added a new customer: ${args.firstName.trim()} ${args.lastName.trim()}`,
      `/${args.orgId}/customers?highlightId=${id}`
    );

    return id;
  },
});

/**
 * Updates an existing customer's details.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    phone: v.optional(v.string()),
    whatsapp: v.optional(v.string()),
    email: v.optional(v.string()),
    nationalId: v.optional(v.string()),
    address: v.optional(v.string()),
    employment: v.optional(
      v.object({
        employer: v.string(),
        title: v.optional(v.string()),
        salary: v.number(),
        hireDate: v.optional(v.number()),
      })
    ),
    financials: v.optional(
      v.object({
        totalMonthlyDebt: v.number(),
        dbr: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const statusLimit = await rateLimiter.limit(ctx, "standardApi");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_CUSTOMERS]);

    validateInput(UpdateCustomerSchema, args);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.isDeleted || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    // If email is being changed, check for duplicates
    if (args.email !== undefined) {
      const normalizedEmail = args.email.toLowerCase().trim();
      if (normalizedEmail !== customer.email) {
        const existing = await ctx.db
          .query("customers")
          .withIndex("by_org_email", (q) =>
            q.eq("orgId", args.orgId).eq("email", normalizedEmail)
          )
          .unique();

        if (existing) {
          throw new ConvexError(
            `A customer with email "${normalizedEmail}" already exists in this organization.`
          );
        }
      }
    }

    // If phone is being changed, check for duplicates
    if (args.phone !== undefined) {
      const normalizedPhone = args.phone.trim() ? normalizePhone(args.phone) : "";
      if (normalizedPhone && normalizedPhone !== customer.phone) {
        const existingByPhone = await ctx.db
          .query("customers")
          .withIndex("by_org_phone", (q) =>
            q.eq("orgId", args.orgId).eq("phone", normalizedPhone)
          )
          .unique();

        if (existingByPhone) {
          throw new ConvexError(
            `A customer with phone "${normalizedPhone}" already exists in this organization.`
          );
        }
      }
    }

    const patch: Record<string, unknown> = {};
    if (args.firstName !== undefined) patch.firstName = args.firstName.trim();
    if (args.lastName !== undefined) patch.lastName = args.lastName.trim();
    if (args.phone !== undefined) patch.phone = args.phone.trim() ? normalizePhone(args.phone) : undefined;
    if (args.whatsapp !== undefined) patch.whatsapp = args.whatsapp.trim();
    if (args.email !== undefined) patch.email = args.email.toLowerCase().trim();
    if (args.nationalId !== undefined) patch.nationalId = args.nationalId.trim();
    if (args.address !== undefined) patch.address = args.address.trim();
    if (args.employment !== undefined) patch.employment = args.employment;
    if (args.financials !== undefined) patch.financials = args.financials;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.customerId, patch);

      const actorName = await getActorName(ctx);
      await notifyManagers(
        ctx,
        args.orgId,
        "Customer Updated",
        `${actorName} updated details for ${customer.firstName} ${customer.lastName}`,
        `/${args.orgId}/customers?highlightId=${args.customerId}`
      );
    }
  },
});

/**
 * Soft deletes a customer. Fails if the customer has any associated leads or sales.
 */
// TODO: Add admin recovery endpoint if needed
export const softDelete = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    const statusLimit = await rateLimiter.limit(ctx, "standardApi");
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_CUSTOMERS]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.isDeleted || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    // Check for associated leads
    const lead = await ctx.db
      .query("leads")
      .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
      .first();

    if (lead && !lead.isDeleted) {
      throw new ConvexError(
        "Cannot delete this customer — they have associated leads. Delete the leads first."
      );
    }

    // Check for associated sales
    const sale = await ctx.db
      .query("sales")
      .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
      .first();

    if (sale && !sale.isDeleted) {
      throw new ConvexError(
        "Cannot delete this customer — they have associated sales records."
      );
    }

    await ctx.db.patch(args.customerId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "Customer Deleted",
      `${actorName} deleted customer ${customer.firstName} ${customer.lastName}`
    );
  },
});

export const getRelations = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);

    // 1. Fetch Sales
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("customerId"), args.customerId))
      .collect();

    const enrichedSales = await Promise.all(
      sales.map(async (sale) => {
        const vehicle = await ctx.db.get(sale.vehicleId);
        const salesperson = await ctx.db.get(sale.salespersonId);
        return {
          ...sale,
          vehicleDesc: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
        };
      })
    );

    // 2. Fetch Leads
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("customerId"), args.customerId))
      .collect();

    const enrichedLeads = await Promise.all(
      leads.map(async (lead) => {
        const vehicle = lead.vehicleId ? await ctx.db.get(lead.vehicleId) : null;
        const assignedUser = lead.assignedUserId ? await ctx.db.get(lead.assignedUserId) : null;
        return {
          ...lead,
          vehicleDesc: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Any",
          assignedUserName: assignedUser && "name" in assignedUser ? assignedUser.name : "Unassigned",
        };
      })
    );

    // 3. Fetch Tasks
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("customerId"), args.customerId))
      .collect();

    const enrichedTasks = await Promise.all(
      tasks.map(async (task) => {
        const assignedUser = await ctx.db.get(task.assignedTo);
        return {
          ...task,
          assignedUserName: assignedUser && "name" in assignedUser ? assignedUser.name : "Unknown",
        };
      })
    );

    // 4. Fetch Quotes
    const quotes = await ctx.db
      .query("quotes")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .collect();

    const enrichedQuotes = await Promise.all(
      quotes.map(async (quote) => {
        const vehicle = await ctx.db.get(quote.vehicleId);
        const company = quote.companyId ? await ctx.db.get(quote.companyId) : null;
        const createdByUser = await ctx.db.get(quote.createdBy);
        return {
          ...quote,
          vehicle: vehicle ?? null,
          vehicleDesc: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          companyName: company ? company.name : "Cash Deal",
          createdByUserName: createdByUser && "name" in createdByUser ? createdByUser.name : "Unknown",
        };
      })
    );

    return {
      sales: enrichedSales.sort((a, b) => b.saleDate - a.saleDate),
      leads: enrichedLeads.sort((a, b) => b._creationTime - a._creationTime),
      tasks: enrichedTasks.sort((a, b) => a.dueDate - b.dueDate),
      quotes: enrichedQuotes.sort((a, b) => b.createdAt - a.createdAt),
    };
  },
});

export const importBulk = mutation({
  args: {
    orgId: v.id("organizations"),
    customers: v.array(v.object({
      firstName: v.string(),
      lastName: v.string(),
      phone: v.optional(v.string()),
      whatsapp: v.optional(v.string()),
      email: v.optional(v.string()),
      nationalId: v.optional(v.string()),
      address: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_CUSTOMERS]);

    let inserted = 0;
    let skipped = 0;

    for (const row of args.customers) {
      const normalizedEmail = row.email?.toLowerCase().trim() || undefined;
      const normalizedPhone = row.phone?.trim() ? normalizePhone(row.phone) : undefined;

      if (normalizedEmail) {
        const existing = await ctx.db
          .query("customers")
          .withIndex("by_org_email", (q) => q.eq("orgId", args.orgId).eq("email", normalizedEmail))
          .unique();
        if (existing) { skipped++; continue; }
      }

      if (normalizedPhone) {
        const existingByPhone = await ctx.db
          .query("customers")
          .withIndex("by_org_phone", (q) => q.eq("orgId", args.orgId).eq("phone", normalizedPhone))
          .unique();
        if (existingByPhone) { skipped++; continue; }
      }

      await ctx.db.insert("customers", {
        orgId: args.orgId,
        firstName: row.firstName.trim(),
        lastName: row.lastName.trim(),
        phone: normalizedPhone,
        whatsapp: row.whatsapp?.trim(),
        email: normalizedEmail,
        nationalId: row.nationalId?.trim(),
        address: row.address?.trim(),
      });
      inserted++;
    }

    return { inserted, skipped };
  },
});

// ─── Merge tool (Phase 19a) ─────────────────────────────────────────────────
// Scoped to customers only — a duplicate lead is just two pipeline entries
// for the same customer, not worth a separate merge engine. One explicit,
// auditable mutation rather than a generic/reflective merge framework,
// mirroring the explicit ORG_SCOPED_TABLES list pattern in adminOrgs.ts.

/**
 * Groups customers in the org by normalized first+last name to surface
 * likely-duplicate clusters for the merge tool. Bounded scan — this powers
 * an occasional review screen, not a live list.
 */
export const findMergeCandidates = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MERGE_CUSTOMERS]);

    const customers = await ctx.db
      .query("customers")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .take(500);

    const groups = new Map<string, Doc<"customers">[]>();
    for (const customer of customers) {
      const first = customer.firstName.trim();
      const last = customer.lastName.trim();
      if (!first || !last) continue;
      const key = `${first.toLowerCase()}|${last.toLowerCase()}`;
      const existing = groups.get(key);
      if (existing) {
        existing.push(customer);
      } else {
        groups.set(key, [customer]);
      }
    }

    return Array.from(groups.values())
      .filter((group) => group.length > 1)
      .map((group) => ({
        firstName: group[0].firstName,
        lastName: group[0].lastName,
        customers: group.map((c) => ({
          _id: c._id,
          _creationTime: c._creationTime,
          phone: c.phone,
          email: c.email,
        })),
      }));
  },
});

/**
 * Returns per-table reassignment counts for a prospective merge, so the UI
 * can show the impact before the user confirms a destructive action.
 */
export const previewMerge = query({
  args: {
    orgId: v.id("organizations"),
    survivorId: v.id("customers"),
    loserId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MERGE_CUSTOMERS]);

    if (args.survivorId === args.loserId) {
      throw new ConvexError("Cannot merge a customer with itself.");
    }

    const survivor = await ctx.db.get(args.survivorId);
    if (!survivor || survivor.isDeleted || survivor.orgId !== args.orgId) {
      throw new ConvexError("Survivor customer not found in this organization.");
    }
    const loser = await ctx.db.get(args.loserId);
    if (!loser || loser.isDeleted || loser.orgId !== args.orgId) {
      throw new ConvexError("Customer to merge not found in this organization.");
    }

    const reassignedCounts: Record<string, number> = {};
    for (const ref of CUSTOMER_REFERENCING_TABLES) {
      const rows = await ref.find(ctx, args.orgId, args.loserId);
      reassignedCounts[ref.table] = rows.length;
    }

    return { survivor, loser, reassignedCounts };
  },
});

/**
 * Merges `loserId` into `survivorId`: reassigns every FK in
 * CUSTOMER_REFERENCING_TABLES to the survivor, fills any blank survivor
 * scalar fields from the loser (or from `fieldOverrides` if the caller
 * picked a specific value per field), soft-deletes the loser, and writes an
 * audit row. Requires PERMISSIONS.MERGE_CUSTOMERS — destructive, so OWNER
 * by default with MANAGER opted in via the default role template.
 */
export const mergeCustomers = mutation({
  args: {
    orgId: v.id("organizations"),
    survivorId: v.id("customers"),
    loserId: v.id("customers"),
    fieldOverrides: v.optional(
      v.object({
        firstName: v.optional(v.string()),
        lastName: v.optional(v.string()),
        phone: v.optional(v.string()),
        whatsapp: v.optional(v.string()),
        email: v.optional(v.string()),
        nationalId: v.optional(v.string()),
        address: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MERGE_CUSTOMERS]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");

    if (args.survivorId === args.loserId) {
      throw new ConvexError("Cannot merge a customer with itself.");
    }

    const survivor = await ctx.db.get(args.survivorId);
    if (!survivor || survivor.isDeleted || survivor.orgId !== args.orgId) {
      throw new ConvexError("Survivor customer not found in this organization.");
    }
    const loser = await ctx.db.get(args.loserId);
    if (!loser || loser.isDeleted || loser.orgId !== args.orgId) {
      throw new ConvexError("Customer to merge not found in this organization.");
    }

    const fieldKeys = ["firstName", "lastName", "phone", "whatsapp", "email", "nationalId", "address"] as const;
    const mergedFields: Record<string, string> = {};
    for (const key of fieldKeys) {
      const override = args.fieldOverrides?.[key];
      if (override !== undefined) {
        mergedFields[key] = override;
      } else if (!survivor[key] && loser[key]) {
        mergedFields[key] = loser[key]!;
      }
    }

    // Don't let the merge violate the phone/email hard-uniqueness constraint
    // against some unrelated third customer — drop the field instead.
    if (mergedFields.phone) {
      const normalizedPhone = normalizePhone(mergedFields.phone);
      const existing = await ctx.db
        .query("customers")
        .withIndex("by_org_phone", (q) => q.eq("orgId", args.orgId).eq("phone", normalizedPhone))
        .unique();
      if (existing && existing._id !== survivor._id && existing._id !== loser._id) {
        delete mergedFields.phone;
      } else {
        mergedFields.phone = normalizedPhone;
      }
    }
    if (mergedFields.email) {
      const normalizedEmail = mergedFields.email.toLowerCase().trim();
      const existing = await ctx.db
        .query("customers")
        .withIndex("by_org_email", (q) => q.eq("orgId", args.orgId).eq("email", normalizedEmail))
        .unique();
      if (existing && existing._id !== survivor._id && existing._id !== loser._id) {
        delete mergedFields.email;
      } else {
        mergedFields.email = normalizedEmail;
      }
    }

    if (Object.keys(mergedFields).length > 0) {
      await ctx.db.patch(survivor._id, mergedFields);
    }

    const reassignedCounts: Record<string, number> = {};
    for (const ref of CUSTOMER_REFERENCING_TABLES) {
      const rows = await ref.find(ctx, args.orgId, args.loserId);
      for (const row of rows) {
        await ctx.db.patch(row._id, { customerId: args.survivorId });
      }
      reassignedCounts[ref.table] = rows.length;
    }

    await ctx.db.patch(loser._id, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject,
    });

    await ctx.db.insert("customerMerges", {
      orgId: args.orgId,
      survivorId: survivor._id,
      loserId: loser._id,
      mergedBy: user._id,
      mergedAt: Date.now(),
      reassignedCounts,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "Customers Merged",
      `${actorName} merged "${loser.firstName} ${loser.lastName}" into "${survivor.firstName} ${survivor.lastName}".`,
      `/${args.orgId}/customers?highlightId=${survivor._id}`
    );

    return { survivorId: survivor._id, reassignedCounts };
  },
});
