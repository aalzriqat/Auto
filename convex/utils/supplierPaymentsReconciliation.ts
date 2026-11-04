import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { AP_AFFECTING_EVENT_TYPES, pendingAffectingPostingState } from "../accountingReports";
import { SYSTEM_KEYS } from "./defaultChart";
import { toMinorUnits } from "./money";
import { settlementView } from "./supplierSettlement";
import { STATEMENT_FAMILY_LIMIT } from "./supplierObligationDue";
import { readBoundedStream, type HeadroomCtx } from "./transactionReadHeadroom";

/**
 * SCRUM-869 per-supplier payments reconciliation (ADR docs/adr/2026-11-04-supplier-payments-gl-reconciliation.md).
 * Compares the cash the subledger says was paid to one supplier with the net debit to GL 2400 posted against that
 * supplier's payables. The credit side (what was owed) cannot be attributed to a supplier, so it is not compared.
 */
export type PaymentsReconciliationUnavailableReason =
  | "OVER_LIMIT"
  | "PENDING_POSTINGS"
  | "NO_CONTROL_ACCOUNT"
  | "INCONSISTENT_REFERENCE";

export type PaymentsReconciliationCurrency = {
  currency: string;
  subledgerPaidMinor: number;
  glPaidMinor: number;
  differenceMinor: number;
};

export type PaymentsReconciliationDifference = {
  payableId: Id<"vehicleSupplierPayables">;
  currency: string;
  subledgerPaidMinor: number;
  glPaidMinor: number;
};

export type PaymentsReconciliation = {
  status: "AVAILABLE" | "UNAVAILABLE";
  unavailableReason?: PaymentsReconciliationUnavailableReason;
  currencies: PaymentsReconciliationCurrency[];
  isReconciled: boolean;
  differences: PaymentsReconciliationDifference[];
  excludedOpeningRows: number;
  /** The obligation side has no supplier dimension on the ledger; it is never given a number here. */
  creditSide: "NOT_ATTRIBUTABLE";
};

/** Journal entries read across all of the supplier's payables. Each costs two index ranges; Convex allows 4,096 per function. */
const ENTRY_BUDGET = 1000;
const OUTBOX_READ_LIMIT = 400;
const LINES_PER_ENTRY_LIMIT = 50;

type PayableStatus = Doc<"vehicleSupplierPayables">["status"];
// Every status is read; a cancelled row may still carry payments. The record type makes a new status a compile error here.
const PAYABLE_STATUS_SET: Record<PayableStatus, true> = {
  PENDING: true,
  NOT_YET_DUE: true,
  DUE_ON_SALE: true,
  PARTIALLY_PAID: true,
  DISPUTED: true,
  PAID: true,
  CANCELLED: true,
};
const PAYABLE_STATUSES = Object.keys(PAYABLE_STATUS_SET) as PayableStatus[];

const unavailable = (unavailableReason: PaymentsReconciliationUnavailableReason): PaymentsReconciliation => ({
  status: "UNAVAILABLE",
  unavailableReason,
  currencies: [],
  isReconciled: false,
  differences: [],
  excludedOpeningRows: 0,
  creditSide: "NOT_ATTRIBUTABLE",
});

type Reason = PaymentsReconciliationUnavailableReason;
/** A read that either produced its value or says why the whole comparison is unavailable. */
type Read<T> = { ok: true; value: T } | { ok: false; reason: Reason };
const refuse = (reason: Reason): { ok: false; reason: Reason } => ({ ok: false, reason });

/** Postings still in flight: the GL is about to move, so a comparison now is not the truth. */
async function readInFlight(ctx: Pick<QueryCtx, "db"> & HeadroomCtx, orgId: Id<"organizations">): Promise<Read<Doc<"pendingAccountingEvents">[]>> {
  // In turn, not together: each document's headroom check must see what the reads before it spent.
  const inFlight: Doc<"pendingAccountingEvents">[] = [];
  for (const status of ["PENDING", "FAILED"] as const) {
    const read = await readBoundedStream(
      ctx,
      ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status)),
      OUTBOX_READ_LIMIT,
    );
    if (read.outOfHeadroom || read.docs.length > OUTBOX_READ_LIMIT) return refuse("OVER_LIMIT");
    inFlight.push(...read.docs);
  }
  return { ok: true, value: inFlight };
}

