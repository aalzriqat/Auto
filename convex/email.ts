"use node";

import { internalAction } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { Resend } from "resend";
import { rateLimiter } from "./rateLimit";
import { getValidatedEnv } from "./utils/env";

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

export const sendNewAccountCredentials = internalAction({
  args: {
    toEmail: v.string(),
    firstName: v.string(),
    orgName: v.string(),
    temporaryPassword: v.string(),
  },
  handler: async (ctx, args) => {
    const status = await rateLimiter.limit(ctx, "email");
    if (!status.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(status.retryAfter / 1000)}s`);
    }
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;
    const appUrl = env.NEXT_PUBLIC_APP_URL;
    const signInUrl = `${appUrl}/sign-in`;

    const safeOrgName = escapeHtml(args.orgName);
    const safeFirstName = escapeHtml(args.firstName);
    const safeEmail = escapeHtml(args.toEmail);
    const safePassword = escapeHtml(args.temporaryPassword);

    const emailHtml = wrapEmailHtml(
      `Your AutoFlow account for ${args.orgName} is ready`,
      `
        <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">Welcome to ${safeOrgName}</h1>
        <p style="margin:0 0 16px;">Hi ${safeFirstName},</p>
        <p style="margin:0 0 20px;">An account has been created for you on AutoFlow. Use the temporary password below to sign in, then change it from your account settings (click your avatar in the top-right corner once signed in).</p>
        <div style="background-color:#f9fafb; border-radius:8px; padding:16px; margin:0 0 24px;">
          <p style="margin:0 0 4px; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em;">Email</p>
          <p style="margin:0 0 12px; font-size:14px; color:#111827;">${safeEmail}</p>
          <p style="margin:0 0 4px; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.05em;">Temporary Password</p>
          <p style="margin:0; font-size:18px; font-family:'SFMono-Regular', Consolas, monospace; font-weight:700; color:#111827;">${safePassword}</p>
        </div>
        ${emailButton(signInUrl, "Sign In to AutoFlow")}
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

/** Sends a reply from the company support inbox (support@autoflowdealer.com) to a subscriber. */
export const sendSupportReply = internalAction({
  args: {
    toEmail: v.string(),
    subject: v.string(),
    bodyText: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean; resendEmailId?: string; error?: string }> => {
    const status = await rateLimiter.limit(ctx, "email");
    if (!status.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(status.retryAfter / 1000)}s`);
    }
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;

    const safeBody = escapeHtml(args.bodyText).replace(/\n/g, "<br />");
    const emailHtml = wrapEmailHtml(
      args.subject,
      `<div style="white-space:pre-wrap;">${safeBody}</div>`
    );

    if (!resendApiKey) {
      return { success: true };
    }

    const resend = new Resend(resendApiKey);

    try {
      const result = await resend.emails.send({
        from: 'AutoFlow Support <support@autoflowdealer.com>',
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

/** Professional acknowledgment sent automatically the first time a new sender emails support@autoflowdealer.com. */
export const sendAutoReplyEmail = internalAction({
  args: {
    toEmail: v.string(),
    participantName: v.optional(v.string()),
    subject: v.string(),
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
        from: 'AutoFlow Support <support@autoflowdealer.com>',
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

export const sendTeamInvite = internalAction({
  args: {
    toEmail: v.string(),
    orgName: v.string(),
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
    const inviteUrl = `${appUrl}/sign-up`;

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
