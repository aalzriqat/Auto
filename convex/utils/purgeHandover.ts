/**
 * SCRUM-1023 Phase 1b (owner ruling D follow-up, 2026-11-27): a CANCELLED application whose handover state still says
 * HANDED_OVER. READ-ONLY, pure (it works on rows the manifest already read).
 *
 * Default: the purged application refuses (LIVE_STATE_ROW on financeApplications): a handover is a live fact about a car.
 * The owner may lift that, but ONLY for an exact application id in `approvedLiveRowIds`, AND only when the rows prove the
 * stale handover has no live consequence. If the proof fails the approval is void and the refusal is HANDOVER_LIVE_CONSEQUENCE:
 *  - EVERY vehicle the application names (vehicleId and each vehicleItems entry) must be in the scan and be AVAILABLE (SOLD,
 *    RESERVED and every other status fail safe); an application that names no vehicle has nothing to prove and refuses;
 *  - no KEPT row of a scanned table may name the application, its deal ids, or the rows that belong to it (a sale, delivery,
 *    custody or handover row, and the vehicle itself, which would carry the customer or a sale owner);
 *  - no POSTED event that names them may be un-reversed (a complete reversed pair is history, not a live effect).
 * The approved overrides are itemized (application, vehicle, vehicle status seen) so the owner approves what he can see.
 */
import type { ManifestRefusal, PurgeSet, Row, TokenIndex } from "./purgeSurvivors";
import { PURGE_AUDIT_SUBJECT } from "./purgeImpactMap";

export interface HandoverVehicle { vehicleId: string; status: string }

export interface HandoverOverride {
  applicationId: string;
  vehicleId: string | null;
  vehicleStatus: string;
  /** Every vehicle the application names (vehicleId and each vehicleItems entry), with the status read. */
  vehicles: HandoverVehicle[];
  /** Empty when the stale handover was proven harmless; otherwise why it was not. */
  liveConsequences: string[];
}

const TABLE = "financeApplications";
const isHandedOver = (r: Row): boolean => r.handoverStatus === "HANDED_OVER" || typeof r.vehicleHandoverAt === "number";

/** The ids that stand for this application's deal: itself, the purged ids it names, and the purged rows that name it. */
function dealIds(app: Row, set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex): Set<string> {
  const names = new Set<string>([app._id]);
  for (const t of tok.of(app)) if (set.has(t)) names.add(t);
  for (const [table, rows] of tableRows) {
    if (table in PURGE_AUDIT_SUBJECT) continue;
    for (const row of rows) if (set.has(row._id) && tok.of(row).includes(app._id)) names.add(row._id);
  }
  return names;
}

/** Code-unit order (what a bare `sort()` gave): table names are camelCase, so the order must not depend on the locale. */
const byCodeUnit = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** Every vehicle the application names: `vehicleId` and each `vehicleItems` entry (multi-vehicle applications), once each. */
function namedVehicleIds(app: Row): string[] {
  const items = Array.isArray(app.vehicleItems) ? (app.vehicleItems as Array<{ vehicleId?: unknown }>) : [];
  const ids = [app.vehicleId, ...items.map((i) => i?.vehicleId)].filter((id): id is string => typeof id === "string");
  return [...new Set(ids)].toSorted(byCodeUnit);
}

/** Why one named vehicle is not proof of "no live consequence" (empty when it is AVAILABLE and does not name the customer). */
function vehicleWhy(id: string, vehicle: Row | undefined, customer: string | null, tok: TokenIndex): string[] {
  if (!vehicle) return [`the vehicle ${id} was not read, so its state cannot be proven`];
  const why: string[] = [];
  if (vehicle.status !== "AVAILABLE") why.push(`the vehicle ${id} is ${String(vehicle.status)}, not AVAILABLE`);
  if (customer && tok.of(vehicle).includes(customer)) why.push(`the vehicle row ${id} names this application's customer`);
  return why;
}

