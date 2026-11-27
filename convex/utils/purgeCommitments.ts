/**
 * SCRUM-1023 Phase 1c (owner ruling 2026-11-27, Jira SCRUM-1023 comments 26166-26168, invariant I17): amounts and holds
 * hanging on cancelled deals are released, so a CONSUMED commitment root leaves WITH the sale that consumed it and a stale
 * claim leaves with its deal. READ-ONLY and pure: it works on rows the manifest already read (no read of its own).
 *
 * - A root joins ONLY when its status is CONSUMED, the sale that consumed it is itself in the purge, it is BOUND to that sale
 *   (same vehicleId and customerId: a sale has one of each) and it is the only such root of that sale (boundRoots). Any other
 *   kept CONSUMED root naming the purged sale refuses COMMITMENT_SHARED_LINEAGE. Its claims join with it (joinConsumedRoots),
 *   but they are still judged below: a claim of ANY status that names a kept evidence row refuses unless that row is terminal
 *   and bound to the claim, so a claim on a kept CANCELLED application still goes and one on a live application does not.
 * - A claim in the purge is judged by its evidence: the deposit, application or reservation it rests on must be purged, or be
 *   terminal (REFUNDED deposit, CANCELLED application); "consumed by a purged sale" counts only for the root's own sale. A reservation has no terminal state. Missing evidence fails closed,
 *   and so does evidence that is not BOUND to the claim (another customer or vehicle, or another kept claim's own evidence).
 * - Refused with their own code (never lifted by an approved id): COMMITMENT_ROOT_NOT_CONSUMED, COMMITMENT_EVIDENCE_LIVE,
 *   COMMITMENT_ACTIVE_HOLD, COMMITMENT_SHARED_LINEAGE (a kept row, root or claim is tied to the same lineage) and
 *   COMMITMENT_CURRENT_FOR_VEHICLE (an ACTIVE claim of a kept OPEN root is the car's live commitment).
 * - `judged` lists the KEPT rows that carry one of these codes, so the generic survivor scan does not refuse them twice.
 */
import { PURGE_IMPACT_MAP } from "./purgeImpactMap";
import type { ManifestRefusal, PurgeSet, Row, TokenIndex } from "./purgeSurvivors";

const ROOTS = "commitmentRoots";
const CLAIMS = "vehicleCommitmentClaims";
const HOLDS = "depositVehicleHolds";

export interface CommitmentItem {
  kind: "root" | "claim";
  id: string;
  status: string;
  vehicleId: string;
  /** Why a claim may leave (what its evidence is); a root says which sale consumed it. */
  evidence: string;
  /** The vehicle's KEPT OPEN commitment root, when it has one: proof that its current commitment stays. */
  keptOpenRootId: string | null;
}

export interface CommitmentFindings {
  items: CommitmentItem[];
  /** Kept rows that already carry a commitment refusal. */
  judged: ReadonlySet<string>;
}

/** Where each kind of claim evidence lives, and the one state in which it is finished history. */
const EVIDENCE: Readonly<Record<string, { table: string; field: string; terminal?: string }>> = {
  DEPOSIT: { table: "deposits", field: "depositId", terminal: "REFUNDED" },
  FINANCE: { table: "financeApplications", field: "applicationId", terminal: "CANCELLED" },
  RESERVATION: { table: "vehicleReservations", field: "reservationId" },
};

/** Kept rows of these classes that name a purged id are what the generic survivor scan would refuse. */
const REFERRER_CLASSES: ReadonlySet<string> = new Set(["ROOT", "EXPLICIT_ROOT", "OWNED_CHILD", "REFUSE_IF_REFERENCED"]);

