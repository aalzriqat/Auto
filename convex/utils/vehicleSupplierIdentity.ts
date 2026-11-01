/**
 * SCRUM-868 P2: the supplier identity of a vehicle, resolved on the server.
 *
 * Two different parties can sit on a vehicle, and they are never the same field (N9):
 *   - the CONSIGNMENT supplier of a SOURCED car (`sourcedSupplierId`; the car is the supplier's), and
 *   - the CREDITOR of an OWNED car bought ON_ACCOUNT (`purchaseSupplierId`; stored on the payable,
 *     not on the vehicle).
 * A third fact, the settlement route, lives elsewhere and is not touched here.
 *
 * Every pilot path that writes either party sends the master row's id. This module resolves the id
 * inside the caller's proven organization (`snapshotSupplier`), hands back the name the SERVER read
 * from the master, and the caller stores that name beside the id. A client-typed name is never the
 * authority: a name-only call is refused with `SUPPLIER_IDENTITY_REQUIRED` and there is no fallback
 * (N2, N3, N5). Nothing here posts, rounds or changes an amount (N4); the functions are read-only.
 *
 * Resolve-then-normalise: the callers resolve first and overwrite the name fields of their input
 * with the server names, then run the pure shape guards and the unchanged posting code. So the
 * guards and the journal see exactly the same shape they always saw.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { PERMISSIONS, isSystemOwnerRole } from "./permissions";
import { assertNoHeldSupplierConcession } from "./supplierConcession";
import { normalizeNameKey } from "./supplierNames";
import {
  SUPPLIER_ERROR,
  snapshotSupplier,
  snapshotSupplierForProvenReplay,
  supplierNameEvidence,
  throwSupplierError,
  type SupplierNameEvidence,
  type SupplierSnapshot,
} from "./supplierRegistry";
import { parseVehicleSourceType, storedVehicleSourceType } from "./vehicleSourceShape";

/** English texts equal the dictionary entries under ServerError_<code> (lib/i18n/domains/common.ts). */
export const SUPPLIER_ROLE_CONFLICT_MESSAGE =
  "This supplier was sent in a role the vehicle does not have. A consignment supplier belongs to a consignment vehicle, and a purchase creditor belongs to an owned vehicle bought on account.";
export const SUPPLIER_LINK_FROZEN_MESSAGE =
  "This vehicle's supplier can no longer be changed because money has already been recorded against it. Ask your accountant for a reviewed correction.";
export const SUPPLIER_FIRST_LINK_NEEDS_FINANCE_MANAGER_MESSAGE =
  "This vehicle has money recorded against it but no supplier yet. Only a finance manager can set its first supplier. Ask a finance manager to link the vehicle on the vehicle edit screen; an edit request cannot do it.";
export const SUPPLIER_FIRST_LINK_NOT_PROVEN_MESSAGE =
  "This supplier cannot be linked because the supplier name stored on the vehicle and on its money records does not match this supplier's name or one of its aliases. Pick the supplier those records were made for, or ask a finance manager to add the old name as an alias of that supplier first. Nothing was changed.";

/** The two supplier ids a vehicle write may carry, plus the facts that decide which one applies. */
export interface VehicleSupplierSubmission {
  sourceType?: string | null;
  purchasePaymentMethod?: string | null;
  sourcedSupplierId?: Id<"suppliers"> | null;
  purchaseSupplierId?: Id<"suppliers"> | null;
}

export interface ResolvedVehicleSuppliers {
  /** The consignment supplier of a SOURCED car. */
  readonly sourced?: SupplierSnapshot;
  /** The creditor of an OWNED car bought ON_ACCOUNT. */
  readonly creditor?: SupplierSnapshot;
}

function throwRoleConflict(): never {
  return throwSupplierError(SUPPLIER_ERROR.ROLE_CONFLICT, SUPPLIER_ROLE_CONFLICT_MESSAGE);
}

const present = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * INTAKE (a vehicle being created): SOURCED needs the consignment supplier's id; an owned car bought
 * ON_ACCOUNT needs the creditor's id; the other id in either case is a role conflict. A submission
 * with no recognised type resolves nothing: the shape guard that runs next refuses it.
 */
