import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_CUSTODY_ENTRIES, MAX_LIVE_DEAL_FEE_LINES } from "./dealCostLimits";

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
 * The document budget of one custody proof: every read inside the proof
 * asks it how many rows it may take and charges what came back.
 *
 * `take(cap)` is the `.take()` argument for a read whose own bound is `cap`:
 * one past the read's cap (so the read detects its own overflow) and never
 * more than one past what is left of the budget (so the whole proof reads
 * at most `limit + 1` documents before it refuses). `charge(rows)` throws
 * the named refusal the moment the running total passes the limit; a proof
 * that refused has decided nothing on a prefix.
 */
export class CustodyLedgerReadBudget {
  private spent = 0;

  constructor(
    private readonly limit: number,
    private readonly action: string
  ) {}

  take(cap: number): number {
    return Math.max(1, Math.min(cap + 1, this.limit - this.spent + 1));
  }

  charge(rows: number): void {
    this.spent += rows;
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
  const rows = await ctx.db
    .query("financeDealFees")
    .withIndex("by_application_custodyPostingVersion", (q) =>
      q.eq("applicationId", applicationId).gt("custodyPostingVersion", 0)
    )
    .take(budget?.take(MAX_CUSTODY_POSTED_LINES) ?? MAX_CUSTODY_POSTED_LINES + 1);
  budget?.charge(rows.length);
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
  const rows = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId))
    .take(budget?.take(MAX_SOURCE_EVENTS) ?? MAX_SOURCE_EVENTS + 1);
  budget?.charge(rows.length);
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
  idempotencyKey: string
): Promise<boolean> {
  const rows = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .take(4);
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

/**
 * Why a queued custody event must NOT post yet, or `null` when it may.
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
  const entries = await ctx.db
    .query("financeDealCustodyEntries")
    .withIndex("by_custody", (q) => q.eq("custodyId", custodyId))
    .take(budget?.take(MAX_CUSTODY_ENTRIES) ?? MAX_CUSTODY_ENTRIES + 1);
  budget?.charge(entries.length);
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
  const postedLines = await loadCustodyPostedLines(ctx, custody.applicationId, action, budget);
  for (const fee of postedLines) {
    const current =
      fee.voidedAt === undefined && fee.custodyId === custody._id && fee.custodyPosted !== undefined
        ? fee.custodyPosted.version
        : null;
    const family = await sourceEvents(ctx, custody.orgId, "financeDealFees", fee._id.toString(), action, budget);
    // The versions to leave first, then the one to arrive: the first unmet
    // dependency names the reason, and a replacement is held behind the
    // reversal it follows before it is awaited itself.
    for (const event of family) {
      if (event.eventType !== "CUSTODY_FEE_PAID" || event.status !== "POSTED" || event.eventVersion === current) continue;
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
  idempotencyKey: string
): Promise<Doc<"pendingAccountingEvents"> | null> {
  const rows = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .take(4);
  return rows.find((row) => row.kind === "POST" && row.status !== "POSTED") ?? null;
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
 */
export async function foldAbandonedPayableDeltas(
  ctx: MutationCtx,
  custody: Doc<"financeDealCustody">,
  action: string
): Promise<{ nextVersion: number; baseTargetMinor: number }> {
  const issued = custody.payableReclassVersion ?? 0;
  const targetMinor = custody.payableTargetMinor ?? 0;
  const intact = { nextVersion: issued + 1, baseTargetMinor: targetMinor };
  if (issued === 0) return intact;
  const family = await sourceEvents(ctx, custody.orgId, "financeDealCustody", custody._id.toString(), action);
  let posted = 0;
  for (const event of family) {
    if (event.eventType === "CUSTODY_PAYABLE_RECLASSIFIED" && event.status === "POSTED" && event.eventVersion > posted) {
      posted = event.eventVersion;
    }
  }
  if (posted >= issued) return intact;
  if (issued - posted > MAX_SOURCE_EVENTS) {
    throw new ConvexError(
      `This custody record has more than ${MAX_SOURCE_EVENTS} payable reclassifications waiting to post, which is past what ${action} can re-base completely; nothing has been changed. Have the record reviewed.`
    );
  }
  const tail: Array<{ version: number; row: Doc<"pendingAccountingEvents">; deltaMinor: number }> = [];
  for (let version = posted + 1; version <= issued; version += 1) {
    const row = await pendingForwardByKey(ctx, custody.orgId, custodyPayableReclassKey(custody._id, version));
    if (row === null) {
      throw new ConvexError(
        `This custody record's payable reclassification v${version} is neither on the ledger nor waiting in the outbox, so ${action} cannot be chained behind it; nothing has been changed. Have the record reviewed.`
      );
    }
    const deltaMinor = (row.payload as Record<string, unknown> | undefined)?.deltaMinor;
    if (typeof deltaMinor !== "number" || !Number.isSafeInteger(deltaMinor)) {
      throw new ConvexError(
        `This custody record's payable reclassification v${version} carries no readable delta, so ${action} cannot be chained behind it; nothing has been changed. Have the record reviewed.`
      );
    }
    tail.push({ version, row, deltaMinor });
  }
  let foldFrom: number | null = null;
  for (const link of tail) {
    const dependencies = parseCustodyDependencies(link.row.payload);
    if (dependencies === null) {
      // Unreadable dependencies hold a row forever at the worker; re-issuing
      // it with readable ones is the only way the chain moves again.
      foldFrom = link.version;
      break;
    }
    for (const dependency of dependencies) {
      if (dependency.must !== "SETTLED") continue;
      if (
        !(await eventPosted(ctx, custody.orgId, dependency.idempotencyKey)) &&
        !(await forwardStillQueued(ctx, custody.orgId, dependency.idempotencyKey))
      ) {
        foldFrom = link.version;
        break;
      }
    }
    if (foldFrom !== null) break;
  }
  if (foldFrom === null) return intact;
  let baseTargetMinor = targetMinor;
  for (const link of tail) {
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
 *  - the payable chain is posted to the version the row says it issued — a
 *    delta still waiting in the outbox is a payable the ledger does not yet
 *    carry.
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
  budget.charge(custodyRows.length + liveFees.length);
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
      const rows = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", custodyEntryPostKey(entry._id)))
        .take(budget.take(7));
      budget.charge(rows.length);
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

    const family = await sourceEvents(ctx, orgId, "financeDealCustody", row._id.toString(), action, budget);
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

  for (const fee of postedLines) {
    const family = await sourceEvents(ctx, orgId, "financeDealFees", fee._id.toString(), action, budget);
    const postings = family.filter((event) => event.eventType === "CUSTODY_FEE_PAID");
    // What the row says the ledger carries: one version for a live charged
    // line, nothing for a line that was voided, unlinked or re-charged away
    // (its `custodyPosted` was cleared when its reversal was issued).
    const claimed = fee.voidedAt === undefined && fee.custodyId !== undefined ? fee.custodyPosted : undefined;
    if (claimed !== undefined) {
      const exact = postings.find((event) => event.eventVersion === claimed.version);
      if (exact === undefined || exact.status !== "POSTED") {
        return `A cost paid out of an employee's custody on this deal is not on the books (${describeStatus(exact)}), so ${action} is refused until it has posted.`;
      }
      if (postings.some((event) => event.status === "POSTED" && event.eventVersion !== claimed.version)) {
        return `A cost paid out of an employee's custody on this deal is on the books at more than one version (an earlier version's reversal has not posted yet), so ${action} is refused until the outbox has posted it.`;
      }
      continue;
    }
    if (postings.some((event) => event.status === "POSTED")) {
      return `A cost that is no longer charged to an employee's custody on this deal (removed, unlinked or re-charged) is still on the books as a custody charge — its reversal has not posted yet — so ${action} is refused until the outbox has posted it.`;
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
  applicationId: Id<"financeApplications">,
  custodyRows: ReadonlyArray<Doc<"financeDealCustody">>,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  action: string
): Promise<void> {
  const refusal = await custodyLedgerFamilyRefusal(ctx, orgId, applicationId, custodyRows, liveFees, action);
  if (refusal !== null) throw new ConvexError(refusal);
}
