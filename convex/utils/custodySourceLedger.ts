import { ConvexError, getDocumentSize } from "convex/values";
import type { TransactionMetrics } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_CUSTODY_ENTRIES, MAX_DEAL_CUSTODY_DECISION_RECORDS, MAX_LIVE_DEAL_FEE_LINES } from "./dealCostLimits";

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
 * The event type a cash leg of each kind posts under, and the version it
 * posts at: a leg is posted once, at version 1, and never replaced — a
 * correction is a REVERSAL entry, not a later version. Mirrors
 * `CUSTODY_CASH_EVENT` in `accounting/workflowHooks` (the hook that mints
 * the event); the family proof holds a leg to THIS identity, so a POSTED
 * event under the leg's key but of another type or version is not its
 * posting. A test pins the two tables against the events the hook posts.
 */
export const CUSTODY_CASH_EVENT_TYPE: Readonly<Record<"ISSUED" | "RETURNED" | "REIMBURSED", string>> = {
  ISSUED: "CUSTODY_CASH_ISSUED",
  RETURNED: "CUSTODY_CASH_RETURNED",
  REIMBURSED: "CUSTODY_REIMBURSED",
};
export const CUSTODY_CASH_EVENT_VERSION = 1;

/**
 * How many rows one source's event family may be read with. A fee's family
 * is one forward event per version plus a reversal per corrected version; a
 * custody record's is its write-offs, their reversals and its payable chain
 * (one per movement, bounded by `MAX_CUSTODY_ENTRIES`). Past it the read
 * refuses rather than judges a prefix.
 */
const MAX_SOURCE_EVENTS = 2 * MAX_CUSTODY_ENTRIES + 16;

/**
 * How many DOCUMENTS one family proof may read from the ledger and the
 * custody rows together. A deal has one custodian, occasionally two, each
 * with a handful of movements and lines — a few dozen documents. The bound
 * keeps the proof well under the platform's per-transaction read limit
 * whatever the rows say; past it the gate REFUSES with a named reason
 * rather than proving a prefix, exactly as the bounded row loaders do.
 *
 * Counted in documents actually RETURNED, not in sources: a per-source read
 * may return up to `MAX_SOURCE_EVENTS + 1` rows, so a budget that charged
 * one per source (the previous design) admitted `MAX_CUSTODY_POSTED_LINES ×
 * MAX_SOURCE_EVENTS` documents — platform scale — before it refused
 * anything. `CustodyLedgerReadBudget` charges every read by its row count
 * and sizes each read so it can never fetch more than one document past
 * what is left.
 */
export const MAX_CUSTODY_LEDGER_PROOFS = 1500;

/**
 * How many BYTES one custody proof may read (R7, F1). A document count
 * bounds nothing by itself: the platform also caps the bytes one
 * transaction reads, and a ledger event carries its whole payload — a
 * queued payable delta names every primary of its position
 * (`MAX_CUSTODY_DEPENDENCIES` entries), an outbox row keeps that payload
 * after it posts — so a family well under `MAX_CUSTODY_LEDGER_PROOFS`
 * documents could pass the platform's byte limit and fail as a platform
 * error instead of the named refusal.
 *
 * Every document a proof reads is charged at its EXACT platform size —
 * `getDocumentSize` from `convex/values`, the same formula the platform
 * uses for its bandwidth and size limits — and the proof refuses by name
 * once the total passes this. Set at a small fraction of the platform's
 * per-transaction read limit (`PLATFORM_TRANSACTION_READ_BYTES`; the
 * caller's own reads — the deal, its lines, its records — share that
 * transaction), so the refusal is reached long before the platform would
 * refuse for it. This is the proof's OWN budget; the transaction's actual
 * headroom is checked beside it (`assertHeadroom`), off the platform's own
 * metrics.
 *
 * ⚠️ `convex-test` tracks these metrics with the same size formula but
 * does NOT enforce the limits unless asked to, so the tests here prove the
 * budget's own accounting and the headroom check's arithmetic — never that
 * a real transaction would have failed one document later. Only a
 * real-platform run proves the runtime metrics.
 */
export const MAX_CUSTODY_LEDGER_READ_BYTES = 4 * 1024 * 1024;

/**
 * The platform limits the derivation below rests on, as documented at the
 * time of writing (https://docs.convex.dev/production/state/limits): one
 * document is at most 1 MiB, and one transaction reads at most 16 MiB.
 * Stated as constants so the derivation is checkable and pinned by a
 * test; if the platform changes them, the derivation is re-done here.
 */
export const PLATFORM_DOCUMENT_BYTES = 1024 * 1024;
export const PLATFORM_TRANSACTION_READ_BYTES = 16 * 1024 * 1024;

/**
 * How many documents ONE query inside a custody proof may fetch (R7, F1
 * correction). Charging bytes after a read returns bounds nothing on its
 * own: a single `.take(MAX_SOURCE_EVENTS + 1)` over near-maximum documents
 * would materialize hundreds of MiB before the charge ran, and the platform
 * would fail the transaction where the proof meant to refuse by name. So
 * every enumeration is read in batches of this many documents, each batch
 * charged — count and exact bytes — and the transaction's real headroom
 * re-checked, before the next is fetched, cursoring on the index's
 * trailing `_creationTime` (`readBatched`). The worst case ONE batch can
 * read is then bounded structurally at `MAX_CUSTODY_READ_BATCH ×
 * PLATFORM_DOCUMENT_BYTES` = 8 MiB, and `assertHeadroom` refuses to fetch
 * a batch unless the transaction still has that much plus the caller's
 * reserve. Every keyed point-read in this module takes at most this many
 * rows too, and a test pins that no query here asks for more.
 */
export const MAX_CUSTODY_READ_BATCH = 8;

/**
 * What the transaction must still be able to read AFTER the proof is done
 * with it: the caller's remaining reads and the rows it will write back
 * (a mutation that proves a family then patches the deal, its lines and
 * its records). Reserved off the platform's own `bytesRead.remaining`, so
 * the proof never spends the caller's share.
 */
export const CUSTODY_PROOF_CALLER_RESERVE_BYTES = 2 * 1024 * 1024;
/** Documents and index ranges reserved for the caller the same way (limits: 32,000 documents, 4,096 queries). */
export const CUSTODY_PROOF_CALLER_RESERVE_DOCUMENTS = 2_000;
export const CUSTODY_PROOF_CALLER_RESERVE_QUERIES = 256;

/**
 * The context surface the headroom check needs: `ctx.meta` as every query
 * and mutation context carries it. Optional at the type level only so a
 * test's wrapped context can omit it; a context WITHOUT it is a context
 * whose headroom cannot be read, and the check refuses rather than
 * assumes — it never fails open.
 */
type HeadroomCtx = { meta?: { getTransactionMetrics?: () => Promise<TransactionMetrics> } };

/**
 * The exact platform size of one document — `getDocumentSize`, the
 * formula the platform bills reads by. A value that is not a Convex
 * document (nothing this module reads; guarded for the `null` a point-read
 * charges) is charged one maximum document: unmeasurable is never free.
 */
export function documentBytes(doc: unknown): number {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return PLATFORM_DOCUMENT_BYTES;
  try {
    return getDocumentSize(doc as Parameters<typeof getDocumentSize>[0]);
  } catch {
    return PLATFORM_DOCUMENT_BYTES;
  }
}

/**
 * The read budget of one custody proof: every read inside the proof asks
 * it how many rows it may take and charges the DOCUMENTS that came back —
 * their count against `limit`, their estimated bytes against `byteLimit`.
 *
 * `take(cap)` is the `.take()` argument for a read whose own bound is `cap`:
 * one past the read's cap (so the read detects its own overflow) and never
 * more than one past what is left of the document budget (so the whole
 * proof reads at most `limit + 1` documents before it refuses). `charge`
 * throws the named refusal the moment either running total passes its
 * limit; a proof that refused has decided nothing on a prefix. The byte
 * bound is charged AFTER a batch returns — a `.take()` cannot be sized in
 * bytes — which is why no query here fetches more than
 * `MAX_CUSTODY_READ_BATCH` documents at once: the overshoot past the byte
 * limit is at most one batch of maximum-size documents, by construction.
 */
export class CustodyLedgerReadBudget {
  private spent = 0;
  private bytes = 0;

  constructor(
    private readonly limit: number,
    private readonly action: string,
    private readonly byteLimit: number = MAX_CUSTODY_LEDGER_READ_BYTES
  ) {}

  take(cap: number): number {
    return Math.max(1, Math.min(cap + 1, this.limit - this.spent + 1));
  }

  charge(docs: ReadonlyArray<unknown>): void {
    this.chargeCount(docs.length);
    for (const doc of docs) this.bytes += documentBytes(doc);
    if (this.bytes > this.byteLimit) {
      throw new ConvexError(
        `This deal's custody carries more than ${this.byteLimit.toLocaleString("en-US")} bytes of ledger postings, which is past what ${this.action} can verify completely; nothing has been changed. Have the deal's custody reviewed.`
      );
    }
  }

