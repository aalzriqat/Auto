"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { openingMixedFamilyAccounts } from "./openingAllocationForm";
import type { OpeningAllocationDraft } from "./openingAllocationForm";

type Props = {
  rows: OpeningAllocationDraft[];
  accountId: string;
  maySelect: boolean;
  noEligibleParty: boolean;
};

/** The status lines under one opening control group: a missing grant, no eligible party, or a mixed family (SCRUM-944). */
export function OpeningGroupNotices({ rows, accountId, maySelect, noEligibleParty }: Props) {
  const { t } = useLanguage();
  const mixedFamily = openingMixedFamilyAccounts(rows).get(accountId);
  return (
    <>
      {!maySelect && <p className="text-xs text-amber-700" role="alert">{t("OpeningAllocationPermissionNeeded")}</p>}
      {noEligibleParty && <p className="text-xs text-amber-700" role="status">{t("OpeningAllocationNoEligibleParty")}</p>}
      {mixedFamily && (
        <p className="text-xs text-amber-700" role="alert">
          {t(mixedFamily === "MIXED_PURPOSE" ? "OpeningAllocationMixedPurpose" : "OpeningAllocationMixedFamily")}
        </p>
      )}
    </>
  );
}