/**
 * SCRUM-1023 Phase 1b (owner ruling D follow-up, 2026-11-27): a CANCELLED application whose handover state still says
 * HANDED_OVER. READ-ONLY, pure (it works on rows the manifest already read).
 *
 * Default: the purged application refuses (LIVE_STATE_ROW on financeApplications): a handover is a live fact about a car.
 * The owner may lift that, but ONLY for an exact application id in `approvedLiveRowIds`, AND only when the rows prove the
 * stale handover has no live consequence. If the proof fails the approval is void and the refusal is HANDOVER_LIVE_CONSEQUENCE:
 *  - the vehicle row must be in the scan and be AVAILABLE (SOLD, RESERVED and every other status fail safe);
 *  - no KEPT row of a scanned table may name the application, its deal ids, or the rows that belong to it (a sale, delivery,
 *    custody or handover row, and the vehicle itself, which would carry the customer or a sale owner);
 *  - no POSTED event that names them may be un-reversed (a complete reversed pair is history, not a live effect).
 * The approved overrides are itemized (application, vehicle, vehicle status seen) so the owner approves what he can see.
 */
import type { ManifestRefusal, PurgeSet, Row, TokenIndex } from "./purgeSurvivors";
import { PURGE_AUDIT_SUBJECT } from "./purgeImpactMap";

export interface HandoverOverride {
  applicationId: string;
  vehicleId: string | null;
  vehicleStatus: string;
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

function consequences(app: Row, set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex): { vehicleStatus: string; why: string[] } {
  const why: string[] = [];
  const vehicleId = typeof app.vehicleId === "string" ? app.vehicleId : null;
  const vehicle = vehicleId ? (tableRows.get("vehicles") ?? []).find((v) => v._id === vehicleId) : undefined;
  const vehicleStatus = vehicle ? String(vehicle.status) : "NOT_READ";
  if (vehicleId && !vehicle) why.push("the vehicle was not read, so its state cannot be proven");
  else if (vehicle && vehicle.status !== "AVAILABLE") why.push(`the vehicle is ${vehicleStatus}, not AVAILABLE`);
  const names = dealIds(app, set, tableRows, tok);
  const customer = typeof app.customerId === "string" ? app.customerId : null;
  if (vehicle && customer && tok.of(vehicle).includes(customer)) why.push("the vehicle row names this application's customer");
  const keptTables: string[] = [];
  for (const [table, rows] of tableRows) {
    if (table in PURGE_AUDIT_SUBJECT) continue;
    if (rows.some((r) => !set.has(r._id) && tok.of(r).some((t) => names.has(t)))) keptTables.push(table);
  }
  if (keptTables.length > 0) why.push(`a kept row names the application or its deal (${keptTables.sort().join(", ")})`);
  const live = (tableRows.get("accountingEvents") ?? []).filter((e) =>
    e.status === "POSTED" && e.eventType !== "JOURNAL_REVERSAL" && tok.of(e).some((t) => names.has(t)));
  if (live.length > 0) why.push(`${live.length} POSTED un-reversed accounting event(s) name the application or its deal`);
  return { vehicleStatus, why };
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
    const { vehicleStatus, why } = consequences(app, set, tableRows, tok);
    if (why.length > 0) unproven += 1;
    overrides.push({ applicationId: app._id, vehicleId: typeof app.vehicleId === "string" ? app.vehicleId : null, vehicleStatus, liveConsequences: why });
  }
  if (unapproved > 0) {
    out.push({ code: "LIVE_STATE_ROW", table: TABLE, detail: "a purged application records that its vehicle was handed over: only an owner-approved id may be purged in that state", count: unapproved });
  }
  if (unproven > 0) {
    out.push({ code: "HANDOVER_LIVE_CONSEQUENCE", table: TABLE, detail: "an approved handed-over application still has a live consequence (vehicle not AVAILABLE or tied to it, a kept row names it, or a POSTED un-reversed event): the approval cannot cover it", count: unproven });
  }
  return overrides.sort((a, b) => a.applicationId.localeCompare(b.applicationId));
}
