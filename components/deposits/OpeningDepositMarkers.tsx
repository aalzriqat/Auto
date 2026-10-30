"use client";

import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/providers/LanguageProvider";

/**
 * SCRUM-858 S1 (owner ruling SCRUM-858#c23884): a deposit that came from an approved opening
 * balance. The cash was received before the books opened, so during the pilot it can only be
 * applied to the customer's sale. These two pieces are display only: the refusal that matters is
 * server-side (`OPENING_DEPOSIT_PAYOUT_REFUSED`), so hiding them would not make a refund possible
 * or impossible.
 */

/** True for a deposit row created from an approved opening balance. */
export function isOpeningOriginDeposit(deposit: { origin?: string | null }): boolean {
  return deposit.origin === "OPENING";
}

export function OpeningDepositBadge() {
  const { t } = useLanguage();
  return (
    <span
      data-testid="opening-deposit-badge"
      className="ms-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-800 dark:bg-slate-800 dark:text-slate-100"
    >
      {t("OpeningDepositBadge")}
    </span>
  );
}

/** Replaces the refund and forfeit controls of a held opening deposit with disabled ones and the reason. */
export function OpeningDepositActionsDisabled() {
  const { t } = useLanguage();
  const reason = t("OpeningDepositActionsUnavailable");
  return (
    <div className="flex min-w-0 max-w-full flex-col items-end gap-1" data-testid="opening-deposit-actions-disabled">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled aria-disabled="true">
          {t("Refund")}
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled aria-disabled="true">
          {t("Forfeit")}
        </Button>
      </div>
      <p className="max-w-[18rem] text-xs font-medium text-amber-700 text-end dark:text-amber-500" role="note">
        {reason}
      </p>
    </div>
  );
}
