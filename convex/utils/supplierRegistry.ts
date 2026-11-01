import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { codeUnitCompare, normalizeNameKey } from "./supplierNames";
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
 * LOCK COVERAGE IS ENFORCED BY A TYPE PLUS A TYPE-AWARE TEST, NOT BY THE COMPILER ALONE. The write
 * helpers below take a `RegistryLock`, a branded value only `withRegistryLock` mints. The compiler
 * cannot stop a caller from writing the table directly, or from casting a lock into place, so
 * `scripts/supplierMasterGuards.test.ts` builds a TypeScript program over `convex/` and fails on
 * any insert, patch or replace of `suppliers` or `supplierAliases` outside a function that holds a
 * lock (the table is read from a literal or from the `Id<"suppliers">` type), on a lock passed to a
 * lock-taking helper that is cast, `any` or not a `RegistryLock`, on a cast to `RegistryLock`, on any
 * delete, and on table-generic access outside two named modules. It does not prove what it cannot
 * see: a table erased to `string` or `any`, or a lock reached through an indirect call. The test's
 * header says exactly what is and is not proven.
 */

export const SUPPLIER_ERROR = {
  REGISTRY_NOT_INITIALISED: "REGISTRY_NOT_INITIALISED",
  REGISTRY_CORRUPT: "REGISTRY_CORRUPT",
  LEGAL_IDENTITY_EXISTS: "SUPPLIER_LEGAL_IDENTITY_EXISTS",
  DUPLICATE_CANDIDATES: "SUPPLIER_DUPLICATE_CANDIDATES",
  CANDIDATES_OVER_CAP: "SUPPLIER_CANDIDATES_OVER_CAP",
  SHARED_IDENTITY_MISMATCH: "SUPPLIER_SHARED_IDENTITY_MISMATCH",
  SHARED_IDENTITY_IN_USE: "SUPPLIER_SHARED_IDENTITY_IN_USE",
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
  /** A foreign-organisation id and a missing id both land here, with one message (no existence oracle). */
  NOT_FOUND: "SUPPLIER_NOT_FOUND",
  /** SCRUM-868 P1: a pilot write path that needs a supplier was called without one. No name fallback. */
  IDENTITY_REQUIRED: "SUPPLIER_IDENTITY_REQUIRED",
  /** SCRUM-868 P1: an action on an existing record that carries no supplier id (old or name-only row). */
  IDENTITY_UNRESOLVED: "SUPPLIER_IDENTITY_UNRESOLVED",
  /** SCRUM-868 P2 (N11): a vehicle's supplier link cannot change once money exists against it. */
  LINK_FROZEN: "SUPPLIER_LINK_FROZEN",
  /** SCRUM-868 P2 (N9): a supplier id was sent in a role the vehicle's shape does not have. */
  ROLE_CONFLICT: "SUPPLIER_ROLE_CONFLICT",
  /**
   * SCRUM-868 P3 round 2: a supplier concession recorded before supplier ids existed, not yet bound to its
   * supplier. Distinct from a stale basis because the remedy differs: re-recording is impossible after
   * handover, and the release repair or a reviewed correction is the step that exists.
   */
  CONCESSION_BASIS_UNBOUND: "SUPPLIER_CONCESSION_BASIS_UNBOUND",
  /**
   * SCRUM-868 P4/P5 round 4: a consignment vehicle with money and no supplier link takes its FIRST link only
   * from a caller who holds manage:finance. Refused here, never silently downgraded to the frozen refusal,
   * so the user is told which role can do it.
   */
  FIRST_LINK_NEEDS_FINANCE_MANAGER: "SUPPLIER_FIRST_LINK_NEEDS_FINANCE_MANAGER",
  /** SCRUM-868 P4/P5 round 4: the picked supplier is not confirmed by the names stored on the vehicle and its money rows. */
  FIRST_LINK_NOT_PROVEN: "SUPPLIER_FIRST_LINK_NOT_PROVEN",
} as const;
export type SupplierErrorCode = (typeof SUPPLIER_ERROR)[keyof typeof SUPPLIER_ERROR];

/** Same message for a missing and a foreign id: no existence oracle (TEN-1, invariant I2). */
export const SUPPLIER_NOT_FOUND_MESSAGE = "Supplier not found.";
export const SUPPLIER_ALIAS_NOT_FOUND_MESSAGE = "Supplier alias not found.";
/** English equals the dictionary entry under ServerError_<code> (lib/i18n/domains/common.ts). */
export const SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE =
  "Supplier identity is unresolved for this record. Check that the vehicle is linked to the right supplier. If the vehicle has no supplier, a finance manager can link it on the vehicle edit screen; the record is then linked to that supplier by the next supplier identity repair, which runs with every release.";
