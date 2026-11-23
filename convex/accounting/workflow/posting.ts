import { type QueryCtx, type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { isChartInitialized, isSystemAccountMapped } from "../chartAccountsRead";
import { ensureGeneralExpenseAccount, ensureSupplierAPAccount } from "../chartLegacyAccounts";
import { getOpenPeriodForDate } from "../../utils/postingPeriod";
import {
  type PostCommand,
  proveReservedReceiptAuthority,
  assertExistingRowIsSameOccurrence,
  postAccountingEvent,
} from "../postingEngine";
import { type SystemKey, SYSTEM_KEYS } from "../../utils/defaultChart";
import { type OpeningSettlementReader } from "../../utils/openingSettlementBasis";
import { assertOpeningPostingProof } from "../../utils/openingPostingProof";
import {
  simplePayloadHash,
  type EventType,
  RECEIPT_CREDIT_APPLIED_EVENT_TYPE,
  RECEIPT_CREDIT_APPLIED_SOURCE_TYPE,
} from "../postingRules";
import { enqueuePendingPost } from "../outboxIngress";
import {
  type PostReceiptOccurrenceArgs,
  assertTrustedOccurrence,
  occurrenceIdempotencyKey,
} from "../receiptOccurrence";

export async function getOrgCurrency(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<string> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  return settings?.currency ?? "JOD";
}

/**
 * Whether an event dated here would post now or queue to the outbox.
 *
 * Exported so the historical migration's dry run can predict which of the two
 * a correction will do instead of reporting a bare "would correct" count —
 * the distinction is the whole difference between a correction that reaches
 * the books and one that sits waiting for a period to open.
 */
export async function shouldPost(ctx: MutationCtx, orgId: Id<"organizations">, date: number): Promise<boolean> {
  const [chartReady, period] = await Promise.all([
    isChartInitialized(ctx, orgId),
    getOpenPeriodForDate(ctx, orgId, date),
  ]);
  return chartReady && period !== null;
}

/**
 * Whether a domain event dated `date` would post immediately (chart ready + an
 * open period) rather than queue to the outbox. Payroll payment uses this to
 * avoid the "payment posts now but its accrual is still queued for a closed
 * period" negative-payable window: only enforce accrual-before-payment when the
 * payment itself would actually hit the ledger.
 */
export async function isPostableNow(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  date: number
): Promise<boolean> {
  return shouldPost(ctx, orgId, date);
}

/**
 * Posts the event now if the chart + an open period exist, otherwise enqueues it
 * to the durable outbox for retry. This is the single choke point that replaced
 * the previous "silently return if not postable" behavior.
 */
async function postOrEnqueue(
  ctx: MutationCtx,
  cmd: PostCommand,
  /**
   * System accounts this event's journal cannot be written without (SCRUM-218-C).
   *
   * ⚠️ A PRECONDITION, NOT A SELF-HEAL. `shouldPost` below only asks whether the
   * org has a chart AT ALL, which is too coarse for an event needing a specific
   * account: an org with a chart but no 2110 passes that check, posts
   * synchronously, and `resolveSystemAccount` throws INSIDE the caller's
   * transaction. Nothing catches it, so Convex rolls back the confirmed receipt
   * — the customer's money vanishes because an account was unmapped. Naming the
   * requirement here routes the event to the durable outbox instead, where the
   * SCRUM-222 worker retries it and fails VISIBLY.
   *
   * Deliberately NOT an `ensure*Account` call. Those exist for keys with a known
   * correct definition that a legacy chart merely lacks; 2110's classification
   * is a SCRUM-231 cutover decision with no reclassification door afterwards, so
   * inventing one at runtime is exactly the substitution c17653 prohibits.
   */
  opts?: { requiredSystemKeys?: readonly SystemKey[] },
  suppliedOpeningReader?:OpeningSettlementReader,
): Promise<void> {
  const openingReader=await assertOpeningPostingProof(ctx,cmd,suppliedOpeningReader);
  // Period integrity: if this exact domain event is already captured but not yet
  // posted in the outbox, it will post with ITS ORIGINAL accounting date once the
  // period opens. A second hook call for the same event (e.g. a commission
  // accrued at sale completion into a closed month, then re-hooked at payroll
  // approval with the period-end date) must NOT create a replacement dated to a
  // different period — that would recognize the expense in the wrong month while
  // the queued original later self-dedupes away. Treat the second call as a
  // no-op; the queued original is the source of truth. (postAccountingEvent only
  // dedupes against POSTED events, so this pending-side guard is the only thing
  // that prevents the cross-period duplicate.)
  //
  // ⚠️ SCRUM-249 — THIS SHORT-CIRCUIT IS KEY-ONLY, AND IT FIRES BEFORE THE
  // POSTING ENGINE IS REACHED AT ALL. For an ordinary event family that is
  // exactly the intended behaviour and nothing below changes it. For the
  // reserved receipt occurrence it is a silent-drop surface: a row queued under
  // this key by something that is NOT this occurrence would make the certified
  // receipt return here having posted nothing and raised nothing. Prove the
  // reservation first, then prove the row found is really this occurrence.
  const reservedAuthority = proveReservedReceiptAuthority(cmd);
  const queued = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", cmd.orgId).eq("idempotencyKey", cmd.idempotencyKey)
    )
    .filter((q) => q.and(q.eq(q.field("kind"), "POST"), q.neq(q.field("status"), "POSTED")))
    .first();
  if (queued) {
    if (reservedAuthority) {
      // A queued row carries its own payload, so "the same work is already
      // waiting" is checkable rather than assumed.
      //
      // ASYMMETRY WITH THE DRAIN, DELIBERATELY NOT "FIXED" (SCRUM-249 / Sonnet F2).
      // `accountingOutbox.postPendingEntry` rebuilds the command with
      // `occurredAt: p.occurredAt ?? p.accountingDate`, because the pending
      // column is optional. The row is passed here WITHOUT that fallback, so an
      // absent `occurredAt` diverges from any real `cmd.occurredAt` and refuses.
      //
      // Mirroring the drain's fallback here was proposed and DECLINED: it would
      // turn a refusal into a MATCH whenever the queued row's `accountingDate`
      // happened to equal the incoming `occurredAt`, which is absorption — the
      // exact outcome this ticket exists to prevent. Fail-closed is the correct
      // asymmetry, not an oversight, and it is unreachable either way:
      // `enqueuePendingPost` is the only POST-kind writer and always sets
      // `occurredAt`, and `PostCommand.occurredAt` is non-optional.
      assertExistingRowIsSameOccurrence(
        { ...queued, payloadHash: await simplePayloadHash((queued.payload ?? {}) as Record<string, unknown>) },
        cmd,
        await simplePayloadHash(cmd.payload)
      );
    }
    return;
  }

  // Already on the books? Then there is nothing to queue. postAccountingEvent
  // dedupes on this key, so the enqueued row could never post anything — it
  // would sit PENDING forever, count as an unposted event against every future
  // period close, burn an attempt on each drain and finally dead-letter.
  //
  // Reachable through ordinary use now that MANUAL accrues at the sale: a July
  // commission posts in July, July closes, and August's payroll run for July
  // re-hooks the same accrual at the period-end date — which no longer posts,
  // so it queued a phantom for an accrual that is already recognized.
  const alreadyPosted = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", cmd.orgId).eq("idempotencyKey", cmd.idempotencyKey)
    )
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .first();
  if (alreadyPosted) {
    // ⚠️ SCRUM-249 §3 K1 REPRODUCED HERE. Before this check existed, a POSTED
    // row holding the receipt's derived key under a DIFFERENT tuple made the
    // genuine receipt return from this line: nothing posted, nothing queued,
    // nothing thrown, and `findPostedReceiptOccurrence` reporting null forever
    // after. The engine's own guard could not help — it is never reached.
    if (reservedAuthority) {
      assertExistingRowIsSameOccurrence(
        alreadyPosted,
        cmd,
        await simplePayloadHash(cmd.payload)
      );
    }
    return;
  }

  // Self-heal: make sure the GENERAL_EXPENSE system account is mapped for this
  // org before the engine tries to resolve it (older charts lack the key).
  // Centralized here (not just in hookExpensePosted) because other posting
  // paths — e.g. cheque-return bank fees — can also resolve GENERAL_EXPENSE.
  if (await isChartInitialized(ctx, cmd.orgId)) {
    await ensureGeneralExpenseAccount(ctx, cmd.orgId, cmd.actorId);
    await ensureSupplierAPAccount(ctx, cmd.orgId, cmd.actorId);
  }
  // Checked BEFORE shouldPost, because an unmapped required account is a reason
  // to queue even when the chart exists and the period is open — the two
  // conditions are independent and only one of them is what `shouldPost` sees.
  for (const key of opts?.requiredSystemKeys ?? []) {
    if (!(await isSystemAccountMapped(ctx, cmd.orgId, key))) {
      await enqueuePendingPost(
        ctx,
        cmd,
        `System account "${key}" is not mapped for this organization at operation time`,
        openingReader,
      );
      return;
    }
  }
  if (await shouldPost(ctx, cmd.orgId, cmd.accountingDate)) {
    await postAccountingEvent(ctx, cmd,openingReader);
  } else {
    await enqueuePendingPost(ctx, cmd, "No chart of accounts or open period at operation time",openingReader);
  }
}

