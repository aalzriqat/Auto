/**
 * HTML building blocks shared by the transactional email senders.
 *
 * Lives outside `convex/email.ts` because that file is a `"use node"` module:
 * a mutation (which cannot run in the Node runtime) that needs to render an
 * email cannot import from it. Behaviour is unchanged from when these were
 * local to `email.ts`.
 */

/** Escape user input before interpolating into HTML to prevent XSS/injection. */
export function escapeHtml(s: string): string {
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
export function wrapEmailHtml(preheader: string, bodyHtml: string): string {
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
export function emailButton(url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block; background-color:#0f172a; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-size:14px; font-weight:600;">${label}</a>`;
}