export const SUPPLIER_CONCESSION_BASIS_UNBOUND_MESSAGE =
  "This supplier concession was recorded before suppliers were tracked by identity, and it is not linked to its supplier yet. Do not record it again: it cannot be changed after handover. Check that the vehicle is linked to the right supplier. If the vehicle has no supplier, a finance manager can link it on the vehicle edit screen; the concession is then linked to that supplier by the next supplier identity repair, which runs with every release.";
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

export type RegistryInitResult = { created: boolean; skipped?: "ORG_MISSING" | "ORG_DELETING" };

/**
 * True once an organization deletion has been requested or its purge has started. Any one of the
 * three fields is enough: `deletionRequestId` and `deletionRequestedAt` are set when the request is
 * filed, and `destructivePurgeStartedAt` is stamped before the first destructive step and is never
 * cleared (see the field's comment in `schema.ts`). A rejected request clears the first two, so an
 * organization that returns to service can be initialised again.
 */
function isOrgBeingDeleted(org: Doc<"organizations">): boolean {
  return (
    org.deletionRequestId !== undefined ||
    org.deletionRequestedAt !== undefined ||
    org.destructivePurgeStartedAt !== undefined
  );
}

/**
 * Creates the organization's registry document if it has none. Safe to call repeatedly. It reads
 * the organization row in the same transaction and creates nothing for a missing or doomed
 * organization: the purge deletes the registry row in one of its last steps and the organization row after it,
 * so a row created in between would be orphaned. Reading the organization row also puts it in this
 * transaction's read set, so a purge that stamps it concurrently conflicts and re-runs
 * (https://docs.convex.dev/database/advanced/occ).
 *
 * An organization that had a deletion request pending when the backfill ran is skipped. If that
 * request is later rejected, the organization has no registry, and every supplier write refuses with
 * REGISTRY_NOT_INITIALISED (fail-closed) until an operator runs `internal.suppliers.initialiseRegistry`
 * for it. The reactivation path is deliberately not changed: it is a guarded, ratcheted function
 * (`scripts/organizationReactivationGuard.test.ts`) and this is a rare, operator-visible state.
 */
export async function ensureRegistryState(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
): Promise<RegistryInitResult> {
  const org = await ctx.db.get(orgId);
  if (!org) return { created: false, skipped: "ORG_MISSING" };
  if (isOrgBeingDeleted(org)) return { created: false, skipped: "ORG_DELETING" };
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
  return await ctx.db.insert("suppliers", row);
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
  return await ctx.db.insert("supplierAliases", row);
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
  refuseIfInactive(supplier);
  return supplier;
}

function refuseIfInactive(supplier: Doc<"suppliers">): void {
  if (supplier.status !== "ACTIVE") {
    throwSupplierError(SUPPLIER_ERROR.INACTIVE, "This supplier is inactive and cannot be used for new records.");
  }
}

/**
 * The party captured on a NEW money record (SCRUM-868 P1; design section 4.3). `name` and `version` are
 * what the master held when the record was created. The record stores them beside `supplierId`
 * (`sourcedFromName` and `supplierSnapshotVersion`) and they are never rewritten, so a later rename,
 * alias or deactivation cannot change what the record says (invariant N3).
 */
export interface SupplierSnapshot {
  readonly supplierId: Id<"suppliers">;
  readonly name: string;
  readonly version: number;
}

/**
 * Resolves the supplier a new record will point at and returns its snapshot. Read-only: it writes
 * nothing and takes no registry lock, so it cannot change any figure or any row (N4).
 *
 * `orgId` must be the organization the caller already proved (`requireTenantAuth`); this function
 * never accepts an organization from the client, and it has no parameter for a name, so the snapshot
 * name is always the one the server reads here.
 *
 * Refusals, all `ConvexError` with a stable `code`:
 *  - no id (`undefined` or `null`): `SUPPLIER_IDENTITY_REQUIRED`. There is no "Unknown supplier"
 *    default and no fallback to a typed name (N5).
 *  - an id of another organization, and an id that does not exist: `SUPPLIER_NOT_FOUND`, the same
 *    code and message for both (N6, no existence oracle).
 *  - an inactive supplier: `SUPPLIER_INACTIVE`. An inactive supplier takes no new records; existing
 *    records keep resolving through ordinary reads, and settlement never goes through this function (N10).
 */
export async function snapshotSupplier(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  supplierId: Id<"suppliers"> | null | undefined,
): Promise<SupplierSnapshot> {
  return await readSupplierSnapshot(ctx, orgId, supplierId, false);
}

