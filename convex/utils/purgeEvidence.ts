/**
 * SCRUM-1023 Phase 1b (owner ruling D, 2026-11-27): CONFIRMED lender-payment evidence of a purged application.
 * READ-ONLY, pure (it works on rows the manifest already read).
 *
 * A `customerFinanceCompanyPayments` row is evidence that the customer paid the finance company directly. It posts
 * nothing and owns no ledger row, so the net-zero proof says nothing about it: deleting a CONFIRMED one erases the only
 * record of a payment that really happened. It therefore refuses by default (CONFIRMED_PAYMENT_EVIDENCE) and leaves
 * only when the owner approved its EXACT id in `approvedLiveRowIds`. The approval has hard limits, so it can never be
 * used to wave through something else:
 *  - a row with ANY ledger link (an accounting event, journal or canonical payment names it, or it names one) is a
 *    different kind of row, one the ledger proof must handle: CONFIRMED_PAYMENT_LEDGER_LINK, approval or not;
 *  - an approved id that is not in the purge set at all (another application's row, another organization's row) is
 *    the generic stale-approval refusal (APPROVED_ROW_NOT_IN_PURGE), raised by `checkLiveStates`. A row of ANOTHER
 *    application can never be in the set: it would name a kept application, and the closure join guard blocks it
 *    (SHARED_WITH_LIVE). So no separate "foreign row" branch exists to test.
 * The rows are itemized (id, amount, status, kind) with no personal data, so the owner approves what he can see.
 */
import { PURGE_LIVE_STATES } from "./purgeImpactMap";
import type { ManifestRefusal, PurgeSet, Row, TokenIndex } from "./purgeSurvivors";

export interface ConfirmedPaymentEvidence {
  id: string;
  applicationId: string;
  amountMinor: number;
  currency: string;
  status: string;
  kind: string;
  approved: boolean;
}

const TABLE = "customerFinanceCompanyPayments";
const LEDGER_TABLES = ["accountingEvents", "journalEntries", "canonicalPayments"] as const;
const byId = (a: ConfirmedPaymentEvidence, b: ConfirmedPaymentEvidence): number => a.id.localeCompare(b.id);

/** Every id of a ledger-side row, and every id token a ledger-side row holds: a link in either direction. */
function ledgerSide(tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex): { ids: Set<string>; tokens: Set<string> } {
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const table of LEDGER_TABLES) {
    for (const row of tableRows.get(table) ?? []) {
      ids.add(row._id);
      for (const t of tok.of(row)) tokens.add(t);
    }
  }
  return { ids, tokens };
}

export function checkConfirmedPaymentEvidence(
  set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, approvedLiveRowIds: ReadonlyArray<string>, out: ManifestRefusal[],
): ConfirmedPaymentEvidence[] {
  const rule = PURGE_LIVE_STATES[TABLE];
  const purged = set.byTable.get(TABLE);
  if (!purged) return [];
  const approved = new Set(approvedLiveRowIds);
  const side = ledgerSide(tableRows, tok);
  const items: ConfirmedPaymentEvidence[] = [];
  let unapproved = 0;
  let linked = 0;
  for (const row of tableRows.get(TABLE) ?? []) {
    if (!purged.has(row._id) || !rule.values.includes(String(row[rule.field]))) continue;
    const applicationId = typeof row.applicationId === "string" ? row.applicationId : "";
    const isApproved = approved.has(row._id);
    const hasLink = side.tokens.has(row._id) || tok.of(row).some((t) => side.ids.has(t));
    if (hasLink) linked += 1;
    else if (!isApproved) unapproved += 1;
    const first = row.firstPayment as { kind?: unknown } | undefined;
    items.push({
      id: row._id, applicationId, amountMinor: typeof row.amountMinor === "number" ? row.amountMinor : 0,
      currency: typeof row.currency === "string" ? row.currency : "", status: String(row[rule.field]),
      kind: typeof first?.kind === "string" ? first.kind : "UNKNOWN", approved: isApproved,
    });
  }
  const refuse = (code: "CONFIRMED_PAYMENT_EVIDENCE" | "CONFIRMED_PAYMENT_LEDGER_LINK", detail: string, count: number): void => {
    if (count > 0) out.push({ code, table: TABLE, detail, count });
  };
  refuse("CONFIRMED_PAYMENT_EVIDENCE", "a CONFIRMED direct payment to the finance company is the only record that the customer paid: only an owner-approved exact id may be purged", unapproved);
  refuse("CONFIRMED_PAYMENT_LEDGER_LINK", "a CONFIRMED payment row is tied to ledger rows: the ledger proof must handle it, an approval cannot", linked);
  return items.sort(byId);
}
