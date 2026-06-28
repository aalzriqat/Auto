"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { renderNotification } from "../lib/notifications/render";

type ReminderMessageType = "DUE_SOON" | "OVERDUE" | "CHEQUE_UPCOMING" | "CHEQUE_RETURNED";

function reminderNotificationType(messageType: ReminderMessageType) {
  switch (messageType) {
    case "DUE_SOON":
      return "collection.receivable_due_soon";
    case "OVERDUE":
      return "collection.receivable_overdue";
    case "CHEQUE_UPCOMING":
      return "collection.cheque_upcoming";
    case "CHEQUE_RETURNED":
      return "collection.cheque_returned_customer";
  }
}

function roundMoney(amount: number) {
  return Math.round(amount * 100) / 100;
}

function safeCustomerName(customer: { firstName?: string; lastName?: string } | null) {
  if (!customer) return "Customer";
  return `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Customer";
}

function reminderData(payload: {
  customer: { firstName?: string; lastName?: string } | null;
  receivable: { outstandingAmount: number; dueDate: number } | null;
  cheque: { amount: number; chequeDate: number } | null;
}) {
  const amount = payload.receivable?.outstandingAmount ?? payload.cheque?.amount ?? 0;
  const dueDate = payload.receivable?.dueDate ?? payload.cheque?.chequeDate ?? Date.now();
  return {
    customerName: safeCustomerName(payload.customer),
    amount: String(roundMoney(amount)),
    dueDate: new Date(dueDate).toLocaleDateString("ar-JO"),
  };
}

export const sendCollectionReminder = internalAction({
  args: { reminderId: v.id("collectionReminders") },
  handler: async (ctx, args) => {
    const payload = await ctx.runQuery(internal.collections.getReminderPayload, {
      reminderId: args.reminderId,
    });

    if (!payload || !payload.customer) {
      await ctx.runMutation(internal.collections.markReminderResult, {
        reminderId: args.reminderId,
        status: "FAILED",
        error: "Reminder payload not found.",
      });
      return { success: false };
    }

    const type = reminderNotificationType(payload.reminder.messageType);
    const data = reminderData(payload);
    const locale: "en" | "ar" = "ar";

    if (payload.reminder.channel === "WHATSAPP") {
      const toPhone = payload.customer.whatsapp ?? payload.customer.phone;
      if (!toPhone) {
        await ctx.runMutation(internal.collections.markReminderResult, {
          reminderId: args.reminderId,
          status: "SKIPPED",
          error: "No WhatsApp or phone number on customer.",
        });
        return { success: false };
      }

      const result: { success: boolean; error?: string } = await ctx.runAction(
        internal.whatsappSend.sendNotificationWhatsapp,
        {
          orgId: payload.reminder.orgId,
          toPhone,
          locale,
          type,
          data,
        }
      );

      await ctx.runMutation(internal.collections.markReminderResult, {
        reminderId: args.reminderId,
        status: result.success ? "SENT" : result.error === "whatsapp_not_configured" ? "SKIPPED" : "FAILED",
        error: result.error,
      });
      return result;
    }

    if (payload.reminder.channel === "SMS") {
      const toPhone = payload.customer.phone ?? payload.customer.whatsapp;
      if (!toPhone) {
        await ctx.runMutation(internal.collections.markReminderResult, {
          reminderId: args.reminderId,
          status: "SKIPPED",
          error: "No SMS phone number on customer.",
        });
        return { success: false };
      }

      const smsResult = await sendSmsReminder(toPhone, locale, type, data);
      await ctx.runMutation(internal.collections.markReminderResult, {
        reminderId: args.reminderId,
        status: smsResult.success ? "SENT" : smsResult.skipped ? "SKIPPED" : "FAILED",
        error: smsResult.error,
      });
      return smsResult;
    }

    await ctx.runMutation(internal.collections.markReminderResult, {
      reminderId: args.reminderId,
      status: "SKIPPED",
      error: "Manual reminder only.",
    });
    return { success: false, skipped: true };
  },
});

async function sendSmsReminder(
  toPhone: string,
  locale: "en" | "ar",
  type: string,
  data: Record<string, string | number>
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromPhone) {
    return { success: false, skipped: true, error: "sms_not_configured" };
  }

  const rendered = renderNotification(locale, type, data);
  const body = [rendered.title, rendered.message].filter(Boolean).join("\n");
  const params = new URLSearchParams({
    To: toPhone,
    From: fromPhone,
    Body: body,
  });

  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    if (response.ok) return { success: true };
    return { success: false, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}` };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
