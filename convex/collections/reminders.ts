import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { isFcLineage } from "../utils/fcCheque";
import { queueCustomerReminder } from "./reminderQueue";
import { ConvexError } from "convex/values";

type ReceivableStatus = Doc<"receivables">["status"];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Organizations processed per scheduled continuation of the reminder cron. */
const REMINDER_ORG_BATCH_SIZE = 50;

/**
 * Budget units one organization may spend in a sweep invocation. A unit is
 * either a row handled inline (each queues at most one provider send) or a
 * deferred window handed to its own child function (one scheduled function).
 * Rows are the only thing that costs a send, so sends + children <= this, and
 * the org's single optional "resume" is the only schedule outside the budget.
 * An org with more work is finished by those follow-ups, so a giant tenant slows
 * only itself, never the tenants behind it.
 */
const REMINDER_SWEEP_ROWS_PER_ORG = 15;

/** Budget units one single-organization continuation may spend (one org, so roomier). */
const REMINDER_RESUME_ROWS = 200;

/** Convex allows a mutation to schedule at most this many functions. */
const CONVEX_MAX_SCHEDULED_PER_MUTATION = 1000;

/**
 * Worst case one sweep invocation schedules: every org spends its whole budget
 * and also schedules its resume, plus the sweep's own next-page continuation.
 * Single source of truth for the scheduling limit; the check below fails module
 * load if a constant is raised past it.
 */
const REMINDER_SWEEP_MAX_SCHEDULED = REMINDER_ORG_BATCH_SIZE * (REMINDER_SWEEP_ROWS_PER_ORG + 1) + 1;

if (REMINDER_SWEEP_MAX_SCHEDULED >= CONVEX_MAX_SCHEDULED_PER_MUTATION) {
  throw new Error("Collection reminder sweep budget can exceed the Convex scheduling limit.");
}

type ReminderStep = (
  | { kind: "overdue"; status: ReceivableStatus }
  | { kind: "dueSoon"; status: ReceivableStatus }
  | { kind: "cheque" }
) & { isDeleted?: false };

/** Overdue rows leave their range when marked; the other steps are windows rows stay in. */
type ReminderWindowStep = Exclude<ReminderStep, { kind: "overdue" }>;

/** The seven per-organization steps, in the order they run. A step is addressed by its index. */
const LEGACY_REMINDER_STEPS: readonly ReminderStep[] = [
  { kind: "overdue", status: "OPEN" },
  { kind: "dueSoon", status: "OPEN" },
  { kind: "overdue", status: "PARTIALLY_PAID" },
  { kind: "dueSoon", status: "PARTIALLY_PAID" },
  { kind: "overdue", status: "RESCHEDULED" },
  { kind: "dueSoon", status: "RESCHEDULED" },
  { kind: "cheque" },
];

// Missing and explicit false are disjoint live cohorts. Original step numbers
// stay stable for queued resumes; deleted history is excluded by the index.
const REMINDER_STEPS: readonly ReminderStep[] = [
  ...LEGACY_REMINDER_STEPS,
  ...LEGACY_REMINDER_STEPS.map((step) => ({ ...step, isDeleted: false as const })),
];

function reminderStepAt(step: number): ReminderStep | undefined {
  return Number.isInteger(step) ? REMINDER_STEPS[step] : undefined;
}

/** Where an org's remaining steps continue after its budget ran out or an overdue step overflowed. */
type ReminderResume = { orgId: Id<"organizations">; step: number };

type OrgReminderOutcome = {
  queued: number;
  markedOverdue: number;
  /** Indexes of windows too large for the budget, each walked by processReminderRange. */
  deferred: number[];
  resume: ReminderResume | null;
};

async function readOverdueReceivables(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  status: ReceivableStatus,
  now: number,
  limit: number,
  isDeleted?: false
) {
  // Rows leave this range as they are marked OVERDUE, so no position is needed.
  return await ctx.db
    .query("receivables")
    .withIndex("by_org_status_isDeleted_dueDate", (q) =>
      q.eq("orgId", orgId).eq("status", status).eq("isDeleted", isDeleted).lte("dueDate", now)
    )
    .take(limit);
}