  /**
   * Refuses, by name, to read on when the TRANSACTION — not this budget —
   * could not take one more worst-case batch and still leave the caller its
   * reserve: the platform's own `bytesRead`, `documentsRead` and
   * `databaseQueries` headroom, asked before every batch. This is what
   * makes the platform's limit unreachable from here whatever the caller
   * read before the proof started; the budget above bounds the proof's own
   * spend. A context whose metrics cannot be read refuses too.
   */
  async assertHeadroom(ctx: HeadroomCtx): Promise<void> {
    const read = ctx.meta?.getTransactionMetrics;
    if (typeof read !== "function") {
      throw new ConvexError(
        `The transaction's read headroom cannot be measured, so ${this.action} cannot prove it would verify this deal's custody completely; nothing has been changed.`
      );
    }
    const metrics = await read.call(ctx.meta);
    const short =
      metrics.bytesRead.remaining < MAX_CUSTODY_READ_BATCH * PLATFORM_DOCUMENT_BYTES + CUSTODY_PROOF_CALLER_RESERVE_BYTES ||
      metrics.documentsRead.remaining < MAX_CUSTODY_READ_BATCH + CUSTODY_PROOF_CALLER_RESERVE_DOCUMENTS ||
      metrics.databaseQueries.remaining < 1 + CUSTODY_PROOF_CALLER_RESERVE_QUERIES;
    if (short) {
      throw new ConvexError(
        `This transaction has read too much for ${this.action} to verify this deal's custody completely (${metrics.bytesRead.used.toLocaleString("en-US")} bytes, ${metrics.documentsRead.used.toLocaleString("en-US")} documents, ${metrics.databaseQueries.used.toLocaleString("en-US")} queries so far); nothing has been changed. Have the deal's custody reviewed.`
      );
    }
  }

  /**
   * Charges one POINT-READ: a keyed lookup that costs the platform one query
   * whether or not it returns a row, so it costs this budget at least one
   * document (and no bytes when it returned none). `charge` alone would let
   * a proof made of empty lookups read without limit.
   */
  chargeRead(docs: ReadonlyArray<unknown>): void {
    if (docs.length === 0) this.chargeCount(1);
    else this.charge(docs);
  }

  private chargeCount(documents: number): void {
    this.spent += documents;
    if (this.spent > this.limit) {
      throw new ConvexError(
        `This deal's custody carries more than ${this.limit} ledger postings, which is past what ${this.action} can verify completely; nothing has been changed. Have the deal's custody reviewed.`
      );
    }
  }

  /** Documents read so far — for tests that pin the bound. */
  get documentsRead(): number {
    return this.spent;
  }

  /** Exact bytes read so far, by the platform's size formula — for tests that pin the bound. */
  get bytesRead(): number {
    return this.bytes;
  }

  /** The door this proof speaks for, for refusals raised by reads it funds. */
  get forAction(): string {
    return this.action;
  }
}

/**
 * One bounded enumeration, read in batches of at most
 * `MAX_CUSTODY_READ_BATCH` documents and charged batch by batch. `page`
 * fetches the next `take` rows strictly after `after` (the last row's
 * `_creationTime`, `undefined` for the first batch), in index order —
 * creation times are unique within a table, on the platform and in the
 * test harness alike, so the cursor never skips or repeats a row. Returns
 * at most `cap + 1` rows, so the caller detects its own overflow exactly
 * as a single `.take(cap + 1)` would have; with a budget, never more than
 * one document past what is left of it — and, with a budget, no batch is
 * fetched unless the transaction's own headroom can take a worst-case one.
 */
async function readBatched<T extends { _creationTime: number }>(
  ctx: HeadroomCtx,
  page: (after: number | undefined, take: number) => Promise<T[]>,
  cap: number,
  budget: CustodyLedgerReadBudget | undefined
): Promise<T[]> {
  const rows: T[] = [];
  let after: number | undefined;
  while (rows.length <= cap) {
    const left = cap - rows.length;
    const take = Math.min(MAX_CUSTODY_READ_BATCH, budget ? budget.take(left) : left + 1);
    await budget?.assertHeadroom(ctx);
    const batch = await page(after, take);
    budget?.charge(batch);
    for (const row of batch) rows.push(row);
    if (batch.length < take) break;
    after = batch[batch.length - 1]._creationTime;
  }
  return rows;
}

/**
 * Every row under ONE idempotency key — the ledger's or the outbox's — or
 * a refusal. A key names one forward posting (its reversal has its own
 * key), so a well-formed family is at most a handful of rows and never a
 * full batch: a batch that comes back FULL is a family this read did not
 * finish, and a judgement made on that prefix — "no POSTED row", "exactly
 * one POSTED row" — would certify whatever sits beyond it. So a full
 * batch is refused as unverifiable rather than judged; nothing is
 * decided on a prefix. Charged as one point-read. `keyedEvents` and
 * `keyedOutboxRows` are the two typed readers over this one rule.
 */
function keyedFamily<T>(rows: T[], idempotencyKey: string, budget: CustodyLedgerReadBudget | undefined): T[] {
  budget?.chargeRead(rows);
  if (rows.length >= MAX_CUSTODY_READ_BATCH) {
    throw new ConvexError(
      `A custody posting (${idempotencyKey}) has ${MAX_CUSTODY_READ_BATCH} or more ledger rows under its key, which is more than one posting can have and past what ${budget?.forAction ?? "this check"} can verify completely; nothing has been changed. Have the record reviewed.`
    );
  }
  return rows;
}

/** The ledger's rows under one key — see `keyedFamily`. */
async function keyedEvents(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string,
  budget?: CustodyLedgerReadBudget
): Promise<Array<Doc<"accountingEvents">>> {
  await budget?.assertHeadroom(ctx);
  const rows = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .take(MAX_CUSTODY_READ_BATCH);
  return keyedFamily(rows, idempotencyKey, budget);
}

/** The outbox's rows under one key — see `keyedFamily`. */
async function keyedOutboxRows(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string,
  budget?: CustodyLedgerReadBudget
): Promise<Array<Doc<"pendingAccountingEvents">>> {
  await budget?.assertHeadroom(ctx);
  const rows = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .take(MAX_CUSTODY_READ_BATCH);
  return keyedFamily(rows, idempotencyKey, budget);
}

/**
 * ## A stored posting version is proven, never trusted (CVX-4; R7, F4)
 *
 * Every version counter the custody family stores — a line's
 * `custodyPostingVersion` and `custodyPosted.version`, a record's
 * `writeOffPostingVersion`, `writeOffPosted.version` and
 * `payableReclassVersion`, an event's `eventVersion` — is declared
 * `v.number()`, which admits NaN, ±Infinity and fractions. `(NaN ?? 0) + 1`
 * is NaN, `Infinity + 1` is Infinity, `1.5 + 1` is 2.5: a producer that
 * counted from such a number posted "version NaN" under a key nothing will
 * ever reverse, and a reversal pinned to it reversed nothing and reported
 * the charge gone. So every door that reads a stored version proves it is
 * a positive safe integer first — through these, so the rule is one rule.
 */
export function isStoredVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Refuses, by name, a stored version that is not one. `what` names the row ("this cost line"); `action` names the door. */
export function assertStoredVersion(value: unknown, what: string, action: string): asserts value is number {
  if (!isStoredVersion(value)) {
    throw new ConvexError(
      `${what} carries a posting version that is not a positive whole number (${String(value)}), so ${action} cannot tell which posting it names; nothing has been changed. Have the record reviewed.`
    );
  }
}

/**
 * The version a producer posts next: 1 for a row that never posted
 * (`undefined` or 0), otherwise one past a counter proven to be a version.
 * Refuses a counter at the safe-integer ceiling too — its successor would
 * not be one.
 */
export function nextStoredVersion(previous: number | undefined, what: string, action: string): number {
  if (previous === undefined || previous === 0) return 1;
  assertStoredVersion(previous, what, action);
  if (previous >= Number.MAX_SAFE_INTEGER) {
    throw new ConvexError(
      `${what} carries a posting version that is not a positive whole number (${previous + 1}), so ${action} cannot tell which posting it names; nothing has been changed. Have the record reviewed.`
    );
  }
  return previous + 1;
}

/**
 * How many of a deal's lines that have EVER posted a custody charge one
 * proof may read. Live or removed: a line that posted once has a
 * `CUSTODY_FEE_PAID` family the ledger must be proven to have finished
 * with, whatever became of the row. Same order as the live-line cap; past
 * it the proof refuses rather than judges a prefix.
 */
export const MAX_CUSTODY_POSTED_LINES = MAX_LIVE_DEAL_FEE_LINES;

/**
 * Every line of a deal that has ever posted a custody charge — live,
 * voided, unlinked or re-charged — from ONE bounded indexed read, or a
 * refusal. `custodyPostingVersion` is set by every writer that posts a
 * charge and never unset, so the range `> 0` is exactly the population the
 * ledger gate must prove; a removed line stays in it, which is the point:
 * its reversal may still be queued.
 */
export async function loadCustodyPostedLines(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">,
  action: string,
  budget?: CustodyLedgerReadBudget
): Promise<Array<Doc<"financeDealFees">>> {
  // The index ranges on `custodyPostingVersion`, so the batch cursor cannot
  // also range on `_creationTime`: the lines are read one VERSION at a time
  // (equality on the version, then the creation-time cursor within it), and
  // the next version to read is the smallest one above the last — one
  // point-read, index order — until there is none. Every batch is charged
  // before the next is fetched, like every other enumeration here.
  const rows: Array<Doc<"financeDealFees">> = [];
  let version = 0;
  while (rows.length <= MAX_CUSTODY_POSTED_LINES) {
    await budget?.assertHeadroom(ctx);
    const next = await ctx.db
      .query("financeDealFees")
      .withIndex("by_application_custodyPostingVersion", (q) =>
        q.eq("applicationId", applicationId).gt("custodyPostingVersion", version)
      )
      .take(1);
    budget?.chargeRead(next);
    if (next.length === 0) break;
    const at = next[0].custodyPostingVersion;
    // A counter that is not a version (NaN, from `v.number()`) cannot be
    // stepped past: where the index orders it decides which lines follow,
    // so the enumeration refuses rather than stops short of them.
    if (at === undefined || !(at > version) || !isStoredVersion(at)) {
      throw new ConvexError(
        `A cost line on this deal carries a custody posting version that is not a positive whole number (${at}), so ${action} cannot enumerate the lines it must verify; nothing has been changed. Have the deal's custody reviewed.`
      );
    }
    version = at;
    const atVersion = await readBatched(
      ctx,
      (after, take) =>
        ctx.db
          .query("financeDealFees")
          .withIndex("by_application_custodyPostingVersion", (q) => {
            const range = q.eq("applicationId", applicationId).eq("custodyPostingVersion", at);
            return after === undefined ? range : range.gt("_creationTime", after);
          })
          .take(take),
      MAX_CUSTODY_POSTED_LINES - rows.length,
      budget
    );
    for (const row of atVersion) rows.push(row);
  }
  if (rows.length > MAX_CUSTODY_POSTED_LINES) {
    throw new ConvexError(
      `This deal has more than ${MAX_CUSTODY_POSTED_LINES} cost lines that have posted a custody charge, which is past what ${action} can verify completely; nothing has been changed. Have the deal's custody reviewed.`
    );
  }
  return rows;
}

