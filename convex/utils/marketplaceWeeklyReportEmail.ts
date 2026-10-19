import { emailButton, escapeHtml, wrapEmailHtml } from "./emailHtml";

/** The report fields a dealer sees, and the names a figure can be flagged under. */
export type WeeklyReportField =
  | "pageViews"
  | "vehicleDetailViews"
  | "requestsMatched"
  | "responsesSent"
  | "avgResponseMinutes"
  | "mostViewedVehicle"
  | "requestsLost";

export type WeeklyReportEmailInput = {
  orgName: string;
  appUrl: string;
  pageViews: number;
  vehicleDetailViews: number;
  requestsMatched: number;
  responsesSent: number;
  avgResponseMinutes: number | null;
  mostViewedVehicle: { make: string; model: string; year: number; views: number } | null;
  requestsLost: number;
  /** Plain counts whose read hit its cap: shown as "at least N", never as exact. */
  lowerBound?: readonly string[];
  /** Figures that cannot be trusted when a read they depend on was capped: shown as unavailable. */
  unavailable?: readonly string[];
};

export const WEEKLY_REPORT_FROM = "AutoFlow Marketplace <marketplace@autoflowdealer.com>";

/**
 * Pure: the complete weekly-report envelope (sender, subject, html) from
 * frozen inputs. Freezing it before the first send means a retry — or a
 * template deploy between attempts — cannot change what the provider sees for
 * the same idempotency key. With no flags the output is exactly what the
 * emailed report has always looked like.
 */
export function renderMarketplaceWeeklyReportEmail(input: WeeklyReportEmailInput): {
  from: string;
  subject: string;
  html: string;
} {
  const lowerBound = new Set(input.lowerBound ?? []);
  const unavailable = new Set(input.unavailable ?? []);
  const count = (field: WeeklyReportField, value: number): string => {
    if (unavailable.has(field)) return "Unavailable";
    return lowerBound.has(field) ? `At least ${value}` : String(value);
  };
  const countInSentence = (field: WeeklyReportField, value: number): string =>
    lowerBound.has(field) ? `at least ${value}` : String(value);

  const safeOrgName = escapeHtml(input.orgName);
  const subject = `Your AutoFlow Marketplace week: ${countInSentence("requestsMatched", input.requestsMatched)} matched request${input.requestsMatched === 1 ? "" : "s"}, ${countInSentence("responsesSent", input.responsesSent)} repl${input.responsesSent === 1 ? "y" : "ies"}`;
  const preheader = `${countInSentence("pageViews", input.pageViews)} dealer-site views, ${countInSentence("requestsMatched", input.requestsMatched)} matched buyer requests this week.`;

  const statRow = (label: string, value: string) =>
    `<tr><td style="padding:6px 0; color:#6b7280;">${label}</td><td style="padding:6px 0; text-align:right; font-weight:600; color:#111827;">${value}</td></tr>`;

  const avgResponse = unavailable.has("avgResponseMinutes")
    ? "Unavailable"
    : input.avgResponseMinutes != null
      ? `${Math.round(input.avgResponseMinutes)} min`
      : "—";

  const rows = [
    statRow("Dealer-site page views", count("pageViews", input.pageViews)),
    statRow("Vehicle detail views", count("vehicleDetailViews", input.vehicleDetailViews)),
    statRow("Buyer requests matched to you", count("requestsMatched", input.requestsMatched)),
    statRow("Responses you sent", count("responsesSent", input.responsesSent)),
    statRow("Avg. response time", avgResponse),
    statRow("Requests lost to no response", count("requestsLost", input.requestsLost)),
  ].join("");

  let mostViewedHtml = "";
  if (unavailable.has("mostViewedVehicle")) {
    mostViewedHtml = `<p style="margin:20px 0 0; font-size:13px; color:#6b7280;">Most-viewed vehicle: <strong style="color:#111827;">Unavailable</strong> (too much activity this week to rank reliably)</p>`;
  } else if (input.mostViewedVehicle) {
    const vehicleLabel = `${input.mostViewedVehicle.year} ${input.mostViewedVehicle.make} ${input.mostViewedVehicle.model}`;
    mostViewedHtml = `<p style="margin:20px 0 0; font-size:13px; color:#6b7280;">Most-viewed vehicle: <strong style="color:#111827;">${escapeHtml(vehicleLabel)}</strong> (${input.mostViewedVehicle.views} views)</p>`;
  }

  const bodyHtml = `
      <h1 style="margin:0 0 16px; font-size:20px; font-weight:700; color:#111827;">Your Marketplace week</h1>
      <p style="margin:0 0 16px;">Hi ${safeOrgName},</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">${rows}</table>
      ${mostViewedHtml}
      ${emailButton(`${input.appUrl}/marketplace/requests`, "View your requests")}
    `;

  return { from: WEEKLY_REPORT_FROM, subject, html: wrapEmailHtml(preheader, bodyHtml) };
}
