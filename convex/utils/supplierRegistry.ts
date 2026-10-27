import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireOwnedRow } from "./tenancy";

/**
 * The supplier registry lock (SCRUM-868 S1).
 *
 * WHY A LOCK DOCUMENT. Convex has no unique index, so "one legal identity per organization"
 * and "the candidate list I checked is still the candidate list" cannot be database
 * constraints. Convex OCC is serializable: a transaction commits only if every record version
 * in its read set is still the latest, and a conflicting one re-runs
 * (https://docs.convex.dev/database/advanced/occ). The documentation says nothing about
 * range-read or phantom-insert behaviour, so no check here relies on a range read to serialise a
 * duplicate check. Instead every supplier or alias write reads, and then patches, ONE document per
 * organization (`supplierRegistryState`). Two concurrent writers both read version n; one
 * conflicts and re-runs against a snapshot that includes the other writer's row.
 * `convex-test` serializes everything, so this is argued from the documented read set; it is
 * not demonstrated by any test.
 *
 * LOCK COVERAGE IS A COMPILE-TIME PROPERTY. The write helpers below take a `RegistryLock`, a
 * branded value only `withRegistryLock` mints, and `scripts/supplierMasterGuards.test.ts` fails on
 * any insert or patch of `suppliers` or `supplierAliases` outside a function that holds one, on a
 * forged lock, and on any delete.
 */

export const SUPPLIER_ERROR = {
  REGISTRY_NOT_INITIALISED: "REGISTRY_NOT_INITIALISED",
  REGISTRY_CORRUPT: "REGISTRY_CORRUPT",
  LEGAL_IDENTITY_EXISTS: "SUPPLIER_LEGAL_IDENTITY_EXISTS",
  DUPLICATE_CANDIDATES: "SUPPLIER_DUPLICATE_CANDIDATES",
  SHARED_IDENTITY_MISMATCH: "SUPPLIER_SHARED_IDENTITY_MISMATCH",
  REASON_REQUIRED: "SUPPLIER_REASON_REQUIRED",
  VERSION_CONFLICT: "SUPPLIER_VERSION_CONFLICT",
  IDEMPOTENCY_CONFLICT: "SUPPLIER_IDEMPOTENCY_CONFLICT",
  INACTIVE: "SUPPLIER_INACTIVE",
  ALREADY_INACTIVE: "SUPPLIER_ALREADY_INACTIVE",
  ALREADY_ACTIVE: "SUPPLIER_ALREADY_ACTIVE",
  INVALID_INPUT: "SUPPLIER_INVALID_INPUT",
  NO_CHANGE: "SUPPLIER_NO_CHANGE",
  ALIAS_EXISTS: "SUPPLIER_ALIAS_EXISTS",
  ALIAS_LIMIT: "SUPPLIER_ALIAS_LIMIT",
  ALIAS_ALREADY_RETIRED: "SUPPLIER_ALIAS_ALREADY_RETIRED",
} as const;
export type SupplierErrorCode = (typeof SUPPLIER_ERROR)[keyof typeof SUPPLIER_ERROR];

/** Same message for a missing and a foreign id: no existence oracle (TEN-1, invariant I2). */
export const SUPPLIER_NOT_FOUND_MESSAGE = "Supplier not found.";
export const SUPPLIER_ALIAS_NOT_FOUND_MESSAGE = "Supplier alias not found.";
const GENERIC_ERROR_MESSAGE = "An unexpected error occurred. Please try again later.";

export function throwSupplierError(
  code: SupplierErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new ConvexError({ code, message, ...extra });
}

/**
 * Runs a handler body. Domain refusals (ConvexError) pass through with their stable code; any
 * other failure is logged in full server-side and surfaces as one generic message. It always
 * rethrows: a caught exception would COMMIT the partial writes before it.
 */
export async function runGuarded<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    console.error(error);
    throw new ConvexError(GENERIC_ERROR_MESSAGE);
  }
}

declare const registryLockBrand: unique symbol;
/** Proof that the caller is inside `withRegistryLock` for `orgId`. Only that function mints it. */
export type RegistryLock = {
  readonly [registryLockBrand]: true;
  readonly orgId: Id<"organizations">;
};

async function readRegistryState(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
): Promise<Doc<"supplierRegistryState"> | null> {
  const rows = await ctx.db
    .query("supplierRegistryState")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(2);
  if (rows.length > 1) {
    // Two lock documents would let two writers each bump their own: fail closed.
    throwSupplierError(SUPPLIER_ERROR.REGISTRY_CORRUPT, "The supplier registry is in an inconsistent state.");
  }
  return rows[0] ?? null;
}

/** Creates the organization's registry document if it has none. Safe to call repeatedly. */
export async function ensureRegistryState(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
): Promise<{ created: boolean }> {
  if (await readRegistryState(ctx, orgId)) return { created: false };
  await ctx.db.insert("supplierRegistryState", { orgId, version: 0 });
  return { created: true };
}

