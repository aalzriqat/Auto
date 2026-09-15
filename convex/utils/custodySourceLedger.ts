import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_CUSTODY_ENTRIES } from "./dealCostLimits";

/**
 * The custody family's ledger identity and its causal guards.
 *
 * ## The payable reclassification chain (Codex AF-CUST-01 / final round A)
 *
 * EMPLOYEE_REIMBURSEMENTS_PAYABLE carries a custody record's out-of-pocket
 * position as a chain of signed deltas, one `CUSTODY_PAYABLE_RECLASSIFIED`
 * event per version. The chain only states the right balance if it posts IN
 * ORDER: version 2 (say, the release when the employee is reimbursed) debits
 * the payable that version 1 credited, so version 2 landing first — because
 * version 1 was dated into a closed month and is still waiting in the outbox
 * while version 2 is dated today — puts a DEBIT on a liability that nothing
 * has credited yet, and a period snapshot taken in between reports it.
 *
 * So version N is held behind version N−1 at BOTH ends: the hook queues it
 * rather than posting it when its predecessor is not yet POSTED, and the
 * outbox worker re-proves the same thing before it posts a queued one. The
 * custody row keeps the TARGET the chain converges on; what is actually on
 * the books is answered here, from the ledger, never from the row.
 *
 * ## Replacement behind a deferred reversal (consolidated round, item 2)
 *
 * A custody-paid fee and a write-off are on the books at most ONCE, at one
 * version. Correcting one reverses the live version and posts the next —
 * and when the reversal is DEFERRED (no period open for its date) the
 * original is STILL POSTED until the outbox drains. A replacement that posts
 * now would put two versions of the same charge on the books at once. So a
 * forward version N is held behind the reversal of every version below it,
 * at both ends, exactly like the payable chain: the hook queues it when an
 * earlier version is still POSTED, and the worker re-proves it.
 *
 * Mirrors `payrollSourceLedger` (PAYROLL_PAID behind its accruals) and
 * `prepaidPostingBlockedReason`, and is wired into the same worker chain.
 */

export const custodyEntryPostKey = (entryId: Id<"financeDealCustodyEntries">): string =>
  `custody_entry_${entryId}`;
export const custodyFeePostKey = (feeId: Id<"financeDealFees">, version: number): string =>
  `custody_fee_paid_${feeId}_v${version}`;
export const custodyWriteOffPostKey = (custodyId: Id<"financeDealCustody">, version: number): string =>
  `custody_written_off_${custodyId}_v${version}`;
export const custodyPayableReclassKey = (custodyId: Id<"financeDealCustody">, version: number): string =>
  `custody_payable_reclass_${custodyId}_v${version}`;

/**
 * How many rows one source's event family may be read with. A fee's family
 * is one forward event per version plus a reversal per corrected version; a
 * custody record's is its write-offs, their reversals and its payable chain
 * (one per movement, bounded by `MAX_CUSTODY_ENTRIES`). Past it the read
 * refuses rather than judges a prefix.
 */
const MAX_SOURCE_EVENTS = 2 * MAX_CUSTODY_ENTRIES + 16;

/**
 * How many ledger point-reads one family proof may spend. A deal has one
 * custodian, occasionally two, each with a handful of movements and lines —
 * a few dozen reads. The bound keeps the proof under the platform's
 * per-transaction read limits whatever the rows say; past it the gate
 * REFUSES with a named reason rather than proving a prefix, exactly as the
 * bounded row loaders do.
 */
export const MAX_CUSTODY_LEDGER_PROOFS = 1500;

/** The events of one source, in full or refused — never a prefix. */
async function sourceEvents(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  sourceType: string,
  sourceId: string,
  action: string
): Promise<Array<Doc<"accountingEvents">>> {
  const rows = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId))
    .take(MAX_SOURCE_EVENTS + 1);
  if (rows.length > MAX_SOURCE_EVENTS) {
    throw new ConvexError(
      `A custody posting on this deal carries more than ${MAX_SOURCE_EVENTS} ledger events, which is past what ${action} can verify completely; nothing has been changed. Have the record reviewed.`
    );
  }
  return rows;
}