/** The events of one source, in full or refused — never a prefix. */
async function sourceEvents(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  sourceType: string,
  sourceId: string,
  action: string,
  budget?: CustodyLedgerReadBudget
): Promise<Array<Doc<"accountingEvents">>> {
  const rows = await readBatched(
    ctx,
    (after, take) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => {
          const range = q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId);
          return after === undefined ? range : range.gt("_creationTime", after);
        })
        .take(take),
    MAX_SOURCE_EVENTS,
    budget
  );
  if (rows.length > MAX_SOURCE_EVENTS) {
    throw new ConvexError(
      `A custody posting on this deal carries more than ${MAX_SOURCE_EVENTS} ledger events, which is past what ${action} can verify completely; nothing has been changed. Have the record reviewed.`
    );
  }
  return rows;
}

/** The outbox rows of one source — queued, dead-lettered or posted — in full or refused; the outbox half of `sourceEvents`. */
async function sourceOutboxRows(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  sourceType: string,
  sourceId: string,
  action: string,
  budget?: CustodyLedgerReadBudget
): Promise<Array<Doc<"pendingAccountingEvents">>> {
  const rows = await readBatched(
    ctx,
    (after, take) =>
      ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_source", (q) => {
          const range = q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId);
          return after === undefined ? range : range.gt("_creationTime", after);
        })
        .take(take),
    MAX_SOURCE_EVENTS,
    budget
  );
  if (rows.length > MAX_SOURCE_EVENTS) {
    throw new ConvexError(
      `A custody posting on this deal has more than ${MAX_SOURCE_EVENTS} outbox rows, which is past what ${action} can verify completely; nothing has been changed. Have the record reviewed.`
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
  idempotencyKey: string,
  budget?: CustodyLedgerReadBudget
): Promise<boolean> {
  const rows = await keyedEvents(ctx, orgId, idempotencyKey, budget);
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
 * ## What a payable delta economically depends on
 *
 * A `CUSTODY_PAYABLE_RECLASSIFIED` delta is computed from the ROWS — the
 * position the fee lines and cash legs now state — and is only true of the
 * books once the primary postings it reflects are there: the corrected
 * fee's replacement version POSTED, the version it replaced OFF the books,
 * a reversed cash leg's forward event REVERSED, a fresh cash leg POSTED.
 * The chain rule (version N behind N−1) orders the deltas among themselves;
 * it says nothing about the postings a delta is a consequence of. So a delta
 * dated into an open month posted AHEAD of a fee reversal deferred into a
 * closed one: the payable moved to the corrected position while the
 * clearing account still carried the old charge, and a snapshot taken in
 * between reported a liability the primary journals did not yet support.
 *
 * The producer names the postings a delta follows (only it knows them),
 * the hook queues the delta when any is not yet where it must be, and the
 * worker re-proves every one on the queued row before it posts — the same
 * two-ended guard as the chain and the replacement rule. Each dependency is
 * ONE idempotency key and the state the ledger must show for it:
 *
 *  - `SETTLED`   — the forward posting under that key has reached its fate:
 *                  POSTED on the books, or cancelled before it ever posted
 *                  (no event, and no queued or dead-lettered outbox row —
 *                  `cancelPendingPostByKey` deletes the row). A forward still
 *                  waiting in the outbox holds. "Posted" alone would hold a
 *                  delta forever behind a version a later correction
 *                  cancelled, and the chain behind it with it — and a
 *                  queued delta whose SETTLED key was cancelled is not left
 *                  to post either: the next delta issued on the record folds
 *                  it away (`foldAbandonedPayableDeltas`), so the worker
 *                  only ever meets this case on a row nothing has re-based.
 *  - `OFF_BOOKS` — no forward event under that key is POSTED (it has been
 *                  REVERSED, or its queued post was cancelled and it never
 *                  reached the ledger).
 *
 * Carried on the event's payload, because a queued row outlives the
 * transaction that queued it and the worker has nothing else to read.
 * A payload whose dependencies cannot be parsed fails CLOSED.
 */
export type CustodyLedgerDependency = Readonly<{
  must: "SETTLED" | "OFF_BOOKS";
  idempotencyKey: string;
}>;

const CUSTODY_DEPENDENCIES_FIELD = "ledgerDependencies";

/**
 * How many postings one derived posting may be chained behind: every cash
 * leg, and for every line that ever posted a custody charge its current
 * version SETTLED plus the one earlier version a deferred reversal can
 * leave POSTED beside it — the whole position, as `custodyPositionDependencies`
 * names it.
 */
const MAX_CUSTODY_DEPENDENCIES = MAX_CUSTODY_ENTRIES + 2 * MAX_CUSTODY_POSTED_LINES;

/** The payload field a producer writes its dependencies into (`{}` when there are none). */
export function custodyDependenciesPayload(
  dependencies: ReadonlyArray<CustodyLedgerDependency>
): Record<string, unknown> {
  if (dependencies.length > MAX_CUSTODY_DEPENDENCIES) {
    throw new ConvexError(
      `A custody payable delta would depend on ${dependencies.length} ledger postings, which is past the ${MAX_CUSTODY_DEPENDENCIES} one delta can be chained behind; nothing has been changed. Have the record reviewed.`
    );
  }
  return dependencies.length === 0 ? {} : { [CUSTODY_DEPENDENCIES_FIELD]: dependencies.map((d) => ({ ...d })) };
}

/**
 * The dependencies a queued payload carries: `[]` when it names none (a
 * delta from before dependencies existed, or one with nothing to wait for),
 * or `null` when the field is present but not readable — which the caller
 * treats as a hold, never as "no dependencies".
 */
export function parseCustodyDependencies(payload: unknown): ReadonlyArray<CustodyLedgerDependency> | null {
  const record = (payload ?? {}) as Record<string, unknown>;
  const raw = record[CUSTODY_DEPENDENCIES_FIELD];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_CUSTODY_DEPENDENCIES) return null;
  const parsed: CustodyLedgerDependency[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const { must, idempotencyKey } = item as Record<string, unknown>;
    if ((must !== "SETTLED" && must !== "OFF_BOOKS") || typeof idempotencyKey !== "string" || idempotencyKey === "") {
      return null;
    }
    parsed.push({ must, idempotencyKey });
  }
  return parsed;
}

/** Whether a forward posting under this key is still waiting (or dead-lettered) in the outbox. */
async function forwardStillQueued(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string,
  budget?: CustodyLedgerReadBudget
): Promise<boolean> {
  const rows = await keyedOutboxRows(ctx, orgId, idempotencyKey, budget);
  return rows.some((row) => row.kind === "POST" && row.status !== "POSTED");
}

/**
 * Why a delta chained behind `dependencies` may NOT post yet, or `null` when
 * every one has reached the fate the ledger must show. Bounded point-reads
 * per dependency, POSTED-only on the ledger side (ACC-4): a PENDING or
 * FAILED event is not on the books, and only a POSTED one counts against
 * `OFF_BOOKS`; `SETTLED` additionally asks the outbox whether the forward is
 * still on its way.
 */
export async function custodyDependencyBlockedReason(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  dependencies: ReadonlyArray<CustodyLedgerDependency>
): Promise<string | null> {
  for (const dependency of dependencies) {
    const posted = await eventPosted(ctx, orgId, dependency.idempotencyKey);
    if (dependency.must === "SETTLED" && !posted && (await forwardStillQueued(ctx, orgId, dependency.idempotencyKey))) {
      return `the custody posting it follows (${dependency.idempotencyKey}) has not posted to the ledger yet`;
    }
    if (dependency.must === "OFF_BOOKS" && posted) {
      return `the custody posting it replaces (${dependency.idempotencyKey}) is still on the books; its reversal has not posted yet`;
    }
  }
  return null;
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

/** Every event type the custody family posts, keyed by the family it belongs to. */
const CUSTODY_CASH_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(CUSTODY_CASH_EVENT_TYPE));
const CUSTODY_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...CUSTODY_CASH_EVENT_TYPES,
  "CUSTODY_FEE_PAID",
  "CUSTODY_WRITTEN_OFF",
  "CUSTODY_PAYABLE_RECLASSIFIED",
]);
const CUSTODY_KEY_PREFIX = /^custody_(entry|fee_paid|written_off|payable_reclass)_/;