// The due-soon window starts strictly AFTER `now`: a receivable due exactly at
// `now` is overdue (the overdue step takes it and flips its status), so it is
// never also reminded as due-soon, whichever step happens to run first.
function dueSoonReceivablesQuery(ctx: MutationCtx, orgId: Id<"organizations">, status: ReceivableStatus, now: number, isDeleted?: false, legacy = false) {
  if (legacy) {
    return ctx.db.query("receivables").withIndex("by_org_status_and_dueDate", (q) =>
      q.eq("orgId", orgId).eq("status", status).gt("dueDate", now).lte("dueDate", now + 2 * DAY_MS)
    );
  }
  return ctx.db
    .query("receivables")
    .withIndex("by_org_status_isDeleted_dueDate", (q) =>
      q.eq("orgId", orgId).eq("status", status).eq("isDeleted", isDeleted).gt("dueDate", now).lte("dueDate", now + 2 * DAY_MS)
    );
}

function upcomingChequesQuery(ctx: MutationCtx, orgId: Id<"organizations">, now: number, isDeleted?: false, legacy = false) {
  if (legacy) {
    return ctx.db.query("postDatedCheques").withIndex("by_org_status_and_chequeDate", (q) =>
      q.eq("orgId", orgId).eq("status", "HELD").gte("chequeDate", now).lte("chequeDate", now + 3 * DAY_MS)
    );
  }
  return ctx.db
    .query("postDatedCheques")
    .withIndex("by_org_status_isDeleted_chequeDate", (q) =>
      q.eq("orgId", orgId).eq("status", "HELD").eq("isDeleted", isDeleted).gte("chequeDate", now).lte("chequeDate", now + 3 * DAY_MS)
    );
}

async function queueDueSoonRows(ctx: MutationCtx, orgId: Id<"organizations">, rows: Doc<"receivables">[]) {
  let queued = 0;
  for (const receivable of rows) {
    // Old queued cursors still use the retained legacy index, one bounded page.
    if (receivable.isDeleted === true) continue;
    const reminderId = await queueCustomerReminder(ctx, {
      orgId,
      customerId: receivable.customerId,
      receivableId: receivable._id,
      messageType: "DUE_SOON",
    });
    if (reminderId) queued++;
  }
  return queued;
}

async function queueChequeRows(ctx: MutationCtx, orgId: Id<"organizations">, rows: Doc<"postDatedCheques">[]) {
  let queued = 0;
  for (const cheque of rows) {
    // SCRUM-447 D5': a finance-company cheque is never chased from the
    // customer, whatever its receivable or applicationId says.
    if (cheque.isDeleted === true || isFcLineage(cheque)) continue;
    const reminderId = await queueCustomerReminder(ctx, {
      orgId,
      customerId: cheque.customerId,
      chequeId: cheque._id,
      receivableId: cheque.receivableId,
      messageType: "CHEQUE_UPCOMING",
    });
    if (reminderId) queued++;
  }
  return queued;
}

type ReminderWindowBatch = { size: number; queue: () => Promise<number> };

/** One due-soon or cheque window as "read some rows" / "read a page", whichever table backs it. */
function reminderWindow(ctx: MutationCtx, orgId: Id<"organizations">, step: ReminderWindowStep, now: number, legacy = false) {
  const windowOf = <Row>(
    query: {
      take(limit: number): Promise<Row[]>;
      paginate(opts: { cursor: string | null; numItems: number }): Promise<{ page: Row[]; isDone: boolean; continueCursor: string }>;
    },
    queue: (rows: Row[]) => Promise<number>
  ) => {
    const batch = (rows: Row[]): ReminderWindowBatch => ({ size: rows.length, queue: () => queue(rows) });
    return {
      take: async (limit: number) => batch(await query.take(limit)),
      paginate: async (opts: { cursor: string | null; numItems: number }) => {
        const page = await query.paginate(opts);
        return { batch: batch(page.page), isDone: page.isDone, continueCursor: page.continueCursor };
      },
    };
  };
  return step.kind === "cheque"
    ? windowOf(upcomingChequesQuery(ctx, orgId, now, step.isDeleted, legacy), (rows) => queueChequeRows(ctx, orgId, rows))
    : windowOf(dueSoonReceivablesQuery(ctx, orgId, step.status, now, step.isDeleted, legacy), (rows) => queueDueSoonRows(ctx, orgId, rows));
}

