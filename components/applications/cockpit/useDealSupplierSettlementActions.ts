import { useRef } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { scaleForCurrency } from "@/components/accounting/AccountingTabShared";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage } from "@/lib/errors";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import type {
  DirectRouteRefusal,
  SupplierSettlementRoute,
} from "./SettlementRouteControl";

export function useDealSupplierSettlementActions({
  orgId,
  applicationId,
  deal,
  app,
  supplierName,
  canChooseSettlementRoute,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  deal:
    | FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
    | undefined;
  app: FunctionReturnType<typeof api.applications.get> | undefined;
  supplierName?: string;
  canChooseSettlementRoute: boolean;
}>) {
  const amendAdvice = useMutation(
    api.applications.amendSupplierDisbursementAdvice,
  );
  const setSupplierSettlementRoute = useMutation(
    api.applications.setSupplierSettlementRoute,
  );
  // One key per correction attempt, so a retry after a lost response is the same
  // amendment rather than a second audited one.
  const correctionKeyRef = useRef<string | null>(null);
  const settlementRoute: DealCockpitViewProps["settlementRoute"] =
    canChooseSettlementRoute && app
      ? {
          route: app.supplierSettlementRoute as
            | SupplierSettlementRoute
            | undefined,
          canSettleDirectToSupplier: app.canSettleDirectToSupplier,
          directRouteRefusal: app.directRouteRefusal as DirectRouteRefusal,
          supplierName,
          onChoose: async (route) => {
            try {
              await setSupplierSettlementRoute({ orgId, applicationId, route });
            } catch (error) {
              // No finance company, or a held deposit that has to be
              // settled first — both name what to do next.
              toast.error(getErrorMessage(error));
            }
          },
        }
      : undefined;

  const correctAdvice: NonNullable<
    DealCockpitViewProps["onCorrectSettlementAdvice"]
  > = async (correction) => {
    correctionKeyRef.current ??= `amend-supplier-advice:${crypto.randomUUID()}`;
    await amendAdvice({
      orgId,
      applicationId,
      // Scaled by the currency the SERVER pinned on this discrepancy, which
      // is the application's `economicsCurrency` — not the org's. The whole
      // reason this deal is flagged is a disagreement about an amount, and
      // rescaling it on the way in would manufacture a second one.
      disbursedAmountMinor: Math.round(
        correction.amountMajor *
          Math.pow(
            10,
            scaleForCurrency(
              deal?.settlementAdviceDiscrepancy?.currency ??
                deal?.money?.currency ??
                "JOD",
            ),
          ),
      ),
      reference: correction.reference,
      // Distinct from omitting it. An emptied field used to arrive as
      // `undefined`, identical to "not part of this correction", so the
      // wrong cheque number survived a correction that reported success.
      clearReference: correction.clearReference,
      disbursedAt: correction.disbursedAt,
      reason: correction.reason,
      idempotencyKey: correctionKeyRef.current,
    });
    correctionKeyRef.current = null;
  };
  return { settlementRoute, correctAdvice };
}

export function useRecordDealSupplierReceipt(orgId: Id<"organizations">) {
  const recordReceipt = useMutation(api.supplierReceivables.recordReceipt);
  const onRecord: NonNullable<
    DealCockpitViewProps["onRecordSupplierReceipt"]
  > = async (receivableId, receipt) => {
    await recordReceipt({
      orgId,
      receivableId,
      amount: receipt.amount,
      receiptMethod: receipt.receiptMethod,
      ...(receipt.bankAccountId
        ? { bankAccountId: receipt.bankAccountId }
        : {}),
      receiptReference: receipt.receiptReference,
      receivedAt: receipt.receivedAt,
      idempotencyKey: receipt.idempotencyKey,
    });
  };
  return onRecord;
}