/**
 * ## The canonical identity a queued custody row must carry BEFORE it posts (R8)
 *
 * The family gate holds every POSTED custody event to an exact identity —
 * a cash leg is its kind's event type at version 1 under `custody_entry_`,
 * a fee posting is `CUSTODY_FEE_PAID` on its line at the version its key
 * names, a write-off and a payable delta likewise on their record — and
 * refuses a deal whose ledger carries anything else under those keys
 * (`custodyLedgerFamilyRefusal`, `provePayableChain`). The worker was the
 * one door that did not: it re-proved ORDER (below) and then posted whatever
 * identity the queued row carried. A row whose key, event type, source or
 * version contradict one another — the shape a raw edit of the outbox
 * writes — would therefore become a POSTED journal the gate refuses for
 * ever, with no version to replace it and nothing to reverse it against.
 *
 * So the worker proves the row's identity first, from the row alone, and a
 * contradiction holds the row with the contradiction named — before the
 * period, dependency or predecessor checks, and before any write. Judged in
 * BOTH directions: a custody key promises exactly one (event type, source,
 * version), and a custody event type promises exactly one key. A row that
 * is not custody's on either side is none of this guard's business.
 *
 * Pure over the row so the worker, a test and a future repair tool cannot
 * disagree about what "canonical" means.
 */
export function custodyCanonicalIdentityRefusal(entry: {
  idempotencyKey: string;
  eventType?: string;
  eventVersion?: number;
  sourceType: string;
  sourceId: string;
  payload?: unknown;
}): string | null {
  const keyedAsCustody = CUSTODY_KEY_PREFIX.test(entry.idempotencyKey);
  const typedAsCustody = entry.eventType !== undefined && CUSTODY_EVENT_TYPES.has(entry.eventType);
  if (!keyedAsCustody && !typedAsCustody) return null;
  if (!keyedAsCustody) {
    return `it is a ${entry.eventType} event under a key that is not a custody posting's (${entry.idempotencyKey}), so the custody posting it would be cannot be traced`;
  }
  if (!typedAsCustody) {
    return `it is keyed as a custody posting (${entry.idempotencyKey}) but carries ${entry.eventType === undefined ? "no event type" : `a ${entry.eventType} event`}, so it is not the posting its key promises`;
  }
  if (!isStoredVersion(entry.eventVersion)) {
    return `it is keyed as a custody posting (${entry.idempotencyKey}) but carries a version that is not a positive whole number (${entry.eventVersion}), so it is not the posting its key promises`;
  }
  const eventType = entry.eventType as string;
  // The one key this (event type, source, version) posts under. The `as Id`
  // below only FORMATS the expected key from the row's own source string so
  // the builders' formats are not duplicated; it proves nothing about the
  // source — that is `custodyPostingRefusal`, which normalizes and loads it.
  let expected: { key: string; sourceType: string } | null = null;
  if (CUSTODY_CASH_EVENT_TYPES.has(eventType)) {
    expected =
      entry.eventVersion === CUSTODY_CASH_EVENT_VERSION
        ? { key: custodyEntryPostKey(entry.sourceId as Id<"financeDealCustodyEntries">), sourceType: "financeDealCustodyEntries" }
        : null;
    if (expected === null) {
      return `it is a ${eventType} event at version ${entry.eventVersion}, but a custody cash leg posts once, at version ${CUSTODY_CASH_EVENT_VERSION}, so it is not the posting its key promises`;
    }
  } else if (eventType === "CUSTODY_FEE_PAID") {
    expected = { key: custodyFeePostKey(entry.sourceId as Id<"financeDealFees">, entry.eventVersion), sourceType: "financeDealFees" };
  } else if (eventType === "CUSTODY_WRITTEN_OFF") {
    expected = { key: custodyWriteOffPostKey(entry.sourceId as Id<"financeDealCustody">, entry.eventVersion), sourceType: "financeDealCustody" };
  } else {
    expected = { key: custodyPayableReclassKey(entry.sourceId as Id<"financeDealCustody">, entry.eventVersion), sourceType: "financeDealCustody" };
  }
  if (entry.sourceType !== expected.sourceType) {
    return `it is a ${eventType} event keyed on ${entry.sourceType} rather than ${expected.sourceType}, so it is not the posting its key promises`;
  }
  if (entry.idempotencyKey !== expected.key) {
    return `it is a ${eventType} event for ${entry.sourceType} ${entry.sourceId} at version ${entry.eventVersion}, whose posting is keyed ${expected.key}, but it is queued under ${entry.idempotencyKey}, so it is not the posting its key promises`;
  }
  if (eventType === "CUSTODY_PAYABLE_RECLASSIFIED") {
    // The chain the fold and the gate read follows the payload's record;
    // a payload naming another record is a delta on the wrong chain.
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    if (payload.custodyId !== entry.sourceId) {
      return `it is a payable reclassification of custody record ${entry.sourceId} whose payload names ${typeof payload.custodyId === "string" ? payload.custodyId : "no custody record"}, so it is not the delta its key promises`;
    }
  }
  return null;
}

/** The shape every custody posting's payload is read through: a plain object, or nothing readable. */
function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}

/**
 * ## The canonical SOURCE a queued custody row must stand on before it posts (R8, Sol)
 *
 * `custodyCanonicalIdentityRefusal` proves only what the row says about
 * itself. A canonical-looking key can still name a source that does not
 * exist, is not an id at all, belongs to another organization, or is a
 * different kind of movement than the event type claims — and the payload
 * the journal is built from can disagree with the source it names. None of
 * that is transient: no period opening, no predecessor posting and no
 * dependency settling ever makes such a row postable, so it is a PERMANENT
 * refusal (`failOutboxRow`: an attempt burned, dead-lettered at the limit),
 * never a hold that leaves it PENDING for ever.
 *
 * Per family, from the source rows the hooks minted the event from — every
 * id normalized through `ctx.db.normalizeId`, never cast:
 *
 *  - a cash leg (`custody_entry_`): the entry exists, in this org; its
 *    record exists, in this org, and is the entry's; the entry is a cash
 *    kind whose event type is the row's; the payload names exactly that
 *    entry, record, deal, holder, amount, currency and method;
 *  - a fee posting: the line exists, in this org; the payload names that
 *    line, its deal, its currency and fee type, a positive amount, and a
 *    custody record that exists, in this org, on the line's deal, in the
 *    line's currency (the record the version was charged to — not
 *    necessarily the line's CURRENT link, which a later version may have
 *    moved);
 *  - a write-off / payable delta: the record exists, in this org; the
 *    payload names that record, its deal, its holder and currency; the
 *    amount (write-off) or delta and resulting position (payable) are safe
 *    integers, the write-off positive; and the dependency list it is
 *    chained behind reads (`parseCustodyDependencies`).
 *
 * The amount on a fee, write-off or delta is the VERSION's, so it is proven
 * a figure, not equal to the row's current one: a queued v1 legitimately
 * carries the actual that v2 has since replaced.
 *
 * Returns the reason, or `null` when the row stands on its source.
 */
export async function custodyPostingRefusal(
  ctx: QueryCtx | MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    idempotencyKey: string;
    eventType?: string;
    eventVersion?: number;
    sourceType: string;
    sourceId: string;
    payload?: unknown;
  }
): Promise<string | null> {
  const identity = custodyCanonicalIdentityRefusal(entry);
  if (identity !== null) return identity;
  const eventType = entry.eventType;
  if (eventType === undefined || !CUSTODY_EVENT_TYPES.has(eventType)) return null;
  const payload = payloadRecord(entry.payload);
  if (payload === null) {
    return `it is a ${eventType} event carrying no readable payload, so the posting cannot be built from it`;
  }
  const names = (field: string, expected: unknown, what: string): string | null =>
    payload[field] === expected ? null : `its payload names ${what} (${String(payload[field])}) that is not the source's (${String(expected)})`;
  const figure = (field: string, what: string, positive: boolean): string | null => {
    const value = payload[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || (positive ? value <= 0 : false)) {
      return `its payload carries ${what} that is not a ${positive ? "positive " : ""}whole amount (${String(value)})`;
    }
    return null;
  };
  const loadCustody = async (raw: string, what: string): Promise<Doc<"financeDealCustody"> | string> => {
    const custodyId = ctx.db.normalizeId("financeDealCustody", raw);
    const custody = custodyId === null ? null : await ctx.db.get(custodyId);
    if (custody === null) return `${what} (${raw}) is not a custody record`;
    if (custody.orgId !== entry.orgId) return `${what} (${raw}) is not a custody record in this organization`;
    return custody;
  };

  if (CUSTODY_CASH_EVENT_TYPES.has(eventType)) {
    const entryId = ctx.db.normalizeId("financeDealCustodyEntries", entry.sourceId);
    const movement = entryId === null ? null : await ctx.db.get(entryId);
    if (movement === null) return `its source (${entry.sourceId}) is not a custody movement`;
    if (movement.orgId !== entry.orgId) return `its source (${entry.sourceId}) is not a custody movement in this organization`;
    if (movement.kind === "REVERSAL") {
      return `its source (${entry.sourceId}) is a reversal entry, which posts as the reversal of the movement it cancels, never as a cash leg of its own`;
    }
    if (CUSTODY_CASH_EVENT_TYPE[movement.kind] !== eventType) {
      return `it is a ${eventType} event, but its source is a ${movement.kind} movement, which posts as ${CUSTODY_CASH_EVENT_TYPE[movement.kind]}`;
    }
    const custody = await loadCustody(movement.custodyId, "the movement's custody record");
    if (typeof custody === "string") return custody;
    return (
      names("entryId", movement._id, "a movement") ??
      names("custodyId", custody._id, "a custody record") ??
      names("applicationId", custody.applicationId, "a deal") ??
      names("userId", custody.userId, "a holder") ??
      names("amountMinor", movement.amountMinor, "an amount") ??
      names("currency", custody.currency, "a currency") ??
      names("paymentMethod", movement.method, "a payment method")
    );
  }

  if (eventType === "CUSTODY_FEE_PAID") {
    const feeId = ctx.db.normalizeId("financeDealFees", entry.sourceId);
    const fee = feeId === null ? null : await ctx.db.get(feeId);
    if (fee === null) return `its source (${entry.sourceId}) is not a cost line`;
    if (fee.orgId !== entry.orgId) return `its source (${entry.sourceId}) is not a cost line in this organization`;
    const own =
      names("feeId", fee._id, "a cost line") ??
      names("applicationId", fee.applicationId, "a deal") ??
      names("currency", fee.currency, "a currency") ??
      names("feeType", fee.feeType, "a fee type") ??
      figure("amountMinor", "an amount", true);
    if (own !== null) return own;
    if (typeof payload.custodyId !== "string") return `its payload names no custody record the cost was paid out of`;
    const custody = await loadCustody(payload.custodyId, "the custody record the cost was paid out of");
    if (typeof custody === "string") return custody;
    if (custody.applicationId !== fee.applicationId) {
      return `the custody record the cost was paid out of (${custody._id}) is on another deal than the cost line`;
    }
    if (custody.currency !== fee.currency) {
      return `the custody record the cost was paid out of (${custody._id}) is held in ${custody.currency}, not the cost line's ${fee.currency}`;
    }
    return null;
  }

  // CUSTODY_WRITTEN_OFF and CUSTODY_PAYABLE_RECLASSIFIED: both on the record.
  const custody = await loadCustody(entry.sourceId, "its source");
  if (typeof custody === "string") return custody;
  const own =
    names("custodyId", custody._id, "a custody record") ??
    names("applicationId", custody.applicationId, "a deal") ??
    names("userId", custody.userId, "a holder") ??
    names("currency", custody.currency, "a currency") ??
    (eventType === "CUSTODY_WRITTEN_OFF"
      ? figure("amountMinor", "a written-off amount", true)
      : (figure("deltaMinor", "a payable delta", false) ?? figure("payableAfterMinor", "a payable position", false)));
  if (own !== null) return own;
  if (parseCustodyDependencies(payload) === null) {
    return "it carries ledger dependencies that cannot be read, so the postings it is chained behind cannot be named";
  }
  return null;
}