/**
 * The snapshot for ONE caller: a proven replay of a command that already ran (the recorded evidence,
 * not this call, is what created the records, and a replay writes nothing). It skips only the inactive
 * refusal; the missing-id, foreign-organization and not-found refusals still apply, and the snapshot
 * name is still the one the server reads. A NEW use goes through `snapshotSupplier`, never through here.
 * It is a separate function, not a flag on `snapshotSupplier`, so that function keeps its fixed
 * (ctx, orgId, supplierId) shape and no caller can pass a value that loosens a new use.
 */
export async function snapshotSupplierForProvenReplay(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  supplierId: Id<"suppliers"> | null | undefined,
): Promise<SupplierSnapshot> {
  return await readSupplierSnapshot(ctx, orgId, supplierId, true);
}

async function readSupplierSnapshot(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  supplierId: Id<"suppliers"> | null | undefined,
  allowInactive: boolean,
): Promise<SupplierSnapshot> {
  if (supplierId === undefined || supplierId === null) {
    throwSupplierError(SUPPLIER_ERROR.IDENTITY_REQUIRED, "A supplier is required.");
  }
  const supplier = await ctx.db.get("suppliers", supplierId);
  if (!supplier || supplier.orgId !== orgId) {
    throwSupplierError(SUPPLIER_ERROR.NOT_FOUND, SUPPLIER_NOT_FOUND_MESSAGE);
  }
  if (!allowInactive) refuseIfInactive(supplier);
  return Object.freeze({ supplierId: supplier._id, name: supplier.displayName, version: supplier.version });
}

/**
 * Any reader that carries a record's STORED supplier id into another record goes through this: the id is
 * returned only when that supplier row exists in `orgId` (N6). A stored id that is missing or belongs to
 * another organization (corruption, never a state a write here produces) is dropped, so it can never be
 * copied into a new record; the name snapshot already on the source record still carries the history.
 * Read-only. It lives here because only the supplier modules read the supplier tables.
 */

/**
 * Asserts that a row has a resolved supplierId in the given orgId (N5, N6, N10).
 * Throws SUPPLIER_ERROR.IDENTITY_UNRESOLVED with SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE if absent or foreign.
 * Note: Does NOT refuse if supplier is inactive (author self-attack #4: deactivation allows settlement).
 */
export async function requireResolvedSupplierId(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  row: { supplierId?: Id<"suppliers">; origin?: string },
): Promise<Id<"suppliers"> | undefined> {
  if (row.origin === "OPENING") {
    return undefined;
  }
  if (!row.supplierId) {
    throwSupplierError(SUPPLIER_ERROR.IDENTITY_UNRESOLVED, SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE);
  }
  const supplier = await ctx.db.get("suppliers", row.supplierId);
  if (!supplier || supplier.orgId !== orgId) {
    throwSupplierError(SUPPLIER_ERROR.IDENTITY_UNRESOLVED, SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE);
  }
  return row.supplierId;
}
/**
 * Resolves the supplier a SOURCED sale will owe (or be owed by) and its snapshot version, before any write.
 * Fails closed with SUPPLIER_IDENTITY_UNRESOLVED when the vehicle carries no supplier id, when the id
 * does not exist, or when it belongs to another organization (N5, N6). One message for all three, so
 * the refusal is not an existence oracle (TEN-1). A completed sale must never write a payable or a
 * receivable that the settlement doors would then refuse for the rest of its life.
 * Does not refuse an inactive supplier: deactivation never strands an obligation (N10).
 *
 * Returns the id, the display name and the version from ONE read of the master, so a record that stores
 * all three stores a pair that existed together (N3): the name and the version are never taken from
 * different sources (the vehicle's intake label, say, beside the master's current version).
 */
export async function requireSupplierSnapshotForCompletion(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  supplierId: Id<"suppliers"> | undefined,
): Promise<{ supplierId: Id<"suppliers">; supplierSnapshotName: string; supplierSnapshotVersion: number }> {
  const supplier = supplierId ? await ctx.db.get("suppliers", supplierId) : null;
  if (!supplier || supplier.orgId !== orgId) {
    return throwSupplierError(SUPPLIER_ERROR.IDENTITY_UNRESOLVED, SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE);
  }
  return {
    supplierId: supplier._id,
    supplierSnapshotName: supplier.displayName,
    supplierSnapshotVersion: supplier.version,
  };
}
export async function ownedStoredSupplierId(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  storedId: Id<"suppliers"> | undefined,
): Promise<Id<"suppliers"> | undefined> {
  if (storedId === undefined) return undefined;
  const row = await ctx.db.get("suppliers", storedId);
  return row !== null && row.orgId === orgId ? storedId : undefined;
}

