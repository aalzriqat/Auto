"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { errorMessage } from "../AccountingTabShared";
import type { Translate } from "./types";

type SystemAccountConflictsPanelProps = {
  orgId: Id<"organizations">;
  canManageFinance: boolean;
  t: Translate;
};

/**
 * A chart self-heal used to silently adopt an org's own custom account onto a
 * reserved system-account code whenever the shape matched (type/normalBalance)
 * — changing what that account means without anyone deciding to, and never
 * confirming its existing balance/purpose. It now blocks posting on that
 * system key (chartOfAccounts.ts:ensureSystemAccount) until an owner/finance
 * user explicitly resolves it here. The list is computed live, not stored —
 * see findSystemAccountAdoptionCandidate's comment for why.
 */
export function SystemAccountConflictsPanel({ orgId, canManageFinance, t }: Readonly<SystemAccountConflictsPanelProps>) {
  const conflicts = useQuery(api.chartOfAccounts.listSystemAccountAdoptionRequests, { orgId });
  const resolve = useMutation(api.chartOfAccounts.confirmSystemAccountAdoption);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (!conflicts || conflicts.length === 0) return null;

  async function handleResolve(systemKey: string, decision: "ADOPT" | "REJECT") {
    setBusyKey(systemKey);
    try {
      await resolve({ orgId, systemKey, decision });
      toast.success(decision === "ADOPT" ? t("SystemAccountAdopted") : t("SystemAccountAdoptionRejected"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-slate-900">{t("SystemAccountConflicts")}</h3>
      <div className="space-y-2">
        {conflicts.map((conflict) => (
          <div
            key={conflict.systemKey}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-3"
          >
            <div className="flex items-start gap-2 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>
                {t("SystemAccountConflictDesc")
                  .replace("{code}", conflict.code)
                  .replace("{systemKey}", conflict.systemKey)
                  .replace("{accountName}", conflict.candidateAccount.name)}
              </span>
            </div>
            {canManageFinance && (
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyKey === conflict.systemKey}
                  onClick={() => handleResolve(conflict.systemKey, "REJECT")}
                >
                  {t("Reject")}
                </Button>
                <Button
                  size="sm"
                  disabled={busyKey === conflict.systemKey}
                  onClick={() => handleResolve(conflict.systemKey, "ADOPT")}
                >
                  {t("Adopt")}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