/**
 * Why a queued custody event must NOT post YET, or `null` when it may — the
 * TRANSIENT half. The worker refuses a row that can never post
 * (`custodyPostingRefusal`: identity, source and payload) permanently and
 * BEFORE asking this, so everything here is a wait that some later posting
 * ends. The fail-closed answers below on an unreadable payload remain for a
 * direct caller; in the worker they are unreachable.
 *
 *  - `CUSTODY_PAYABLE_RECLASSIFIED` version N waits for version N−1.
 *  - `CUSTODY_FEE_PAID` / `CUSTODY_WRITTEN_OFF` version N waits for the
 *    REVERSAL of every earlier version — a deferred reversal leaves the
 *    earlier version POSTED, and the replacement must not overtake it.
 *  - `CUSTODY_PAYABLE_RECLASSIFIED` and `CUSTODY_WRITTEN_OFF` — the DERIVED
 *    postings, computed from the rows — also wait for every primary posting
 *    they are a consequence of, named on their payload (`ledgerDependencies`).
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
    idempotencyKey: string;
    eventType?: string;
    eventVersion?: number;
    sourceType: string;
    sourceId: string;
    payload?: unknown;
  }
): Promise<string | null> {
  const version = entry.eventVersion ?? 1;
  if (entry.eventType === "CUSTODY_FEE_PAID" || entry.eventType === "CUSTODY_WRITTEN_OFF") {
    if (version > 1) {
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
    }
    if (entry.eventType === "CUSTODY_FEE_PAID") return null;
    // A write-off absorbs the residual its legs and lines leave: derived, so
    // it waits for them exactly as the payable delta does.
    const writeOffDependencies = parseCustodyDependencies(entry.payload);
    if (writeOffDependencies === null) {
      return "it carries ledger dependencies that cannot be read, so the postings its shortage derives from cannot be proven on the books";
    }
    const writeOffBlock = await custodyDependencyBlockedReason(ctx, entry.orgId, writeOffDependencies);
    return writeOffBlock === null
      ? null
      : `${writeOffBlock}, so this would absorb a shortage the clearing account does not yet show`;
  }
  if (entry.eventType !== "CUSTODY_PAYABLE_RECLASSIFIED") return null;
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  if (version > 1) {
    const raw = typeof payload.custodyId === "string" ? payload.custodyId : null;
    const custodyId = raw ? ctx.db.normalizeId("financeDealCustody", raw) : null;
    if (!custodyId) {
      return "it carries no readable custody reference, so the payable reclassification it follows cannot be traced";
    }
    if (!(await custodyPayableReclassPosted(ctx, entry.orgId, custodyId, version - 1))) {
      return `custody payable reclassification v${version - 1} behind it has not posted to the ledger yet, so this would move an Employee Reimbursements Payable balance the ledger does not carry`;
    }
  }
  // Version 1 has no predecessor delta, but it still follows the postings it
  // is a consequence of — a first out-of-pocket position exists because a
  // fee posted, and that fee may be queued for a closed month.
  const dependencies = parseCustodyDependencies(payload);
  if (dependencies === null) {
    return "it carries ledger dependencies that cannot be read, so the postings it follows cannot be proven on the books";
  }
  const dependencyBlock = await custodyDependencyBlockedReason(ctx, entry.orgId, dependencies);
  if (dependencyBlock !== null) {
    return `${dependencyBlock}, so this would move an Employee Reimbursements Payable balance ahead of the custody posting it reflects`;
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
  action: string,
  budget?: CustodyLedgerReadBudget
): Promise<Array<Doc<"financeDealCustodyEntries">>> {
  const entries = await readBatched(
    ctx,
    (after, take) =>
      ctx.db
        .query("financeDealCustodyEntries")
        .withIndex("by_custody", (q) => {
          const range = q.eq("custodyId", custodyId);
          return after === undefined ? range : range.gt("_creationTime", after);
        })
        .take(take),
    MAX_CUSTODY_ENTRIES,
    budget
  );
  if (entries.length > MAX_CUSTODY_ENTRIES) {
    throw new ConvexError(
      `This custody record carries more than ${MAX_CUSTODY_ENTRIES} movements, which is past what ${action} can decide on completely; nothing has been changed. Have the record reviewed rather than extended.`
    );
  }
  return entries;
}

/**
 * ## What a custody record's POSITION is made of (follow-up audit, H2)
 *
 * The primary postings a derived posting on this record — a write-off, a
 * payable delta — is a consequence of, as the dependencies it is chained
 * behind:
 *
 *  - every standing cash leg SETTLED, every reversed leg OFF the books;
 *  - every line that has EVER posted a custody charge on this deal —
 *    enumerated through `by_application_custodyPostingVersion`, never from
 *    the live rows — at the state the record's position assumes: a line
 *    live and charged to THIS record has its current version SETTLED, and
 *    every OTHER version of any such line that is still POSTED must be OFF
 *    the books first. A line the position no longer counts (voided,
 *    unlinked, re-charged elsewhere) whose deferred reversal has left its
 *    charge POSTED is exactly the residual a write-off would otherwise
 *    absorb twice: the clearing account still carries the charge while the
 *    rows call the cash unaccounted for. Reading the live lines alone
 *    (the previous design) could not see it — a voided line is not live.
 *
 * Which versions are still POSTED is read from the ledger, under the same
 * document budget as the family proof; the worker re-proves each named key
 * off the payload. A version that never posted and is not queued is named
 * by nobody: a SETTLED key must be the version the row still claims, and
 * an OFF_BOOKS key must be one the ledger showed POSTED. Tenant-bound by
 * the record's own `orgId` and `applicationId`.
 *
 * ### Whose charge a posted version is (R5, F2)
 *
 * A deal may have two custodians, and a line re-charged from one to the
 * other has a version on each record's books: v1 charged to A (reversed,
 * perhaps under a deferred reversal), v2 charged to B and LIVE. B's v2 is
 * B's position, not a charge A's residual is waiting to see leave — naming
 * it OFF the books for A held A's write-off and every later payable delta
 * behind a posting that will legitimately never reverse. So a posted
 * version is A's dependency only when it is ATTRIBUTED to A: the event's
 * own `custodyId` (written by every producer of `CUSTODY_FEE_PAID`), never
 * the row's current link, which says nothing about earlier versions. An
 * attribution that cannot be read — absent, not an id, or a record that is
 * not one of this deal's — is a version whose fate this record cannot
 * judge, and the proof REFUSES rather than guesses (fail closed): every
 * posted version of a line matters to SOME record of the deal. The version
 * the row still claims is SETTLED only when the row AND the ledger agree it
 * is this record's.
 *
 * ### The record's own write-offs (R5, F1)
 *
 * A written-off shortage is a credit on the clearing account; reopening
 * reverses it, and a DEFERRED reversal leaves the write-off POSTED while
 * the row (now OPEN, `writeOffPosted` cleared) no longer names it. Every
 * derived posting after that — a payable delta for a receipt that turned
 * up, a re-closure — is computed from a position the ledger does not yet
 * show, so every POSTED write-off version other than the one the row still
 * claims is named OFF the books here, read from the record's own event
 * family. The row cannot carry it (reopen erases the claim on purpose:
 * the loss is withdrawn); the ledger is the only witness.
 */