/**
 * Works one organization's reminder steps from index `fromStep`, spending at
 * most `budget` units (see REMINDER_SWEEP_ROWS_PER_ORG). Overdue rows leave
 * their range as they are marked, so that step simply re-reads until empty. A
 * due-soon or cheque window is handled inline only when ALL of it fits in the
 * remaining budget (probed with one extra row); otherwise it costs one unit and
 * is returned in `deferred` for `processReminderRange`, which walks it with a
 * native pagination cursor. No hand-built position is ever carried, so no row
 * can be skipped at a boundary, and a small tenant never schedules a child.
 */
async function processOrgReminders(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  now: number,
  fromStep: number,
  budget: number
): Promise<OrgReminderOutcome> {
  const outcome: OrgReminderOutcome = { queued: 0, markedOverdue: 0, deferred: [], resume: null };
  let left = budget;

  for (let index = fromStep; index < REMINDER_STEPS.length; index += 1) {
    if (left <= 0) {
      outcome.resume = { orgId, step: index };
      return outcome;
    }
    const step = REMINDER_STEPS[index];

    if (step.kind !== "overdue") {
      // One extra row tells us whether the window fits without a second query.
      const batch = await reminderWindow(ctx, orgId, step, now).take(left + 1);
      if (batch.size > left) {
        outcome.deferred.push(index);
        left -= 1;
      } else {
        outcome.queued += await batch.queue();
        left -= batch.size;
      }
      continue;
    }

    const read = await readOverdueReceivables(ctx, orgId, step.status, now, left + 1, step.isDeleted);
    const rows = read.slice(0, left);
    for (const receivable of rows) {
      await ctx.db.patch(receivable._id, { status: "OVERDUE", updatedAt: now });
      outcome.markedOverdue++;
      const reminderId = await queueCustomerReminder(ctx, {
        orgId,
        customerId: receivable.customerId,
        receivableId: receivable._id,
        messageType: "OVERDUE",
      });
      if (reminderId) outcome.queued++;
    }
    left -= rows.length;
    // Marked rows left the range, so re-running the same step finds the rest.
    if (read.length > rows.length) {
      outcome.resume = { orgId, step: index };
      return outcome;
    }
  }
  return outcome;
}

/**
 * One due-soon or cheque window of one organization, walked with a native
 * pagination cursor in its own mutation (Convex allows a single paginated query
 * per function, and the organization sweep already uses it). A page that comes
 * back short or empty while `isDone` is false is normal - the platform may cut a
 * page on read limits - so progress is "continue from `continueCursor` until
 * isDone", never "stop on a small page". Schedules at most
 * REMINDER_RESUME_ROWS sends plus its own continuation.
 */
export async function processReminderRangeHandler(ctx: MutationCtx, args: { orgId: Id<"organizations">; step: number; cursor: string | null; now: number; indexVersion?: "active-v1" }) {
  const step = reminderStepAt(args.step);
  if (!step || step.kind === "overdue" || (args.indexVersion === undefined && args.step >= LEGACY_REMINDER_STEPS.length)) {
    throw new ConvexError("Invalid collection reminder window step.");
  }
  const org = await ctx.db.get(args.orgId);
  if (!org) return { queued: 0, isDone: true };
  // Never reinterpret a queued old-index cursor using the new live-row index.
  const page = await reminderWindow(ctx, org._id, step, args.now, args.indexVersion === undefined).paginate({
    cursor: args.cursor,
    numItems: REMINDER_RESUME_ROWS,
  });
  const queued = await page.batch.queue();
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.collections.processReminderRange, {
      orgId: org._id,
      step: args.step,
      cursor: page.continueCursor,
      now: args.now,
      indexVersion: args.indexVersion,
    });
  }
  return { queued, isDone: page.isDone };
}

