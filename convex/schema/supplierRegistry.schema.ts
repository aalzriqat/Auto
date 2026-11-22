import { defineTable } from "convex/server";
import { v } from "convex/values";

export const supplierRegistryTables = {
  // ─── Supplier master (SCRUM-868 S1) ─────────────────────────────────────
  //
  // Identity only. A supplier row carries no amount, balance, currency or ledger
  // dimension: party figures stay in the subledgers and the GL (invariant I12, and
  // `scripts/supplierMasterGuards.test.ts` fails on a money-shaped field). Nothing
  // consumes these tables yet; S1 creates them, S2 onwards links money rows to them.
  //
  // Every write goes through `withRegistryLock` (`utils/supplierRegistry.ts`), which
  // reads and bumps the organization's single `supplierRegistryState` document.
  // Convex has no unique index, so uniqueness of a legal identity cannot be a
  // database constraint; the lock document makes concurrent writers conflict under
  // OCC instead (https://docs.convex.dev/database/advanced/occ).
  suppliers: defineTable({
    orgId: v.id("organizations"),
    displayName: v.string(),
    /** `normalizeNameKey(displayName)`: candidate lookup only, never identity. */
    displayNameKey: v.string(),
    legalName: v.optional(v.string()),
    status: v.union(v.literal("ACTIVE"), v.literal("INACTIVE")),
    contact: v.optional(
      v.object({
        phone: v.optional(v.string()),
        email: v.optional(v.string()),
        address: v.optional(v.string()),
      }),
    ),
    taxId: v.optional(v.string()),
    /** `normalizeTaxIdKey(taxId)`. Present exactly when `taxId` is. */
    taxIdKey: v.optional(v.string()),
    /** ISO 3166-1 alpha-2 country code (upper-case, alpha-2 only, no subdivision) the tax id was issued in. */
    taxJurisdiction: v.optional(v.string()),
    /** A second branch of one legal entity: the supplier it shares the legal identity with. */
    sharedLegalIdentityOf: v.optional(v.id("suppliers")),
    sharedLegalIdentityReason: v.optional(v.string()),
    /** Bumped by every change to a snapshot field (name, legal name, tax identity). */
    version: v.number(),
    /**
     * The edit token (SCRUM-887): raised by EVERY successful `suppliers.update`, contact and shared-
     * identity link included, so `expectedVersion` protects every field the screen writes (the
     * strong-validator rule of RFC 9110 section 13: the token must change whenever the
     * representation does). Absent on a row never updated since this field was added; the token is
     * then `version`. A money record never reads it: records snapshot `version` only.
     */
    editRevision: v.optional(v.number()),
    origin: v.union(v.literal("MANUAL"), v.literal("MIGRATION"), v.literal("IMPORT")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
    deactivatedBy: v.optional(v.id("users")),
    deactivatedAt: v.optional(v.number()),
    deactivatedReason: v.optional(v.string()),
  })
    .index("by_org_and_status", ["orgId", "status"])
    .index("by_org_and_displayNameKey", ["orgId", "displayNameKey"])
    .index("by_org_and_taxJurisdiction_and_taxIdKey", ["orgId", "taxJurisdiction", "taxIdKey"])
    // Added beyond the design's list: a tax id typed with no jurisdiction, or a
    // different one, is only a soft candidate and must still be found by key alone.
    .index("by_org_and_taxIdKey", ["orgId", "taxIdKey"])
    // Finds the suppliers that share a legal identity with a given one, so its identity
    // cannot change underneath them.
    .index("by_org_and_sharedLegalIdentityOf", ["orgId", "sharedLegalIdentityOf"])
    .searchIndex("search_displayName", { searchField: "displayName", filterFields: ["orgId", "status"] }),

  supplierAliases: defineTable({
    orgId: v.id("organizations"),
    supplierId: v.id("suppliers"),
    alias: v.string(),
    /** `normalizeNameKey(alias)`. An alias hit is a candidate, never a binding. */
    aliasKey: v.string(),
    source: v.union(v.literal("MANUAL"), v.literal("MIGRATION"), v.literal("IMPORT")),
    status: v.union(v.literal("ACTIVE"), v.literal("RETIRED")),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    // Status is part of the key so the bounded candidate and search reads see ACTIVE rows only:
    // retired rows are kept for history and must not crowd active ones out of a `.take(n)`.
    .index("by_org_and_aliasKey_and_status", ["orgId", "aliasKey", "status"])
    .index("by_org_and_supplierId", ["orgId", "supplierId"]),

  // Exactly one row per organization: the registry lock document.
  supplierRegistryState: defineTable({
    orgId: v.id("organizations"),
    version: v.number(),
  }).index("by_org", ["orgId"]),
};