/**
 * Shared shape for every forward-posting domain hook: version-1 event dated at
 * the operational occurredAt, posted or durably enqueued. Individual hooks
 * only differ by event type, source, idempotency key, and payload.
 */
export async function postDomainEvent(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    eventType: EventType;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    currency: string;
    occurredAt: number;
    actorId: Id<"users">;
    payload: Record<string, unknown>;
    /**
     * Distinguishes REPEATED events of the same type against the same source —
     * several instalments against one claim, say. `postAccountingEvent` dedupes
     * on (eventType, sourceType, sourceId, eventVersion) as well as on the
     * idempotency key, so leaving this at 1 makes every payment after the first
     * silently return "already posted": the subledger records three receipts
     * and the ledger records one. Defaults to 1, which is right for the events
     * that genuinely happen once per source.
     */
    eventVersion?: number;
    /** Forwarded to `postOrEnqueue` — see the note there. */
    requiredSystemKeys?: readonly SystemKey[];
    /**
     * A CAUSAL predecessor this event must not overtake, as the reason it is
     * waiting. When set the event is queued to the outbox outright — even
     * into an open period with a ready chart — and the worker's own
     * dependency guard (`accountingOutbox.postOutboxRow`) holds it until the
     * predecessor is POSTED. The producer names the predecessor because only
     * it knows the chain; the worker re-proves it because a queued row
     * outlives the transaction that queued it.
     */
    queueBehind?: string;
  },
  openingReader?:OpeningSettlementReader,
): Promise<void> {
  const cmd: PostCommand = {
    orgId: args.orgId,
    eventType: args.eventType,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    eventVersion: args.eventVersion ?? 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: args.idempotencyKey,
    payload: args.payload,
    actorId: args.actorId,
  };
  if (args.queueBehind !== undefined) {
    await enqueuePendingPost(ctx, cmd, `Waiting on a predecessor: ${args.queueBehind}`,openingReader);
    return;
  }
  await postOrEnqueue(
    ctx,
    cmd,
    args.requiredSystemKeys ? { requiredSystemKeys: args.requiredSystemKeys } : undefined,
    openingReader,
  );
}