/**
 * Whether a domain event with this idempotency key is actually on the books.
 * POSTED only: `accountingEvents.status` also admits PENDING and FAILED, and
 * either would let a release debit a payable whose credit never landed. The
 * key names one forward event; the bounded page is read in full rather than
 * `.first()`-ed, because a reversal shares the source key (ACC-4).
 */
async function eventPosted(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<boolean> {
  const rows = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .take(8);
  return rows.some((row) => row.status === "POSTED");
}

/** Whether version `version` of a record's payable reclassification is POSTED. */
export async function custodyPayableReclassPosted(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  custodyId: Id<"financeDealCustody">,
  version: number
): Promise<boolean> {
  return eventPosted(ctx, orgId, custodyPayableReclassKey(custodyId, version));
}

/**
 * The lowest version of `eventType` against `sourceId` that is STILL POSTED
 * below `version`, or `null` when none is — i.e. whether a replacement at
 * `version` would put a second copy of the same charge on the books. Read
 * from the ledger, never from a caller's `ReversalOutcome`: an outcome
 * describes one branch's path, a queued row outlives the transaction that
 * queued it, and the worker re-proves this on the row it is about to post.
 */
export async function earlierVersionStillPosted(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  eventType: "CUSTODY_FEE_PAID" | "CUSTODY_WRITTEN_OFF",
  sourceType: "financeDealFees" | "financeDealCustody",
  sourceId: string,
  version: number
): Promise<number | null> {
  if (version <= 1) return null;
  const rows = await sourceEvents(ctx, orgId, sourceType, sourceId, "posting this custody replacement");
  let earliest: number | null = null;
  for (const row of rows) {
    if (row.eventType !== eventType || row.status !== "POSTED" || row.eventVersion >= version) continue;
    if (earliest === null || row.eventVersion < earliest) earliest = row.eventVersion;
  }
  return earliest;
}

/**
 * Why a queued custody event must NOT post yet, or `null` when it may.
 *
 *  - `CUSTODY_PAYABLE_RECLASSIFIED` version N waits for version N−1.
 *  - `CUSTODY_FEE_PAID` / `CUSTODY_WRITTEN_OFF` version N waits for the
 *    REVERSAL of every earlier version — a deferred reversal leaves the
 *    earlier version POSTED, and the replacement must not overtake it.
 *
 * Every other custody event carries its own complete journal and has no
 * predecessor to wait for. Fails closed on a payload it cannot read: a
 * reclassification whose custody reference does not normalize cannot prove
 * its predecessor posted, and skipping the check is an ALLOW.
 */
export async function custodyPostingBlockedReason(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    eventType?: string;
    eventVersion?: number;
    sourceType: string;
    sourceId: string;
    payload?: unknown;
  }
): Promise<string | null> {
  const version = entry.eventVersion ?? 1;
  if (entry.eventType === "CUSTODY_FEE_PAID" || entry.eventType === "CUSTODY_WRITTEN_OFF") {
    if (version <= 1) return null;
    const sourceType = entry.eventType === "CUSTODY_FEE_PAID" ? "financeDealFees" : "financeDealCustody";
    if (entry.sourceType !== sourceType) {
      return `it is a ${entry.eventType} event keyed on ${entry.sourceType} rather than ${sourceType}, so the earlier version it replaces cannot be traced`;
    }
    const earlier = await earlierVersionStillPosted(ctx, entry.orgId, entry.eventType, sourceType, entry.sourceId, version);
    if (earlier !== null) {
      return entry.eventType === "CUSTODY_FEE_PAID"
        ? `custody fee posting v${earlier} it replaces is still on the books (its reversal has not posted yet), so this would charge the cost out of custody twice`
        : `custody write-off v${earlier} it replaces is still on the books (its reversal has not posted yet), so this would absorb the shortage twice`;
    }
    return null;
  }
  if (entry.eventType !== "CUSTODY_PAYABLE_RECLASSIFIED") return null;
  if (version <= 1) return null;
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  const raw = typeof payload.custodyId === "string" ? payload.custodyId : null;
  const custodyId = raw ? ctx.db.normalizeId("financeDealCustody", raw) : null;
  if (!custodyId) {
    return "it carries no readable custody reference, so the payable reclassification it follows cannot be traced";
  }
  if (!(await custodyPayableReclassPosted(ctx, entry.orgId, custodyId, version - 1))) {
    return `custody payable reclassification v${version - 1} behind it has not posted to the ledger yet, so this would move an Employee Reimbursements Payable balance the ledger does not carry`;
  }
  return null;
}

