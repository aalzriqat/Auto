/**
 * SCRUM-1023 Phase 1b (owner rulings B and C, 2026-11-27): the two new explicit roots. READ-ONLY, pure.
 *
 *  B. A CANCELLED payroll run (`payrollRunIds`). Eligible only when NOTHING proves it ever took effect. The `status`
 *     field is never the proof (it only got the run past `loadRoot`): the proof is the absence of payment and ledger
 *     evidence, read from the rows that would carry it:
 *       - the run's own paid fields (paidAt / paidBy / paidMethod / paidBankAccountId);
 *       - a row that names one of its payslips: an advance recovery, a commission line or an opening commission
 *         liability paid on it (PURGE_PAYROLL_PAYMENT_TABLES);
 *       - a POSTED accounting event that names the run or a payslip and was never reversed (PAYROLL_ACCRUED /
 *         PAYROLL_PAID). A complete reversed pair is acceptable history and goes through the normal pair + net-zero proof.
 *     The payslips leave with the run even when they name a real sale (that is the point of the ruling); any OTHER kept
 *     row that names the run or a payslip is a surviving reference (the survivor mechanism, not this module).
 *  C. A fully REFUNDED deposit (`depositIds`). The deposit row must say so (status REFUNDED, refunded == amount ==
 *     released, nothing forfeited, hold not active, not an opening deposit), every hold slice must be resolved and inactive
 *     and name no kept sale, and its ledger must prove it: at least one POSTED, unreversed DEPOSIT_RECEIVED and one
 *     DEPOSIT_REFUNDED event whose `payload.amountMinor` totals both equal the deposit amount, and no other live event
 *     (a forfeiture, an application, a refund return) naming it. The receipt and the refund are two independent events,
 *     not a reversal pair, so they are exempt from PAIRING only; the net-zero proof per (period, account, currency, bank)
 *     still runs over their journal lines, so a refund booked to another period, account or bank refuses (NONZERO_NET).
 */
import { PURGE_OWNED_CHILDREN, PURGE_PAYROLL_PAYMENT_TABLES } from "./purgeImpactMap";
import { namesLiveRoot, type ManifestRefusal, type PurgeSet, type Row, type TokenIndex } from "./purgeSurvivors";

export interface RootProof {
  kind: "payrollRun" | "deposit";
  id: string;
  /** Payroll: the payslips that leave with the run. */
  itemIds?: string[];
  /** Deposit: the receipt and refund events proven, and the amount both equal. */
  receiptEventIds?: string[];
  refundEventIds?: string[];
  amountMinor?: number;
}

export interface RootProofResult {
  refusals: ManifestRefusal[];
  proofs: RootProof[];
  /** Events and journals of a deposit's receipt/refund: exempt from pair completeness only (netting still applies). */
  exemptEventIds: Set<string>;
  exemptJournalIds: Set<string>;
}

const byText = (a: string, b: string): number => a.localeCompare(b);

/** Children that belong to a purged explicit root through their owner field join with it, before the closure grows. */
export function joinOwnedChildren(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>): void {
  for (const [child, rule] of Object.entries(PURGE_OWNED_CHILDREN)) {
    const parents = set.byTable.get(rule.parent);
    if (!parents) continue;
    for (const row of tableRows.get(child) ?? []) {
      const owner = row[rule.field];
      if (typeof owner === "string" && parents.has(owner)) set.add(child, row._id);
    }
  }
}

/** An explicit root row that itself names a kept sale, application or expense (a deposit applied to a real sale) is shared. */
export function sharedExplicitRoots(
  set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, rootClassIds: ReadonlySet<string>, shared: Map<string, string>,
): void {
  for (const table of ["payrollRuns", "deposits"]) {
    for (const row of tableRows.get(table) ?? []) {
      if (set.rootIds.has(row._id) && namesLiveRoot(tok.of(row), set, rootClassIds)) shared.set(row._id, table);
    }
  }
}

const refuse = (out: ManifestRefusal[], code: ManifestRefusal["code"], table: string, detail: string, count = 1): void => {
  if (count > 0) out.push({ code, table, detail, count });
};

/** The events of the scanned ledger that name any of these ids. */
const eventsNaming = (tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, ids: ReadonlySet<string>): Row[] =>
  (tableRows.get("accountingEvents") ?? []).filter((e) => tok.of(e).some((t) => ids.has(t)));

function provePayrollRun(
  run: Row, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, out: ManifestRefusal[],
): RootProof {
  const itemIds = (tableRows.get("payrollItems") ?? []).filter((i) => i.runId === run._id).map((i) => i._id).sort(byText);
  const items = new Set(itemIds);
  const named = new Set([run._id, ...itemIds]);
  const paidFields = ["paidAt", "paidBy", "paidMethod", "paidBankAccountId"].filter((f) => run[f] !== undefined && run[f] !== null);
  refuse(out, "PAYROLL_RUN_PAYMENT_EVIDENCE", "payrollRuns", `the run carries paid fields (${paidFields.join(", ")}): it was paid`, paidFields.length > 0 ? 1 : 0);
  for (const table of PURGE_PAYROLL_PAYMENT_TABLES) {
    const hits = (tableRows.get(table) ?? []).filter((r) => tok.of(r).some((t) => items.has(t))).length;
    refuse(out, "PAYROLL_RUN_PAYMENT_EVIDENCE", table, "a row records a payment or deduction made on a payslip of this run", hits);
  }
  const live = eventsNaming(tableRows, tok, named).filter((e) => e.status === "POSTED" && e.eventType !== "JOURNAL_REVERSAL").length;
  refuse(out, "PAYROLL_RUN_LEDGER_EFFECT", "accountingEvents", "a POSTED, never-reversed accounting event names the run or one of its payslips: it took effect in the ledger", live);
  return { kind: "payrollRun", id: run._id, itemIds };
}

