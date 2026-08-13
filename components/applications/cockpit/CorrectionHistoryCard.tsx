"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The corrections made to this deal's recorded figures, newest first.
 *
 * Without this the audit trail existed and was invisible. `reopenApproval` and
 * `approveDealerPurchaseAmount` have always written override rows — who changed
 * what, from what, to what, and why — and nothing in the product ever read one.
 * So after a wrong 150,000 was corrected to 15,000 the screen simply showed
 * 15,000, and an operator had no way to tell a corrected deal from one that was
 * always right. A record nobody can see does not answer the question the record
 * exists to answer.
 *
 * Absent, not empty, on a deal that has never been corrected: a permanent
 * "no corrections" heading on every healthy deal is noise, and it invites the
 * reading that something is missing.
 *
 * The rows carry money figures, so the server withholds them entirely from a
 * caller who may not see the approved amount — see `getEconomics`. This card
 * therefore renders whatever it is given and makes no permission decision of
 * its own; a second, hand-copied rule here is how the two would drift apart.
 */
export type CorrectionEntry = {
  id: string;
  field: string;
  /**
   * The figures, as NUMBERS in the deal's own minor units.
   *
   * Never the stored strings. Those are written for an audit table and carry
   * the whole decision — `"150000000 (MANUAL @ 85% LTV, approved by pd78…)"` —
   * so rendering one would show a money figure a thousand times too large
   * beside an internal user id. `getEconomics` extracts the amount and drops
   * the rest; this component formats it in the deal's currency.
   *
   * Absent where the server could not present the value safely, in which case
   * the line still carries the reason, the person and the time.
   */
  previousAmountMinor?: number;
  newAmountMinor?: number;
  /** The reopen path writes a state, not a figure. Said in words, not shown raw. */
  newIsReopened: boolean;
  reason: string;
  changedByName?: string;
  /**
   * Already formatted, and absent when the stored moment is not renderable.
   *
   * Convex stores `NaN` and `±Infinity` verbatim through `v.number()`, and
   * `date-fns` `format()` THROWS on them — which would take the whole cockpit
   * down to render one history line. The guard lives with `isRenderableMoment`
   * in `DealCockpit`, so this component cannot be handed a value that crashes it.
   */
  changedAtLabel?: string;
};

type CorrectionHistoryCardProps = {
  entries: ReadonlyArray<CorrectionEntry>;
  /** The DEAL's own currency formatter — never the organisation's. */
  money: (minor: number) => string;
  t: (key: string) => string;
};

export function CorrectionHistoryCard({
  entries,
  money,
  t,
}: Readonly<CorrectionHistoryCardProps>) {
  if (entries.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("CorrectionHistoryHeading")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("CorrectionHistoryIntro")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {entries.map((entry) => {
          const before =
            entry.previousAmountMinor === undefined ? null : money(entry.previousAmountMinor);
          const after = entry.newIsReopened
            ? t("CorrectionValueReopened")
            : entry.newAmountMinor === undefined
              ? null
              : money(entry.newAmountMinor);
          return (
            <div key={entry.id} className="space-y-1 border-s-2 ps-3">
              {/* The reason FIRST, because it is the only part written by a
                  person and the only part that answers "why is this different
                  from what I remember". */}
              <p className="text-sm font-medium">{entry.reason}</p>
              {(before !== null || after !== null) && (
                <p className="text-xs text-muted-foreground">
                  {before !== null && <bdi className="tabular-nums">{before}</bdi>}
                  {before !== null && after !== null && <span aria-hidden="true"> → </span>}
                  {after !== null && <bdi className="tabular-nums">{after}</bdi>}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                <bdi>{entry.changedByName ?? t("CorrectionByUnknownUser")}</bdi>
                {entry.changedAtLabel !== undefined && (
                  <>
                    {" · "}
                    <bdi>{entry.changedAtLabel}</bdi>
                  </>
                )}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