export async function custodyPositionDependencies(
  ctx: QueryCtx | MutationCtx,
  custody: Doc<"financeDealCustody">,
  action: string
): Promise<CustodyLedgerDependency[]> {
  const budget = new CustodyLedgerReadBudget(MAX_CUSTODY_LEDGER_PROOFS, action);
  const entries = await loadCustodyEntries(ctx, custody._id, action, budget);
  const reversed = new Set(entries.filter((entry) => entry.kind === "REVERSAL").map((entry) => entry.reversesEntryId));
  const dependencies: CustodyLedgerDependency[] = [];
  for (const entry of entries) {
    if (entry.kind === "REVERSAL") continue;
    dependencies.push({
      must: reversed.has(entry._id) ? "OFF_BOOKS" : "SETTLED",
      idempotencyKey: custodyEntryPostKey(entry._id),
    });
  }

  // The record's own family: every write-off still on the books that the
  // row no longer claims must leave them first.
  const own = await sourceEvents(ctx, custody.orgId, "financeDealCustody", custody._id.toString(), action, budget);
  const claimedWriteOff = custody.writeOffPosted?.version;
  for (const event of own) {
    if (event.eventType !== "CUSTODY_WRITTEN_OFF" || event.status !== "POSTED" || event.eventVersion === claimedWriteOff) continue;
    dependencies.push({ must: "OFF_BOOKS", idempotencyKey: custodyWriteOffPostKey(custody._id, event.eventVersion) });
  }

  // The deal's custody records, so an attribution names a record of THIS
  // deal (and org) or is refused. Bounded like every decision read.
  const dealCustody = await readBatched(
    ctx,
    (after, take) =>
      ctx.db
        .query("financeDealCustody")
        .withIndex("by_application", (q) => {
          const range = q.eq("applicationId", custody.applicationId);
          return after === undefined ? range : range.gt("_creationTime", after);
        })
        .take(take),
    MAX_DEAL_CUSTODY_DECISION_RECORDS,
    budget
  );
  if (dealCustody.length > MAX_DEAL_CUSTODY_DECISION_RECORDS) {
    throw new ConvexError(
      `This deal carries more than ${MAX_DEAL_CUSTODY_DECISION_RECORDS} custody records, which is past what ${action} can decide on completely; nothing has been changed. Have the deal's custody reviewed.`
    );
  }
  const dealCustodyIds = new Set(dealCustody.filter((row) => row.orgId === custody.orgId).map((row) => row._id.toString()));
  const attributedTo = (event: Doc<"accountingEvents">): string => {
    const raw = (event.payload as Record<string, unknown> | null | undefined)?.custodyId;
    const id = typeof raw === "string" ? ctx.db.normalizeId("financeDealCustody", raw) : null;
    if (id === null || !dealCustodyIds.has(id.toString())) {
      throw new ConvexError(
        `A custody charge on this deal (custody fee posting v${event.eventVersion}) cannot be attributed to a custody record of the deal, so ${action} cannot prove whose books it is on; nothing has been changed. Have the deal's custody reviewed.`
      );
    }
    return id.toString();
  };

  const postedLines = await loadCustodyPostedLines(ctx, custody.applicationId, action, budget);
  const self = custody._id.toString();
  for (const fee of postedLines) {
    const current =
      fee.voidedAt === undefined &&
      fee.custodyId === custody._id &&
      fee.custodyPosted !== undefined &&
      fee.custodyPosted.custodyId === custody._id
        ? fee.custodyPosted.version
        : null;
    const family = await sourceEvents(ctx, custody.orgId, "financeDealFees", fee._id.toString(), action, budget);
    // The versions to leave first, then the one to arrive: the first unmet
    // dependency names the reason, and a replacement is held behind the
    // reversal it follows before it is awaited itself. Only the versions
    // attributed to THIS record are its concern; the attribution of every
    // posted version is proven, whichever record it names.
    for (const event of family) {
      if (event.eventType !== "CUSTODY_FEE_PAID" || event.status !== "POSTED") continue;
      const owner = attributedTo(event);
      if (event.eventVersion === current) {
        if (owner !== self) {
          throw new ConvexError(
            `A custody charge on this deal (custody fee posting v${event.eventVersion}) is on the books against a different custody record than the one its line names, so ${action} cannot prove this record's position; nothing has been changed. Have the deal's custody reviewed.`
          );
        }
        continue;
      }
      if (owner !== self) continue;
      dependencies.push({ must: "OFF_BOOKS", idempotencyKey: custodyFeePostKey(fee._id, event.eventVersion) });
    }
    if (current !== null) {
      dependencies.push({ must: "SETTLED", idempotencyKey: custodyFeePostKey(fee._id, current) });
    }
  }
  return dependencies;
}

/** The unposted POST row under this key — PENDING or dead-lettered — or `null`. */
async function pendingForwardByKey(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string,
  budget?: CustodyLedgerReadBudget
): Promise<Doc<"pendingAccountingEvents"> | null> {
  const rows = await keyedOutboxRows(ctx, orgId, idempotencyKey, budget);
  return rows.find((row) => row.kind === "POST" && row.status !== "POSTED") ?? null;
}

/**
 * One queued link of a record's payable chain, proven to be the row the
 * chain expects at that version, with its dependencies parsed ONCE here —
 * the fold reads them off the link rather than the payload again.
 */
type PayableChainLink = Readonly<{
  version: number;
  row: Doc<"pendingAccountingEvents">;
  deltaMinor: number;
  dependencies: ReadonlyArray<CustodyLedgerDependency>;
}>;

/**
 * What one exact reading of a record's payable chain establishes, or why it
 * cannot be read as a chain at all. `what` is the defect in the record's own
 * terms ("payable reclassification v2 is on the ledger more than once"); the
 * caller wraps it in the sentence its door speaks.
 */
type PayableChainProof =
  | Readonly<{ ok: true; tail: ReadonlyArray<PayableChainLink> }>
  | Readonly<{ ok: false; what: string }>;

/**
 * ## The one exact reading of a payable chain (R5 F5, R6 F2)
 *
 * The chain a record carries is EXACTLY: one POSTED `CUSTODY_PAYABLE_RECLASSIFIED`
 * event of this record at each of versions 1..P, then one queued `POST` row
 * of this record at each of P+1..N where N is the version the row says it
 * issued — and NOTHING else: no second event or row at any version, no
 * event or row above N, every link under the chain's own key for its
 * version, every delta a safe integer, every link's dependencies readable,
 * and the deltas summing to the target the row carries. The POSTED half is
 * held to the same identity and payload contract as the queued half (R7,
 * F5): a posted event under another key is not the chain's link, and a
 * posted payload whose dependencies cannot be read is not one the worker
 * could have proven before it posted. "The highest POSTED version" said nothing about the versions
 * below it; "every version 1..N appears in a Set" said nothing about
 * duplicates, about what lies above N, or about whether any of it can be
 * read. Both doors that judge the chain — the fold that re-bases it before
 * a movement, the family gate that certifies it before a deal classifies
 * or finalizes — read it through THIS function, so they cannot disagree.
 *
 * Reads: the record's event family (or the one the caller already read),
 * ONE bounded enumeration of the record's outbox rows, and a keyed lookup
 * only for a version the enumeration did not carry — to say whether it is
 * missing or merely mis-shaped. Every read is charged to `budget`.
 */