function byKey(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The roots that are PROVEN to be a purged sale's one commitment: CONSUMED by that sale, for the sale's own vehicle and
 * customer (a sale has exactly one of each, cashSales.schema.ts), and the only root that does so. Two roots for one sale, or
 * a root for another car or customer, prove nothing, so neither joins; the kept root then refuses (COMMITMENT_SHARED_LINEAGE).
 */
function boundRoots(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>): Row[] {
  const sales = new Map((tableRows.get("sales") ?? []).map((s) => [s._id, s]));
  const named = (tableRows.get(ROOTS) ?? []).filter((root) => root.status === "CONSUMED" && set.has(text(root.consumedBySaleId)));
  const bound = named.filter((root) => {
    const sale = sales.get(text(root.consumedBySaleId));
    return sale !== undefined && sale.vehicleId === root.vehicleId && sale.customerId === root.customerId;
  });
  return bound.filter((root) => bound.filter((other) => other.consumedBySaleId === root.consumedBySaleId).length === 1);
}

/** Pre-closure: a CONSUMED root bound to a purged sale joins, and so do its claims (unless a kept sale consumed one). */
export function joinConsumedRoots(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>): void {
  const joined = new Set<string>();
  for (const root of boundRoots(set, tableRows)) {
    set.add(ROOTS, root._id);
    joined.add(root._id);
  }
  for (const claim of tableRows.get(CLAIMS) ?? []) {
    const consumer = text(claim.consumedBySaleId);
    if (joined.has(text(claim.rootId)) && (consumer === "" || set.has(consumer))) set.add(CLAIMS, claim._id);
  }
}

interface Scan {
  set: PurgeSet;
  tableRows: ReadonlyMap<string, Row[]>;
  tok: TokenIndex;
  out: ManifestRefusal[];
  judged: Set<string>;
  /** Commitment roots and claims in the purge. */
  mine: ReadonlySet<string>;
  /** Commitment roots and claims that stay. */
  kept: ReadonlyMap<string, Row>;
  byId: ReadonlyMap<string, Row>;
}

type Code = "COMMITMENT_ROOT_NOT_CONSUMED" | "COMMITMENT_EVIDENCE_LIVE" | "COMMITMENT_ACTIVE_HOLD" | "COMMITMENT_SHARED_LINEAGE" | "COMMITMENT_CURRENT_FOR_VEHICLE";

const refuse = (scan: Scan, code: Code, table: string, detail: string): void => {
  scan.out.push({ code, table, detail, count: 1 });
};

function buildScan(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, out: ManifestRefusal[]): Scan {
  const byId = new Map<string, Row>();
  for (const table of [ROOTS, CLAIMS, "deposits", "financeApplications", "vehicleReservations"]) {
    for (const row of tableRows.get(table) ?? []) byId.set(row._id, row);
  }
  const mine = new Set<string>([...(set.byTable.get(ROOTS) ?? []), ...(set.byTable.get(CLAIMS) ?? [])]);
  const kept = new Map<string, Row>();
  for (const table of [ROOTS, CLAIMS]) {
    for (const row of tableRows.get(table) ?? []) if (!mine.has(row._id)) kept.set(row._id, row);
  }
  return { set, tableRows, tok, out, judged: new Set(), mine, kept, byId };
}

/** The refusal a KEPT row earns for naming the purge, or null when it names no commitment row and is not a kept root of it. */
function referrerCode(scan: Scan, table: string, row: Row): Code | null {
  const named = scan.tok.of(row).filter((t) => scan.set.has(t));
  if (table === HOLDS && row.active === true && named.some((t) => scan.mine.has(t))) return "COMMITMENT_ACTIVE_HOLD";
  const namesOther = named.some((t) => !scan.mine.has(t));
  if (table === ROOTS && row.status !== "CONSUMED" && namesOther) return "COMMITMENT_ROOT_NOT_CONSUMED";
  return named.some((t) => scan.mine.has(t)) ? "COMMITMENT_SHARED_LINEAGE" : null;
}

const REFERRER_DETAIL: Readonly<Record<string, string>> = {
  COMMITMENT_ROOT_NOT_CONSUMED: "a kept commitment root that is not CONSUMED names the purge: only a CONSUMED root leaves, with the sale that consumed it",
  COMMITMENT_ACTIVE_HOLD: "an ACTIVE deposit hold still points at a purged commitment claim",
  COMMITMENT_SHARED_LINEAGE: "a kept row still points at a purged commitment root or claim (the same lineage lives on)",
};

const UNBOUND_ROOT_DETAIL = "a kept CONSUMED commitment root names a purged sale but is not proven to be that sale's one commitment (another vehicle or customer, or a second root for the same sale), so it stays";

/** A kept CONSUMED root that names a purged sale: the join refused it (see boundRoots), so it must refuse the purge. */
const isUnboundConsumedRoot = (table: string, row: Row, sales: ReadonlySet<string> | undefined): boolean =>
  table === ROOTS && row.status === "CONSUMED" && sales?.has(text(row.consumedBySaleId)) === true;

/** Kept rows that name a purged commitment row (or a kept root that is not CONSUMED naming the purge). */
function checkReferrers(scan: Scan): void {
  const sales = scan.set.byTable.get("sales");
  for (const [table, rows] of scan.tableRows) {
    if (!REFERRER_CLASSES.has(PURGE_IMPACT_MAP[table])) continue;
    for (const row of rows) {
      if (scan.set.has(row._id)) continue;
      const unbound = isUnboundConsumedRoot(table, row, sales);
      const code = referrerCode(scan, table, row);
      if (code === null && !unbound) continue;
      if (unbound) refuse(scan, "COMMITMENT_SHARED_LINEAGE", table, UNBOUND_ROOT_DETAIL);
      if (code !== null) refuse(scan, code, table, REFERRER_DETAIL[code]);
      // Judged only when these codes explain EVERY purged id the row names; any other id stays a generic survivor.
      const explained = (t: string): boolean => scan.mine.has(t) || ((unbound || code === "COMMITMENT_ROOT_NOT_CONSUMED") && sales?.has(t) === true);
      if (scan.tok.of(row).filter((t) => scan.set.has(t)).every(explained)) scan.judged.add(row._id);
    }
  }
}

/** A purged commitment row that names a KEPT root or claim (a restored-from or lineage link) leaves that lineage dangling. */
function checkKeptLinks(scan: Scan, row: Row, table: string): void {
  const keptNamed = scan.tok.of(row).some((t) => scan.kept.has(t));
  if (keptNamed) refuse(scan, "COMMITMENT_SHARED_LINEAGE", table, "a purged commitment row names a KEPT root or claim of the same lineage");
}

const vehicleIdsOf = (value: unknown): string[] => (Array.isArray(value) ? (value as Array<{ vehicleId?: unknown }>) : []).map((v) => text(v?.vehicleId)).filter((id) => id !== "");

/** The vehicles the evidence row itself names (empty when it names none, e.g. a deposit without a vehicle). */
function evidenceVehicles(row: Row): string[] {
  return [text(row.vehicleId), ...vehicleIdsOf(row.vehicleItems)].filter((id) => id !== "");
}

/** The claims the evidence row names as ITS commitment for this vehicle (deposit pointer, application current claims). */
function evidenceClaimPointers(row: Row, vehicleId: string): string[] {
  const own = text(row.singleVehicleCommitmentClaimId);
  const current = (Array.isArray(row.currentCommitmentClaims) ? row.currentCommitmentClaims : [])
    .filter((c: { vehicleId?: unknown }) => text(c?.vehicleId) === vehicleId).map((c: { claimId?: unknown }) => text(c?.claimId));
  return [own, ...current].filter((id) => id !== "");
}

/**
 * Binding (round-3 lesson from 1b): the row a claim names must really be THIS claim's evidence, not merely some row that is
 * purged or terminal. It must belong to the claim root's customer, name the claim's vehicle when it names any, and not name
 * another KEPT claim as its own commitment. Returns why it is not bound, or null.
 */
function unboundWhy(scan: Scan, claim: Row, row: Row): string | null {
  const root = scan.byId.get(text(claim.rootId));
  if (!root || text(row.customerId) !== text(root.customerId)) return "the evidence row belongs to another customer than the claim's root";
  const vehicles = evidenceVehicles(row);
  if (vehicles.length > 0 && !vehicles.includes(text(claim.vehicleId))) return "the evidence row names another vehicle than the claim";
  const elsewhere = evidenceClaimPointers(row, text(claim.vehicleId)).filter((id) => id !== claim._id && !scan.mine.has(id));
  return elsewhere.length > 0 ? "the evidence row is the commitment evidence of another, kept claim" : null;
}

interface Evidence {
  finished: boolean;
  label: string;
  /** The claim names a KEPT evidence row that is not (bound and terminal): the I10 rule, for a claim that joined with its root. */
  keptLive: boolean;
}

/** The evidence row the claim names, judged: purged or terminal-and-BOUND is finished; a missing or unbound row fails closed. */
function judgeRow(scan: Scan, claim: Row): Evidence {
  const rule = EVIDENCE[text(claim.evidenceKind)];
  const id = rule ? text(claim[rule.field]) : "";
  const row = scan.byId.get(id);
  if (!rule || !row) return { finished: false, keptLive: false, label: `${text(claim.evidenceKind)} evidence was not read, so it cannot be proven finished` };
  const unbound = unboundWhy(scan, claim, row);
  if (unbound) return { finished: false, keptLive: !scan.set.has(id), label: unbound };
  if (scan.set.has(id)) return { finished: true, keptLive: false, label: `${rule.table} row is in the purge` };
  const state = text(row.status);
  const finished = rule.terminal !== undefined && state === rule.terminal;
  return { finished, keptLive: !finished, label: `${rule.table} row is ${state} and kept` };
}

/** The sale that consumed the claim's root: the only sale whose purge may finish a claim by itself ("consumed by a purged sale"). */
const rootSaleOf = (scan: Scan, claim: Row): string => text(scan.byId.get(text(claim.rootId))?.consumedBySaleId);

/**
 * What a claim rests on, and whether that is finished. An ACTIVE claim consumed by its OWN root's purged sale is finished;
 * a claim "consumed" by any other purged sale is not (no binding), so it falls through to its evidence row. A claim of any
 * status that names a KEPT evidence row which is not terminal and bound is `keptLive` (round 1, F1).
 */
function evidenceOf(scan: Scan, claim: Row): Evidence {
  const judged = judgeRow(scan, claim);
  const consumer = text(claim.consumedBySaleId);
  const own = consumer !== "" && consumer === rootSaleOf(scan, claim) && scan.set.has(consumer);
  if (own && (claim.status === "ACTIVE" || !judged.keptLive)) return { finished: true, keptLive: false, label: "consumed by a purged sale" };
  return judged;
}
/** An ACTIVE hold of the same deposit and vehicle that names no claim (a legacy slice) still backs the claim. */
function hasActiveHold(scan: Scan, claim: Row): boolean {
  return (scan.tableRows.get(HOLDS) ?? []).some((h) => !scan.set.has(h._id) && h.active === true
    && (h.sourceCommitmentClaimId === claim._id
      || (!h.sourceCommitmentClaimId && text(claim.depositId) !== "" && h.depositId === claim.depositId && h.vehicleId === claim.vehicleId)));
}

/** The kept root of a purged claim: an ACTIVE claim of a kept OPEN root is the car's current commitment. */
function checkKeptRoot(scan: Scan, claim: Row): void {
  const root = scan.kept.get(text(claim.rootId));
  if (!root) return;
  const current = claim.status === "ACTIVE" && root.status === "OPEN";
  if (current) refuse(scan, "COMMITMENT_CURRENT_FOR_VEHICLE", CLAIMS, "an ACTIVE claim of a kept OPEN commitment root is the vehicle's current commitment");
  else refuse(scan, "COMMITMENT_SHARED_LINEAGE", CLAIMS, "the claim's root is kept: the lineage lives on");
}

function checkClaim(scan: Scan, claim: Row): string {
  const { finished, keptLive, label } = evidenceOf(scan, claim);
  if (claim.status === "ACTIVE" ? !finished : keptLive) refuse(scan, "COMMITMENT_EVIDENCE_LIVE", CLAIMS, "a claim rests on live evidence that is kept: only evidence that is purged, or terminal (REFUNDED deposit, CANCELLED application) and bound to this claim, lets it go");
  if (claim.status === "ACTIVE" && hasActiveHold(scan, claim)) refuse(scan, "COMMITMENT_ACTIVE_HOLD", CLAIMS, "an ACTIVE deposit hold still backs the claim");
  checkKeptRoot(scan, claim);
  if (!scan.kept.has(text(claim.rootId))) checkKeptLinks(scan, claim, CLAIMS);
  return label;
}

function keptOpenRoots(scan: Scan): Map<string, string> {
  const open = new Map<string, string>();
  for (const root of scan.tableRows.get(ROOTS) ?? []) if (root.status === "OPEN" && scan.kept.has(root._id)) open.set(text(root.vehicleId), root._id);
  return open;
}

/** Judges the commitment rows the purge now holds; refusals go to `out`, the itemized list is for the owner. */
export function checkCommitments(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, out: ManifestRefusal[]): CommitmentFindings {
  const scan = buildScan(set, tableRows, tok, out);
  const open = keptOpenRoots(scan);
  const items: CommitmentItem[] = [];
  for (const root of (tableRows.get(ROOTS) ?? []).filter((r) => set.has(r._id))) {
    checkKeptLinks(scan, root, ROOTS);
    items.push({ kind: "root", id: root._id, status: text(root.status), vehicleId: text(root.vehicleId), evidence: `consumed by purged sale ${text(root.consumedBySaleId)}`, keptOpenRootId: open.get(text(root.vehicleId)) ?? null });
  }
  for (const claim of (tableRows.get(CLAIMS) ?? []).filter((r) => set.has(r._id))) {
    const evidence = checkClaim(scan, claim);
    items.push({ kind: "claim", id: claim._id, status: text(claim.status), vehicleId: text(claim.vehicleId), evidence, keptOpenRootId: open.get(text(claim.vehicleId)) ?? null });
  }
  checkReferrers(scan);
  return { items: items.toSorted((a, b) => byKey(`${a.kind}|${a.id}`, `${b.kind}|${b.id}`)), judged: scan.judged };
}