/* ------------------------------------------------------------------------- *
 * SCRUM-237 — the v2 receipt occurrence facade (owner-proxy c17593 §6)
 *
 * The three generic helpers above take `sourceType`, `sourceId`, `eventType`,
 * `eventVersion` and the idempotency keys as INDEPENDENT arguments. That is the
 * defect: one receipt's identity is assembled separately at each call site, so
 * the forward post, the outbox key, the causal check and the reversal can drift
 * apart and nothing fails when they do.
 *
 * These three entry points take the identity as ONE value and derive every one
 * of those fields from it, so a v2 receipt producer has no parameter through
 * which to re-split the tuple. The generic helpers stay exactly as they are for
 * the unrelated event families that still use them.
 *
 * Nothing calls these yet, by design. SCRUM-236 rewires `recordPayment` /
 * `clearCheque` onto them and removes the old `hookCollectionPayment`;
 * SCRUM-218-C persists and consumes the identity. This commit defines the
 * surface those two build against and changes no production behavior.
 * ------------------------------------------------------------------------- */

/**
 * Post — or durably enqueue — the receipt occurrence named by `identity`.
 *
 * The idempotency key is DERIVED here rather than accepted, which is what makes
 * `postOrEnqueue`'s POSTED short-circuit (keyed by `by_org_idempotency`) and
 * `postAccountingEvent`'s dedupe (keyed by the economic tuple) the same fact
 * instead of two conventions that happen to agree today.
 */
