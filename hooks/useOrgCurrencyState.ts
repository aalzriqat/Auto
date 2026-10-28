"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useOrgSettings } from "./useOrgSettings";

/**
 * The organization's currency as the owner stored it (SCRUM-85, owner ruling
 * SCRUM-760 c23812 ruling 9: currency code and scale are never defaulted).
 *
 *  - `loading`: the answer has not arrived, or the caller has no answer yet. A
 *    screen shows a skeleton, never a currency.
 *  - `unconfigured`: the organization chose no currency. A screen shows
 *    "currency not configured" instead of a number.
 *  - `configured`: the stored code (and symbol, when the owner stored one).
 *
 * The settings query is gated on `view:settings` and returns null for any other
 * member, which reads exactly like "no settings yet". When it gives no currency,
 * `orgSettings.getCurrencyStatus` (open to every member) decides between
 * "configured", "not configured" and "no answer yet" - so no member's screen falls
 * back to a guessed currency.
 */
export type OrgCurrencyState =
  | { status: "loading" }
  | { status: "unconfigured" }
  | { status: "configured"; code: string; symbol: string | null };

export function useOrgCurrencyState(): OrgCurrencyState {
  const { activeOrgId } = useOrg();
  const settings = useOrgSettings();
  const storedByProjection = typeof settings?.currency === "string" ? settings.currency.trim() : "";
  const status = useQuery(
    api.orgSettings.getCurrencyStatus,
    activeOrgId && storedByProjection === "" ? { orgId: activeOrgId } : "skip"
  );

  if (storedByProjection !== "") {
    const symbol = settings?.currencySymbol?.trim();
    return { status: "configured", code: storedByProjection, symbol: symbol ? symbol : null };
  }
  if (status === undefined || status === null) return { status: "loading" };
  if (!status.configured || status.currency === null) return { status: "unconfigured" };
  return { status: "configured", code: status.currency, symbol: status.currencySymbol };
}