const RECEIPT = "DEPOSIT_RECEIVED";
const REFUND = "DEPOSIT_REFUNDED";

function notRefundedWhy(d: Row): string | null {
  const amount = d.amountMinor;
  if (d.status !== "REFUNDED") return `the deposit is ${String(d.status)}, not REFUNDED`;
  if (d.origin !== undefined) return "an opening deposit is outside this ruling";
  if (d.holdActive === true) return "the deposit still holds its vehicle";
  if (typeof amount !== "number" || amount <= 0) return "the deposit has no amount in minor units to prove against";
  if (d.refundedAmountMinor !== amount) return "the refunded amount is not the whole deposit (partly refunded)";
  if (d.releasedAmountMinor !== undefined && d.releasedAmountMinor !== amount) return "released and deposit amounts differ (an open balance)";
  if (typeof d.forfeitedAmountMinor === "number" && d.forfeitedAmountMinor !== 0) return "part of the deposit was forfeited";
  return null;
}

const payloadAmount = (e: Row): number | null => {
  const payload = e.payload as { amountMinor?: unknown } | undefined;
  return typeof payload?.amountMinor === "number" ? payload.amountMinor : null;
};

function proveDeposit(
  d: Row, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, set: PurgeSet, rootClassIds: ReadonlySet<string>,
  out: ManifestRefusal[], exempt: { events: Set<string>; journals: Set<string> },
): RootProof {
  const proof: RootProof = { kind: "deposit", id: d._id };
  // The receipt and the refund are exempt from pairing even when another check refuses, so one cause shows as one refusal.
  const mine = eventsNaming(tableRows, tok, new Set([d._id]));
  const receipts = mine.filter((e) => e.eventType === RECEIPT && e.status === "POSTED");
  const refunds = mine.filter((e) => e.eventType === REFUND && e.status === "POSTED");
  for (const e of [...receipts, ...refunds]) {
    exempt.events.add(e._id);
    if (typeof e.journalEntryId === "string") exempt.journals.add(e.journalEntryId);
  }
  const why = notRefundedWhy(d);
  if (why) { refuse(out, "DEPOSIT_NOT_REFUNDED", "deposits", why); return proof; }
  // A pointer from the deposit to a payment or commitment row that is not leaving would strand that row without its deposit.
  const pointers = [d.canonicalPaymentId, d.singleVehicleCommitmentClaimId].filter((id): id is string => typeof id === "string" && !set.has(id));
  if (pointers.length > 0) {
    refuse(out, "DEPOSIT_REFUND_PROOF", "deposits", "the deposit points at a payment or commitment row that is not in the purge set", pointers.length);
    return proof;
  }
  const badHolds = (tableRows.get("depositVehicleHolds") ?? []).filter((h) =>
    h.depositId === d._id && (h.active !== false || h.allocationStatus !== "RESOLVED" || namesLiveRoot(tok.of(h), set, rootClassIds)));
  if (badHolds.length > 0) {
    refuse(out, "DEPOSIT_NOT_REFUNDED", "depositVehicleHolds", "a vehicle slice of the deposit is still active, unresolved or applied to a kept sale", badHolds.length);
    return proof;
  }
  const others = mine.filter((e) => e.status !== "REVERSED" && e.eventType !== "JOURNAL_REVERSAL" && e.eventType !== RECEIPT && e.eventType !== REFUND);
  const sum = (events: Row[]): number | null => {
    const amounts = events.map(payloadAmount);
    return amounts.length === 0 || amounts.some((a) => a === null) ? null : amounts.reduce<number>((t, a) => t + (a ?? 0), 0);
  };
  const [received, refunded] = [sum(receipts), sum(refunds)];
  if (others.length > 0) {
    refuse(out, "DEPOSIT_REFUND_PROOF", "accountingEvents", "a live event other than the receipt and the refund names the deposit (forfeiture, application, refund return)", others.length);
  } else if (received === null || refunded === null) {
    refuse(out, "DEPOSIT_REFUND_PROOF", "accountingEvents", "the ledger does not hold both a POSTED receipt and a POSTED refund of the deposit with their amounts");
  } else if (received !== d.amountMinor || refunded !== d.amountMinor) {
    refuse(out, "DEPOSIT_REFUND_PROOF", "accountingEvents", "the receipt and refund amounts are not both the deposit amount");
  }
  return { ...proof, receiptEventIds: receipts.map((e) => e._id).sort(byText), refundEventIds: refunds.map((e) => e._id).sort(byText), amountMinor: received ?? undefined };
}

/** Proves every explicit root in the final set. Roots are the only members of `payrollRuns` and `deposits` (neither joins by closure). */
export function proveExplicitRoots(
  set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, rootClassIds: ReadonlySet<string>,
): RootProofResult {
  const result: RootProofResult = { refusals: [], proofs: [], exemptEventIds: new Set(), exemptJournalIds: new Set() };
  const exempt = { events: result.exemptEventIds, journals: result.exemptJournalIds };
  for (const run of tableRows.get("payrollRuns") ?? []) {
    if (set.rootIds.has(run._id)) result.proofs.push(provePayrollRun(run, tableRows, tok, result.refusals));
  }
  for (const d of tableRows.get("deposits") ?? []) {
    if (set.rootIds.has(d._id)) result.proofs.push(proveDeposit(d, tableRows, tok, set, rootClassIds, result.refusals, exempt));
  }
  result.proofs.sort((a, b) => byText(`${a.kind}|${a.id}`, `${b.kind}|${b.id}`));
  return result;
}