/** What the vehicle rows prove: each named vehicle's status as read, and why that state is not a proof. No vehicle fails closed. */
function vehicleFindings(app: Row, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex): { vehicles: HandoverVehicle[]; vehicleStatus: string; why: string[] } {
  const ids = namedVehicleIds(app);
  if (ids.length === 0) return { vehicles: [], vehicleStatus: "NO_VEHICLE", why: ["the application names no vehicle, so no vehicle state can be proven"] };
  const rows = new Map((tableRows.get("vehicles") ?? []).map((v) => [v._id, v]));
  const customer = typeof app.customerId === "string" ? app.customerId : null;
  const vehicles = ids.map((id) => ({ vehicleId: id, status: rows.has(id) ? String(rows.get(id)?.status) : "NOT_READ" }));
  const primary = typeof app.vehicleId === "string" ? app.vehicleId : ids[0];
  const vehicleStatus = vehicles.find((v) => v.vehicleId === primary)?.status ?? "NOT_READ";
  return { vehicles, vehicleStatus, why: ids.flatMap((id) => vehicleWhy(id, rows.get(id), customer, tok)) };
}
/** Tables (code-unit order) holding a KEPT row that names the application or its deal. */
function keptTablesNaming(names: ReadonlySet<string>, set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex): string[] {
  const tables: string[] = [];
  for (const [table, rows] of tableRows) {
    if (table in PURGE_AUDIT_SUBJECT) continue;
    if (rows.some((r) => !set.has(r._id) && tok.of(r).some((t) => names.has(t)))) tables.push(table);
  }
  return tables.toSorted(byCodeUnit);
}

/** POSTED accounting events (a reversal's own event excluded) that name the application or its deal. */
function livePostedEvents(names: ReadonlySet<string>, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex): number {
  return (tableRows.get("accountingEvents") ?? []).filter((e) =>
    e.status === "POSTED" && e.eventType !== "JOURNAL_REVERSAL" && tok.of(e).some((t) => names.has(t))).length;
}

function consequences(app: Row, set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex): { vehicles: HandoverVehicle[]; vehicleStatus: string; why: string[] } {
  const { vehicles, vehicleStatus, why } = vehicleFindings(app, tableRows, tok);
  const names = dealIds(app, set, tableRows, tok);
  const keptTables = keptTablesNaming(names, set, tableRows, tok);
  if (keptTables.length > 0) why.push(`a kept row names the application or its deal (${keptTables.join(", ")})`);
  const live = livePostedEvents(names, tableRows, tok);
  if (live > 0) why.push(`${live} POSTED un-reversed accounting event(s) name the application or its deal`);
  return { vehicles, vehicleStatus, why };
}

export function checkHandover(
  set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, approvedLiveRowIds: ReadonlyArray<string>, out: ManifestRefusal[],
): HandoverOverride[] {
  const purged = set.byTable.get(TABLE);
  if (!purged) return [];
  const approved = new Set(approvedLiveRowIds);
  const overrides: HandoverOverride[] = [];
  let unapproved = 0;
  let unproven = 0;
  for (const app of (tableRows.get(TABLE) ?? []).filter((r) => purged.has(r._id) && isHandedOver(r))) {
    if (!approved.has(app._id)) { unapproved += 1; continue; }
    const { vehicles, vehicleStatus, why } = consequences(app, set, tableRows, tok);
    if (why.length > 0) unproven += 1;
    overrides.push({ applicationId: app._id, vehicleId: typeof app.vehicleId === "string" ? app.vehicleId : null, vehicleStatus, vehicles, liveConsequences: why });
  }
  if (unapproved > 0) {
    out.push({ code: "LIVE_STATE_ROW", table: TABLE, detail: "a purged application records that its vehicle was handed over: only an owner-approved id may be purged in that state", count: unapproved });
  }
  if (unproven > 0) {
    out.push({ code: "HANDOVER_LIVE_CONSEQUENCE", table: TABLE, detail: "an approved handed-over application still has a live consequence (vehicle not AVAILABLE or tied to it, a kept row names it, or a POSTED un-reversed event): the approval cannot cover it", count: unproven });
  }
  return overrides.toSorted((a, b) => a.applicationId.localeCompare(b.applicationId));
}
