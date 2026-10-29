"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { Coins } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useCurrency } from "@/hooks/useCurrency";

/** The "currency not configured" panel: what a money screen shows instead of a number (SCRUM-85). */
export function CurrencyNotConfiguredPanel() {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const membership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const isOwner = membership?.isSystemOwnerRole === true;

  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl border bg-card p-8 text-center"
    >
      <Coins className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-lg font-semibold">{t("CurrencyNotConfigured")}</h1>
      <p className="text-sm text-muted-foreground">{t("ServerError_CURRENCY_NOT_CONFIGURED")}</p>
      {isOwner ? (
        <Link
          href={`/${activeOrgId}/settings/general`}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          {t("CurrencyNotConfiguredChoose")}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Renders its children only once the organization's stored currency is known. A
 * screen under this wrapper may pass `useCurrency().code` through
 * `requireStoredCurrencyCode` and rely on a real ISO code: while the code is loading nothing is shown, and an organization with
 * none sees the "currency not configured" panel, never a defaulted number.
 */
export function RequireOrgCurrency({ children }: Readonly<{ children: React.ReactNode }>) {
  const { code, status } = useCurrency();
  if (code !== null) return <>{children}</>;
  if (status === "unconfigured") return <CurrencyNotConfiguredPanel />;
  return null;
}
