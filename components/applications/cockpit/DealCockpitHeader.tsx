import Link from "next/link";
import { ArrowLeft, Ban } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dealStatusLabelKey, type DealCockpitData } from "./DealStagePresentation";
export { dealStatusLabelKey } from "./DealStagePresentation";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";

/**
 * The header badge's words. Every application is created PENDING_DOCS, so on a
 * deal the server proved needs no document (DELIVERY_ACTIONS NOT_APPLICABLE) it
 * read "pending documents" for documents that do not exist (SCRUM-629 F-08).
 * Display only: the stored status and its transitions are unchanged.
 */
export function dealStatusBadgeKey(
  status: string,
  stages: ReadonlyArray<Readonly<{ key: string; state: string }>>
): string {
  if (
    status === "PENDING_DOCS" &&
    stages.some((stage) => stage.key === "DELIVERY_ACTIONS" && stage.state === "NOT_APPLICABLE")
  ) {
    return "AppStatusSubmitted";
  }
  return dealStatusLabelKey(status);
}

export function DealCockpitHeader({
  deal,
  dealNumberLabel,
  backHref,
  ownerLabel,
  updatedLabel,
  cancel,
  cashCancel,
  cancelHint,
  chequeReturn,
  forwardCorrection,
  unwind,
  t,
}: Pick<DealCockpitViewProps, "backHref" | "cancel" | "cashCancel" | "cancelHint" | "chequeReturn" | "forwardCorrection" | "unwind"> & Readonly<{
  deal: Pick<DealCockpitData, "applicationId" | "dealRef" | "status" | "stages">;
  dealNumberLabel: string | null;
  ownerLabel: string | undefined;
  updatedLabel: string;
  t: (key: string) => string;
}>) {
  return (
    <>
      {/* Sticky: the deal's identity, status and the exceptional action stay
          in view while the operator works down the rail and the money —
          the owner's workspace shell. Negative margins let the bar span the
          page padding; the backdrop keeps it legible over scrolled content. */}
      {/* The negative HORIZONTAL margins mirror the workspace `main` padding
          exactly (p-3 / sm:p-4 / md:p-6 / lg:p-8): one step wider than the
          padding and the bar is the page's only horizontal overflow.
          No negative TOP margin, deliberately. `main` is the scroll container
          and a sticky box is clamped inside its containing block, so Chromium
          shifts a `-mt-*` header straight back down by the same amount: the
          bar never moved up, only the essentials row under it did — and at
          `lg` the 32px shift ate the 24px gap and put the row's labels under
          the bar. `playwright/visual/deal-cockpit.visual.spec.ts` measures
          this in a real engine. */}
      <div
        className="sticky top-0 z-20 -mx-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-background/95 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-4 sm:px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8"
        data-testid="deal-header"
      >
        {backHref && (
          <Link
            href={backHref}
            className="inline-flex min-h-9 items-center gap-1 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
            {t("BackToDeals")}
          </Link>
        )}
        {/* Full-width on a phone, so the back link and the cancel share the
            first row and the identity gets a clean row of its own. */}
        <div className="order-last flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 sm:order-none sm:flex-1 sm:basis-0">
          <h1 className="whitespace-nowrap text-xl font-semibold tracking-tight">
            {/* The TITLE names the RECORD, so it follows the server's own
                identity of the deal (`applicationId`), not `dealKind`: an
                applicationless FINANCED/LEASE sale is `dealKind: "FINANCED"`
                and still has no finance application to be titled after —
                headed `طلب تمويل` it named a record that does not exist for
                it. `dealRef` rather than the application id for the same
                reason. Both queries supply both. */}
            {t(deal.applicationId === null ? "DealCockpitTitleCash" : "DealCockpitTitle")}{" "}
            {/* SCRUM-808: the issued deal number; the id tail only for a deal the backfill has not reached. */}
            <bdi dir="ltr" className="font-normal text-muted-foreground" data-testid="deal-title-number">
              {dealNumberLabel ?? `#${String(deal.dealRef).slice(-4)}`}
            </bdi>
          </h1>
          <Badge variant={deal.status === "APPROVED" || deal.status === "CLOSED" ? "default" : "secondary"}>
            {t(dealStatusBadgeKey(deal.status, deal.stages))}
          </Badge>
          {/* Whose move the deal is on, from the same source the rail uses —
              one owner per screen, never two. */}
          {ownerLabel && (
            <span className="text-sm text-muted-foreground">
              <bdi>{ownerLabel}</bdi>
            </span>
          )}
          {/* Off the sticky bar on a phone, where every row it takes is a row
              of the deal hidden under it; the essentials carry it there. */}
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {t("LastUpdated")}: <bdi>{updatedLabel}</bdi>
          </span>
        </div>
        {/* The exceptional action, in the header and quiet on purpose: it is
            never the recommended next step, so it must not compete with the
            one CTA the focus panel carries. Present only when the SERVER would
            accept it from this caller. Kept visible rather than folded into a
            menu: it would be the menu's only item, and a destructive action
            behind a one-item menu is hidden, not tidied. */}
        {forwardCorrection && (
          <div className="ms-auto flex flex-wrap items-center gap-1" data-testid="deal-forward-correction">
            {forwardCorrection.canVoid && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                data-testid="deal-forward-void"
                onClick={() => forwardCorrection.onOpen("VOID")}
              >
                {t("ForwardVoidAction")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-9"
              data-testid="deal-forward-returned"
              onClick={() => forwardCorrection.onOpen("RETURNED")}
            >
              {t("ForwardReturnedAction")}
            </Button>
          </div>
        )}
        {chequeReturn && (
          <Button
            variant="ghost"
            size="sm"
            className={forwardCorrection ? "h-9" : "ms-auto h-9"}
            data-testid="deal-cheque-returned-by-bank"
            onClick={chequeReturn.onOpen}
          >
            {t("ChequeReturnedByBankAction")}
          </Button>
        )}
        {cancel && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-9 text-destructive hover:text-destructive", !(forwardCorrection || chequeReturn) && "ms-auto")}
            data-testid="deal-cancel-application"
            onClick={() => cancel.onOpenChange(true)}
          >
            <Ban className="h-4 w-4" aria-hidden />
            {t("CancelApplication")}
          </Button>
        )}
        {!cancel && cashCancel && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-9 text-destructive hover:text-destructive", !(forwardCorrection || chequeReturn) && "ms-auto")}
            data-testid="deal-cancel-deal"
            onClick={() => cashCancel.onOpenChange(true)}
          >
            <Ban className="h-4 w-4" aria-hidden />
            {t("CancelDealAction")}
          </Button>
        )}
        {unwind?.offered && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-9 text-destructive hover:text-destructive", !(forwardCorrection || chequeReturn) && "ms-auto")}
            data-testid="deal-unwind-deal"
            onClick={() => unwind.onOpenChange(true)}
          >
            <Ban className="h-4 w-4" aria-hidden />
            {t(unwind.status.status === "ACTIVE" ? "UnwindDealResume" : "UnwindDealAction")}
          </Button>
        )}
        {!cancel && cancelHint && (
          <span className="ms-auto text-xs text-muted-foreground" data-testid="deal-cancel-manager-hint">
            {t(cancelHint === "FORWARD" ? "CancelWaitsForForward" : "ManagerCancelsFinalizedDeal")}
          </span>
        )}
      </div>

      {unwind?.offered && (
        <p
          className="rounded-md border border-amber-500/40 border-s-4 border-s-amber-500 bg-amber-500/5 p-3 text-sm"
          role="status"
          data-testid="deal-unwind-banner"
        >
          {t(unwind.status.status === "ACTIVE" ? "UnwindInProgressBadge" : "UnwindPaidDealBanner")}
        </p>
      )}
      {unwind && !unwind.offered && unwind.status.status === "ACTIVE" && (
        // A viewer who may act on none of it still sees that the deal is being unwound.
        <p
          className="rounded-md border border-amber-500/40 border-s-4 border-s-amber-500 bg-amber-500/5 p-3 text-sm"
          role="status"
          data-testid="deal-unwind-banner"
        >
          {t("UnwindInProgressBadge")}
        </p>
      )}
      {unwind && !unwind.offered && unwind.hint && (
        <p className="text-sm text-muted-foreground" data-testid="deal-unwind-hint">
          {(() => {
            const key = `ServerError_${unwind.hint.code}`;
            const text = t(key);
            return text === key ? unwind.hint.message : text;
          })()}
        </p>
      )}
    </>
  );
}
