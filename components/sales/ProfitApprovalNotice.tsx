"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { CheckCircle2, Clock, ShieldAlert } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";

/**
 * SCRUM-260: the minimum-profit approval for one vehicle at one price, read
 * from the same server verdict `completeSale` enforces. `blocked` is true while
 * a completion at this price would be refused — including while the verdict is
 * still loading, so a completion control never flickers enabled.
 */
export function useProfitApproval(args: {
  orgId: Id<"organizations"> | null | undefined;
  vehicleId: Id<"vehicles"> | null | undefined;
  salePrice: number;
  /** False for cash sales and anything else the rule does not cover. */
  enabled: boolean;
}) {
  const active = args.enabled && !!args.orgId && !!args.vehicleId && args.salePrice > 0;
  const verdict = useQuery(
    api.approvals.profitApprovalStatus,
    active
      ? { orgId: args.orgId as Id<"organizations">, vehicleId: args.vehicleId as Id<"vehicles">, salePrice: args.salePrice }
      : "skip"
  );
  const needsApproval =
    verdict?.status === "REQUIRED" || verdict?.status === "PENDING" || verdict?.status === "REJECTED";
  return {
    verdict: active ? verdict : undefined,
    blocked: active && (verdict === undefined || needsApproval),
  };
}

export function ProfitApprovalNotice({
  orgId,
  vehicleId,
  salePrice,
  verdict,
}: {
  orgId: Id<"organizations">;
  vehicleId: Id<"vehicles">;
  salePrice: number;
  verdict: ReturnType<typeof useProfitApproval>["verdict"];
}) {
  const { t } = useLanguage();
  const currency = useCurrency();
  const requestApproval = useMutation(api.approvals.requestProfitApproval);
  const [isRequesting, setIsRequesting] = useState(false);

  if (!verdict || verdict.status === "NOT_REQUIRED" || verdict.status === "INVALID") return null;

  if (verdict.status === "APPROVED") {
    return (
      <p
        role="status"
        className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-700 dark:text-emerald-400"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t("ProfitApprovalApproved" as any)}
      </p>
    );
  }

  const handleRequest = async () => {
    setIsRequesting(true);
    try {
      await requestApproval({ orgId, vehicleId, salePrice });
    } catch (error) {
      console.error("requestProfitApproval failed", error);
      toast.error(
        error instanceof ConvexError && typeof error.data === "string"
          ? error.data
          : t("ProfitApprovalRequestFailed" as any)
      );
    } finally {
      setIsRequesting(false);
    }
  };

  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-700 dark:text-red-400"
    >
      <p className="flex items-center gap-2 font-semibold">
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t("ProfitApprovalRequiredTitle" as any)}
      </p>
      <p className="leading-relaxed">
        {t("ProfitApprovalRequiredBody" as any)
          .replace("{margin}", currency.format(verdict.margin))
          .replace("{minimum}", currency.format(verdict.minimumProfit))}
      </p>
      {verdict.status === "PENDING" ? (
        <p className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
          <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t("ProfitApprovalPending" as any)}
        </p>
      ) : (
        <>
          {verdict.status === "REJECTED" ? <p className="font-medium">{t("ProfitApprovalRejected" as any)}</p> : null}
          <Button type="button" variant="destructive" size="sm" onClick={handleRequest} disabled={isRequesting}>
            {isRequesting ? t("ProfitApprovalRequesting" as any) : t("ProfitApprovalRequestAction" as any)}
          </Button>
        </>
      )}
    </div>
  );
}
