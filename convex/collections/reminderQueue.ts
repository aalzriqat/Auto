import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

type ReminderMessageType = Doc<"collectionReminders">["messageType"];

type ReminderChannel = Doc<"collectionReminders">["channel"];

const REMINDER_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/** Reminder states that count towards the cooldown; FAILED rows never do. */
const REMINDER_DEDUPE_STATUSES = ["PENDING", "SENT", "SKIPPED"] as const;

async function hasRecentReminder(
  ctx: MutationCtx,
  args: {
    receivableId?: Id<"receivables">;
    chequeId?: Id<"postDatedCheques">;
    messageType: ReminderMessageType;
    since: number;
  }
) {
  const { receivableId, chequeId, messageType, since } = args;
  // A cheque reminder is keyed by its CHEQUE even when the cheque also names a
  // receivable: keyed by receivable, one cheque's reminder suppressed every
  // sibling cheque of the same receivable.
  for (const status of REMINDER_DEDUPE_STATUSES) {
    const recent = chequeId
      ? await ctx.db
          .query("collectionReminders")
          .withIndex("by_cheque_and_messageType_and_status_and_createdAt", (q) =>
            q.eq("chequeId", chequeId).eq("messageType", messageType).eq("status", status).gte("createdAt", since)
          )
          .first()
      : receivableId
        ? await ctx.db
            .query("collectionReminders")
            .withIndex("by_receivable_and_messageType_and_status_and_createdAt", (q) =>
              q.eq("receivableId", receivableId).eq("messageType", messageType).eq("status", status).gte("createdAt", since)
            )
            .first()
        : null;
    if (recent) return true;
  }
  return false;
}

export async function queueCustomerReminder(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    receivableId?: Id<"receivables">;
    chequeId?: Id<"postDatedCheques">;
    messageType: ReminderMessageType;
  }
) {
  const customer = await ctx.db.get(args.customerId);
  const channel: ReminderChannel = customer?.whatsapp ? "WHATSAPP" : customer?.phone ? "SMS" : "MANUAL";
  const now = Date.now();
  if (await hasRecentReminder(ctx, { ...args, since: now - REMINDER_COOLDOWN_MS })) {
    return null;
  }
  const reminderId = await ctx.db.insert("collectionReminders", {
    orgId: args.orgId,
    customerId: args.customerId,
    receivableId: args.receivableId,
    chequeId: args.chequeId,
    channel,
    messageType: args.messageType,
    status: channel === "MANUAL" ? "SKIPPED" : "PENDING",
    scheduledAt: now,
    error: channel === "MANUAL" ? "No customer phone or WhatsApp number on file." : undefined,
    createdAt: now,
  });
  if (channel !== "MANUAL") {
    await ctx.scheduler.runAfter(0, internal.collectionReminderActions.sendCollectionReminder, { reminderId });
  }
  return reminderId;
}