/** Why the queued postings make the comparison untrue, or null when none of them can move the AP side. */
async function pendingPostingsReason(
  ctx: Pick<QueryCtx, "db"> & HeadroomCtx,
  inFlight: Doc<"pendingAccountingEvents">[],
): Promise<Reason | null> {
  // A queued reversal of a supplier payment is typed JOURNAL_REVERSAL, which the AP classification marks false:
  // unknown must not read as safe, so any queued reversal makes this unavailable.
  if (inFlight.some((event) => event.eventType === "JOURNAL_REVERSAL")) return "PENDING_POSTINGS";
  // The original-event lookups spend the same read budget; running out of it is OVER_LIMIT, not "nothing pending".
  const pending = await pendingAffectingPostingState(ctx, inFlight, AP_AFFECTING_EVENT_TYPES);
  if (pending === "OVER_LIMIT") return "OVER_LIMIT";
  return pending === "AFFECTING" ? "PENDING_POSTINGS" : null;
}

/** Every payable of the supplier under one bound; past it nothing is summed (W14). */
async function readAllPayables(
  ctx: Pick<QueryCtx, "db"> & HeadroomCtx,
  orgId: Id<"organizations">,
  supplierId: Id<"suppliers">,
): Promise<Read<Doc<"vehicleSupplierPayables">[]>> {
  const payables: Doc<"vehicleSupplierPayables">[] = [];
  for (const status of PAYABLE_STATUSES) {
    const read = await readBoundedStream(
      ctx,
      ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_org_and_supplierId_and_status", (q) =>
          q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status),
        ),
      STATEMENT_FAMILY_LIMIT,
    );
    if (read.outOfHeadroom) return refuse("OVER_LIMIT");
    payables.push(...read.docs);
    if (payables.length > STATEMENT_FAMILY_LIMIT) return refuse("OVER_LIMIT");
  }
  return { ok: true, value: payables };
}

/** Net debit to the control account across one entry's lines, or the reason a line cannot be trusted. */
function controlDebitMinor(
  lines: Doc<"journalLines">[],
  args: { orgId: Id<"organizations">; controlAccountId: Id<"chartOfAccounts">; currency: string },
): Read<number> {
  let minor = 0;
  for (const line of lines) {
    if (line.orgId !== args.orgId) return refuse("INCONSISTENT_REFERENCE");
    if (line.accountId !== args.controlAccountId) continue;
    if (line.currency !== args.currency) return refuse("INCONSISTENT_REFERENCE");
    minor += line.debitMinor - line.creditMinor;
  }
  return { ok: true, value: minor };
}

/** The GL side of one payable: its posted entries' lines on the control account. `entriesRead` is spent from the shared budget. */
async function readGlPaid(
  ctx: Pick<QueryCtx, "db"> & HeadroomCtx,
  args: { orgId: Id<"organizations">; payable: Doc<"vehicleSupplierPayables">; controlAccountId: Id<"chartOfAccounts">; entriesLeft: number },
): Promise<Read<{ glPaidMinor: number; entriesRead: number }>> {
  const { orgId, payable, controlAccountId, entriesLeft } = args;
  const entryRead = await readBoundedStream(
    ctx,
    ctx.db
      .query("journalEntries")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payable._id),
      ),
    Math.max(entriesLeft, 0),
  );
  const entries = entryRead.docs;
  if (entryRead.outOfHeadroom || entries.length > entriesLeft) return refuse("OVER_LIMIT");
  let glPaidMinor = 0;
  for (const entry of entries) {
    if (entry.status !== "POSTED" && entry.status !== "REVERSED") continue;
    const lineRead = await readBoundedStream(
      ctx,
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)),
      LINES_PER_ENTRY_LIMIT,
    );
    if (lineRead.outOfHeadroom || lineRead.docs.length > LINES_PER_ENTRY_LIMIT) return refuse("OVER_LIMIT");
    const debit = controlDebitMinor(lineRead.docs, { orgId, controlAccountId, currency: payable.currency });
    if (!debit.ok) return debit;
    glPaidMinor += debit.value;
  }
  return { ok: true, value: { glPaidMinor, entriesRead: entries.length } };
}

