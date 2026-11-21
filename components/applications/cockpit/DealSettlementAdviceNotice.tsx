import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Money } from "./DealMoneyDisplay";

export function DealSettlementAdviceNotice({
  figures,
  onCorrectAdvice,
  pilotDisabled,
  t,
}: Readonly<{
  figures: Readonly<{ recorded: string; approved: string; difference: string | null }> | null;
  onCorrectAdvice?: () => void;
  pilotDisabled: boolean;
  t: (key: string) => string;
}>) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 border-s-4 border-s-destructive bg-destructive/5 p-4"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
          aria-hidden
        />
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-destructive">
            {t("SettlementAdviceDiscrepancyTitle")}
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">
            {t("SettlementAdviceDiscrepancyBody")}
          </p>
        </div>
      </div>

      {/* Figures and action on one row, in that order.
              The discrepancy IS the content, so it is set as the two records
              facing each other rather than described in a sentence. Each figure
              is its own `<bdi>` run: an Arabic label beside a Latin amount
              beside a currency marker is exactly the bidi case that reorders
              into nonsense when left as one run.
              The action comes AFTER them and not beside the heading, because on
              a phone the row wraps in source order — and the first rendered
              layout put "correct the advice" between the explanation and the
              evidence, offering the fix before showing what needs fixing.
              Indented to the text on desktop only; on a 390px screen that
              indent costs width the three figures need to stay on one line. */}
      {/* Only for a caller the SERVER sent the evidence to. The correction
              button lives in here with it, and that is the point: correcting a
              figure you were never shown is a guess, not a correction.
              `manage:finance` and `view:finance` are independent permissions and
              roles here are customizable, so one can be held without the other —
              this nesting is what stops the button appearing for such a role. */}
      {figures && (
        <div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 sm:ps-6">
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div className="space-y-0.5">
              <dt className="text-xs text-muted-foreground">
                {t("SettlementAdviceRecorded")}
              </dt>
              <dd className="font-semibold">
                <Money>{figures.recorded}</Money>
              </dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-xs text-muted-foreground">
                {t("SettlementAdviceApproved")}
              </dt>
              <dd className="font-semibold">
                <Money>{figures.approved}</Money>
              </dd>
            </div>
            {figures.difference && (
              <div className="space-y-0.5">
                <dt className="text-xs text-muted-foreground">
                  {t("SettlementAdviceDifference")}
                </dt>
                <dd className="font-semibold text-destructive">
                  <Money>{figures.difference}</Money>
                </dd>
              </div>
            )}
          </dl>
          {onCorrectAdvice && (
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={pilotDisabled}
              title={
                pilotDisabled
                  ? t("ServerError_SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED")
                  : undefined
              }
              onClick={onCorrectAdvice}
            >
              {t("CorrectSettlementAdvice")}
            </Button>
          )}
          {onCorrectAdvice && pilotDisabled && (
            <p className="text-xs text-muted-foreground">
              {t("ServerError_SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