/**
 * Every movement of one custody record, or a refusal — never a prefix.
 * The invariant is `entries.length <= MAX_CUSTODY_ENTRIES` for any record a
 * writer or a gate decides on; it is established here at every such read.
 */
export async function loadCustodyEntries(
  ctx: QueryCtx | MutationCtx,
  custodyId: Id<"financeDealCustody">,
  action: string
): Promise<Array<Doc<"financeDealCustodyEntries">>> {
  const entries = await ctx.db
    .query("financeDealCustodyEntries")
    .withIndex("by_custody", (q) => q.eq("custodyId", custodyId))
    .take(MAX_CUSTODY_ENTRIES + 1);
  if (entries.length > MAX_CUSTODY_ENTRIES) {
    throw new ConvexError(
      `This custody record carries more than ${MAX_CUSTODY_ENTRIES} movements, which is past what ${action} can decide on completely; nothing has been changed. Have the record reviewed rather than extended.`
    );
  }
  return entries;
}

/**
 * ## The canonical family boundary (final round B)
 *
 * A custody record is on the books as a FAMILY: the record's marker
 * (`ledgerPosting: "CANONICAL"`, set only by a writer that posts), every cash
 * leg, and every custody-paid cost line at its current actual
 * (`custodyPosted`). A deal is classified and finalized on the strength of
 * those postings — the sale's journal treats the handover costs as already
 * expensed out of the employee's cash. A record from before posting existed,
 * or a linked line whose posting is absent or does not match the row, would
 * let a deal close with cash movements the ledger never saw. Such a family is
 * refused every gate until `migrateLegacyCustodyToLedger` has posted it
 * completely; nothing here infers what those postings would have been.
 *
 * This is the ROW half of the predicate — pure over the same bounded rows the
 * gates already read, so classification and finalization cannot disagree
 * about it. It is necessary, never sufficient: a marker says a writer
 * INTENDED to post, and a posting dated into a closed month, or one whose
 * event failed, carries the marker just the same. `custodyLedgerFamilyRefusal`
 * runs this first and then proves the ledger.
 */
export function custodyLedgerFamilyRowRefusal(
  custodyRows: ReadonlyArray<Doc<"financeDealCustody">>,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): string | null {
  const byId = new Map(custodyRows.map((row) => [row._id, row]));
  for (const row of custodyRows) {
    if (row.ledgerPosting !== "CANONICAL") {
      return `A custody record on this deal predates ledger posting, so its cash movements are not on the books; ${action} is refused until the custody accounting migration has posted it.`;
    }
  }
  for (const fee of liveFees) {
    if (fee.voidedAt !== undefined || fee.custodyId === undefined) continue;
    if (!byId.has(fee.custodyId)) {
      return `A cost on this deal is charged to a custody record that is not on this deal, so ${action} is refused until the line is corrected.`;
    }
    const charged =
      fee.actualAmountMinor !== undefined && Number.isSafeInteger(fee.actualAmountMinor) && fee.actualAmountMinor > 0;
    const posted = fee.custodyPosted;
    if (!charged) {
      if (posted !== undefined) {
        return `A cost on this deal carries a custody posting for an actual it no longer records, so ${action} is refused until the line is corrected.`;
      }
      continue;
    }
    if (posted === undefined || posted.custodyId !== fee.custodyId || posted.amountMinor !== fee.actualAmountMinor) {
      return `A cost paid out of an employee's custody on this deal is not on the books at its recorded amount, so ${action} is refused until the custody accounting migration has posted it.`;
    }
  }
  return null;
}