/**
 * Reads the organization's registry document, runs `fn`, then bumps the document's version by
 * one. If `fn` throws, the whole mutation rolls back, the bump included.
 */
export async function withRegistryLock<T>(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  fn: (lock: RegistryLock) => Promise<T>,
): Promise<T> {
  const state = await readRegistryState(ctx, orgId);
  if (!state) {
    throwSupplierError(
      SUPPLIER_ERROR.REGISTRY_NOT_INITIALISED,
      "The supplier registry has not been initialised for this organization.",
    );
  }
  const lock = { orgId } as RegistryLock;
  const result = await fn(lock);
  await ctx.db.patch("supplierRegistryState", state._id, { version: state.version + 1 });
  return result;
}

// ─── Write helpers: the only places that touch `suppliers` and `supplierAliases` ──────────────

type SupplierInsert = Omit<Doc<"suppliers">, "_id" | "_creationTime">;
type SupplierPatch = Partial<Omit<Doc<"suppliers">, "_id" | "_creationTime" | "orgId">>;
type AliasInsert = Omit<Doc<"supplierAliases">, "_id" | "_creationTime">;
type AliasPatch = Partial<Pick<Doc<"supplierAliases">, "status">>;

function assertLockMatches(lock: RegistryLock, orgId: Id<"organizations">): void {
  if (lock.orgId !== orgId) {
    throwSupplierError(SUPPLIER_ERROR.INVALID_INPUT, "The registry lock belongs to a different organization.");
  }
}

export async function insertSupplier(
  ctx: MutationCtx,
  lock: RegistryLock,
  row: SupplierInsert,
): Promise<Id<"suppliers">> {
  assertLockMatches(lock, row.orgId);
  return ctx.db.insert("suppliers", row);
}

export async function patchSupplier(
  ctx: MutationCtx,
  lock: RegistryLock,
  supplier: Doc<"suppliers">,
  patch: SupplierPatch,
): Promise<void> {
  assertLockMatches(lock, supplier.orgId);
  await ctx.db.patch("suppliers", supplier._id, patch);
}

export async function insertSupplierAlias(
  ctx: MutationCtx,
  lock: RegistryLock,
  row: AliasInsert,
): Promise<Id<"supplierAliases">> {
  assertLockMatches(lock, row.orgId);
  return ctx.db.insert("supplierAliases", row);
}

export async function patchSupplierAlias(
  ctx: MutationCtx,
  lock: RegistryLock,
  alias: Doc<"supplierAliases">,
  patch: AliasPatch,
): Promise<void> {
  assertLockMatches(lock, alias.orgId);
  await ctx.db.patch("supplierAliases", alias._id, patch);
}

// ─── Reads shared with later slices ───────────────────────────────────────────────────────────

/**
 * A supplier of `orgId` that may take NEW use. A foreign id and a missing id are refused with the
 * same not-found error; an inactive supplier is refused with a coded error. Existing references
 * to an inactive supplier keep resolving through ordinary reads.
 */