async function provePayableChain(
  ctx: QueryCtx | MutationCtx,
  custody: Doc<"financeDealCustody">,
  action: string,
  budget: CustodyLedgerReadBudget,
  family?: ReadonlyArray<Doc<"accountingEvents">>
): Promise<PayableChainProof> {
  const issued = custody.payableReclassVersion ?? 0;
  const targetMinor = custody.payableTargetMinor ?? 0;
  const orgId = custody.orgId;
  const sourceId = custody._id.toString();
  const refused = (version: number, what: string): PayableChainProof => ({
    ok: false,
    what: `payable reclassification v${version} ${what}`,
  });
  const readDelta = (payload: unknown): number | null => {
    const deltaMinor = (payload as Record<string, unknown> | null | undefined)?.deltaMinor;
    return typeof deltaMinor === "number" && Number.isSafeInteger(deltaMinor) ? deltaMinor : null;
  };
  // `v.number()` admits NaN and fractions (CVX-4). A NaN issued count makes
  // every range comparison below false and the tail empty — an "intact"
  // chain nobody issued — and a NaN or zero version is a Map key the prefix
  // walk never reaches and the stray check never flags. Each stored number
  // is proven to be what the chain treats it as before it is compared.
  if (!Number.isSafeInteger(issued) || issued < 0) {
    return { ok: false, what: `payable reclassification count (${issued}) is not a whole number of versions` };
  }
  if (!Number.isSafeInteger(targetMinor)) {
    return { ok: false, what: `payable target (${targetMinor}) is not a readable amount` };
  }
  const events = family ?? (await sourceEvents(ctx, orgId, "financeDealCustody", sourceId, action, budget));
  const postedByVersion = new Map<number, Doc<"accountingEvents">>();
  for (const event of events) {
    if (event.eventType !== "CUSTODY_PAYABLE_RECLASSIFIED" || event.status !== "POSTED") continue;
    if (!isStoredVersion(event.eventVersion)) {
      return { ok: false, what: `payable reclassification event carries a version that is not a positive whole number (${event.eventVersion})` };
    }
    if (postedByVersion.has(event.eventVersion)) return refused(event.eventVersion, "is on the ledger more than once");
    if (event.idempotencyKey !== custodyPayableReclassKey(custody._id, event.eventVersion)) {
      return refused(event.eventVersion, "is not the reclassification the chain expects (its ledger event names another event, source or version)");
    }
    postedByVersion.set(event.eventVersion, event);
  }
  // The contiguous POSTED prefix 1..posted, and its arithmetic — each link
  // held to the same payload contract as a queued one.
  let posted = 0;
  let postedSum = 0;
  while (postedByVersion.has(posted + 1)) {
    posted += 1;
    const link = postedByVersion.get(posted)!;
    const deltaMinor = readDelta(link.payload);
    if (deltaMinor === null) return refused(posted, "carries no readable delta");
    if (parseCustodyDependencies(link.payload) === null) return refused(posted, "carries ledger dependencies that cannot be read");
    postedSum += deltaMinor;
  }
  if (posted > issued) return refused(posted, "is on the ledger past the version the record says it issued");
  for (const version of postedByVersion.keys()) {
    if (version > posted) return refused(posted + 1, "is neither on the ledger nor waiting in the outbox");
  }

  // Every unposted POST row of this record, by version — the tail, and
  // anything queued where the chain says nothing should be.
  const outbox = await sourceOutboxRows(ctx, orgId, "financeDealCustody", sourceId, action, budget);
  const queuedByVersion = new Map<number, Doc<"pendingAccountingEvents">>();
  for (const row of outbox) {
    if (row.kind !== "POST" || row.status === "POSTED" || row.eventType !== "CUSTODY_PAYABLE_RECLASSIFIED") continue;
    if (!isStoredVersion(row.eventVersion)) {
      return { ok: false, what: `payable reclassification outbox row carries a version that is not a positive whole number (${row.eventVersion})` };
    }
    if (queuedByVersion.has(row.eventVersion)) return refused(row.eventVersion, "is waiting in the outbox more than once");
    queuedByVersion.set(row.eventVersion, row);
  }
  for (const version of queuedByVersion.keys()) {
    if (version <= posted) return refused(version, "is waiting in the outbox although it is already on the ledger");
    if (version > issued) return refused(version, "is waiting in the outbox past the version the record says it issued");
  }

  const tail: PayableChainLink[] = [];
  let queuedSum = 0;
  for (let version = posted + 1; version <= issued; version += 1) {
    const link = queuedByVersion.get(version) ?? null;
    if (link === null) {
      // Under the chain's key but not this record's row — or nowhere at all.
      const underKey = await pendingForwardByKey(ctx, orgId, custodyPayableReclassKey(custody._id, version), budget);
      return underKey === null
        ? refused(version, "is neither on the ledger nor waiting in the outbox")
        : refused(version, "is not the reclassification the chain expects (its queued row names another event, source or version)");
    }
    if (link.idempotencyKey !== custodyPayableReclassKey(custody._id, version)) {
      return refused(version, "is not the reclassification the chain expects (its queued row names another event, source or version)");
    }
    const deltaMinor = readDelta(link.payload);
    if (deltaMinor === null) return refused(version, "carries no readable delta");
    const dependencies = parseCustodyDependencies(link.payload);
    if (dependencies === null) return refused(version, "carries ledger dependencies that cannot be read");
    queuedSum += deltaMinor;
    tail.push({ version, row: link, deltaMinor, dependencies });
  }
  if (postedSum + queuedSum !== targetMinor) {
    return {
      ok: false,
      what: `payable reclassification chain (${postedSum} posted, ${queuedSum} waiting) does not add up to the target the row carries (${targetMinor})`,
    };
  }
  return { ok: true, tail };
}

/**
 * ## A derived version whose primary was cancelled (follow-up audit, H3)
 *
 * A payable delta is computed from the rows and chained behind the
 * primaries it reflects. When a primary it named SETTLED is cancelled
 * before it ever posts — a fee version replaced by a later correction while
 * still queued, a cash leg reversed while still queued — the delta's
 * target is a position the ledger will never support, and "cancelled
 * counts as settled" would let it post: after v1's deferred reversal landed
 * and before v3 posted, the payable moved to the cancelled v2's amount, and
 * a snapshot taken between the two reported a liability no journal carried.
 * Holding it forever instead would deadlock the chain behind it.
 *
 * So the unposted tail of the chain is FOLDED at the moment the caller
 * issues the next delta: from the lowest queued version that follows a
 * primary the ledger will never carry as it stated (its SETTLED key is
 * neither POSTED nor on its way), every queued row is dropped and the
 * caller re-issues ONE delta at that version, measured from the target the
 * POSTED chain reached and chained behind the whole position
 * (`custodyPositionDependencies`). The arithmetic is exact — the dropped
 * rows never reached the books, so the sum of what is posted plus the new
 * delta is the current target — and the chain rule still holds, because the
 * re-issued version's predecessor is POSTED or a queued row left standing.
 * A queued row that merely waits (its primary is queued too) is left alone.
 *
 * Returns the version to issue at and the target to measure the delta
 * from; refuses when a version the row says it issued is neither on the
 * ledger nor in the outbox, or a queued row's delta cannot be read — the
 * chain cannot be re-based on a link nobody can see.
 *
 * ### The chain is proven link by link, never by its highest link (R5, F5)
 *
 * "The highest POSTED version" said nothing about the versions below it:
 * v2 POSTED over a v1 that exists nowhere read as an intact chain, and the
 * next delta was issued on top of a payable no journal ever credited. So
 * the chain is read through `provePayableChain` — the contiguous POSTED
 * prefix, the exact queued tail, nothing above the issued version, every
 * delta and dependency readable, the arithmetic against the row's target —
 * and a chain that reads as anything else REFUSES the mutation, never
 * folds: folding deletes rows, and a row nobody can read is not one to
 * delete.
 *
 * The one compatibility rule: a queued row with NO dependency field at all
 * (from before dependencies existed) names none. It is left standing and
 * posts by the chain rule alone; it is neither folded nor refused.
 *
 * ### Each primary is proven ONCE (R6, F1)
 *
 * Every queued link names the whole position it was computed from, so a
 * tail of N links over a record with K primaries names on the order of
 * N × K dependencies — and proving each mention afresh read the ledger and
 * the outbox N × K times: past the platform's per-transaction read limit on
 * a record that was merely long-lived. A primary's fate does not depend on
 * which link asks, so it is proven once per idempotency key and remembered
 * for every later mention, and every read the fold makes — the family, the
 * outbox enumeration, each proof — is charged to ONE document budget that
 * refuses with a named reason before the platform would.
 */
