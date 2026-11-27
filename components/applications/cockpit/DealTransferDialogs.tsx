import { ForwardCorrectionDialog } from "../ForwardCorrectionDialog";
import { ChequeReturnedByBankDialog } from "../ChequeReturnedByBankDialog";
import { DisbursementConfirmationDialog } from "../DisbursementConfirmationDialog";
import { RecordForwardToFinanceCompanyDialog } from "../RecordForwardToFinanceCompanyDialog";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";

export function DealTransferCorrections({
  forwardCorrection,
  chequeReturn,
  t,
}: Pick<DealCockpitViewProps, "forwardCorrection" | "chequeReturn"> & {
  t: (key: string) => string;
}) {
  return (
    <>
    {forwardCorrection && (
      <ForwardCorrectionDialog
        open={forwardCorrection.open !== null}
        kind={forwardCorrection.open ?? "RETURNED"}
        submitting={forwardCorrection.submitting}
        t={t}
        onOpenChange={(next) => {
          if (!next) forwardCorrection.onClose();
        }}
        onConfirm={forwardCorrection.onConfirm}
      />
    )}
    {chequeReturn && (
      <ChequeReturnedByBankDialog
        open={chequeReturn.open}
        submitting={chequeReturn.submitting}
        t={t}
        onOpenChange={(next) => {
          if (!next) chequeReturn.onClose();
        }}
        onConfirm={chequeReturn.onConfirm}
      />
    )}
    </>
  );
}

export function DealTransferConfirmations({
  disbursement,
  t,
}: Pick<DealCockpitViewProps, "disbursement"> & {
  t: (key: string) => string;
}) {
  return (
    <>
    {/* Both mounted without their own trigger: the DISBURSEMENT focus row
        owns the action, and which of the two it opens follows the recorded
        route. Confirming the dealership's receipt posts DR Bank; recording
        the supplier's advice moves no dealership money. */}
    {disbursement && (
      <>
        {disbursement.forward && (
          <RecordForwardToFinanceCompanyDialog
            open={disbursement.forward.confirming}
            submitting={disbursement.forward.submitting}
            dueMinor={disbursement.forward.dueMinor}
            totalLabel={disbursement.forward.totalLabel}
            depositLabel={disbursement.forward.depositLabel}
            excessLabel={disbursement.forward.excessLabel}
            contributionLabel={disbursement.forward.contributionLabel}
            bankOptions={disbursement.forward.bankOptions}
            t={t}
            onOpenChange={disbursement.forward.onOpenChange}
            onConfirm={disbursement.forward.onConfirm}
          />
        )}
        <DisbursementConfirmationDialog
          open={disbursement.financeCompany.confirming}
          withTrigger={false}
          disabled={disbursement.financeCompany.submitting}
          submitting={disbursement.financeCompany.submitting}
          amountLabel={disbursement.financeCompany.amountLabel}
          bank={disbursement.financeCompany.bank}
          t={t}
          onOpenChange={disbursement.financeCompany.onOpenChange}
          onConfirm={disbursement.financeCompany.onConfirm}
        />
        <DisbursementConfirmationDialog
          mode="SUPPLIER"
          open={disbursement.supplier.confirming}
          withTrigger={false}
          disabled={disbursement.supplier.submitting}
          submitting={disbursement.supplier.submitting}
          supplierName={disbursement.supplier.supplierName}
          amountLabel={disbursement.supplier.amountLabel}
          defaultAmountMajor={disbursement.supplier.defaultAmountMajor}
          t={t}
          onOpenChange={disbursement.supplier.onOpenChange}
          onConfirm={() => undefined}
          onConfirmSupplier={disbursement.supplier.onConfirm}
        />
      </>
    )}
    </>
  );
}
