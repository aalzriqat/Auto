"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * What the finance company told the dealership, and what that leaves.
 *
 * The two figures at the top are FACTS FROM OUTSIDE — the quotation the
 * dealership sent, and the amount the company answered with. Everything under
 * the separator is arithmetic the backend already did on them, rendered
 * read-only: the funding split, the unfinanced portion and the dealership's own
 * contribution have exactly one author, `recomputeAndPatchEconomics`, and an
 * editable copy of any of them would be a second one.
 *
 * It lives beside the stage rail rather than inside the money panel, and that
 * placement is load-bearing. The money panel is gated on `view:finance`, which
 * the default MANAGER template does not hold — while `approve:finance_application`
 * is exactly MANAGER's. Putting the recorder in the money panel would have
 * hidden it from the only role allowed to use it, which is the same dead end
 * SCRUM-68 exists to remove, moved somewhere less obvious.
 */
export type FinanceDecisionFacts = {
  /**
   * Whether the approved amount is ON THE RECORD.
   *
   * Read from the stage rail, which the SERVER derives from the unredacted row
   * — never inferred from `approvedPurchaseAmountMinor` being null. That field
   * is also null when `redactSettlementEvidence` withheld it, and a screen that
   * conflated the two would tell an operator no amount was recorded on a deal
   * that has one, and offer to record it again.
   */
  approvedPurchaseRecorded: boolean;
  submittedQuotationMinor: number | null;
  /** Null when not recorded OR not visible to this caller — see above. */
  approvedPurchaseAmountMinor: number | null;
  financeCompanyFundedPortionMinor: number | null;
  unfinancedPortionMinor: number | null;
  dealerContributionMinor: number | null;
  appliedLtvPercent: number | null;
  /** CLOSED or CANCELLED: both writers refuse, so neither action is offered. */
  closed: boolean;
};

type FinanceCompanyDecisionCardProps = {
  facts: FinanceDecisionFacts;
  /** `create:finance_application` — the quotation writer's own permission. */
  canRecordQuotation: boolean;
  /** `approve:finance_application` — the approval writer's own permission. */
  canRecordApproval: boolean;
  /**
   * Whether the viewer is the salesperson on this application.
   *
   * `approveDealerPurchaseAmount` refuses them by design — the same separation
   * of duties `updateStatus` applies to the credit decision. Surfaced here as an
   * explanation rather than discovered as a failed submit.
   */
  isOwnDeal: boolean;
  money: (minor: number) => string;
  t: (key: string) => string;
  onRecordQuotation: () => void;
  onRecordApproved: () => void;
};

/** One recorded-or-not row, with whatever action belongs to it. */
function DecisionRow({
  label,
  value,
  note,
  action,
}: Readonly<{
  label: string;
  value: React.ReactNode;
  note?: string;
  action?: React.ReactNode;
}>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="font-semibold">{value}</p>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {action}
    </div>
  );
}

export function FinanceCompanyDecisionCard({
  facts,
  canRecordQuotation,
  canRecordApproval,
  isOwnDeal,
  money,
  t,
  onRecordQuotation,
  onRecordApproved,
}: Readonly<FinanceCompanyDecisionCardProps>) {
  const quotationRecorded = facts.submittedQuotationMinor !== null;

  // The quotation can only be recorded BEFORE an approval exists — the server
  // refuses to move the figure an approval was based on, and directs the caller
  // to reopen the approval instead. Offering the action anyway would produce a
  // refusal the screen cannot act on, since reopening has no UI yet.
  const quotationActionAvailable =
    canRecordQuotation && !facts.closed && !facts.approvedPurchaseRecorded;
  const approvalActionAvailable =
    canRecordApproval && !isOwnDeal && !facts.closed && quotationRecorded;

  const derived: Array<{ key: string; label: string; value: string }> = [];
  if (facts.financeCompanyFundedPortionMinor !== null) {
    derived.push({
      key: "funded",
      label: t("DerivedFundedPortion"),
      value: money(facts.financeCompanyFundedPortionMinor),
    });
  }
  if (facts.unfinancedPortionMinor !== null) {
    derived.push({
      key: "unfinanced",
      label: t("DerivedUnfinancedPortion"),
      value: money(facts.unfinancedPortionMinor),
    });
  }
  if (facts.dealerContributionMinor !== null) {
    derived.push({
      key: "contribution",
      label: t("DerivedDealerContribution"),
      value: money(facts.dealerContributionMinor),
    });
  }
  if (facts.appliedLtvPercent !== null) {
    derived.push({
      key: "ltv",
      label: t("DerivedAppliedLtv"),
      value: `${facts.appliedLtvPercent.toLocaleString()}%`,
    });
  }

  /**
   * Why the approval action is not offered — never silence.
   *
   * A missing button with no explanation is what sent the operator looking for
   * a screen that does not exist. Ordered by what the operator can act on: the
   * step they can still take themselves comes before the ones somebody else has
   * to take.
   */
  let approvalNote: string | undefined;
  if (facts.closed) approvalNote = t("FinanceDecisionClosed");
  else if (!quotationRecorded) approvalNote = t("QuotationNeededFirst");
  else if (!canRecordApproval) approvalNote = t("ApprovedPurchaseNeedsApprover");
  else if (isOwnDeal) approvalNote = t("ApprovedPurchaseNotOwnDeal");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("FinanceDecisionHeading")}</CardTitle>
        {/* The hard business rule, stated on the screen and not only in the
            code: AutoFlow mirrors the finance company's decision, it does not
            make one. */}
        <p className="text-xs text-muted-foreground">{t("FinanceDecisionIntro")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <DecisionRow
          label={t("QuotationSubmittedLabel")}
          value={
            facts.submittedQuotationMinor !== null ? (
              <bdi className="tabular-nums">{money(facts.submittedQuotationMinor)}</bdi>
            ) : (
              <span className="text-muted-foreground">{t("NotRecordedYet")}</span>
            )
          }
          action={
            quotationActionAvailable ? (
              <Button size="sm" variant={quotationRecorded ? "outline" : "default"} onClick={onRecordQuotation}>
                {t("RecordQuotationAction")}
              </Button>
            ) : undefined
          }
        />

        <DecisionRow
          label={t("ApprovedPurchaseLabel")}
          value={(() => {
            if (facts.approvedPurchaseAmountMinor !== null) {
              return <bdi className="tabular-nums">{money(facts.approvedPurchaseAmountMinor)}</bdi>;
            }
            // Recorded, but withheld from this caller. Saying "not recorded"
            // here would be the screen asserting something it cannot see.
            if (facts.approvedPurchaseRecorded) {
              return <span className="text-muted-foreground">{t("RecordedAmountHidden")}</span>;
            }
            return <span className="text-muted-foreground">{t("NotRecordedYet")}</span>;
          })()}
          note={facts.approvedPurchaseRecorded ? undefined : approvalNote}
          action={
            approvalActionAvailable && !facts.approvedPurchaseRecorded ? (
              <Button size="sm" onClick={onRecordApproved}>
                {t("RecordApprovedPurchaseAction")}
              </Button>
            ) : undefined
          }
        />

        {derived.length > 0 && (
          <>
            <Separator />
            <div className="space-y-1.5">
              <p className="text-sm font-medium">{t("DerivedEconomicsHeading")}</p>
              <dl className="space-y-1.5 text-sm">
                {derived.map((line) => (
                  <div key={line.key} className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">{line.label}</dt>
                    <dd>
                      <bdi className="tabular-nums">{line.value}</bdi>
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">{t("DerivedEconomicsNote")}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
