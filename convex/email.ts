"use node";

import { ActionCtx, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { Resend } from "resend";
import { rateLimiter } from "./rateLimit";
import { getValidatedEnv } from "./utils/env";
import { renderNotification } from "../lib/notifications/render";

/** Escape user input before interpolating into HTML to prevent XSS/injection. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wraps inner content in a branded, table-based email shell.
 * Table layout + inline styles are deliberate — they're the only markup that
 * renders consistently across Outlook/Gmail/Apple Mail, which all strip or
 * ignore <style> blocks and modern CSS (flexbox/grid).
 */
function wrapEmailHtml(preheader: string, bodyHtml: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  </head>
  <body style="margin:0; padding:0; background-color:#f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <span style="display:none; font-size:1px; color:#f4f5f7; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">${preheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            <tr>
              <td style="background-color:#0f172a; padding:24px 32px;">
                <span style="color:#ffffff; font-size:20px; font-weight:700; letter-spacing:-0.02em;">AutoFlow</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px; color:#374151; font-size:14px; line-height:1.6;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px; background-color:#f9fafb; border-top:1px solid #eef0f2;">
                <p style="margin:0; font-size:12px; color:#9ca3af;">This is an automated message from AutoFlow. If you weren't expecting this email, you can safely ignore it.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Bulletproof-enough button styling for the email clients this app's recipients realistically use. */
function emailButton(url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block; background-color:#0f172a; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-size:14px; font-weight:600;">${label}</a>`;
}

/**
 * Plain wrapper for human-written replies — no branded banner, card, or
 * "automated message" disclaimer, since a support agent actually typed this.
 */
function wrapPlainEmailHtml(preheader: string, bodyHtml: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  </head>
  <body style="margin:0; padding:0; background-color:#ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <span style="display:none; font-size:1px; color:#ffffff; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">${preheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:24px; color:#1f2937; font-size:14px; line-height:1.6;">
          ${bodyHtml}
          <p style="margin:24px 0 0; font-size:13px; color:#6b7280;">AutoFlow Support<br />support@autoflowdealer.com</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export const sendTaskAlarm = internalAction({
  args: {
    toEmail: v.string(),
    taskTitle: v.string(),
    taskDescription: v.optional(v.string()),
    dueDate: v.number(),
  },
  handler: async (ctx, args) => {
    const status = await rateLimiter.limit(ctx, "email");
    if (!status.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(status.retryAfter / 1000)}s`);
    }
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;

    // Generate basic .ics file string
    const dateStart = new Date(args.dueDate);
    const dateEnd = new Date(args.dueDate + 60 * 60 * 1000); // 1 hour duration

    const formatICSDate = (date: Date) => {
      return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    const icsString = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//AutoFlow CRM//Task Alarm//EN',
      'BEGIN:VEVENT',
      `UID:${args.dueDate}@autoflow.crm`,
      `DTSTAMP:${formatICSDate(new Date())}`,
      `DTSTART:${formatICSDate(dateStart)}`,
      `DTEND:${formatICSDate(dateEnd)}`,
      `SUMMARY:${args.taskTitle}`,
      `DESCRIPTION:${args.taskDescription || 'Task Reminder'}`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const safeTaskTitle = escapeHtml(args.taskTitle);
    const appUrl = env.NEXT_PUBLIC_APP_URL;

    const emailHtml = wrapEmailHtml(
      `Reminder: ${args.taskTitle}`,
      `
        <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">Task Reminder</h1>
        <p style="margin:0 0 16px;">You have a task due soon:</p>
        <div style="background-color:#f9fafb; border-radius:8px; padding:16px; margin:0 0 20px;">
          <p style="margin:0 0 4px; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em;">Task</p>
          <p style="margin:0 0 12px; font-size:16px; font-weight:600; color:#111827;">${safeTaskTitle}</p>
          <p style="margin:0 0 4px; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em;">Due</p>
          <p style="margin:0; font-size:14px; color:#111827;">${new Date(args.dueDate).toLocaleString()}</p>
          ${args.taskDescription ? `<p style="margin:12px 0 0; font-size:14px; color:#374151;">${escapeHtml(args.taskDescription)}</p>` : ""}
        </div>
        ${emailButton(`${appUrl}/dashboard`, "View in AutoFlow")}
      `
    );

    if (!resendApiKey) {
      return { success: true, mock: true };
    }

    const resend = new Resend(resendApiKey);

    try {
      await resend.emails.send({
        from: 'AutoFlow Tasks <notifications@autoflowdealer.com>',
        to: args.toEmail,
        subject: `Task Reminder: ${args.taskTitle}`,
        html: emailHtml,
        attachments: [
          {
            filename: 'invite.ics',
            content: Buffer.from(icsString).toString('base64'),
          }
        ]
      });
      return { success: true, mock: false };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

export const sendAccountSetupLink = internalAction({
  args: {
    toEmail: v.string(),
    firstName: v.string(),
    orgName: v.string(),
    setupToken: v.string(),
  },
  handler: async (ctx, args) => {
    const status = await rateLimiter.limit(ctx, "email");
    if (!status.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(status.retryAfter / 1000)}s`);
    }
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;
    const appUrl = env.NEXT_PUBLIC_APP_URL;
    const setupUrl = `${appUrl}/setup-account?ticket=${encodeURIComponent(args.setupToken)}`;

    const safeOrgName = escapeHtml(args.orgName);
    const safeFirstName = escapeHtml(args.firstName);
    const safeEmail = escapeHtml(args.toEmail);

    const emailHtml = wrapEmailHtml(
      `Your AutoFlow account for ${args.orgName} is ready`,
      `
        <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">Welcome to ${safeOrgName}</h1>
        <p style="margin:0 0 16px;">Hi ${safeFirstName},</p>
        <p style="margin:0 0 20px;">An account has been created for you on AutoFlow. Click the button below to activate it and choose your own password. The link can be used once and expires in 7 days.</p>
        <div style="background-color:#f9fafb; border-radius:8px; padding:16px; margin:0 0 24px;">
          <p style="margin:0 0 4px; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em;">Email</p>
          <p style="margin:0; font-size:14px; color:#111827;">${safeEmail}</p>
        </div>
        ${emailButton(setupUrl, "Set Up Your Account")}
        <p style="margin:24px 0 0; font-size:12px; color:#6b7280;">If the link has expired, ask your administrator to re-create the invitation, or use "Forgot password" on the sign-in page.</p>
      `
    );

    if (!resendApiKey) {
      return { success: true, mock: true };
    }

    const resend = new Resend(resendApiKey);

    try {
      await resend.emails.send({
        from: 'AutoFlow Team <notifications@autoflowdealer.com>',
        to: args.toEmail,
        subject: `Your AutoFlow account for ${args.orgName}`,
        html: emailHtml,
      });
      return { success: true, mock: false };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const SUPPORT_INBOX_FROM: Record<"support" | "info" | "subscriptions", string> = {
  support: "AutoFlow Support <support@autoflowdealer.com>",
  info: "AutoFlow <info@autoflowdealer.com>",
  subscriptions: "AutoFlow Subscriptions <subscriptions@autoflowdealer.com>",
};

/** Sends a reply from the company support, info, or subscriptions inbox to a subscriber. */
export const sendSupportReply = internalAction({
  args: {
    toEmail: v.string(),
    subject: v.string(),
    bodyText: v.string(),
    inbox: v.union(v.literal("support"), v.literal("info"), v.literal("subscriptions")),
  },
  handler: async (ctx, args): Promise<{ success: boolean; resendEmailId?: string; error?: string }> => {
    const status = await rateLimiter.limit(ctx, "email");
    if (!status.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(status.retryAfter / 1000)}s`);
    }
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;

    const safeBody = escapeHtml(args.bodyText).replace(/\n/g, "<br />");
    const emailHtml = wrapPlainEmailHtml(
      args.subject,
      `<div style="white-space:pre-wrap;">${safeBody}</div>`
    );

    if (!resendApiKey) {
      return { success: true };
    }

    const resend = new Resend(resendApiKey);

    try {
      const result = await resend.emails.send({
        from: SUPPORT_INBOX_FROM[args.inbox],
        to: args.toEmail,
        subject: args.subject,
        html: emailHtml,
        text: args.bodyText,
      });
      return { success: true, resendEmailId: result.data?.id };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

/** Professional acknowledgment sent automatically the first time a new sender emails support@, info@, or subscriptions@autoflowdealer.com. */
export const sendAutoReplyEmail = internalAction({
  args: {
    toEmail: v.string(),
    participantName: v.optional(v.string()),
    subject: v.string(),
    inbox: v.union(v.literal("support"), v.literal("info"), v.literal("subscriptions")),
  },
  handler: async (ctx, args): Promise<{ success: boolean; resendEmailId?: string; error?: string }> => {
    const status = await rateLimiter.limit(ctx, "email");
    if (!status.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(status.retryAfter / 1000)}s`);
    }
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;

    const greetingName = args.participantName?.trim().split(" ")[0];
    const safeGreetingName = greetingName ? escapeHtml(greetingName) : null;
    const safeSubject = escapeHtml(args.subject);
    const replySubject = args.subject.toLowerCase().startsWith("re:") ? args.subject : `Re: ${args.subject}`;

    const emailHtml = wrapEmailHtml(
      "We've received your message",
      `
        <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">Thanks for reaching out</h1>
        <p style="margin:0 0 16px;">Hi${safeGreetingName ? ` ${safeGreetingName}` : ""},</p>
        <p style="margin:0 0 20px;">This confirms we've received your message. A member of the AutoFlow team will get back to you within 1 business day.</p>
        <div style="background-color:#f9fafb; border-radius:8px; padding:16px; margin:0 0 20px;">
          <p style="margin:0 0 4px; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em;">Your message</p>
          <p style="margin:0; font-size:14px; color:#111827;">${safeSubject}</p>
        </div>
        <p style="margin:0; font-size:14px; color:#374151;">If anything else comes up in the meantime, just reply directly to this email — it'll be added to the same conversation.</p>
        <p style="margin:20px 0 0; font-size:14px; color:#374151;">— The AutoFlow Team</p>
      `
    );

    const textBody = `Hi${greetingName ? ` ${greetingName}` : ""},\n\nThis confirms we've received your message: "${args.subject}". A member of the AutoFlow team will get back to you within 1 business day.\n\nIf anything else comes up in the meantime, just reply directly to this email.\n\n— The AutoFlow Team`;

    if (!resendApiKey) {
      return { success: true };
    }

    const resend = new Resend(resendApiKey);

    try {
      const result = await resend.emails.send({
        from: SUPPORT_INBOX_FROM[args.inbox],
        to: args.toEmail,
        subject: replySubject,
        html: emailHtml,
        text: textBody,
      });
      return { success: true, resendEmailId: result.data?.id };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

/** Sends (or mocks, if Resend isn't configured) a plain transactional email and logs the outcome. Shared by sendSubscriptionReminderEmail and sendMarketplaceWeeklyReportEmail — same send-or-mock/try-catch/log shape, only the content differs. */
async function sendTransactionalEmail(
  ctx: ActionCtx,
  args: {
    resendApiKey: string | undefined;
    from: string;
    to: string;
    subject: string;
    html: string;
    logSource: "subscription-reminder" | "marketplace-weekly-report";
    logSummary: string;
  }
): Promise<{ success: boolean; error?: string }> {
  let result: { success: boolean; error?: string };
  if (!args.resendApiKey) {
    result = { success: true };
  } else {
    const resend = new Resend(args.resendApiKey);
    try {
      await resend.emails.send({ from: args.from, to: args.to, subject: args.subject, html: args.html });
      result = { success: true };
    } catch (error) {
      result = { success: false, error: String(error) };
    }
  }

  await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
    source: args.logSource,
    status: result.success ? "success" : "error",
    summary: args.logSummary,
    error: result.error,
  });

  return result;
}

export const sendSubscriptionReminderEmail = internalAction({
  args: {
    toEmail: v.string(),
    orgName: v.string(),
    kind: v.literal("renewal_due"),
    planName: v.string(),
    endsAt: v.number(),
    priceJod: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string }> => {
    const status = await rateLimiter.limit(ctx, "email");
    if (!status.ok) {
      return { success: false, error: "rate_limited" };
    }
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;
    const appUrl = env.NEXT_PUBLIC_APP_URL;

    const safeOrgName = escapeHtml(args.orgName);
    const safePlanName = escapeHtml(args.planName);
    const endDate = new Date(args.endsAt).toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric",
    });

    const subject = `Your AutoFlow subscription renews on ${endDate}`;
    const preheader = `Your ${safePlanName} plan renews in 2 days.`;

    const bodyHtml = `
      <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">Your subscription renews in 2 days</h1>
      <p style="margin:0 0 16px;">Hi ${safeOrgName},</p>
      <p style="margin:0 0 24px;">Your <strong>${safePlanName} plan</strong>${args.priceJod ? ` (${args.priceJod} JOD/month)` : ""} will renew automatically on <strong>${endDate}</strong>.</p>
      ${emailButton(`${appUrl}/settings/billing`, "Manage Subscription")}
      <p style="margin:20px 0 0; font-size:13px; color:#6b7280;">To cancel or change your plan before renewal, visit <a href="${appUrl}/settings/billing" style="color:#0f172a;">Settings → Billing</a> or reply to this email at <a href="mailto:subscriptions@autoflowdealer.com" style="color:#0f172a;">subscriptions@autoflowdealer.com</a>.</p>
    `;

    const emailHtml = wrapEmailHtml(preheader, bodyHtml);

    return await sendTransactionalEmail(ctx, {
      resendApiKey,
      from: "AutoFlow Subscriptions <subscriptions@autoflowdealer.com>",
      to: args.toEmail,
      subject,
      html: emailHtml,
      logSource: "subscription-reminder",
      logSummary: `${args.kind} -> ${args.toEmail} (${args.orgName})`,
    });
  },
});

export const sendMarketplaceWeeklyReportEmail = internalAction({
  args: {
    toEmail: v.string(),
    orgName: v.string(),
    pageViews: v.number(),
    vehicleDetailViews: v.number(),
    requestsMatched: v.number(),
    responsesSent: v.number(),
    avgResponseMinutes: v.union(v.number(), v.null()),
    mostViewedVehicle: v.union(
      v.null(),
      v.object({ make: v.string(), model: v.string(), year: v.number(), views: v.number() })
    ),
    requestsLost: v.number(),
  },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string }> => {
    const status = await rateLimiter.limit(ctx, "email");
    if (!status.ok) {
      return { success: false, error: "rate_limited" };
    }
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;
    const appUrl = env.NEXT_PUBLIC_APP_URL;

    const safeOrgName = escapeHtml(args.orgName);
    const subject = `Your AutoFlow Marketplace week: ${args.requestsMatched} matched request${args.requestsMatched === 1 ? "" : "s"}, ${args.responsesSent} repl${args.responsesSent === 1 ? "y" : "ies"}`;
    const preheader = `${args.pageViews} dealer-site views, ${args.requestsMatched} matched buyer requests this week.`;

    const statRow = (label: string, value: string) =>
      `<tr><td style="padding:6px 0; color:#6b7280;">${label}</td><td style="padding:6px 0; text-align:right; font-weight:600; color:#111827;">${value}</td></tr>`;

    const rows = [
      statRow("Dealer-site page views", String(args.pageViews)),
      statRow("Vehicle detail views", String(args.vehicleDetailViews)),
      statRow("Buyer requests matched to you", String(args.requestsMatched)),
      statRow("Responses you sent", String(args.responsesSent)),
      statRow("Avg. response time", args.avgResponseMinutes != null ? `${Math.round(args.avgResponseMinutes)} min` : "—"),
      statRow("Requests lost to no response", String(args.requestsLost)),
    ].join("");

    let mostViewedHtml = "";
    if (args.mostViewedVehicle) {
      const vehicleLabel = `${args.mostViewedVehicle.year} ${args.mostViewedVehicle.make} ${args.mostViewedVehicle.model}`;
      mostViewedHtml = `<p style="margin:20px 0 0; font-size:13px; color:#6b7280;">Most-viewed vehicle: <strong style="color:#111827;">${escapeHtml(vehicleLabel)}</strong> (${args.mostViewedVehicle.views} views)</p>`;
    }

    const bodyHtml = `
      <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">Your Marketplace week</h1>
      <p style="margin:0 0 16px;">Hi ${safeOrgName},</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">${rows}</table>
      ${mostViewedHtml}
      ${emailButton(`${appUrl}/marketplace/requests`, "View your requests")}
    `;

    const emailHtml = wrapEmailHtml(preheader, bodyHtml);

    return await sendTransactionalEmail(ctx, {
      resendApiKey,
      from: "AutoFlow Marketplace <marketplace@autoflowdealer.com>",
      to: args.toEmail,
      subject,
      html: emailHtml,
      logSource: "marketplace-weekly-report",
      logSummary: `weekly-report -> ${args.toEmail} (${args.orgName})`,
    });
  },
});

export const sendTeamInvite = internalAction({
  args: {
    toEmail: v.string(),
    orgName: v.string(),
    inviteToken: v.string(),
  },
  handler: async (ctx, args) => {
    const status = await rateLimiter.limit(ctx, "email");
    if (!status.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(status.retryAfter / 1000)}s`);
    }
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;

    // Build the invite URL from the environment
    const appUrl = env.NEXT_PUBLIC_APP_URL;
    const inviteUrl = `${appUrl}/sign-up?invite=${encodeURIComponent(args.inviteToken)}`;

    const safeOrgName = escapeHtml(args.orgName);
    const emailHtml = wrapEmailHtml(
      `You've been invited to join ${args.orgName} on AutoFlow`,
      `
        <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">You're invited to join ${safeOrgName}</h1>
        <p style="margin:0 0 20px;">Your team at ${safeOrgName} has invited you to join them on AutoFlow.</p>
        ${emailButton(inviteUrl, "Accept Invitation & Sign Up")}
        <p style="margin:20px 0 0; font-size:12px; color:#9ca3af;">If the button doesn't work, copy and paste this link into your browser: ${inviteUrl}</p>
      `
    );

    if (!resendApiKey) {
      return { success: true, mock: true };
    }

    const resend = new Resend(resendApiKey);

    try {
      await resend.emails.send({
        from: 'AutoFlow Team <notifications@autoflowdealer.com>',
        to: args.toEmail,
        subject: `You're invited to join ${args.orgName} on AutoFlow`,
        html: emailHtml,
      });
      return { success: true, mock: false };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

/**
 * Email delivery for the typed in-app notification system (convex/utils/notifications.ts).
 * Renders the same bilingual templates the bell/notifications page use
 * (lib/notifications/render.ts) so copy never drifts between channels.
 */
export const sendNotificationEmail = internalAction({
  args: {
    toEmail: v.string(),
    locale: v.union(v.literal("en"), v.literal("ar")),
    type: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const status = await rateLimiter.limit(ctx, "email");
    if (!status.ok) {
      // Silently drop rather than throw — this runs from a scheduled action
      // with no caller to surface the error to; the in-app notification
      // (already inserted by dispatch()) is the source of truth regardless.
      return { success: false, error: "rate_limited" };
    }

    const { title, message } = renderNotification(args.locale, args.type, args.data);

    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;
    const appUrl = env.NEXT_PUBLIC_APP_URL;

    const emailHtml = wrapEmailHtml(
      title,
      `
        <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">${escapeHtml(title)}</h1>
        <p style="margin:0 0 20px;">${escapeHtml(message)}</p>
        ${emailButton(`${appUrl}/dashboard`, "View in AutoFlow")}
      `
    );

    let result: { success: boolean; error?: string };
    if (!resendApiKey) {
      result = { success: true };
    } else {
      const resend = new Resend(resendApiKey);
      try {
        await resend.emails.send({
          from: 'AutoFlow Notifications <notifications@autoflowdealer.com>',
          to: args.toEmail,
          subject: title,
          html: emailHtml,
        });
        result = { success: true };
      } catch (error) {
        result = { success: false, error: String(error) };
      }
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "notification-email",
      status: result.success ? "success" : "error",
      summary: `${args.type} -> ${args.toEmail}`,
      error: result.error,
    });

    return result;
  },
});

export const sendUpgradeRequestEmail = internalAction({
  args: {
    orgName: v.string(),
    orgId: v.string(),
    currentPlan: v.string(),
    targetPlan: v.string(),
    userName: v.string(),
    userEmail: v.string(),
    phone: v.string(),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;

    const safeOrgName = escapeHtml(args.orgName);
    const safeUserName = escapeHtml(args.userName);
    const safePhone = escapeHtml(args.phone);
    const safeMessage = args.message ? escapeHtml(args.message) : "";
    const safeTarget = escapeHtml(args.targetPlan);
    const safeCurrent = escapeHtml(args.currentPlan);

    const subject = `Upgrade Request: ${safeOrgName} → ${safeTarget}`;
    const bodyHtml = `
      <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">New Plan Upgrade Request</h1>
      <table style="width:100%; border-collapse:collapse; margin-bottom:20px; font-size:14px;">
        <tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; width:140px; border:1px solid #e5e7eb;">Organization</td><td style="padding:8px 12px; border:1px solid #e5e7eb;">${safeOrgName}</td></tr>
        <tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Org ID</td><td style="padding:8px 12px; border:1px solid #e5e7eb; font-family:monospace; font-size:12px;">${args.orgId}</td></tr>
        <tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Current Plan</td><td style="padding:8px 12px; border:1px solid #e5e7eb;">${safeCurrent}</td></tr>
        <tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Requested Plan</td><td style="padding:8px 12px; border:1px solid #e5e7eb; font-weight:700; color:#d97706;">${safeTarget}</td></tr>
        <tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Contact Name</td><td style="padding:8px 12px; border:1px solid #e5e7eb;">${safeUserName}</td></tr>
        <tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Email</td><td style="padding:8px 12px; border:1px solid #e5e7eb;"><a href="mailto:${args.userEmail}">${args.userEmail}</a></td></tr>
        <tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Phone / WhatsApp</td><td style="padding:8px 12px; border:1px solid #e5e7eb; font-weight:700;">${safePhone}</td></tr>
        ${safeMessage ? `<tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Message</td><td style="padding:8px 12px; border:1px solid #e5e7eb;">${safeMessage}</td></tr>` : ""}
      </table>
      <p style="margin:0; font-size:13px; color:#6b7280;">Reply directly to this email or call the number above to follow up.</p>
    `;

    const emailHtml = wrapEmailHtml(subject, bodyHtml);

    let result: { success: boolean; error?: string };
    if (!resendApiKey) {
      result = { success: true };
    } else {
      const resend = new Resend(resendApiKey);
      try {
        await resend.emails.send({
          from: "AutoFlow System <notifications@autoflowdealer.com>",
          to: "subscriptions@autoflowdealer.com",
          replyTo: args.userEmail,
          subject,
          html: emailHtml,
        });
        result = { success: true };
      } catch (error) {
        result = { success: false, error: String(error) };
      }
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "upgrade-request",
      status: result.success ? "success" : "error",
      summary: `${args.orgName} → ${args.targetPlan} (${args.userEmail})`,
      error: result.error,
    });

    return result;
  },
});

export const sendSupportInboxNotification = internalAction({
  args: {
    toEmails: v.array(v.string()),
    inbox: v.string(),
    fromEmail: v.string(),
    fromName: v.optional(v.string()),
    subject: v.string(),
    bodyPreview: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;
    if (!resendApiKey || args.toEmails.length === 0) return { success: true };

    const safeName = escapeHtml(args.fromName ?? args.fromEmail);
    const safeSubject = escapeHtml(args.subject);
    const safeInbox = escapeHtml(args.inbox);
    const safePreview = args.bodyPreview ? escapeHtml(args.bodyPreview) : "";

    const bodyHtml = `
      <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">New Email in ${safeInbox}@ Inbox</h1>
      <table style="width:100%; border-collapse:collapse; margin-bottom:20px; font-size:14px;">
        <tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; width:100px; border:1px solid #e5e7eb;">From</td><td style="padding:8px 12px; border:1px solid #e5e7eb;">${safeName} &lt;${args.fromEmail}&gt;</td></tr>
        <tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Inbox</td><td style="padding:8px 12px; border:1px solid #e5e7eb;">${safeInbox}@autoflowdealer.com</td></tr>
        <tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Subject</td><td style="padding:8px 12px; border:1px solid #e5e7eb;">${safeSubject}</td></tr>
        ${safePreview ? `<tr><td style="padding:8px 12px; background:#f9fafb; font-weight:600; border:1px solid #e5e7eb;">Preview</td><td style="padding:8px 12px; border:1px solid #e5e7eb; color:#6b7280;">${safePreview}</td></tr>` : ""}
      </table>
      ${emailButton("https://autoflowdealer.com/admin/support", "Open Support Inbox")}
    `;

    const emailHtml = wrapEmailHtml(`New email from ${args.fromEmail}`, bodyHtml);

    const resend = new Resend(resendApiKey);
    let result: { success: boolean; error?: string };
    try {
      await resend.emails.send({
        from: "AutoFlow Inbox <notifications@autoflowdealer.com>",
        to: args.toEmails,
        subject: `[${safeInbox}] New email from ${safeName}`,
        html: emailHtml,
      });
      result = { success: true };
    } catch (error) {
      result = { success: false, error: String(error) };
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "support-inbox-notification",
      status: result.success ? "success" : "error",
      summary: `notify ${args.toEmails.join(", ")} for ${args.inbox} inbox`,
      error: result.error,
    });

    return result;
  },
});
