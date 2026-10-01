/**
 * SCRUM-447 D4 — a sale that belongs to a financed deal is cancelled from the
 * deal screen (which resolves its finance-company cheque), never from the sales
 * list. The server refuses the cancel too; this decides what the phone shows
 * INSTEAD of the Cancel button.
 */
export type FinancedDealCancelTarget =
  | { kind: "link"; url: string; reference: string }
  | { kind: "text"; reference: string };

/**
 * `appUrl` is the configured web origin (`getMobileAppUrl()`), already
 * validated as http(s) or undefined. Without it there is no honest link to
 * offer, so the phone names where to go instead.
 */
export function financedDealCancelTarget(
  sale: { applicationId?: string | null; status: string },
  orgId: string,
  appUrl: string | undefined
): FinancedDealCancelTarget | null {
  if (!sale.applicationId || sale.status === "CANCELLED") return null;
  const reference = sale.applicationId;
  if (!appUrl) return { kind: "text", reference };
  const base = appUrl.replace(/\/+$/, "");
  return {
    kind: "link",
    url: `${base}/${encodeURIComponent(orgId)}/applications/${encodeURIComponent(sale.applicationId)}/deal`,
    reference,
  };
}
