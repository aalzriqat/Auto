"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
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
      throw new Error(`Rate limit exceeded. Try again in ${Math.ceil(status.retryAfter / 1000)}s`);
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
      'PRODID:-//Bloom Cars CRM//Task Alarm//EN',
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

    const emailHtml = `
      <h1>Task Reminder: ${escapeHtml(args.taskTitle)}</h1>
      <p>This task is scheduled for ${new Date(args.dueDate).toLocaleString()}.</p>
      ${args.taskDescription ? `<p>Notes: ${escapeHtml(args.taskDescription)}</p>` : ''}
      <p>Please check your AutoFlow dashboard for details.</p>
    `;

    if (!resendApiKey) {
      console.log(`[MOCK EMAIL] To: ${args.toEmail} | Subject: Reminder - ${args.taskTitle}`);
      console.log(`[MOCK ICS]\n${icsString}`);
      return { success: true, mock: true };
    }

    const resend = new Resend(resendApiKey);

    try {
      await resend.emails.send({
        from: 'AutoFlow Tasks <onboarding@resend.dev>',
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
      console.error("Failed to send email via Resend:", error);
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
      throw new Error(`Rate limit exceeded. Try again in ${Math.ceil(status.retryAfter / 1000)}s`);
    }
    const env = getValidatedEnv();
    const resendApiKey = env.RESEND_API_KEY;

    // Build the invite URL from the environment
    const appUrl = env.NEXT_PUBLIC_APP_URL;
    const inviteUrl = `${appUrl}/sign-up`;

    const safeOrgName = escapeHtml(args.orgName);
    const emailHtml = `
      <h1>You've been invited to join ${safeOrgName}</h1>
      <p>Your team at ${safeOrgName} has invited you to join them on AutoFlow.</p>
      <p>Click the link below to sign up and join your team automatically:</p>
      <p><a href="${inviteUrl}">Accept Invitation &amp; Sign Up</a></p>
      <br />
      <p>If the link doesn't work, copy and paste this into your browser: ${inviteUrl}</p>
    `;

    if (!resendApiKey) {
      console.log(`[MOCK EMAIL] To: ${args.toEmail} | Subject: Join ${args.orgName}`);
      return { success: true, mock: true };
    }

    const resend = new Resend(resendApiKey);

    try {
      await resend.emails.send({
        from: 'AutoFlow Teams <onboarding@resend.dev>',
        to: args.toEmail,
        subject: `You're invited to join ${args.orgName} on AutoFlow`,
        html: emailHtml,
      });
      return { success: true, mock: false };
    } catch (error) {
      console.error("Failed to send invite email via Resend:", error);
      return { success: false, error: String(error) };
    }
  },
});