export async function resolveIntakeSuppliers(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  input: VehicleSupplierSubmission,
): Promise<ResolvedVehicleSuppliers> {
  const type = parseVehicleSourceType(input.sourceType);
  if (type === null) return {};
  if (type === "SOURCED") {
    if (present(input.purchaseSupplierId)) throwRoleConflict();
    return { sourced: await snapshotSupplier(ctx, orgId, input.sourcedSupplierId) };
  }
  if (present(input.sourcedSupplierId)) throwRoleConflict();
  if (input.purchasePaymentMethod === "ON_ACCOUNT") {
    return { creditor: await snapshotSupplier(ctx, orgId, input.purchaseSupplierId) };
  }
  if (present(input.purchaseSupplierId)) throwRoleConflict();
  return {};
}

/**
 * The input with its name fields replaced by the names the server read from the master. Only a role
 * that resolved is overwritten; a name that has no role (an owned car carrying a consignment name)
 * is left for the shape guard to refuse.
 */
export function withServerSupplierNames<
  T extends { sourcedFromName?: string; purchaseSupplierName?: string },
>(input: T, resolved: ResolvedVehicleSuppliers): T {
  return {
    ...input,
    ...(resolved.sourced ? { sourcedFromName: resolved.sourced.name } : {}),
    ...(resolved.creditor ? { purchaseSupplierName: resolved.creditor.name } : {}),
  };
}

/**
 * UPDATE: the consignment supplier a patch sets, or undefined when it sets none.
 *
 *  - an id for a vehicle that is (or becomes) SOURCED resolves to a snapshot; an id that equals the
 *    stored one is a no-op and is not re-resolved, so an unrelated edit of a car whose supplier was
 *    since deactivated still works (N10: an inactive supplier takes no NEW use);
 *  - an id for a vehicle that is (or becomes) owned stock is a role conflict;
 *  - a typed name that differs from the stored one, with no id, is a name-only write: refused.
 *    A name that equals the stored one is the client echoing the row back and is ignored.
 */
export async function resolveUpdateSourcedSupplier(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicle: Pick<Doc<"vehicles">, "sourceType" | "sourcedFromName" | "sourcedSupplierId">,
  patch: { sourceType?: string | null; sourcedFromName?: string | null; sourcedSupplierId?: Id<"suppliers"> | null },
): Promise<SupplierSnapshot | undefined> {
  const stored = storedVehicleSourceType(vehicle.sourceType);
  const target = parseVehicleSourceType(patch.sourceType) ?? stored;
  if (present(patch.sourcedSupplierId)) {
    if (target !== "SOURCED") throwRoleConflict();
    if (stored === "SOURCED" && patch.sourcedSupplierId === vehicle.sourcedSupplierId) return undefined;
    return await snapshotSupplier(ctx, orgId, patch.sourcedSupplierId);
  }
  const typedName = (patch.sourcedFromName ?? "").trim();
  const storedName = (vehicle.sourcedFromName ?? "").trim();
  if (target === "SOURCED" && typedName !== "" && typedName !== storedName) {
    return await snapshotSupplier(ctx, orgId, undefined);
  }
  return undefined;
}

/**
 * The creditor of an acquisition that WILL post (UPDATE paths, once the caller knows it will).
 * ON_ACCOUNT needs the id; any other method with an id is a role conflict because nothing would use it.
 */
export async function resolveCreditorForPosting(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  input: { purchasePaymentMethod?: string | null; purchaseSupplierId?: Id<"suppliers"> | null },
): Promise<SupplierSnapshot | undefined> {
  if (input.purchasePaymentMethod === "ON_ACCOUNT") {
    return await snapshotSupplier(ctx, orgId, input.purchaseSupplierId);
  }
  if (present(input.purchaseSupplierId)) throwRoleConflict();
  return undefined;
}

/** A creditor id sent on a write that posts no acquisition would be silently dropped: refuse it. */
export function refuseUnusedCreditorId(input: { purchaseSupplierId?: Id<"suppliers"> | null }): void {
  if (present(input.purchaseSupplierId)) throwRoleConflict();
}