/** Subledger paid and GL paid, per payable. */
async function compareEachPayable(
  ctx: Pick<QueryCtx, "db"> & HeadroomCtx,
  orgId: Id<"organizations">,
  payables: Doc<"vehicleSupplierPayables">[],
): Promise<Read<PaymentsReconciliationDifference[]>> {
  const controlAccount = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS))
    .unique();
  const perPayable: PaymentsReconciliationDifference[] = [];
  let entriesRead = 0;
  for (const payable of payables) {
    const subledgerPaidMinor = toMinorUnits(settlementView(payable).amountPaid, payable.currency);
    let glPaidMinor = 0;
    if (controlAccount) {
      const gl = await readGlPaid(ctx, { orgId, payable, controlAccountId: controlAccount._id, entriesLeft: ENTRY_BUDGET - entriesRead });
      if (!gl.ok) return gl;
      entriesRead += gl.value.entriesRead;
      glPaidMinor = gl.value.glPaidMinor;
    } else if (subledgerPaidMinor !== 0) {
      return refuse("NO_CONTROL_ACCOUNT");
    }
    perPayable.push({ payableId: payable._id, currency: payable.currency, subledgerPaidMinor, glPaidMinor });
  }
  return { ok: true, value: perPayable };
}

/** Per currency, never blended (W7). */
function totalsByCurrency(perPayable: PaymentsReconciliationDifference[]): PaymentsReconciliationCurrency[] {
  const totals = new Map<string, PaymentsReconciliationCurrency>();
  for (const row of perPayable) {
    const total = totals.get(row.currency) ?? {
      currency: row.currency,
      subledgerPaidMinor: 0,
      glPaidMinor: 0,
      differenceMinor: 0,
    };
    total.subledgerPaidMinor += row.subledgerPaidMinor;
    total.glPaidMinor += row.glPaidMinor;
    total.differenceMinor = total.subledgerPaidMinor - total.glPaidMinor;
    totals.set(row.currency, total);
  }
  return [...totals.values()].filter((c) => c.subledgerPaidMinor !== 0 || c.glPaidMinor !== 0);
}

/**
 * The caller must already have proved the supplier belongs to `orgId`.
 *
 * Every read below goes through `readBoundedStream`: a row cap bounds documents, not bytes, and one function may read 16 MiB
 * (https://docs.convex.dev/production/state/limits). A read the transaction has no room for answers UNAVAILABLE / OVER_LIMIT with
 * no totals, the same refusal as a row cap, instead of throwing "Read too much data" (#764 round 4).
 */
export async function readSupplierPaymentsReconciliation(
  ctx: Pick<QueryCtx, "db"> & HeadroomCtx,
  args: { orgId: Id<"organizations">; supplierId: Id<"suppliers"> },
): Promise<PaymentsReconciliation> {
  const { orgId, supplierId } = args;

  const inFlight = await readInFlight(ctx, orgId);
  if (!inFlight.ok) return unavailable(inFlight.reason);
  const pendingReason = await pendingPostingsReason(ctx, inFlight.value);
  if (pendingReason) return unavailable(pendingReason);

  const payables = await readAllPayables(ctx, orgId, supplierId);
  if (!payables.ok) return unavailable(payables.reason);
  // Opening-basis payables settle against opening accounts, not 2400: out of both sides, and counted.
  const native = payables.value.filter((p) => p.origin !== "OPENING");
  const excludedOpeningRows = payables.value.length - native.length;

  const compared = await compareEachPayable(ctx, orgId, native);
  if (!compared.ok) return unavailable(compared.reason);
  const perPayable = compared.value;
  const differences = perPayable.filter((row) => row.subledgerPaidMinor !== row.glPaidMinor);
  return {
    status: "AVAILABLE",
    currencies: totalsByCurrency(perPayable),
    isReconciled: differences.length === 0,
    differences,
    excludedOpeningRows,
    creditSide: "NOT_ATTRIBUTABLE",
  };
}