export async function postReceiptOccurrence(
  ctx: MutationCtx,
  args: PostReceiptOccurrenceArgs
): Promise<void> {
  const id = args.identity;
  // ⚠️ REFUSE AN UNMINTED IDENTITY BEFORE THE FIRST WRITE (c17632). This is the
  // door B237-HEAD-01 walked through: a spread clone carrying a forged
  // `eventType` selected a different posting rule and put a cash receipt in the
  // bank account, while `postOrEnqueue`'s key-only short-circuit later absorbed
  // the genuine post. The tuple below is only trustworthy because of this line.
  assertTrustedOccurrence(id);
  await postOrEnqueue(ctx, {
    orgId: id.orgId,
    eventType: id.eventType,
    sourceType: id.sourceType,
    sourceId: id.sourceId,
    eventVersion: id.eventVersion,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: occurrenceIdempotencyKey(id),
    payload: args.payload,
    actorId: args.actorId,
    // SCRUM-249 — the capability that distinguishes this producer from the
    // generic ingress. Carried, never persisted: `enqueuePendingPost` stores an
    // explicit column list, and the drain re-establishes authority from that
    // stored row instead of from anything held in memory.
    receiptAuthority: id,
  }, { requiredSystemKeys: args.requiredSystemKeys });
}

/**
 * SCRUM-218-C — one later application of retained customer credit.
 *
 * ⚠️ NOT A SECOND RECEIPT. The cash arrived and was banked when the
 * COLLECTION_PAYMENT posted; this event only converts an existing 2110 liability
 * into relief of a receivable. `ruleReceiptCreditApplied` therefore writes no
 * cash or bank line at all.
 *
 * `sourceId` and `idempotencyKey` are both derived by `receiptMovement` from
 * (movement, sequence) and passed through unchanged — the sequence is part of
 * the accounting identity, so application #2 can never be swallowed by #1's
 * dedup tuple.
 *
 * 2110 is required rather than optional here: it is the DEBIT of this journal,
 * so without it there is no entry to write. If the mapping has been removed
 * since the receipt posted, the application defers to the outbox and surfaces
 * there instead of throwing inside the caller's money transaction.
 */
export async function hookReceiptCreditApplied(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sourceId: string;
    idempotencyKey: string;
    receiptMovementId: string;
    applicationId: string;
    sequence: number;
    amountMinor: number;
    currency: string;
    customerId: string;
    receivableDocumentId: string;
    occurredAt: number;
    actorId: Id<"users">;
  }
): Promise<void> {
  await postOrEnqueue(
    ctx,
    {
      orgId: args.orgId,
      eventType: RECEIPT_CREDIT_APPLIED_EVENT_TYPE,
      sourceType: RECEIPT_CREDIT_APPLIED_SOURCE_TYPE,
      sourceId: args.sourceId,
      eventVersion: 1,
      accountingDate: args.occurredAt,
      occurredAt: args.occurredAt,
      currency: args.currency,
      idempotencyKey: args.idempotencyKey,
      payload: {
        receiptMovementId: args.receiptMovementId,
        applicationId: args.applicationId,
        sequence: args.sequence,
        amountMinor: args.amountMinor,
        currency: args.currency,
        customerId: args.customerId,
        receivableDocumentId: args.receivableDocumentId,
      },
      actorId: args.actorId,
    },
    { requiredSystemKeys: [SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY] }
  );
}

/** True while an entry for this key is still queued (captured but not posted). */
export async function isEventQueued(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<boolean> {
  return (await queuedEntryStatus(ctx, orgId, idempotencyKey)) !== null;
}

/**
 * "PENDING", "FAILED", or null when nothing is outstanding.
 *
 * The distinction is the difference between a message that helps and one that
 * misleads. A PENDING entry really is waiting for its period to open. A FAILED
 * one has exhausted its retries: the due-work sweep selects only PENDING rows,
 * so opening a period does nothing for it, and telling someone to do that sends
 * them somewhere they cannot fix it.
 */
export async function queuedEntryStatus(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<"PENDING" | "FAILED" | null> {
  const pending = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .filter((q) => q.neq(q.field("status"), "POSTED"))
    .first();
  if (!pending) return null;
  return pending.status === "FAILED" ? "FAILED" : "PENDING";
}