/** The fields of one import row that decide which supplier roles it carries. */
export interface ImportSupplierRow {
  rowId?: number;
  sourceType?: string;
  purchasePrice?: number;
  sourcedFromName?: string;
  purchaseSupplierName?: string;
  sourcedSupplierId?: Id<"suppliers">;
  purchaseSupplierId?: Id<"suppliers">;
}

/**
 * IMPORT: resolves every supplier id of a file once, inside the caller's org, and returns the rows with
 * their name fields replaced by the master's names plus the snapshots by id (the poster needs the
 * snapshot version). The whole file is refused before any write if one row is wrong.
 *
 *  - a SOURCED row that names a supplier must carry its id (a name alone is `SUPPLIER_IDENTITY_REQUIRED`);
 *    a SOURCED row with neither keeps the file's existing handling (skipped, or refused as uncreatable);
 *  - an owned row that will open a payable (an ON_ACCOUNT purchase import, positive price) must carry the
 *    creditor's id; an id on any row that would not use it is a role conflict, never silently dropped.
 *
 * `posting.provenReplayRowIds` names the rows whose (import, row) evidence was already read and matched
 * by fingerprint: those rows ran before and write nothing now, so a supplier deactivated since does not
 * refuse them. Their ids are still looked up inside the caller's organization (a missing or foreign id
 * still refuses). Every other row is a NEW use and needs an active supplier.
 */
export async function resolveImportSuppliers<Row extends ImportSupplierRow>(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  rows: readonly Row[],
  posting: { onAccountPurchase: boolean; provenReplayRowIds?: ReadonlySet<number> },
): Promise<{ rows: Row[]; snapshots: Map<Id<"suppliers">, SupplierSnapshot> }> {
  const snapshots = new Map<Id<"suppliers">, SupplierSnapshot>();
  // A replay row resolves leniently and its snapshot is never cached for a new-use row: an inactive
  // supplier must still refuse a different row that would use it for the first time.
  const resolve = async (id: Id<"suppliers"> | null | undefined, replay: boolean): Promise<SupplierSnapshot> => {
    if (id !== undefined && id !== null && !replay) {
      const cached = snapshots.get(id);
      if (cached) return cached;
    }
    const snapshot = replay
      ? await snapshotSupplierForProvenReplay(ctx, orgId, id)
      : await snapshotSupplier(ctx, orgId, id);
    if (!replay) snapshots.set(snapshot.supplierId, snapshot);
    return snapshot;
  };
  const resolved: Row[] = [];
  for (const row of rows) {
    const replay = row.rowId !== undefined && posting.provenReplayRowIds?.has(row.rowId) === true;
    const type = parseVehicleSourceType(row.sourceType);
    if (type === "SOURCED") {
      if (present(row.purchaseSupplierId)) throwRoleConflict();
      if (present(row.sourcedSupplierId) || (row.sourcedFromName ?? "").trim() !== "") {
        const snapshot = await resolve(row.sourcedSupplierId, replay);
        resolved.push({ ...row, sourcedFromName: snapshot.name });
      } else {
        resolved.push(row);
      }
      continue;
    }
    if (type === "STOCK") {
      if (present(row.sourcedSupplierId)) throwRoleConflict();
      const opensPayable = posting.onAccountPurchase && (row.purchasePrice ?? 0) > 0;
      if (opensPayable) {
        const snapshot = await resolve(row.purchaseSupplierId, replay);
        resolved.push({ ...row, purchaseSupplierName: snapshot.name });
        continue;
      }
      if (present(row.purchaseSupplierId)) throwRoleConflict();
    }
    resolved.push(row);
  }
  return { rows: resolved, snapshots };
}

/** Supplier-borne expenses read per vehicle before the check gives up and fails closed. */
const FROZEN_EXPENSE_SCAN_BOUND = 200;

/**
 * N11: true when any money record references this vehicle's supplier relationship: a supplier
 * payable, a supplier receivable, a supplier cost recovery, or a supplier-borne expense.
 * Bounded; a scan that fills its bound without a hit counts as frozen (fail closed, N5).
 */
