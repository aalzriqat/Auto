"use client";

import { usePathname } from "next/navigation";
import { useOrg } from "@/components/providers/OrgProvider";
import { useOrgCurrencyState } from "@/hooks/useOrgCurrencyState";
import { CurrencyNotConfiguredPanel } from "@/components/layout/RequireOrgCurrency";

/**
 * First path segments (after the org id) whose screens show or record money. On
 * these, an organization with no stored currency gets the "currency not
 * configured" panel instead of the screen (SCRUM-85, owner ruling SCRUM-760
 * c23812 ruling 9). Every other screen (settings, team, tasks, messages...)
 * renders as before, and the backend refuses the money mutations either way.
 */
const MONEY_SEGMENTS: ReadonlySet<string> = new Set([
  "dashboard", "accounting", "sales", "deals", "applications", "expenses",
  "payroll", "reports", "approvals", "commissions", "vehicles", "leads", "customers", "sourcing",
]);

export function isMoneyRoute(pathname: string | null, orgId: string | null): boolean {
  if (!pathname || !orgId) return false;
  const [, first, second] = pathname.split("/");
  if (first !== orgId) return false;
  return second !== undefined && MONEY_SEGMENTS.has(second);
}

export function CurrencyGate({ children }: { children: React.ReactNode }) {
  const { activeOrgId } = useOrg();
  const pathname = usePathname();
  const state = useOrgCurrencyState();

  if (state.status !== "unconfigured" || !isMoneyRoute(pathname, activeOrgId)) {
    return <>{children}</>;
  }

  return <CurrencyNotConfiguredPanel />;
}