/**
 * Schedules what one organization still owes: each deferred window as its own
 * paginated child (already paid for in the budget), plus the one resume if the
 * budget ran out before the steps did.
 */
async function scheduleOrgFollowUps(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  now: number,
  result: OrgReminderOutcome
) {
  for (const step of result.deferred) {
    await ctx.scheduler.runAfter(0, internal.collections.processReminderRange, { orgId, step, cursor: null, now, indexVersion: "active-v1" });
  }
  if (result.resume) {
    await ctx.scheduler.runAfter(0, internal.collections.processDailyCollectionReminders, { now, resume: result.resume });
  }
}

export async function processDailyCollectionRemindersHandler(ctx: MutationCtx, args: { cursor?: string; now?: number; resume?: ReminderResume }) {
  const now = args.now ?? Date.now();
  let queued = 0;
  let markedOverdue = 0;

  if (args.resume) {
    if (!reminderStepAt(args.resume.step)) throw new ConvexError("Invalid collection reminder resume step.");
    const org = await ctx.db.get(args.resume.orgId);
    if (!org) return { queued, markedOverdue, isDone: true };
    const result = await processOrgReminders(ctx, org._id, now, args.resume.step, REMINDER_RESUME_ROWS);
    await scheduleOrgFollowUps(ctx, org._id, now, result);
    return { queued: result.queued, markedOverdue: result.markedOverdue, isDone: !result.resume };
  }

  // Was `.take(200)`. Convex's default order is ascending _creationTime, so
  // that processed the same OLDEST 200 organizations every single day and
  // silently skipped every tenant created after them — their receivables
  // never flipped to OVERDUE and no customer reminder was ever sent, with no
  // error to notice. Paginate across scheduled continuations instead, the
  // same shape changelog.broadcastNewEntry already uses for org fan-out.
  const page = await ctx.db
    .query("organizations")
    .paginate({ cursor: args.cursor ?? null, numItems: REMINDER_ORG_BATCH_SIZE });

  for (const org of page.page) {
    const result = await processOrgReminders(ctx, org._id, now, 0, REMINDER_SWEEP_ROWS_PER_ORG);
    queued += result.queued;
    markedOverdue += result.markedOverdue;
    await scheduleOrgFollowUps(ctx, org._id, now, result);
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.collections.processDailyCollectionReminders, {
      cursor: page.continueCursor,
      now,
    });
  }

  return { queued, markedOverdue, isDone: page.isDone };
}

export async function getReminderPayloadHandler(ctx: QueryCtx, args: { reminderId: Id<"collectionReminders"> }) {
  const reminder = await ctx.db.get(args.reminderId);
  if (!reminder) return null;
  const [customer, receivable, cheque, currency] = await Promise.all([
    ctx.db.get(reminder.customerId),
    reminder.receivableId ? ctx.db.get(reminder.receivableId) : null,
    reminder.chequeId ? ctx.db.get(reminder.chequeId) : null,
    getOrgCurrency(ctx, reminder.orgId),
  ]);
  // SCRUM-447 D5': re-read at send time. A reminder queued before the row was
  // recognised as finance-company (or before it was replaced) is suppressed
  // here. This narrows the window; it cannot recall a message already handed
  // to the provider, and no atomicity is claimed.
  const fcLineageSuppressed = cheque ? isFcLineage(cheque) : false;
  const sourceUnavailable = !customer || customer.isDeleted === true ||
    Boolean(reminder.receivableId && (!receivable || receivable.isDeleted === true)) ||
    Boolean(reminder.chequeId && (!cheque || cheque.isDeleted === true));
  return { reminder, customer, receivable, cheque, currency, fcLineageSuppressed, sourceUnavailable };
}

export async function markReminderResultHandler(ctx: MutationCtx, args: { reminderId: Id<"collectionReminders">; status: "SENT" | "FAILED" | "SKIPPED"; error?: string }) {
  const patch: Partial<Pick<Doc<"collectionReminders">, "status" | "error" | "sentAt">> = {
    status: args.status,
    error: args.error,
  };
  if (args.status === "SENT") patch.sentAt = Date.now();
  await ctx.db.patch(args.reminderId, patch);
}