export async function vehicleSupplierLinkHasMoney(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
): Promise<boolean> {
  const payable = await ctx.db
    .query("vehicleSupplierPayables")
    .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId))
    .first();
  if (payable && payable.orgId === orgId) return true;
  const receivable = await ctx.db
    .query("vehicleSupplierReceivables")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
    .first();
  if (receivable) return true;
  const recovery = await ctx.db
    .query("supplierCostRecoveries")
    .withIndex("by_org_vehicle_status", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
    .first();
  if (recovery) return true;
  const expenses = await ctx.db
    .query("expenses")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
    .take(FROZEN_EXPENSE_SCAN_BOUND);
  if (expenses.some((expense) => expense.costBearer === "SUPPLIER" && expense.isDeleted !== true)) return true;
  return expenses.length >= FROZEN_EXPENSE_SCAN_BOUND;
}

/**
 * Rows read from each money table by the first-link proof. A table that fills this bound is refused (fail
 * closed): the proof must see every row it vouches for. A consignment car has a handful of rows.
 */
const FIRST_LINK_ROW_BOUND = 100;

/** What the first-link proof established; the caller records it in the audit log. Read-only data. */
export interface FirstLinkProof {
  /** How the name stored on the VEHICLE matched the picked supplier. */
  readonly nameMatchedOn: "DISPLAY_NAME" | "ALIAS";
  /** How many id-less (or already bound to this supplier) rows of each table were checked. */
  readonly rowsChecked: { readonly payables: number; readonly receivables: number; readonly recoveries: number };
}

/** The slice of a role the first-link permission check reads (the same two facts `requireTenantAuth` reads). */
export type FirstLinkActorRole = Pick<Doc<"roles">, "permissions" | "isSystemOwnerRole" | "isDeleted" | "name">;

/** The fields every supplier money row that carries a supplier name has in common. */
interface NamedSupplierRow {
  orgId: Id<"organizations">;
  sourcedFromName: string;
  supplierId?: Id<"suppliers">;
  supplierSnapshotVersion?: number;
}

function throwFirstLinkNotProven(): never {
  return throwSupplierError(SUPPLIER_ERROR.FIRST_LINK_NOT_PROVEN, SUPPLIER_FIRST_LINK_NOT_PROVEN_MESSAGE);
}

/**
 * The FIRST link of a consignment car that already has money and no supplier (SCRUM-868 P4/P5 round 4).
 *
 * The operator picked `link.supplierId`. The picked id is confirmed, never chosen, by names:
 *   - the name stored on the VEHICLE is that supplier's display name or one of its aliases (ACTIVE or
 *     RETIRED), compared by the registry's own `normalizeNameKey` (`supplierNameEvidence`);
 *   - every payable, receivable and cost recovery of the vehicle that has no supplier id carries a stored
 *     name that matches the same way, and a snapshot version the master has reached (the exact rules the
 *     release repair will apply to bind the row next, so a link this accepts is a link the repair accepts);
 *   - a row already bound to this supplier agrees; a row bound to ANOTHER supplier refuses.
 * Supplier-borne expenses carry no supplier name; they are confirmed by the vehicle's name alone.
 * Read-only: it binds nothing, posts nothing and changes no amount. The existing repair binds the rows.
 */
