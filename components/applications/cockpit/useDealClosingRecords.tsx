import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { scaleForCurrency } from "@/components/accounting/AccountingTabShared";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage, getLocalizedErrorMessage } from "@/lib/errors";
import { RecordLegalInvoiceDialog } from "./RecordLegalInvoiceDialog";
import { ResolveReconciliationDialog } from "./ResolveReconciliationDialog";
import {
  legalInvoiceReflected,
  reconciliationReflected,
  type useRecordedFeedback,
} from "./recordedFeedback";

export function useDealClosingRecords({
  orgId,
  applicationId,
  applicationStatus,
  hasFinalizedSale,
  canConfirmFinanceDisbursement,
  dealCosts,
  economicsStamp,
  orgCurrencyCode,
  isConsignedDeal,
  reconciliationRequired,
  reconciliationReason,
  trackRecorded,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  applicationStatus?: string;
  hasFinalizedSale: boolean;
  canConfirmFinanceDisbursement: boolean;
  dealCosts?: FunctionReturnType<typeof api.financeDealCosts.listDealCosts>;
  economicsStamp?: string;
  orgCurrencyCode: string;
  isConsignedDeal: boolean;
  reconciliationRequired: boolean;
  reconciliationReason?: string | null;
  trackRecorded: ReturnType<typeof useRecordedFeedback>["track"];
  t: (key: string) => string;
}>) {
  const resolveFinancingReconciliation = useMutation(
    api.financingEconomics.resolveFinancingReconciliation,
  );
  const recordLegalInvoice = useMutation(
    api.financeDealCosts.recordLegalInvoice,
  );

  const [recordingLegalInvoice, setRecordingLegalInvoice] = useState(false);
  const [invoiceCorrectionVersion, setInvoiceCorrectionVersion] = useState<{
    expectedEconomicsStamp?: string;
    expectedInvoiceRevision?: number;
  }>({});
  const [legalInvoiceSubmitting, setLegalInvoiceSubmitting] = useState(false);
  const [legalInvoiceError, setLegalInvoiceError] = useState<string | null>(
    null,
  );

  const [resolvingReconciliation, setResolvingReconciliation] = useState(false);
  const [reconciliationSubmitting, setReconciliationSubmitting] =
    useState(false);
  const [reconciliationError, setReconciliationError] = useState<string | null>(
    null,
  );

  // The accounting tier can correct the optional invoice while the deal's
  // economics are still open. Both entry points use the same server verdict.
  const legalInvoice =
    dealCosts && canConfirmFinanceDisbursement
      ? {
          recorded: dealCosts.legalInvoiceAmountMinor === undefined
            ? undefined
            : {
                amountMinor: dealCosts.legalInvoiceAmountMinor,
                number: dealCosts.legalInvoiceNumber,
                date: dealCosts.legalInvoiceDate,
                issuedTo: dealCosts.legalInvoiceIssuedTo,
              },
          onRecord:
            dealCosts.economicsFrozen?.frozen ||
            applicationStatus === "CLOSED" ||
            applicationStatus === "CANCELLED" ||
            applicationStatus === "REJECTED" ||
            hasFinalizedSale
              ? undefined
              : () => {
                  setLegalInvoiceError(null);
                  setInvoiceCorrectionVersion({
                    expectedEconomicsStamp: economicsStamp,
                    expectedInvoiceRevision: dealCosts.legalInvoiceRevision,
                  });
                  setRecordingLegalInvoice(true);
                },
        }
      : undefined;

  function openReconciliation() {
    setReconciliationError(null);
    setResolvingReconciliation(true);
  }

  const dialogs = (
    <>
      {reconciliationRequired && (
        <ResolveReconciliationDialog
          open={resolvingReconciliation}
          submitting={reconciliationSubmitting}
          error={reconciliationError}
          reason={reconciliationReason ?? null}
          t={t}
          onOpenChange={setResolvingReconciliation}
          onSubmit={async ({ note }) => {
            setReconciliationSubmitting(true);
            setReconciliationError(null);
            try {
              await trackRecorded(
                () =>
                  resolveFinancingReconciliation({
                    orgId,
                    applicationId,
                    note,
                  }),
                "ReconciliationResolved",
                { reflectedWhen: reconciliationReflected },
              );
              setResolvingReconciliation(false);
            } catch (error) {
              // "Record what was checked", "not flagged" — each names what to
              // change, so it stays in the form that earned it.
              const message = getErrorMessage(error);
              setReconciliationError(message);
              toast.error(message);
            } finally {
              setReconciliationSubmitting(false);
            }
          }}
        />
      )}
      {recordingLegalInvoice && (
        <RecordLegalInvoiceDialog
          open={recordingLegalInvoice}
          submitting={legalInvoiceSubmitting}
          error={legalInvoiceError}
          scale={scaleForCurrency(dealCosts?.currency ?? orgCurrencyCode)}
          currency={dealCosts?.currency ?? orgCurrencyCode}
          vehicleIsConsigned={isConsignedDeal}
          existing={
            dealCosts?.legalInvoiceAmountMinor !== undefined
              ? {
                  amountMinor: dealCosts.legalInvoiceAmountMinor,
                  number: dealCosts.legalInvoiceNumber,
                  date: dealCosts.legalInvoiceDate,
                  issuedTo: dealCosts.legalInvoiceIssuedTo,
                  issuedToOther: dealCosts.legalInvoiceIssuedToOther,
                  issuedBy: dealCosts.legalInvoiceIssuedBy,
                  issuerName: dealCosts.legalInvoiceIssuerName,
                }
              : undefined
          }
          t={t}
          onOpenChange={setRecordingLegalInvoice}
          onSubmit={async (values) => {
            setLegalInvoiceSubmitting(true);
            setLegalInvoiceError(null);
            try {
              await trackRecorded(
                () =>
                  recordLegalInvoice({
                    orgId,
                    applicationId,
                    legalInvoiceAmountMinor: values.legalInvoiceAmountMinor,
                    legalInvoiceNumber: values.legalInvoiceNumber,
                    legalInvoiceDate: values.legalInvoiceDate,
                    issuedTo: values.issuedTo,
                    issuedToOther: values.issuedToOther,
                    issuedBy: values.issuedBy,
                    issuerName: values.issuerName,
                    expectedEconomicsStamp:
                      invoiceCorrectionVersion.expectedEconomicsStamp,
                    expectedInvoiceRevision:
                      invoiceCorrectionVersion.expectedInvoiceRevision,
                  }),
                "LegalInvoiceRecorded",
                {
                  reflectedWhen: legalInvoiceReflected({
                    number: values.legalInvoiceNumber,
                    amountMinor: values.legalInvoiceAmountMinor,
                    date: values.legalInvoiceDate,
                    issuedTo: values.issuedTo,
                    issuerName: values.issuerName,
                  }),
                },
              );
              setRecordingLegalInvoice(false);
            } catch (err) {
              setLegalInvoiceError(getLocalizedErrorMessage(err, t));
            } finally {
              setLegalInvoiceSubmitting(false);
            }
          }}
        />
      )}
    </>
  );

  return { legalInvoice, openReconciliation, dialogs };
}