export async function foldAbandonedPayableDeltas(
  ctx: MutationCtx,
  custody: Doc<"financeDealCustody">,
  action: string,
  budget: CustodyLedgerReadBudget = new CustodyLedgerReadBudget(MAX_CUSTODY_LEDGER_PROOFS, action)
): Promise<{ nextVersion: number; baseTargetMinor: number }> {
  const issued = custody.payableReclassVersion ?? 0;
  const targetMinor = custody.payableTargetMinor ?? 0;
  const intact = { nextVersion: issued + 1, baseTargetMinor: targetMinor };
  if (issued > MAX_SOURCE_EVENTS) {
    throw new ConvexError(
      `This custody record has more than ${MAX_SOURCE_EVENTS} payable reclassifications, which is past what ${action} can re-base completely; nothing has been changed. Have the record reviewed.`
    );
  }
  const chain = await provePayableChain(ctx, custody, action, budget);
  if (!chain.ok) {
    throw new ConvexError(
      `This custody record's ${chain.what}, so ${action} cannot be chained behind it; nothing has been changed. Have the record reviewed.`
    );
  }
  if (chain.tail.length === 0) return intact;

  // A primary the ledger will never carry as a link stated it: its SETTLED
  // key is neither POSTED nor on its way. Proven once per key.
  const abandonedByKey = new Map<string, boolean>();
  const abandoned = async (idempotencyKey: string): Promise<boolean> => {
    const known = abandonedByKey.get(idempotencyKey);
    if (known !== undefined) return known;
    const result =
      !(await eventPosted(ctx, custody.orgId, idempotencyKey, budget)) &&
      !(await forwardStillQueued(ctx, custody.orgId, idempotencyKey, budget));
    abandonedByKey.set(idempotencyKey, result);
    return result;
  };
  let foldFrom: number | null = null;
  for (const link of chain.tail) {
    // Parsed once by the chain proof; a row that names none is left standing.
    for (const dependency of link.dependencies) {
      if (dependency.must === "SETTLED" && (await abandoned(dependency.idempotencyKey))) {
        foldFrom = link.version;
        break;
      }
    }
    if (foldFrom !== null) break;
  }
  if (foldFrom === null) return intact;
  let baseTargetMinor = targetMinor;
  for (const link of chain.tail) {
    if (link.version < foldFrom) continue;
    baseTargetMinor -= link.deltaMinor;
    await ctx.db.delete(link.row._id);
  }
  return { nextVersion: foldFrom, baseTargetMinor };
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
 *  - every line that has EVER posted a custody charge (live, voided,
 *    unlinked or re-charged — enumerated through
 *    `by_application_custodyPostingVersion`, never inferred from the live
 *    rows) is on the books EXACTLY as its row says: a live charged line
 *    POSTED at the version `custodyPosted` names and at no other; a line
 *    that no longer carries a charge with NO version POSTED at all. A voided
 *    line whose reversal was deferred is a charge the deal calls removed
 *    and the ledger still carries;
 *  - a written-off record has its write-off POSTED at the version the row
 *    names and no other; any other record has NO write-off on the books;
 *  - every one of those postings is on the books EXACTLY ONCE, under its
 *    own idempotency key, with no other live event beside it
 *    (`exactlyOnePosted`, R7 F2) — a duplicated forward is the amount twice;
 *  - the payable chain is EXACTLY the one the row says it issued
 *    (`provePayableChain`): one POSTED delta at each version 1..N, no
 *    duplicate, nothing posted or queued above N, every delta readable and
 *    the deltas summing to the row's target — a delta still waiting in the
 *    outbox is a payable the ledger does not yet carry.
 *
 * Bounded like every decision read: the rows come from the bounded loaders,
 * each movement log is read under `MAX_CUSTODY_ENTRIES`, the ever-posted
 * lines under `MAX_CUSTODY_POSTED_LINES`, and the proof refuses once the
 * documents it was handed plus the documents it read pass
 * `MAX_CUSTODY_LEDGER_PROOFS`, rather than judging a prefix.
 * Nothing here trusts a marker as proof of success: `custodyPostingVersion`
 * only ENUMERATES the lines to prove, and `custodyPosted` only states what
 * the ledger is expected to carry; the ledger answers.
 */
export async function custodyLedgerFamilyRefusal(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">,
  custodyRows: ReadonlyArray<Doc<"financeDealCustody">>,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): Promise<string | null> {
  const rowRefusal = custodyLedgerFamilyRowRefusal(custodyRows, liveFees, action);
  if (rowRefusal !== null) return rowRefusal;

  // Every document the proof reads — the rows it was handed, the rows it
  // enumerates AND every ledger row each read returns — is charged to one
  // budget, and every read is sized so it cannot fetch more than one
  // document past what is left. The custody rows and live lines the caller
  // passed were read under their own bounds before this; both are charged
  // here so the proof's total is literally every document it judged.
  const budget = new CustodyLedgerReadBudget(MAX_CUSTODY_LEDGER_PROOFS, action);
  budget.charge([...custodyRows, ...liveFees]);
  const postedLines = await loadCustodyPostedLines(ctx, applicationId, action, budget);
  const logs = new Map<Id<"financeDealCustody">, Array<Doc<"financeDealCustodyEntries">>>();
  for (const row of custodyRows) {
    logs.set(row._id, await loadCustodyEntries(ctx, row._id, action, budget));
  }

  for (const row of custodyRows) {
    const entries = logs.get(row._id) ?? [];
    const reversed = new Set<Id<"financeDealCustodyEntries">>();
    for (const entry of entries) {
      if (entry.kind === "REVERSAL" && entry.reversesEntryId !== undefined) reversed.add(entry.reversesEntryId);
    }
    for (const entry of entries) {
      if (entry.kind === "REVERSAL") continue;
      const kind = entry.kind;
      // The whole key family or a refusal (`keyedEvents`): a full batch is
      // never judged, so a duplicate beyond it cannot hide.
      const rows = await keyedEvents(ctx, orgId, custodyEntryPostKey(entry._id), budget);
      const forwards = rows.filter((event) => event.sourceType === "financeDealCustodyEntries" && event.sourceId === entry._id.toString());
      if (reversed.has(entry._id)) {
        if (forwards.some((event) => event.status !== "REVERSED")) {
          return `A cancelled custody movement on this deal is still on the books (its reversal has not posted yet), so ${action} is refused until the outbox has posted it.`;
        }
        continue;
      }
      // The leg's canonical posting: its kind's event type, at the one
      // version a leg is ever posted at. An event under the leg's key and
      // source but of another type or version is not the leg on the books.
      const canonical = forwards.filter(
        (event) => event.eventType === CUSTODY_CASH_EVENT_TYPE[kind] && event.eventVersion === CUSTODY_CASH_EVENT_VERSION
      );
      const exact = exactlyOnePosted(canonical);
      if (exact === "NONE") {
        return `A custody movement on this deal is not on the books (${describeStatus(canonical[0] ?? forwards[0])}), so ${action} is refused until it has posted.`;
      }
      if (exact === "MORE_THAN_ONCE" || forwards.filter(isLive).length > 1) {
        return `A custody movement on this deal is on the books more than once, so ${action} is refused until the record has been reviewed.`;
      }
    }

    const family = await sourceEvents(ctx, orgId, "financeDealCustody", row._id.toString(), action, budget);
    const writeOffs = family.filter((event) => event.eventType === "CUSTODY_WRITTEN_OFF");
    const postedWriteOffVersions = writeOffs.filter((event) => event.status === "POSTED").map((event) => event.eventVersion);
    if (row.status === "WRITTEN_OFF") {
      const claimed = row.writeOffPosted;
      if (claimed === undefined) {
        return `A written-off custody record on this deal carries no write-off posting, so ${action} is refused until the custody accounting migration has posted it.`;
      }
      if (!isStoredVersion(claimed.version)) {
        return `A custody write-off on this deal names a posting version that is not a positive whole number (${claimed.version}), so ${action} is refused until the record has been reviewed.`;
      }
      const canonical = writeOffs.filter(
        (event) => event.eventVersion === claimed.version && event.idempotencyKey === custodyWriteOffPostKey(row._id, claimed.version)
      );
      const exact = exactlyOnePosted(canonical);
      if (exact === "NONE") {
        return `A custody write-off on this deal is not on the books (${describeStatus(canonical[0] ?? writeOffs.find((event) => event.eventVersion === claimed.version))}), so ${action} is refused until it has posted.`;
      }
      if (postedWriteOffVersions.some((version) => version !== claimed.version)) {
        return `A custody write-off on this deal is on the books at more than one version (an earlier version's reversal has not posted yet), so ${action} is refused until the outbox has posted it.`;
      }
      if (exact === "MORE_THAN_ONCE" || writeOffs.filter(isLive).length > 1) {
        return `A custody write-off on this deal is on the books more than once, so ${action} is refused until the record has been reviewed.`;
      }
    } else if (postedWriteOffVersions.length > 0) {
      return `A reopened custody record on this deal still has its write-off on the books (the reversal has not posted yet), so ${action} is refused until the outbox has posted it.`;
    }

    // The payable chain, read exactly as the fold reads it (R6, F2): a
    // chain that does not read as one at all is refused for what it is; a
    // chain that reads but is not yet all on the books is refused as waiting.
    const chain = await provePayableChain(ctx, row, action, budget, family);
    if (!chain.ok) {
      return `A custody record on this deal has a ${chain.what}, so ${action} is refused until the record has been reviewed.`;
    }
    if (chain.tail.length > 0) {
      return `A custody record on this deal has a payable reclassification (v${chain.tail[0].version}) that has not posted to the ledger yet, so ${action} is refused until the outbox has posted it.`;
    }
  }

  for (const fee of postedLines) {
    const family = await sourceEvents(ctx, orgId, "financeDealFees", fee._id.toString(), action, budget);
    const postings = family.filter((event) => event.eventType === "CUSTODY_FEE_PAID");
    // What the row says the ledger carries: one version for a live charged
    // line, nothing for a line that was voided, unlinked or re-charged away
    // (its `custodyPosted` was cleared when its reversal was issued).
    const claimed = fee.voidedAt === undefined && fee.custodyId !== undefined ? fee.custodyPosted : undefined;
    if (claimed !== undefined) {
      if (!isStoredVersion(claimed.version)) {
        return `A cost paid out of an employee's custody on this deal names a posting version that is not a positive whole number (${claimed.version}), so ${action} is refused until the line has been reviewed.`;
      }
      const canonical = postings.filter(
        (event) => event.eventVersion === claimed.version && event.idempotencyKey === custodyFeePostKey(fee._id, claimed.version)
      );
      const exact = exactlyOnePosted(canonical);
      if (exact === "NONE") {
        return `A cost paid out of an employee's custody on this deal is not on the books (${describeStatus(canonical[0] ?? postings.find((event) => event.eventVersion === claimed.version))}), so ${action} is refused until it has posted.`;
      }
      if (postings.some((event) => event.status === "POSTED" && event.eventVersion !== claimed.version)) {
        return `A cost paid out of an employee's custody on this deal is on the books at more than one version (an earlier version's reversal has not posted yet), so ${action} is refused until the outbox has posted it.`;
      }
      if (exact === "MORE_THAN_ONCE" || postings.filter(isLive).length > 1) {
        return `A cost paid out of an employee's custody on this deal is on the books more than once, so ${action} is refused until the line has been reviewed.`;
      }
      continue;
    }
    if (postings.some((event) => event.status === "POSTED")) {
      return `A cost that is no longer charged to an employee's custody on this deal (removed, unlinked or re-charged) is still on the books as a custody charge — its reversal has not posted yet — so ${action} is refused until the outbox has posted it.`;
    }
  }
  return null;
}

/**
 * ## Exactly one canonical POSTED forward event per family member (R7, F2)
 *
 * "The event at the claimed version is POSTED" — `find` — said nothing about
 * a SECOND POSTED event at that version, or a second journal under another
 * key beside the first: a duplicated forward is the charge on the books
 * twice, and the proof certified it. So each member's canonical posting —
 * its own event type, version AND idempotency key — must be POSTED exactly
 * once, and no OTHER live event may stand beside it. Live is POSTED or
 * PENDING: a PENDING event is one whose journal may already exist (the
 * engine posts the journal before it marks the event), so it is not "not on
 * the books"; FAILED and REVERSED are settled and never counted.
 */
function isLive(event: Doc<"accountingEvents">): boolean {
  return event.status === "POSTED" || event.status === "PENDING";
}

/** Whether `candidates` (one member's canonical events) hold exactly one POSTED event and nothing else live. */
function exactlyOnePosted(candidates: ReadonlyArray<Doc<"accountingEvents">>): "ONE" | "NONE" | "MORE_THAN_ONCE" {
  const posted = candidates.filter((event) => event.status === "POSTED").length;
  if (posted === 0) return "NONE";
  if (posted > 1 || candidates.filter(isLive).length > 1) return "MORE_THAN_ONCE";
  return "ONE";
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
  applicationId: Id<"financeApplications">,
  custodyRows: ReadonlyArray<Doc<"financeDealCustody">>,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): Promise<void> {
  const refusal = await custodyLedgerFamilyRefusal(ctx, orgId, applicationId, custodyRows, liveFees, action);
  if (refusal !== null) throw new ConvexError(refusal);
}
