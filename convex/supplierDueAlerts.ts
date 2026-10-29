import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
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
 * handles one bounded page of one obligation kind and schedules its own continuation, so no
 * transaction reads more than a page and one organisation's failure cannot roll back another's.
 * The worker also catches and logs its own failure (TEN-3). Catch-up: each run sends the latest step
 * an obligation has reached unless that step's idempotency record exists, so a day the cron or an
 * organisation worker missed is made up on the next run, once, never as a burst.
 */

const ORG_BATCH_SIZE = 20;
const ROW_PAGE_SIZE = Math.min(50, OBLIGATION_PAGE_MAX);
const KINDS: readonly ObligationKind[] = ["PAYABLE", "RECEIVABLE", "RECOVERY"];
const kindValidator = v.union(v.literal("PAYABLE"), v.literal("RECEIVABLE"), v.literal("RECOVERY"));
const ALERT_OPERATION = "supplier-due-alert";

/** Owner, Finance Manager (manage:finance) and authorised accounting staff (view:finance). */
async function resolveRecipients(ctx: MutationCtx, orgId: Id<"organizations">): Promise<Id<"users">[]> {
  const memberships = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(1000);
  const recipients = new Set<Id<"users">>();
  for (const membership of memberships) {
    // The same predicate `requireTenantAuth` refuses on: an offboarding member is not active.
    if (membership.offboardingStatus) continue;
    const role = await ctx.db.get(membership.roleId);
    if (!role || role.orgId !== orgId) continue;
    const holdsFinance =
      isSystemOwnerRole(role) ||
      role.permissions.includes(PERMISSIONS.MANAGE_FINANCE) ||
      role.permissions.includes(PERMISSIONS.VIEW_FINANCE);
    if (holdsFinance) recipients.add(membership.userId);
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

async function alertRow(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  row: ObligationRow,
  getRecipients: () => Promise<Id<"users">[]>
): Promise<number> {
  // A missing due date can never alert, and a disputed obligation is held back.
  if (row.dueAt === null || row.disputedMinor > 0) return 0;
  const plan = alertStepFor(row.daysOverdue);
  if (!plan) return 0;
  const type = alertTypeFor(plan.step);
  const def = NOTIFICATION_TYPES[type];
  const data = alertData(row);
  const recipients = await getRecipients();
  const stored = await runWithIdempotency(
    ctx,
    {
      orgId,
      operation: ALERT_OPERATION,
      economic: false,
      idempotencyKey: `${row.kind}:${row.id}:${plan.step}:${plan.occurrence}`,
    },
    async () => {
      for (const userId of recipients) {
        await ctx.db.insert("notifications", {
          orgId,
          userId,
          type,
          category: def.category,
          priority: def.priority,
          data,
          isRead: false,
          link: `/${orgId}/accounting`,
        });
      }
      return recipients.length;
    }
  );
  return stored;
}

export const processOrgSupplierDueAlerts = internalMutation({
  args: {
    orgId: v.id("organizations"),
    now: v.number(),
    kind: v.optional(kindValidator),
    cursor: v.optional(v.string()),
  },
  returns: v.object({ alerted: v.number(), failed: v.boolean() }),
  handler: async (ctx, args) => {
    const kind = args.kind ?? KINDS[0];
    try {
      if (!(await hasPlanFeature(ctx, args.orgId, "accounting"))) return { alerted: 0, failed: false };
      const page = await readObligationPage(ctx, {
        orgId: args.orgId,
        kind,
        cursor: args.cursor ?? null,
        limit: ROW_PAGE_SIZE,
        nowMs: args.now,
      });
      let recipients: Id<"users">[] | null = null;
      const getRecipients = async () => (recipients ??= await resolveRecipients(ctx, args.orgId));
      let alerted = 0;
      for (const row of page.rows) alerted += await alertRow(ctx, args.orgId, row, getRecipients);
      if (!page.complete) {
        await ctx.scheduler.runAfter(0, internal.supplierDueAlerts.processOrgSupplierDueAlerts, {
          orgId: args.orgId,
          now: args.now,
          kind,
          cursor: page.continueCursor,
        });
      } else {
        const next = KINDS[KINDS.indexOf(kind) + 1];
        if (next) {
          await ctx.scheduler.runAfter(0, internal.supplierDueAlerts.processOrgSupplierDueAlerts, {
            orgId: args.orgId,
            now: args.now,
            kind: next,
          });
        }
      }
      return { alerted, failed: false };
    } catch (error) {
      console.error("supplier due alerts failed for one organisation", error);
      return { alerted: 0, failed: true };
    }
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
      await ctx.scheduler.runAfter(0, internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: org._id, now });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.supplierDueAlerts.processSupplierDueAlerts, { cursor: page.continueCursor, now });
    }
    return { organizations: page.page.length, isDone: page.isDone };
  },
});