/**
 * The LEDGER half of the family predicate (consolidated round, item 1):
 * every posting the rows claim is proven against `accountingEvents`, and
 * only the exact POSTED family passes.
 *
 * "On the books" has four answers (ACC-4), and the rows can only ever state
 * intent. What is proven, per custody record:
 *
 *  - every cash leg that stands (no reversal names it) has its forward event
 *    POSTED — not queued for a closed month, not PENDING, not FAILED, not
 *    already REVERSED by something the record does not know about;
 *  - every cash leg a reversal names is OFF the books: its forward event is
 *    REVERSED, or never reached the ledger at all (a queued post cancelled
 *    by the reversal, so both net to nothing on both sides). A forward event
 *    still POSTED under a deferred reversal is a movement the record calls
 *    cancelled and the ledger still carries;
 *  - every live custody-paid line is POSTED at EXACTLY the version the row
 *    names, and no OTHER version of it is still POSTED — a replacement that
 *    landed while an earlier version's reversal is deferred is two charges;
 *  - a written-off record has its write-off POSTED at the version the row
 *    names and no other; any other record has NO write-off on the books;
 *  - the payable chain is posted to the version the row says it issued — a
 *    delta still waiting in the outbox is a payable the ledger does not yet
 *    carry.
 *
 * Bounded like every decision read: the rows come from the bounded loaders,
 * each movement log is read under `MAX_CUSTODY_ENTRIES`, and the proof
 * refuses past `MAX_CUSTODY_LEDGER_PROOFS` point-reads rather than judging a
 * prefix. The lines a deal has VOIDED are not read here: they are unbounded
 * (a row count never falls) and their reversal, deferred or not, is the
 * `syncCustodyFeePosting` path's to finish through the outbox.
 */