async function proveFirstLink(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicle: Pick<Doc<"vehicles">, "_id" | "sourcedFromName">,
  supplierId: Id<"suppliers">,
): Promise<FirstLinkProof> {
  // Many rows repeat one name; the evidence for a name is the same every time, so read it once.
  const evidenceByKey = new Map<string, SupplierNameEvidence>();
  const evidenceFor = async (name: string): Promise<SupplierNameEvidence> => {
    const key = normalizeNameKey(name);
    const cached = evidenceByKey.get(key);
    if (cached) return cached;
    const evidence = await supplierNameEvidence(ctx, orgId, supplierId, name);
    evidenceByKey.set(key, evidence);
    return evidence;
  };
  const vehicleEvidence = await evidenceFor(vehicle.sourcedFromName ?? "");
  if (vehicleEvidence.kind !== "MATCH") return throwFirstLinkNotProven();

  const rowAgrees = async (row: NamedSupplierRow): Promise<boolean> => {
    if (row.orgId !== orgId) return false;
    if (row.supplierId !== undefined) return row.supplierId === supplierId;
    const evidence = await evidenceFor(row.sourcedFromName);
    if (evidence.kind !== "MATCH") return false;
    const version = row.supplierSnapshotVersion;
    return version === undefined || (Number.isSafeInteger(version) && version >= 1 && version <= evidence.version);
  };
  const allAgree = async (rows: readonly NamedSupplierRow[]): Promise<number> => {
    if (rows.length > FIRST_LINK_ROW_BOUND) return throwFirstLinkNotProven();
    for (const row of rows) {
      if (!(await rowAgrees(row))) return throwFirstLinkNotProven();
    }
    return rows.length;
  };

  const payables = await ctx.db
    .query("vehicleSupplierPayables")
    .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicle._id))
    .take(FIRST_LINK_ROW_BOUND + 1);
  const receivables = await ctx.db
    .query("vehicleSupplierReceivables")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicle._id))
    .take(FIRST_LINK_ROW_BOUND + 1);
  const recoveries = await ctx.db
    .query("supplierCostRecoveries")
    .withIndex("by_org_vehicle_status", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicle._id))
    .take(FIRST_LINK_ROW_BOUND + 1);
  return {
    nameMatchedOn: vehicleEvidence.matchedOn,
    rowsChecked: {
      payables: await allAgree(payables),
      receivables: await allAgree(receivables),
      recoveries: await allAgree(recoveries),
    },
  };
}

/**
 * Refuses a change of the vehicle's supplier link (id or snapshot name) once money exists (N11), and
 * while an open deal holds the supplier terms (its own refusal). `link` is the new snapshot, or
 * undefined when the patch keeps the link; an unchanged link is never refused.
 *
 * One narrow exception, the FIRST link: a SOURCED car with money and NO link (`sourcedSupplierId` unset)
 * may be linked to the supplier the operator picked, when the caller holds manage:finance (`actor`) and
 * `proveFirstLink` confirms the picked id against the stored names. Any other link change on a car with
 * money (X to Y, X to none, a car that is not SOURCED) is refused exactly as before. A caller that passes
 * no `actor` (the edit-request doors) can never take the exception: a sales-originated request gains no
 * finance power. Returns the proof when the exception was taken, so the caller can audit it; undefined
 * otherwise.
 */
export async function assertSupplierLinkChangeAllowed(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicle: Pick<Doc<"vehicles">, "_id" | "sourcedSupplierId" | "sourceType" | "sourcedFromName">,
  link: SupplierSnapshot | undefined,
  actor?: { readonly role: FirstLinkActorRole },
): Promise<FirstLinkProof | undefined> {
  if (link === undefined || link.supplierId === vehicle.sourcedSupplierId) return undefined;
  await assertNoHeldSupplierConcession(ctx, orgId, vehicle._id);
  if (!(await vehicleSupplierLinkHasMoney(ctx, orgId, vehicle._id))) return undefined;
  const isFirstLink = vehicle.sourcedSupplierId === undefined && storedVehicleSourceType(vehicle.sourceType) === "SOURCED";
  if (!isFirstLink) return throwSupplierError(SUPPLIER_ERROR.LINK_FROZEN, SUPPLIER_LINK_FROZEN_MESSAGE);
  const holdsFinanceAuthority =
    actor !== undefined &&
    (isSystemOwnerRole(actor.role) || actor.role.permissions.includes(PERMISSIONS.MANAGE_FINANCE));
  if (!holdsFinanceAuthority) {
    return throwSupplierError(
      SUPPLIER_ERROR.FIRST_LINK_NEEDS_FINANCE_MANAGER,
      SUPPLIER_FIRST_LINK_NEEDS_FINANCE_MANAGER_MESSAGE,
    );
  }
  return await proveFirstLink(ctx, orgId, vehicle, link.supplierId);
}
