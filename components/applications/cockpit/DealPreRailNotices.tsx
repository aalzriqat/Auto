import type { ComponentProps } from "react";
import { DealPendingDepositRequests } from "@/components/deposits/DepositRequests";
import { DealSettlementAdviceNotice } from "./DealSettlementAdviceNotice";
import { StoppedDealDepositsPanel } from "./StoppedDealDepositsPanel";
import { FcChequePanel } from "./FcChequePanel";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import type { DealCockpitData } from "./DealStagePresentation";

export function DealPreRailNotices({
  deal,
  advice,
  depositRequests,
  depositAwaitingResolution,
  deposits,
  orgId,
  formatDepositAmount,
  fcCheque,
  canCorrectAdvice,
  canRegisterPayment,
  onRegisterCheque,
  t,
}: Pick<DealCockpitViewProps, "depositRequests" | "depositAwaitingResolution" | "deposits" | "orgId" | "fcCheque"> &
  Readonly<{
    deal: DealCockpitData;
    advice: Omit<ComponentProps<typeof DealSettlementAdviceNotice>, "t"> | undefined;
    formatDepositAmount: (amount: number) => string;
    canCorrectAdvice: boolean;
    canRegisterPayment: boolean;
    onRegisterCheque: () => void;
    t: (key: string) => string;
  }>) {
  return (
    <>
      {/* --- the two records that disagree -------------------------------- */}
      {/* Above the stage rail, not inside the money column. The rail tells the
          deal's normal story; this is the exception that has stopped it, so it
          has to be the first thing read.
          The WARNING is ungated — a deal stuck in reconciliation that only the
          accountant can see is not a warning. The FIGURES inside it are gated,
          and the SERVER decides: `settlementAdviceDiscrepancy` arrives `null`
          for a caller without `view:finance`, so this renders the alert and its
          explanation with no amounts under it. Nothing here re-derives the
          permission, which is why the two cannot drift apart. */}
      {advice && <DealSettlementAdviceNotice {...advice} t={t} />}

      {/* --- held customer deposit on a stopped deal ----------------------
          Above the rail on purpose. On a rejected or cancelled deal the rail
          has nothing left to say — every stage is STOPPED — while the one thing
          still outstanding is real customer cash sitting in a liability with
          nobody's name on it. A single bordered strip rather than a card: at
          this density an alert earns its weight from colour and position. */}
      {depositRequests && depositRequests.requests.length > 0 && (
        <DealPendingDepositRequests
          orgId={depositRequests.orgId}
          requests={depositRequests.requests}
        />
      )}

      {(depositAwaitingResolution || deposits) && (
        <div
          className={
            depositAwaitingResolution
              ? "space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/30"
              : "space-y-3 rounded-md border bg-muted/30 px-3 py-2"
          }
          data-testid={depositAwaitingResolution ? "deal-deposit-awaiting-resolution" : "deal-deposits-resolved"}
        >
          {depositAwaitingResolution && (
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t("DepositAwaitingResolutionTitle")}
              </p>
              <p className="text-sm text-amber-800 dark:text-amber-300">
                {t("DepositAwaitingResolutionBody")}
              </p>
            </div>
          )}
          {/* The deposits themselves, and the decision on each HELD one — the
              action the applications list has been pointing at Review for.
              The amounts are the org-currency majors `applications.get`
              lists, formatted the way that dialog formatted them. */}
          {deposits && (
            <StoppedDealDepositsPanel
              orgId={orgId}
              deposits={deposits.items}
              canResolve={deposits.canResolve}
              faceValueIsReleasable={deposits.faceValueIsReleasable}
              resolvingId={deposits.resolvingId}
              formatAmount={formatDepositAmount}
              t={t}
              onResolve={deposits.onResolve}
              unconfirmed={deposits.unconfirmed}
              onDismissUnconfirmed={deposits.onDismissUnconfirmed}
            />
          )}
        </div>
      )}

      {/* --- finance-company cheque: face, correction, re-registration ------
          Workflow flags only (no amounts) from the server. Above the rail for
          the same reason the discrepancy alert is: it is the exception that
          stops the disbursement stage. */}
      {fcCheque && "chequePaymentRegistered" in deal && (
        <FcChequePanel
          canManage={canCorrectAdvice}
          canRegisterPayment={canRegisterPayment}
          needsCorrection={deal.chequeNeedsCorrection === true}
          needsAccountingReview={deal.chequeNeedsAccountingReview === true}
          chequeFaceAttested={deal.chequeFaceAttested === true}
          chequeFaceUnrecorded={deal.chequeFaceUnrecorded}
          unattestedChequeId={deal.unattestedChequeId ?? null}
          expectedPaymentCorrectable={deal.expectedPaymentCorrectable}
          chequePaymentRegistered={deal.chequePaymentRegistered}
          needsReRegistration={deal.expectedPaymentReRegistrable}
          t={t}
          onAttest={fcCheque.onAttest}
          onCorrect={fcCheque.onCorrect}
          onRegister={onRegisterCheque}
        />
      )}
    </>
  );
}
