"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function CashNoCostCloseout({ orgId, applicationId, t }: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  t: (key: string) => string;
}>) {
  const closeout = useQuery(api.cashDealCloseout.getNoCostCloseout, { orgId, applicationId });
  const declareNoCosts = useMutation(api.cashDealCloseout.declareNoCosts);
  const confirmNoCosts = useMutation(api.cashDealCloseout.confirmNoCosts);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!closeout) return null;

  const { canDeclare, state } = closeout;
  const confirmVersion = "confirmVersion" in closeout ? closeout.confirmVersion : undefined;
  const pending = state === "AWAITING_APPROVAL";
  async function submit(expectedVersion?: number) {
    setSubmitting(true);
    setFailed(false);
    try {
      if (canDeclare) await declareNoCosts({ orgId, applicationId });
      else if (expectedVersion !== undefined) {
        await confirmNoCosts({ orgId, applicationId, expectedVersion });
      }
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  }

  const hasVersion = typeof confirmVersion === "number" && Number.isSafeInteger(confirmVersion);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="font-medium">{t(pending ? "CashNoCostAwaitingApproval" : "CashNoCostNeedsDeclaration")}</p>
      {(canDeclare || hasVersion) && (
        <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={() => void submit(hasVersion ? confirmVersion : undefined)}>
          {t(canDeclare ? "CashNoCostDeclare" : "CashNoCostConfirm")}
        </Button>
      )}
      <p role="status" className={submitting ? "text-sm text-muted-foreground" : "sr-only"}>
        {submitting ? t("Saving") : null}
      </p>
      {failed && <p role="alert" className="text-destructive">{t("CashNoCostSaveFailed")}</p>}
    </div>
  );
}