export async function custodyLedgerFamilyRefusal(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  custodyRows: ReadonlyArray<Doc<"financeDealCustody">>,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): Promise<string | null> {
  const rowRefusal = custodyLedgerFamilyRowRefusal(custodyRows, liveFees, action);
  if (rowRefusal !== null) return rowRefusal;

  const chargedLines = liveFees.filter(
    (fee) => fee.voidedAt === undefined && fee.custodyId !== undefined && fee.custodyPosted !== undefined
  );
  const logs = new Map<Id<"financeDealCustody">, Array<Doc<"financeDealCustodyEntries">>>();
  let budget = chargedLines.length + custodyRows.length;
  for (const row of custodyRows) {
    const entries = await loadCustodyEntries(ctx, row._id, action);
    logs.set(row._id, entries);
    budget += entries.length;
  }
  if (budget > MAX_CUSTODY_LEDGER_PROOFS) {
    throw new ConvexError(
      `This deal's custody carries more than ${MAX_CUSTODY_LEDGER_PROOFS} ledger postings, which is past what ${action} can verify completely; nothing has been changed. Have the deal's custody reviewed.`
    );
  }

  for (const row of custodyRows) {
    const entries = logs.get(row._id) ?? [];
    const reversed = new Set<Id<"financeDealCustodyEntries">>();
    for (const entry of entries) {
      if (entry.kind === "REVERSAL" && entry.reversesEntryId !== undefined) reversed.add(entry.reversesEntryId);
    }
    for (const entry of entries) {
      if (entry.kind === "REVERSAL") continue;
      const rows = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", custodyEntryPostKey(entry._id)))
        .take(8);
      const forward = rows.find((event) => event.sourceType === "financeDealCustodyEntries" && event.sourceId === entry._id.toString());
      if (reversed.has(entry._id)) {
        if (forward !== undefined && forward.status !== "REVERSED") {
          return `A cancelled custody movement on this deal is still on the books (its reversal has not posted yet), so ${action} is refused until the outbox has posted it.`;
        }
        continue;
      }
      if (forward === undefined || forward.status !== "POSTED") {
        return `A custody movement on this deal is not on the books (${describeStatus(forward)}), so ${action} is refused until it has posted.`;
      }
    }

    const family = await sourceEvents(ctx, orgId, "financeDealCustody", row._id.toString(), action);
    const writeOffs = family.filter((event) => event.eventType === "CUSTODY_WRITTEN_OFF");
    const postedWriteOffVersions = writeOffs.filter((event) => event.status === "POSTED").map((event) => event.eventVersion);
    if (row.status === "WRITTEN_OFF") {
      const claimed = row.writeOffPosted;
      if (claimed === undefined) {
        return `A written-off custody record on this deal carries no write-off posting, so ${action} is refused until the custody accounting migration has posted it.`;
      }
      const exact = writeOffs.find((event) => event.eventVersion === claimed.version);
      if (exact === undefined || exact.status !== "POSTED") {
        return `A custody write-off on this deal is not on the books (${describeStatus(exact)}), so ${action} is refused until it has posted.`;
      }
      if (postedWriteOffVersions.some((version) => version !== claimed.version)) {
        return `A custody write-off on this deal is on the books at more than one version (an earlier version's reversal has not posted yet), so ${action} is refused until the outbox has posted it.`;
      }
    } else if (postedWriteOffVersions.length > 0) {
      return `A reopened custody record on this deal still has its write-off on the books (the reversal has not posted yet), so ${action} is refused until the outbox has posted it.`;
    }

    const issued = row.payableReclassVersion ?? 0;
    if (issued > 0) {
      const postedReclass = new Set(
        family
          .filter((event) => event.eventType === "CUSTODY_PAYABLE_RECLASSIFIED" && event.status === "POSTED")
          .map((event) => event.eventVersion)
      );
      for (let version = 1; version <= issued; version += 1) {
        if (!postedReclass.has(version)) {
          return `A custody record on this deal has a payable reclassification (v${version}) that has not posted to the ledger yet, so ${action} is refused until the outbox has posted it.`;
        }
      }
    }
  }

  for (const fee of chargedLines) {
    const claimed = fee.custodyPosted!;
    const family = await sourceEvents(ctx, orgId, "financeDealFees", fee._id.toString(), action);
    const postings = family.filter((event) => event.eventType === "CUSTODY_FEE_PAID");
    const exact = postings.find((event) => event.eventVersion === claimed.version);
    if (exact === undefined || exact.status !== "POSTED") {
      return `A cost paid out of an employee's custody on this deal is not on the books (${describeStatus(exact)}), so ${action} is refused until it has posted.`;
    }
    if (postings.some((event) => event.status === "POSTED" && event.eventVersion !== claimed.version)) {
      return `A cost paid out of an employee's custody on this deal is on the books at more than one version (an earlier version's reversal has not posted yet), so ${action} is refused until the outbox has posted it.`;
    }
  }
  return null;
}

function describeStatus(event: Doc<"accountingEvents"> | undefined): string {
  if (event === undefined) return "no ledger event exists for it, or it is still queued for a closed period";
  switch (event.status) {
    case "PENDING":
      return "its ledger event is still pending";
    case "FAILED":
      return "its ledger event failed";
    case "REVERSED":
      return "its ledger event has been reversed";
    default:
      return `its ledger event is ${event.status}`;
  }
}

/** Throws the family refusal, if any — the mutation-boundary form of the predicate above. */
export async function assertCustodyLedgerFamilyComplete(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  custodyRows: ReadonlyArray<Doc<"financeDealCustody">>,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): Promise<void> {
  const refusal = await custodyLedgerFamilyRefusal(ctx, orgId, custodyRows, liveFees, action);
  if (refusal !== null) throw new ConvexError(refusal);
}
