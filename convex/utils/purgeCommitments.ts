/**
 * SCRUM-1023 Phase 1c (owner ruling 2026-11-27, Jira SCRUM-1023 comments 26166-26168, invariant I17): amounts and holds
 * hanging on cancelled deals are released, so a CONSUMED commitment root leaves WITH the sale that consumed it and a stale
 * claim leaves with its deal. READ-ONLY and pure: it works on rows the manifest already read (no read of its own).
 *
 * - A root joins ONLY when its status is CONSUMED and the sale that consumed it is itself in the purge. Its claims join
 *   with it (joinConsumedRoots), so a claim on a kept CANCELLED application still goes.
 * - A claim in the purge is judged by its evidence: the deposit, application or sale it rests on must be purged, or be
 *   terminal (REFUNDED deposit, CANCELLED application). A reservation has no terminal state. Missing evidence fails closed.
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

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Pre-closure: a CONSUMED root consumed by a purged sale joins, and so do its claims (unless a kept sale consumed one). */
export function joinConsumedRoots(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>): void {
  const joined = new Set<string>();
  for (const root of tableRows.get(ROOTS) ?? []) {
    if (root.status === "CONSUMED" && set.has(text(root.consumedBySaleId))) {
      set.add(ROOTS, root._id);
      joined.add(root._id);
    }
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

/** Kept rows that name a purged commitment row (or a kept root that is not CONSUMED naming the purge). */
function checkReferrers(scan: Scan): void {
  for (const [table, rows] of scan.tableRows) {
    if (!REFERRER_CLASSES.has(PURGE_IMPACT_MAP[table])) continue;
    for (const row of rows) {
      if (scan.set.has(row._id)) continue;
      const code = referrerCode(scan, table, row);
      if (code === null) continue;
      refuse(scan, code, table, REFERRER_DETAIL[code]);
      // Judged only when this code explains EVERY purged id the row names; any other id stays a generic survivor.
      const sales = scan.set.byTable.get("sales");
      const explained = (t: string): boolean => scan.mine.has(t) || (code === "COMMITMENT_ROOT_NOT_CONSUMED" && sales?.has(t) === true);
      if (scan.tok.of(row).filter((t) => scan.set.has(t)).every(explained)) scan.judged.add(row._id);
    }
  }
}

/** A purged commitment row that names a KEPT root or claim (a restored-from or lineage link) leaves that lineage dangling. */
function checkKeptLinks(scan: Scan, row: Row, table: string): void {
  const keptNamed = scan.tok.of(row).some((t) => scan.kept.has(t));
  if (keptNamed) refuse(scan, "COMMITMENT_SHARED_LINEAGE", table, "a purged commitment row names a KEPT root or claim of the same lineage");
}

/** What a claim rests on, and whether that is finished (purged, or terminal). A missing row fails closed. */
function evidenceOf(scan: Scan, claim: Row): { finished: boolean; label: string } {
  if (scan.set.has(text(claim.consumedBySaleId))) return { finished: true, label: "consumed by a purged sale" };
  const rule = EVIDENCE[text(claim.evidenceKind)];
  const id = rule ? text(claim[rule.field]) : "";
  const row = scan.byId.get(id);
  if (!rule || !row) return { finished: false, label: `${text(claim.evidenceKind)} evidence was not read, so it cannot be proven finished` };
  if (scan.set.has(id)) return { finished: true, label: `${rule.table} row is in the purge` };
  const state = text(row.status);
  return { finished: rule.terminal !== undefined && state === rule.terminal, label: `${rule.table} row is ${state} and kept` };
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
  const { finished, label } = evidenceOf(scan, claim);
  if (claim.status === "ACTIVE" && !finished) refuse(scan, "COMMITMENT_EVIDENCE_LIVE", CLAIMS, "an ACTIVE claim rests on live evidence that is kept: only evidence that is purged or terminal (REFUNDED deposit, CANCELLED application) lets it go");
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
