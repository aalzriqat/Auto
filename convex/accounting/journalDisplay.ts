/**
 * SCRUM-1013 — read-side display facts for the General Ledger journal screen.
 *
 * The journal list used to print `sourceType: sourceId` (for a treasury transfer
 * the sourceId is the client's idempotency key, a JSON tuple of internal ids) and
 * the stored English memo. Nothing here changes a stored row: every field below
 * is derived at read time from columns the posting engine already wrote — the
 * entry's accounting event, its reversal links and the lines' bank ids — so the
 * screen can localize the text and never needs the raw key.
 *
 * Reads are bounded by the page the caller already asked for: one batched pass
 * over the distinct events, linked entries and banks of that page, each lookup
 * tenant-checked (a row from another organization is treated as absent).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { EventType } from "./postingRules";
import { readTreasuryTransferPayload, TREASURY_TRANSFER_EVENT } from "./treasuryTransfer";

export const JOURNAL_SOURCE_FAMILIES = [
  "SALE", "DEPOSIT", "COLLECTION", "CHEQUE", "EXPENSE", "COMMISSION", "FINANCE", "PAYMENT_LINK",
  "SUPPLIER", "INVENTORY", "FIXED_ASSET", "EQUITY", "CASH_DRAWER", "TREASURY_TRANSFER", "PAYROLL",
  "CUSTODY", "MANUAL_JOURNAL", "OPENING_BALANCE", "OTHER",
] as const;
export type JournalSourceFamily = (typeof JOURNAL_SOURCE_FAMILIES)[number];

/**
 * The family an entry belongs to, keyed by the accounting event that posted it —
 * the economic family, not the table name (one table, e.g. `financeApplications`,
 * hosts several families). Exhaustive over EventType (`satisfies`), so a new event
 * type fails typecheck until it is classified, like AP_AFFECTING_BY_EVENT_TYPE.
 */
export const SOURCE_FAMILY_BY_EVENT_TYPE = {
  DEPOSIT_RECEIVED: "DEPOSIT", DEPOSIT_APPLIED: "DEPOSIT", DEPOSIT_APPLIED_TO_SETTLEMENT: "DEPOSIT",
  DEPOSIT_REFUNDED: "DEPOSIT", DEPOSIT_REFUND_RETURNED: "DEPOSIT", DEPOSIT_FORFEITED: "DEPOSIT",
  SALE_COMPLETED: "SALE", SALE_CANCELLED: "SALE", CONSIGNED_SALE_RECLASSIFIED: "SALE",
  COLLECTION_PAYMENT: "COLLECTION", COLLECTION_REFUND: "COLLECTION",
  RECEIPT_CREDIT_APPLIED: "COLLECTION", RETAINED_CREDIT_REFUNDED: "COLLECTION", RECEIVABLE_CREATED: "COLLECTION",
  EXPENSE_POSTED: "EXPENSE",
  PREPAID_EXPENSE_AMORTIZED: "EXPENSE", PREPAID_EXPENSE_REFUNDED: "EXPENSE", PREPAID_EXPENSE_WRITTEN_OFF: "EXPENSE",
  CHEQUE_RECEIVED: "CHEQUE", CHEQUE_DEPOSITED: "CHEQUE", CHEQUE_CLEARED: "CHEQUE", CHEQUE_RETURNED: "CHEQUE",
  COMMISSION_ACCRUED: "COMMISSION", COMMISSION_ADJUSTED: "COMMISSION", COMMISSION_PAID: "COMMISSION",
  FINANCE_DISBURSED: "FINANCE", FINANCE_CASH_RECEIVED: "FINANCE", FINANCE_COMPANY_FORWARD_PAID: "FINANCE",
  FI_COMMISSION_RECOGNIZED: "FINANCE", CLAIM_SETTLED: "FINANCE", CLAIM_WRITTEN_OFF: "FINANCE",
  PAYMENT_LINK_RECEIVED: "PAYMENT_LINK",
  SUPPLIER_PAYMENT_SETTLED: "SUPPLIER", SUPPLIER_RECEIVABLE_COLLECTED: "SUPPLIER",
  SUPPLIER_COST_RECOVERY_RECEIVED: "SUPPLIER",
  ASSET_CAPITALIZED: "FIXED_ASSET", DEPRECIATION_POSTED: "FIXED_ASSET",
  ASSET_IMPAIRED: "FIXED_ASSET", ASSET_DISPOSED: "FIXED_ASSET",
  CAPITAL_CONTRIBUTED: "EQUITY", PARTNER_DREW: "EQUITY", PROFIT_DISTRIBUTED: "EQUITY",
  CASH_DRAWER_DEPOSITED: "CASH_DRAWER", TREASURY_TRANSFER: "TREASURY_TRANSFER",
  // SCRUM-1012: a bank's stored opening balance posted late. Its journal category is ADJUSTMENT (so the
  // organization-opening proofs never see it), but economically it is an opening balance.
  BANK_OPENING_BALANCE_LATE: "OPENING_BALANCE",
  VEHICLE_ACQUIRED: "INVENTORY", VEHICLE_LANDED_COST_CAPITALIZED: "INVENTORY",
  VEHICLE_INVENTORY_OPENING_BALANCE: "INVENTORY", VEHICLE_ACQUISITION_COST_CORRECTED: "INVENTORY",
  VEHICLE_PREP_EXPENSE_RECLASSIFIED: "INVENTORY", TRADE_IN_ACCEPTED: "INVENTORY",
  EMPLOYEE_ADVANCE_PAID: "PAYROLL", EMPLOYEE_ADVANCE_RECOVERED: "PAYROLL",
  PAYROLL_ACCRUED: "PAYROLL", PAYROLL_PAID: "PAYROLL",
  CUSTODY_CASH_ISSUED: "CUSTODY", CUSTODY_CASH_RETURNED: "CUSTODY", CUSTODY_REIMBURSED: "CUSTODY",
  CUSTODY_FEE_PAID: "CUSTODY", CUSTODY_WRITTEN_OFF: "CUSTODY", CUSTODY_PAYABLE_RECLASSIFIED: "CUSTODY",
  HANDOVER_COST_PAID_DIRECT: "CUSTODY",
  // A reversal is classified by the event it reverses, resolved below.
  JOURNAL_REVERSAL: "OTHER",
} as const satisfies Record<EventType, JournalSourceFamily>;

