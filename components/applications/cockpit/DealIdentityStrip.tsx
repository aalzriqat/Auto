import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DealCockpitData } from "./DealStagePresentation";

/**
 * The record's full opaque id with a copy control (SCRUM-372). Shown whole so
 * an operator can quote it to support; long ids wrap rather than truncate.
 * A clipboard the browser refuses is not an error worth a toast — the id is
 * still on screen to select by hand.
 */
function CopyableReference({
  value,
  t,
  testId = "deal-reference-copy",
}: Readonly<{ value: string; t: (key: string) => string; testId?: string }>) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error(error);
    }
  };
  return (
    <>
      <bdi dir="ltr" className="min-w-0 break-all font-mono text-xs">
        {value}
      </bdi>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={copy}
        aria-label={t(copied ? "DealReferenceCopied" : "CopyDealReference")}
        data-testid={testId}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-profit-positive" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? t("DealReferenceCopied") : ""}
      </span>
    </>
  );
}

export function DealIdentityStrip({
  deal,
  dealNumberLabel,
  createdLabel,
  updatedLabel,
  placement,
  t,
}: Readonly<{
  deal: Pick<
    DealCockpitData,
    | "dealKind"
    | "dealRef"
    | "applicationId"
    | "customer"
    | "financeCompanyName"
    | "salespersonName"
  >;
  dealNumberLabel: string | null;
  createdLabel: string;
  updatedLabel: string;
  placement: "desktop" | "phone";
  t: (key: string) => string;
}>) {
  return (
    <dl
      className={cn(
        "grid-cols-2 gap-x-4 gap-y-3 rounded-lg border bg-card p-4 text-sm shadow-sm sm:gap-x-6 lg:grid-cols-5",
        placement === "desktop" ? "hidden md:grid" : "grid md:hidden",
      )}
      aria-label={t("DealEssentialsHeading")}
      data-testid={
        placement === "desktop" ? "deal-identity" : "deal-identity-mobile"
      }
    >
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{t("DealTypeLabel")}</dt>
        <dd className="font-medium">
          {t(deal.dealKind === "CASH" ? "DealKindCash" : "DealKindFinanced")}
        </dd>
      </div>
      {dealNumberLabel !== null && (
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">
            {t("DealNumberLabel")}
          </dt>
          <dd
            className="flex min-w-0 items-center gap-1 font-medium"
            data-testid="deal-number"
          >
            <CopyableReference
              value={dealNumberLabel}
              t={t}
              testId="deal-number-copy"
            />
          </dd>
        </div>
      )}
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">
          {t(
            deal.applicationId === null
              ? "DealReferenceSale"
              : "DealReferenceApplication",
          )}
        </dt>
        <dd className="flex min-w-0 items-center gap-1 font-medium">
          <CopyableReference value={String(deal.dealRef)} t={t} />
        </dd>
      </div>
      {deal.customer && (
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t("Customer")}</dt>
          <dd className="min-w-0 break-words font-medium">
            <bdi>{deal.customer.name}</bdi>
            {deal.customer.phone && (
              <>
                {" "}
                <bdi className="font-normal text-muted-foreground">
                  {deal.customer.phone}
                </bdi>
              </>
            )}
          </dd>
        </div>
      )}
      {deal.financeCompanyName && (
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">
            {t("PartyFinancier")}
          </dt>
          <dd className="min-w-0 break-words font-medium">
            <bdi>{deal.financeCompanyName}</bdi>
          </dd>
        </div>
      )}
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{t("DealOwner")}</dt>
        <dd className="min-w-0 break-words font-medium">
          <bdi>{deal.salespersonName}</bdi>{" "}
          <bdi className="font-normal text-muted-foreground">
            {createdLabel}
          </bdi>
        </dd>
      </div>
      {/* The header's "last updated", in the flow on a phone only. */}
      <div
        className="min-w-0 sm:hidden"
        data-testid="deal-essentials-last-updated"
      >
        <dt className="text-xs text-muted-foreground">{t("LastUpdated")}</dt>
        <dd className="font-medium">
          <bdi>{updatedLabel}</bdi>
        </dd>
      </div>
    </dl>
  );
}