/** The alias keys read for one name before the lookup gives up and treats it as no evidence (fail closed). */
const ALIAS_EVIDENCE_READ_BOUND = 50;

export type SupplierNameEvidence =
  | { kind: "MATCH"; matchedOn: "DISPLAY_NAME" | "ALIAS"; version: number }
  | { kind: "NOT_IN_ORG" }
  | { kind: "NO_NAME_MATCH" };

/**
 * Whether `name` is the display name, or an ACTIVE or RETIRED alias, of a supplier of this organization
 * (SCRUM-868 P3 release repair). Read-only; never throws and never writes. Corroboration only: the caller
 * already holds the supplier id from a frozen vehicle link, and this never searches for a supplier BY name.
 * An alias lookup that fills its read bound without finding this supplier counts as no evidence.
 * Returns the master's current version so the caller can reject a snapshot version the master never reached.
 */
export async function supplierNameEvidence(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  supplierId: Id<"suppliers">,
  name: string,
): Promise<SupplierNameEvidence> {
  const supplier = await ctx.db.get("suppliers", supplierId);
  if (!supplier || supplier.orgId !== orgId) return { kind: "NOT_IN_ORG" };
  const key = normalizeNameKey(name);
  if (key === "") return { kind: "NO_NAME_MATCH" };
  if (supplier.displayNameKey === key) return { kind: "MATCH", matchedOn: "DISPLAY_NAME", version: supplier.version };
  for (const status of ["ACTIVE", "RETIRED"] as const) {
    const aliases = await ctx.db
      .query("supplierAliases")
      .withIndex("by_org_and_aliasKey_and_status", (q) => q.eq("orgId", orgId).eq("aliasKey", key).eq("status", status))
      .take(ALIAS_EVIDENCE_READ_BOUND);
    if (aliases.some((alias) => alias.supplierId === supplier._id)) {
      return { kind: "MATCH", matchedOn: "ALIAS", version: supplier.version };
    }
  }
  return { kind: "NO_NAME_MATCH" };
}

// ─── Duplicate detection (read-only; callers run it inside the lock) ──────────────────────────

/**
 * The cap on the candidate list a caller must confirm, and the per-source read bound.
 *
 * The bound is the cap plus two. Each source below returns at most one row per supplier (a name key
 * belongs to one supplier row, and an ACTIVE alias key is unique per supplier), and the supplier
 * being edited may be one of the rows. So a read that fills the bound holds at least
 * `CANDIDATE_CAP + 1` other suppliers: the list is over the cap, and the read refuses instead of
 * returning what it happened to see. A read that does not fill the bound has seen every row.
 */
export const CANDIDATE_CAP = 20;
const READ_BOUND = CANDIDATE_CAP + 2;

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
 * Refuses a change to a supplier's legal identity while another supplier declares it shares that
 * identity (`sharedLegalIdentityOf`). Otherwise the link would point at a different identity and
 * two suppliers could not be told apart from an undeclared duplicate. Callers run it inside the lock.
 */
