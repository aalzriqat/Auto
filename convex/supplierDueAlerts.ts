import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { internalAction, query, type MutationCtx } from "./_generated/server";
import { requireSuperAdmin } from "./utils/tenancy";
import { internalMutation } from "./functions";
import { supplierDueAlertJobName } from "./constants";
import { hasPlanFeature } from "./subscriptions";
import { isSystemOwnerRole, PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { NOTIFICATION_TYPES } from "../lib/notifications/types";
import { fromMinorUnits, scaleForCurrency } from "./utils/money";
import { alertStepFor, alertTypeFor } from "./utils/supplierDueAlertPlan";
import { OBLIGATION_PAGE_MAX, readObligationPage, type ObligationKind, type ObligationRow } from "./utils/supplierObligationDue";

/**
 * SCRUM-869 S8 - in-app alerts for supplier obligations coming due or overdue.
 *
 * Owner ruling SCRUM-869#c23883 (OQ-1; the coordinator's Jira record of a chat ruling): alert 3
 * days before the due date, on it, at 7 days overdue, then weekly. In-app through the existing
 * `notifications` table; idempotent per obligation, step and occurrence; tenant-scoped; recipients
 * resolved on the server; disputed and no-due-date obligations are suppressed.
 *
 * Why the row is inserted here and `utils/notifications.dispatch` is NOT used: dispatch also
 * fans out to email, WhatsApp, web push and mobile push. This ruling is in-app only.
 *
 * Shape (modelled on collections.processDailyCollectionReminders): the cron runs the dispatcher,
 * which pages the organisations and schedules ONE worker mutation per organisation. A worker
 * runs one bounded transaction of one obligation kind and schedules its own continuation, so one
 * organisation's failure cannot roll back another's. Catch-up: each run sends the latest step an
 * obligation has reached unless that (obligation, step, occurrence, recipient) idempotency record
 * exists, so a day the cron or an organisation worker missed is made up on the next run, once,
 * never as a burst.
 *
 * Failure model (PR #716 round 2). The worker does NOT catch its own failure. A Convex mutation that
 * throws is rolled back whole and its scheduled continuation is dropped with it; one that catches and
 * returns commits everything written before the throw (a notification and a STARTED idempotency
 * record, with the retry then refused) and silently drops the rest of the organisation. So every
 * data fault that can be seen from a READ is handled before the first write - an unreadable row is
 * skipped with a log line - and anything else throws and rolls back cleanly. Scheduled mutations are
 * retried by Convex only for internal errors (docs.convex.dev/scheduling/scheduled-functions); a
 * thrown developer error stops that organisation's chain for the day and is visible in the logs, and
 * the next day's sweep starts it again from the first page.
 *
 * Write bound (PR #716 round 2). One transaction sends at most `SEND_BUDGET` alerts. Each send is one
 * notification insert plus one idempotency record (an insert and a patch), so a transaction writes at
 * most three documents per send: 1,200 at the budget, a tenth of Convex's 16,000 documents-written
 * limit, and about two index-range reads per send against the 4,096 limit
 * (docs.convex.dev/production/state/limits). A transaction takes one page of obligations and as many
 * memberships as keep (alerts x memberships) within the budget, then continues with the same
 * obligation page and the next membership cursor, and only then moves to the next obligation page.
 * The idempotency key names the recipient, so a continuation, a retry or a later sweep can never send
 * the same (obligation, step, occurrence) to the same person twice.
 *
 * Failure signal (PR #716 round 3). A worker that throws cannot record its own failure: that write rolls
 * back with the rest. The chain is therefore run through `runOrgSupplierDueAlerts`, an action that calls
 * the worker and, if it throws, records the failure from a separate transaction and rethrows (so the
 * scheduled function still shows as failed in the Convex logs). The record goes into the existing
 * `cronHeartbeats` table under a per-organisation job name (`supplierDueAlertJobName`): one failure row
 * per organisation, updated in place while it keeps failing, and superseded by a success row the next
 * time the worker commits for that organisation. It names the organisation, kind and cursors, so an
 * operator can see where the chain stopped (`adminSystem.listSupplierDueAlertFailures`). Scheduled
 * functions and actions are not retried by Convex for developer errors
 * (https://docs.convex.dev/scheduling/scheduled-functions, https://docs.convex.dev/functions/actions).
 */

const ORG_BATCH_SIZE = 20;
const ROW_PAGE_SIZE = Math.min(50, OBLIGATION_PAGE_MAX);
/** Alert sends per worker transaction. Chosen from the limits above, not measured: convex-test has no write meter. */
const SEND_BUDGET = 400;
const KINDS: readonly ObligationKind[] = ["PAYABLE", "RECEIVABLE", "RECOVERY"];
const kindValidator = v.union(v.literal("PAYABLE"), v.literal("RECEIVABLE"), v.literal("RECOVERY"));
const ALERT_OPERATION = "supplier-due-alert";

/**
 * The members of one membership page who are alerted: Owner, Finance Manager (manage:finance) and
 * authorised accounting staff (view:finance), and only active ones. An offboarding member, a super
 * admin's temporary impersonation membership (it copies the target's role) and a disabled user are
 * not recipients, the same predicates `requireTenantAuth` and `countOwners` apply.
 */
async function eligibleRecipients(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  memberships: Doc<"memberships">[]
): Promise<Id<"users">[]> {
  const rolesHoldingFinance = new Map<Id<"roles">, boolean>();
  const recipients = new Set<Id<"users">>();
  for (const membership of memberships) {
    if (membership.offboardingStatus || membership.impersonationGrantId) continue;
    let holdsFinance = rolesHoldingFinance.get(membership.roleId);
    if (holdsFinance === undefined) {
      const role = await ctx.db.get(membership.roleId);
      holdsFinance =
        !!role &&
        role.orgId === orgId &&
        (isSystemOwnerRole(role) ||
          role.permissions.includes(PERMISSIONS.MANAGE_FINANCE) ||
          role.permissions.includes(PERMISSIONS.VIEW_FINANCE));
      rolesHoldingFinance.set(membership.roleId, holdsFinance);
    }
    if (!holdsFinance) continue;
    const user = await ctx.db.get(membership.userId);
    if (!user || user.disabled) continue;
    recipients.add(membership.userId);
  }
  return [...recipients];
}

function alertData(row: ObligationRow): Record<string, string | number> {
  return {
    kind: row.kind,
    amount: fromMinorUnits(row.outstandingMinor, row.currency).toFixed(scaleForCurrency(row.currency)),
    currency: row.currency,
    dueDate: row.dueDate ?? "",
    daysOverdue: Math.max(0, row.daysOverdue ?? 0),
  };
}

interface PlannedAlert {
  type: ReturnType<typeof alertTypeFor>;
  data: Record<string, string | number>;
  idempotencyKey: string;
}

/**
 * Decides whether an obligation alerts now, and what it would say. Pure: it writes nothing. The
 * idempotent write itself stays inside `processOrgSupplierDueAlerts`, because the SCRUM-57
 * classification ratchet (`idempotencyEconomicCommands.test.ts`) attributes each
 * `runWithIdempotency` call to the exported function it sits in.
 */
function planAlert(row: ObligationRow): PlannedAlert | null {
  // A missing due date can never alert, and a disputed obligation is held back.
  if (row.dueAt === null || row.disputedMinor > 0) return null;
  const plan = alertStepFor(row.daysOverdue);
  if (!plan) return null;
  return {
    type: alertTypeFor(plan.step),
    data: alertData(row),
    idempotencyKey: `${row.kind}:${row.id}:${plan.step}:${plan.occurrence}`,
  };
}

/** The worker's arguments other than `orgId`, shared by the mutation and the action that wraps it. */
const workerArgsBase = {
  now: v.number(),
  kind: v.optional(kindValidator),
  /** Obligation page cursor, supplied by the worker's own continuation. */
  cursor: v.optional(v.string()),
  /** Membership page cursor within the obligation page, supplied by the worker's own continuation. */
  recipientCursor: v.optional(v.string()),
};

/** One failure row's `detail` is at most this long, whatever the error text and cursors are. */
const FAILURE_DETAIL_MAX = 1_000;
const FAILURE_CURSOR_MAX = 300;

async function newestOrgHeartbeat(ctx: MutationCtx, orgId: Id<"organizations">) {
  return await ctx.db
    .query("cronHeartbeats")
    .withIndex("by_job_ranAt", (q) => q.eq("jobName", supplierDueAlertJobName(orgId)))
    .order("desc")
    .first();
}

export const processOrgSupplierDueAlerts = internalMutation({
  // `orgId` stays a native declaration so the tenantWriteGuard analyser still covers this worker.
  args: { orgId: v.id("organizations"), ...workerArgsBase },
  returns: v.object({ alerted: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const kind = args.kind ?? KINDS[0];
    if (!(await hasPlanFeature(ctx, args.orgId, "accounting"))) return { alerted: 0, skipped: 0 };

    // Everything that can be learned from a read is learned before the first write below, so a data
    // fault is skipped here and can never leave a half-written transaction behind.
    const firstRecipientPage = args.recipientCursor === undefined;
    let skipped = 0;
    const page = await readObligationPage(ctx, {
      orgId: args.orgId,
      kind,
      cursor: args.cursor ?? null,
      limit: ROW_PAGE_SIZE,
      nowMs: args.now,
      onUnreadableRow: (row) => {
        // The same unreadable row is met again by each membership continuation: count and log it once.
        if (!firstRecipientPage) return;
        skipped += 1;
        console.error("supplier due alert skipped an unreadable row", { orgId: args.orgId, kind: row.kind, id: row.id, reason: row.reason });
      },
    });
    const planned: PlannedAlert[] = [];
    for (const row of page.rows) {
      const alert = planAlert(row);
      if (alert) planned.push(alert);
    }

    let alerted = 0;
    let moreRecipients = false;
    let recipientCursor: string | undefined;
    if (planned.length > 0) {
      // (alerts) x (memberships) stays within the send budget, whatever the alert count of the page.
      const membershipPage = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .paginate({ cursor: args.recipientCursor ?? null, numItems: Math.max(1, Math.floor(SEND_BUDGET / planned.length)) });
      const recipients = await eligibleRecipients(ctx, args.orgId, membershipPage.page);
      for (const { type, data, idempotencyKey } of planned) {
        const def = NOTIFICATION_TYPES[type];
        for (const userId of recipients) {
          let sent = false;
          // Non-economic: this command writes one in-app notification row and moves no money.
          await runWithIdempotency(
            ctx,
            { orgId: args.orgId, operation: ALERT_OPERATION, economic: false, idempotencyKey: `${idempotencyKey}:${userId}` },
            async () => {
              await ctx.db.insert("notifications", {
                orgId: args.orgId,
                userId,
                type,
                category: def.category,
                priority: def.priority,
                data,
                isRead: false,
                link: `/${args.orgId}/accounting`,
              });
              sent = true;
              return 1;
            }
          );
          if (sent) alerted += 1;
        }
      }
      moreRecipients = !membershipPage.isDone;
      recipientCursor = membershipPage.continueCursor;
    }

    // No `undefined` field is ever passed on: a Convex argument is either present or absent.
    const nextKind = KINDS[KINDS.indexOf(kind) + 1];
    let continuation: { kind: ObligationKind; cursor?: string; recipientCursor?: string } | null = null;
    if (moreRecipients && recipientCursor !== undefined) {
      continuation = { kind, ...(args.cursor !== undefined ? { cursor: args.cursor } : {}), recipientCursor };
    } else if (!page.complete) {
      continuation = { kind, cursor: page.continueCursor };
    } else if (nextKind) {
      continuation = { kind: nextKind };
    }
    if (continuation) {
      await ctx.scheduler.runAfter(0, internal.supplierDueAlerts.runOrgSupplierDueAlerts, {
        orgId: args.orgId,
        now: args.now,
        ...continuation,
      });
    }

    // A transaction that committed supersedes an earlier failure of this organisation. One indexed read;
    // a row is written only when the newest one is a failure, so a healthy organisation writes nothing.
    const newest = await newestOrgHeartbeat(ctx, args.orgId);
    if (newest && !newest.success) {
      await ctx.db.insert("cronHeartbeats", {
        jobName: supplierDueAlertJobName(args.orgId),
        ranAt: Date.now(),
        success: true,
        detail: "supplier due alerts ran again for this organisation after a failure",
      });
    }
    return { alerted, skipped };
  },
});

/**
 * Runs one worker transaction and reports its failure. Convex rolls a throwing mutation back whole, so
 * the failure is written here, from a separate transaction, and then rethrown: the scheduled function
 * still fails visibly and is not retried (a developer error is not an internal error).
 */
export const runOrgSupplierDueAlerts = internalAction({
  args: { orgId: v.id("organizations"), ...workerArgsBase },
  returns: v.object({ alerted: v.number(), skipped: v.number() }),
  // Annotated: the action and the mutation name each other through `internal`, which TypeScript
  // cannot infer around (a TS7022 circular-inference error without it; Convex documents the same
  // remedy, an explicit return type, for functions that call each other through `api`/`internal`).
  handler: async (ctx, args): Promise<{ alerted: number; skipped: number }> => {
    try {
      return await ctx.runMutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, args);
    } catch (error) {
      console.error("supplier due alert worker failed", { orgId: args.orgId, kind: args.kind ?? KINDS[0] });
      await ctx.runMutation(internal.supplierDueAlerts.recordSupplierDueAlertFailure, {
        orgId: args.orgId,
        kind: args.kind ?? KINDS[0],
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        ...(args.recipientCursor !== undefined ? { recipientCursor: args.recipientCursor } : {}),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

/**
 * The organisations whose supplier due-alert chain last failed and has not run again since (operator
 * view of the failure signal above). One page of organisations per call (the caller pages with
 * `continueCursor`) and one indexed heartbeat read per organisation, so the read set is bounded by the
 * page size. A row is returned only while the newest heartbeat of that organisation's job is a failure:
 * a later success supersedes it. Super admins only. Lives here, not in `adminSystem.ts`, so the whole
 * signal is in one module.
 */
export const listSupplierDueAlertFailures = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(v.object({ orgId: v.id("organizations"), ranAt: v.number(), detail: v.string() })),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const orgPage = await ctx.db.query("organizations").paginate(args.paginationOpts);
    const newest = await Promise.all(
      orgPage.page.map(async (org) => ({
        orgId: org._id,
        heartbeat: await ctx.db
          .query("cronHeartbeats")
          .withIndex("by_job_ranAt", (q) => q.eq("jobName", supplierDueAlertJobName(org._id)))
          .order("desc")
          .first(),
      }))
    );
    const page = newest.flatMap(({ orgId, heartbeat }) =>
      heartbeat && !heartbeat.success ? [{ orgId, ranAt: heartbeat.ranAt, detail: heartbeat.detail ?? "" }] : []
    );
    return { page, isDone: orgPage.isDone, continueCursor: orgPage.continueCursor };
  },
});

/** Non-economic operational write: one bounded `cronHeartbeats` row per failing organisation, updated in place while it keeps failing. */
export const recordSupplierDueAlertFailure = internalMutation({
  args: {
    orgId: v.id("organizations"),
    kind: kindValidator,
    cursor: v.optional(v.string()),
    recipientCursor: v.optional(v.string()),
    message: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);
    const head =
      `supplier due alerts failed: org=${args.orgId} kind=${args.kind} ` +
      `cursor=${args.cursor === undefined ? "none" : clip(args.cursor, FAILURE_CURSOR_MAX)} ` +
      `recipientCursor=${args.recipientCursor === undefined ? "none" : clip(args.recipientCursor, FAILURE_CURSOR_MAX)} error=`;
    const detail = `${head}${clip(args.message, Math.max(0, FAILURE_DETAIL_MAX - head.length - 3))}`.slice(0, FAILURE_DETAIL_MAX);
    const now = Date.now();
    const newest = await newestOrgHeartbeat(ctx, args.orgId);
    if (newest && !newest.success) {
      await ctx.db.patch(newest._id, { ranAt: now, detail });
    } else {
      await ctx.db.insert("cronHeartbeats", { jobName: supplierDueAlertJobName(args.orgId), ranAt: now, success: false, detail });
    }
    return null;
  },
});
export const processSupplierDueAlerts = internalMutation({
  // `cursor` and `now` are supplied by this mutation's own continuation; the cron passes nothing.
  // `now` pins every continuation of one sweep to the same Amman day.
  args: { cursor: v.optional(v.string()), now: v.optional(v.number()) },
  returns: v.object({ organizations: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const page = await ctx.db.query("organizations").paginate({ cursor: args.cursor ?? null, numItems: ORG_BATCH_SIZE });
    for (const org of page.page) {
      await ctx.scheduler.runAfter(0, internal.supplierDueAlerts.runOrgSupplierDueAlerts, { orgId: org._id, now });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.supplierDueAlerts.processSupplierDueAlerts, { cursor: page.continueCursor, now });
    }
    return { organizations: page.page.length, isDone: page.isDone };
  },
});