/** Every event type the screen can label: the closed EventType union, as data. */
export const JOURNAL_DISPLAY_EVENT_TYPES = Object.keys(SOURCE_FAMILY_BY_EVENT_TYPE) as EventType[];

export function isKnownEventType(value: unknown): value is EventType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SOURCE_FAMILY_BY_EVENT_TYPE, value);
}

export type TransferEndpoint = { kind: "CASH" } | { kind: "BANK"; bankName: string | null };

export interface JournalEntryLink {
  journalEntryId: Id<"journalEntries">;
  journalNumber: string;
}

export interface JournalEntryDisplay {
  sourceFamily: JournalSourceFamily;
  /** The economic event. For a reversal, the event it reverses (see `isReversal`). */
  eventType: EventType | null;
  isReversal: boolean;
  /** Text a person typed: a transfer reference, a reversal reason, a manual journal memo. */
  note: string | null;
  transfer: { from: TransferEndpoint; to: TransferEndpoint } | null;
  reversalOf: JournalEntryLink | null;
  reversedBy: JournalEntryLink | null;
}

export interface JournalLineDisplay {
  /** Name of the physical bank a BANK_ACCOUNT line moved money through, same org only. */
  bankName: string | null;
  /** Leg of a treasury transfer: line 1 is the destination, line 2 the source (see requireTreasuryReversal). */
  transferLeg: "IN" | "OUT" | null;
  /** The stored line description without the reversal engine's `[REVERSAL]` marker. */
  description: string | null;
  isReversalLine: boolean;
}

const REVERSAL_LINE_MARKER = "[REVERSAL]";

type TransferPayload = ReturnType<typeof readTreasuryTransferPayload>;

function safeTransferPayload(event: Doc<"accountingEvents"> | null): TransferPayload | null {
  if (!event || event.eventType !== TREASURY_TRANSFER_EVENT) return null;
  try {
    return readTreasuryTransferPayload(event.payload);
  } catch {
    return null;
  }
}

function payloadString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Batched, tenant-scoped point reads: one `get` per distinct id, foreign rows read as absent. */
async function loadOwned<T extends "accountingEvents" | "journalEntries" | "bankAccounts">(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  ids: Iterable<Id<T> | undefined | null>,
): Promise<Map<string, Doc<T>>> {
  const distinct = [...new Set([...ids].filter((id): id is Id<T> => Boolean(id)))];
  const rows = await Promise.all(distinct.map((id) => ctx.db.get(id)));
  const owned = new Map<string, Doc<T>>();
  rows.forEach((row, index) => {
    if (row && (row as { orgId?: Id<"organizations"> }).orgId === orgId) owned.set(String(distinct[index]), row as Doc<T>);
  });
  return owned;
}

function bankIdOf(ctx: QueryCtx, value: string | null): Id<"bankAccounts"> | null {
  return value === null ? null : ctx.db.normalizeId("bankAccounts", value);
}

function endpoint(
  ctx: QueryCtx,
  value: string | null,
  banks: Map<string, Doc<"bankAccounts">>,
): TransferEndpoint {
  if (value === null) return { kind: "CASH" };
  const id = bankIdOf(ctx, value);
  return { kind: "BANK", bankName: id ? banks.get(String(id))?.name ?? null : null };
}