export async function requireActiveSupplier(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  supplierId: Id<"suppliers">,
): Promise<Doc<"suppliers">> {
  const supplier = await requireOwnedRow(ctx, orgId, "suppliers", supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
  if (supplier.status !== "ACTIVE") {
    throwSupplierError(SUPPLIER_ERROR.INACTIVE, "This supplier is inactive and cannot be used for new records.");
  }
  return supplier;
}

// ─── Duplicate detection (read-only; callers run it inside the lock) ──────────────────────────

/** Per-source read bound and the cap on the candidate list a caller must confirm. */
export const CANDIDATE_CAP = 20;
const READ_BOUND = CANDIDATE_CAP + 1;

export type CandidateReason = "SAME_NAME" | "ALIAS" | "CLOSE_NAME" | "TAX_ID";
export interface SupplierCandidate {
  supplierId: Id<"suppliers">;
  displayName: string;
  status: Doc<"suppliers">["status"];
  reasons: CandidateReason[];
}

/** Suppliers of the org with the same jurisdiction and tax key: the hard legal-identity match. */
export async function findLegalIdentityMatches(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  identity: { taxJurisdiction: string; taxIdKey: string },
  excludeSupplierId?: Id<"suppliers">,
): Promise<Doc<"suppliers">[]> {
  const rows = await ctx.db
    .query("suppliers")
    .withIndex("by_org_and_taxJurisdiction_and_taxIdKey", (q) =>
      q.eq("orgId", orgId).eq("taxJurisdiction", identity.taxJurisdiction).eq("taxIdKey", identity.taxIdKey),
    )
    .take(3);
  return rows.filter((row) => row._id !== excludeSupplierId);
}

/**
 * Refuses a second supplier with the same complete legal identity (tax id and jurisdiction). An
 * incomplete identity has no hard match, so it returns without reading. Callers run it inside the
 * lock and skip it when the supplier declares a shared legal identity.
 */
export async function requireNoLegalIdentityDuplicate(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  identity: { taxJurisdiction?: string; taxIdKey?: string },
  excludeSupplierId?: Id<"suppliers">,
): Promise<void> {
  if (identity.taxIdKey === undefined || identity.taxJurisdiction === undefined) return;
  const [existing] = await findLegalIdentityMatches(
    ctx,
    orgId,
    { taxJurisdiction: identity.taxJurisdiction, taxIdKey: identity.taxIdKey },
    excludeSupplierId,
  );
  if (existing) {
    throwSupplierError(
      SUPPLIER_ERROR.LEGAL_IDENTITY_EXISTS,
      "A supplier with this tax id and jurisdiction already exists.",
      { existingSupplierId: existing._id },
    );
  }
}

/**
 * The candidates a new or renamed supplier must be confirmed distinct from: same name key, an
 * active alias hit, a close name (one key is a whole-word prefix of the other), and a soft tax-id
 * match (same key, jurisdiction missing or different). A hard legal-identity match is not a
 * candidate; the caller refuses it before getting here. Sorted by id and capped, so the list is
 * deterministic.
 */
export async function findSupplierCandidates(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  probe: {
    nameKey: string;
    taxIdKey?: string;
    taxJurisdiction?: string;
    excludeSupplierId?: Id<"suppliers">;
  },
): Promise<SupplierCandidate[]> {
  const found = new Map<Id<"suppliers">, { doc: Doc<"suppliers">; reasons: Set<CandidateReason> }>();
  const note = (doc: Doc<"suppliers"> | null, reason: CandidateReason): void => {
    if (!doc || doc.orgId !== orgId || doc._id === probe.excludeSupplierId) return;
    const entry = found.get(doc._id) ?? { doc, reasons: new Set<CandidateReason>() };
    entry.reasons.add(reason);
    found.set(doc._id, entry);
  };
  const byNameKey = (key: string) =>
    ctx.db
      .query("suppliers")
      .withIndex("by_org_and_displayNameKey", (q) => q.eq("orgId", orgId).eq("displayNameKey", key))
      .take(READ_BOUND);

  for (const doc of await byNameKey(probe.nameKey)) note(doc, "SAME_NAME");

  const aliasHits = await ctx.db
    .query("supplierAliases")
    .withIndex("by_org_and_aliasKey", (q) => q.eq("orgId", orgId).eq("aliasKey", probe.nameKey))
    .take(READ_BOUND);
  const aliased = await Promise.all(
    aliasHits.filter((alias) => alias.status === "ACTIVE").map((alias) => ctx.db.get(alias.supplierId)),
  );
  for (const doc of aliased) note(doc, "ALIAS");

  // Close names: every proper whole-word prefix of the new key that is an existing key, and every
  // existing key that starts with the new key followed by a space. The prefix reads are independent,
  // so they run together; the result is sorted by id, so completion order does not matter.
  const tokens = probe.nameKey.split(" ");
  const prefixes = tokens.slice(0, -1).map((_, i) => tokens.slice(0, i + 1).join(" "));
  for (const docs of await Promise.all(prefixes.map(byNameKey))) {
    for (const doc of docs) note(doc, "CLOSE_NAME");
  }
  const longer = await ctx.db
    .query("suppliers")
    .withIndex("by_org_and_displayNameKey", (q) =>
      q.eq("orgId", orgId).gte("displayNameKey", `${probe.nameKey} `).lt("displayNameKey", `${probe.nameKey}!`),
    )
    .take(READ_BOUND);
  for (const doc of longer) note(doc, "CLOSE_NAME");

  if (probe.taxIdKey) {
    const taxKey = probe.taxIdKey;
    const sameKey = await ctx.db
      .query("suppliers")
      .withIndex("by_org_and_taxIdKey", (q) => q.eq("orgId", orgId).eq("taxIdKey", taxKey))
      .take(READ_BOUND);
    for (const doc of sameKey) {
      const hardMatch =
        probe.taxJurisdiction !== undefined && doc.taxJurisdiction !== undefined && doc.taxJurisdiction === probe.taxJurisdiction;
      if (!hardMatch) note(doc, "TAX_ID");
    }
  }

  return [...found.values()]
    .sort((a, b) => (a.doc._id < b.doc._id ? -1 : a.doc._id > b.doc._id ? 1 : 0))
    .slice(0, CANDIDATE_CAP)
    .map(({ doc, reasons }) => ({
      supplierId: doc._id,
      displayName: doc.displayName,
      status: doc.status,
      reasons: [...reasons].sort(),
    }));
}
