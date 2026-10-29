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
import { assertNoHeldSupplierConcession } from "./supplierConcession";
import {
  SUPPLIER_ERROR,
  snapshotSupplier,
  snapshotSupplierForProvenReplay,
  throwSupplierError,
  type SupplierSnapshot,
} from "./supplierRegistry";
import { parseVehicleSourceType, storedVehicleSourceType } from "./vehicleSourceShape";

/** English texts equal the dictionary entries under ServerError_<code> (lib/i18n/domains/common.ts). */
export const SUPPLIER_ROLE_CONFLICT_MESSAGE =
  "This supplier was sent in a role the vehicle does not have. A consignment supplier belongs to a consignment vehicle, and a purchase creditor belongs to an owned vehicle bought on account.";
export const SUPPLIER_LINK_FROZEN_MESSAGE =
  "This vehicle's supplier can no longer be changed because money has already been recorded against it. Ask your accountant for a reviewed correction.";

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
 * Refuses a change of the vehicle's supplier link (id or snapshot name) once money exists (N11), and
 * while an open deal holds the supplier terms (its own refusal). `link` is the new snapshot, or
 * undefined when the patch keeps the link; an unchanged link is never refused.
 */
export async function assertSupplierLinkChangeAllowed(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicle: Pick<Doc<"vehicles">, "_id" | "sourcedSupplierId">,
  link: SupplierSnapshot | undefined,
): Promise<void> {
  if (link === undefined || link.supplierId === vehicle.sourcedSupplierId) return;
  await assertNoHeldSupplierConcession(ctx, orgId, vehicle._id);
  if (await vehicleSupplierLinkHasMoney(ctx, orgId, vehicle._id)) {
    throwSupplierError(SUPPLIER_ERROR.LINK_FROZEN, SUPPLIER_LINK_FROZEN_MESSAGE);
  }
}