function familyFor(
  entry: Doc<"journalEntries">,
  eventType: EventType | null,
  reversed: Doc<"journalEntries"> | null,
): JournalSourceFamily {
  if (eventType && eventType !== "JOURNAL_REVERSAL") return SOURCE_FAMILY_BY_EVENT_TYPE[eventType];
  const category = reversed?.category ?? entry.category;
  if (category === "MANUAL") return "MANUAL_JOURNAL";
  if (category === "OPENING_BALANCE") return "OPENING_BALANCE";
  return "OTHER";
}

/**
 * Display facts for one page of journal entries. Never throws for bad or missing
 * links: an unverifiable fact is returned as null, so one damaged row cannot hide
 * the rest of the ledger page.
 */
export async function buildJournalEntryDisplays(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  entries: Doc<"journalEntries">[],
): Promise<JournalEntryDisplay[]> {
  const events = await loadOwned(ctx, orgId, entries.map((entry) => entry.accountingEventId));
  const reversedEventIds = [...events.values()].map((event) => event.reversalOfEventId);
  const [originalEvents, linkedEntries] = await Promise.all([
    loadOwned(ctx, orgId, reversedEventIds),
    loadOwned(ctx, orgId, entries.flatMap((entry) => [entry.reversalOfJournalEntryId, entry.reversedByJournalEntryId])),
  ]);

  const transferOf = (entry: Doc<"journalEntries">): TransferPayload | null => {
    const event = entry.accountingEventId ? events.get(String(entry.accountingEventId)) ?? null : null;
    if (event?.eventType === "JOURNAL_REVERSAL" && event.reversalOfEventId) {
      return safeTransferPayload(originalEvents.get(String(event.reversalOfEventId)) ?? null);
    }
    return safeTransferPayload(event);
  };
  const transfers = entries.map(transferOf);
  const banks = await loadOwned(ctx, orgId, transfers.flatMap((payload) =>
    payload ? [bankIdOf(ctx, payload.fromBankAccountId), bankIdOf(ctx, payload.toBankAccountId)] : []));

  const link = (id: Id<"journalEntries"> | undefined): JournalEntryLink | null => {
    const linked = id ? linkedEntries.get(String(id)) : undefined;
    return linked ? { journalEntryId: linked._id, journalNumber: linked.journalNumber } : null;
  };

  return entries.map((entry, index) => {
    const event = entry.accountingEventId ? events.get(String(entry.accountingEventId)) ?? null : null;
    const isReversal = entry.category === "REVERSAL" || entry.reversalOfJournalEntryId !== undefined;
    let eventType: EventType | null = isKnownEventType(event?.eventType) ? event.eventType : null;
    if (eventType === "JOURNAL_REVERSAL") {
      const original = event?.reversalOfEventId ? originalEvents.get(String(event.reversalOfEventId)) : undefined;
      const originalType = original?.eventType ?? payloadString(event?.payload, "originalEventType");
      eventType = isKnownEventType(originalType) && originalType !== "JOURNAL_REVERSAL" ? originalType : null;
    }
    const reversed = entry.reversalOfJournalEntryId ? linkedEntries.get(String(entry.reversalOfJournalEntryId)) ?? null : null;
    const transfer = transfers[index];

    let note: string | null = null;
    if (isReversal) note = event?.eventType === "JOURNAL_REVERSAL" ? payloadString(event.payload, "reason") : null;
    else if (transfer) note = transfer.reference;
    else if (entry.category === "MANUAL") note = entry.memo.trim() || null;

    return {
      sourceFamily: familyFor(entry, eventType, reversed),
      eventType,
      isReversal,
      note,
      transfer: transfer
        ? { from: endpoint(ctx, transfer.fromBankAccountId, banks), to: endpoint(ctx, transfer.toBankAccountId, banks) }
        : null,
      reversalOf: link(entry.reversalOfJournalEntryId),
      reversedBy: link(entry.reversedByJournalEntryId),
    };
  });
}

/** Display facts for the lines of one entry: bank names (one batched read) and transfer legs. */
export async function buildJournalLineDisplays(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  entryDisplay: JournalEntryDisplay | null,
  lines: Doc<"journalLines">[],
): Promise<JournalLineDisplay[]> {
  const banks = await loadOwned(ctx, orgId, lines.map((line) => line.bankAccountId));
  const isTransfer = entryDisplay?.eventType === TREASURY_TRANSFER_EVENT && entryDisplay.transfer !== null;
  return lines.map((line) => {
    const stored = line.description?.trim() ?? "";
    const isReversalLine = entryDisplay?.isReversal === true && stored.startsWith(REVERSAL_LINE_MARKER);
    const description = (isReversalLine ? stored.slice(REVERSAL_LINE_MARKER.length).trim() : stored) || null;
    const transferLeg = isTransfer ? (line.lineNumber === 1 ? "IN" : line.lineNumber === 2 ? "OUT" : null) : null;
    return {
      bankName: line.bankAccountId ? banks.get(String(line.bankAccountId))?.name ?? null : null,
      transferLeg,
      description,
      isReversalLine,
    };
  });
}