export async function requireNoSharedIdentityDependents(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  supplierId: Id<"suppliers">,
): Promise<void> {
  const dependent = await ctx.db
    .query("suppliers")
    .withIndex("by_org_and_sharedLegalIdentityOf", (q) => q.eq("orgId", orgId).eq("sharedLegalIdentityOf", supplierId))
    .first();
  if (dependent) {
    throwSupplierError(
      SUPPLIER_ERROR.SHARED_IDENTITY_IN_USE,
      "Other suppliers share this legal identity. Unlink them or change them first.",
      { dependentSupplierId: dependent._id },
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
    /** Which sources to read. Default: both. An edit passes the sources whose field it changes. */
    sources?: { name: boolean; taxId: boolean };
  },
): Promise<SupplierCandidate[]> {
  const sources = probe.sources ?? { name: true, taxId: true };
  const collector = candidateCollector(orgId, probe.excludeSupplierId);
  if (sources.name) await collectNameCandidates(ctx, orgId, probe.nameKey, collector.note);
  if (sources.taxId && probe.taxIdKey) {
    await collectTaxCandidates(ctx, orgId, probe.taxIdKey, probe.taxJurisdiction, collector.note);
  }
  return collector.toList();
}

type NoteCandidate = (doc: Doc<"suppliers"> | null, reason: CandidateReason) => void;

function overCap(): never {
  return throwSupplierError(
    SUPPLIER_ERROR.CANDIDATES_OVER_CAP,
    `More than ${CANDIDATE_CAP} similar suppliers exist. Use an existing supplier or ask an administrator to clean up the duplicates.`,
    { limit: CANDIDATE_CAP },
  );
}

/** A read that fills its bound cannot be shown to be complete, so it refuses (see READ_BOUND). */
function complete<T>(rows: T[]): T[] {
  if (rows.length >= READ_BOUND) overCap();
  return rows;
}

/**
 * Gathers candidates from the reads, keyed by supplier so one supplier hit twice lists once with
 * both reasons. Rows of another organization and the excluded supplier are dropped. `toList` refuses
 * when the merged list passes the cap even though no single read filled its bound, then returns
 * the list sorted by id (UTF-16 code units, so the order is the same on every runtime).
 */
function candidateCollector(orgId: Id<"organizations">, excludeSupplierId: Id<"suppliers"> | undefined) {
  const found = new Map<Id<"suppliers">, { doc: Doc<"suppliers">; reasons: Set<CandidateReason> }>();
  const note: NoteCandidate = (doc, reason) => {
    if (!doc || doc.orgId !== orgId || doc._id === excludeSupplierId) return;
    const entry = found.get(doc._id) ?? { doc, reasons: new Set<CandidateReason>() };
    entry.reasons.add(reason);
    found.set(doc._id, entry);
  };
  const toList = (): SupplierCandidate[] => {
    if (found.size > CANDIDATE_CAP) overCap();
    return [...found.values()]
      .sort((a, b) => codeUnitCompare(a.doc._id, b.doc._id))
      .map(({ doc, reasons }) => ({
        supplierId: doc._id,
        displayName: doc.displayName,
        status: doc.status,
        reasons: [...reasons].sort(codeUnitCompare),
      }));
  };
  return { note, toList };
}

async function suppliersByNameKey(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, key: string) {
  return complete(
    await ctx.db
      .query("suppliers")
      .withIndex("by_org_and_displayNameKey", (q) => q.eq("orgId", orgId).eq("displayNameKey", key))
      .take(READ_BOUND),
  );
}

/** Same name key, an active alias with the key, and close names (whole-word prefix either way). */
async function collectNameCandidates(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  nameKey: string,
  note: NoteCandidate,
): Promise<void> {
  for (const doc of await suppliersByNameKey(ctx, orgId, nameKey)) note(doc, "SAME_NAME");

  // ACTIVE rows only, through the index, so retired aliases cannot fill the bound.
  const aliasHits = complete(
    await ctx.db
      .query("supplierAliases")
      .withIndex("by_org_and_aliasKey_and_status", (q) =>
        q.eq("orgId", orgId).eq("aliasKey", nameKey).eq("status", "ACTIVE"),
      )
      .take(READ_BOUND),
  );
  const aliased = await Promise.all(aliasHits.map((alias) => ctx.db.get(alias.supplierId)));
  for (const doc of aliased) note(doc, "ALIAS");

  // Close names: every proper whole-word prefix of the new key that is an existing key, and every
  // existing key that starts with the new key followed by a space. The prefix reads are independent,
  // so they run together; the result is sorted by id, so completion order does not matter.
  const tokens = nameKey.split(" ");
  const prefixes = tokens.slice(0, -1).map((_, i) => tokens.slice(0, i + 1).join(" "));
  for (const docs of await Promise.all(prefixes.map((key) => suppliersByNameKey(ctx, orgId, key)))) {
    for (const doc of docs) note(doc, "CLOSE_NAME");
  }
  const longer = complete(
    await ctx.db
      .query("suppliers")
      .withIndex("by_org_and_displayNameKey", (q) =>
        q.eq("orgId", orgId).gte("displayNameKey", `${nameKey} `).lt("displayNameKey", `${nameKey}!`),
      )
      .take(READ_BOUND),
  );
  for (const doc of longer) note(doc, "CLOSE_NAME");
}

/** Soft tax-id match: the same key where the jurisdiction is missing or different. */
async function collectTaxCandidates(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  taxKey: string,
  taxJurisdiction: string | undefined,
  note: NoteCandidate,
): Promise<void> {
  // The hard-match filter below drops rows after the read, so a full read cannot prove how many
  // soft candidates it holds. It refuses rather than guess.
  const sameKey = complete(
    await ctx.db
      .query("suppliers")
      .withIndex("by_org_and_taxIdKey", (q) => q.eq("orgId", orgId).eq("taxIdKey", taxKey))
      .take(READ_BOUND),
  );
  for (const doc of sameKey) {
    const hardMatch =
      taxJurisdiction !== undefined && doc.taxJurisdiction !== undefined && doc.taxJurisdiction === taxJurisdiction;
    if (!hardMatch) note(doc, "TAX_ID");
  }
}
