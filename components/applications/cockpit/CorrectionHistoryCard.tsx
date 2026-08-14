"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The corrections made to this deal's recorded figures, newest first.
 *
 * Without this the audit trail existed and was invisible. The economics writers
 * have always recorded who changed what, from what, to what and why, and nothing
 * in the product ever read one. So after a wrong 150,000 was corrected to 15,000
 * the screen simply showed 15,000, and an operator had no way to tell a corrected
 * deal from one that was always right. A record nobody can see does not answer
 * the question the record exists to answer.
 *
 * Absent, not empty, on a deal that has never been corrected: a permanent
 * "no corrections" heading on every healthy deal is noise, and it invites the
 * reading that something is missing.
 *
 * Every figure the rows carry is gated at the server, per subject — see
 * `getEconomics`. This card renders whatever it is given and makes no permission
 * decision of its own; a second, hand-copied rule here is how the two would
 * drift apart.
 */

/** WHICH figure the entry is about. Never inferred here — the server names it. */
export type CorrectionSubject =
  | "APPROVED_PURCHASE_AMOUNT"
  | "SUBMITTED_QUOTATION"
  | "RECONCILIATION_FLAG"
  | "ACCOUNTING_CLASSIFICATION"
  | "CUSTODY_SETTLEMENT"
  | "DEAL_COST"
  | "LEGAL_INVOICE";

/** WHAT HAPPENED to it. */
export type CorrectionEvent = "CORRECTED" | "WITHDRAWN" | "SUPERSEDED" | "RESOLVED";

export type CorrectionEntry = {
  id: string;
  /**
   * The subject exists so an entry can never be read as being about the wrong
   * figure.
   *
   * The projection this replaced described every money-suffixed audit field
   * through one unlabelled shape, so a corrected quotation and a corrected
   * approved purchase amount arrived on screen indistinguishable — and a
   * correction to the EXPENSES behind a quotation arrived as an unlabelled
   * movement from 12,500 to 12,500, because that writer stores the quotation
   * amount unchanged on both sides of the row.
   */
  subject: CorrectionSubject;
  event: CorrectionEvent;
  /**
   * The figures, as NUMBERS in the deal's own minor units, and only where the
   * server could name them unambiguously.
   *
   * Never the stored strings. Those are written for an audit table and carry the
   * whole decision — `"150000000 (MANUAL @ 85% LTV, approved by pd78…)"` — so
   * rendering one would show a money figure a thousand times too large beside an
   * internal user id.
   *
   * Absent is ordinary, not an error, and never a zero: the entry then carries
   * the subject, what happened, the reason, the person and the time, which still
   * explains the deal.
   */
  previousAmountMinor?: number;
  newAmountMinor?: number;
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

/**
 * Exhaustive by TYPE, so a subject the server learns to send cannot arrive here
 * with no label. `Record<CorrectionSubject, string>` makes adding one to the
 * union a compile error until it is named in both languages — the alternative
 * renders an entry whose heading is blank or, worse, the raw enum.
 */
const SUBJECT_LABEL: Record<CorrectionSubject, string> = {
  APPROVED_PURCHASE_AMOUNT: "CorrectionSubjectApprovedAmount",
  SUBMITTED_QUOTATION: "CorrectionSubjectQuotation",
  RECONCILIATION_FLAG: "CorrectionSubjectReconciliation",
  ACCOUNTING_CLASSIFICATION: "CorrectionSubjectClassification",
  CUSTODY_SETTLEMENT: "CorrectionSubjectCustody",
  DEAL_COST: "CorrectionSubjectDealCost",
  LEGAL_INVOICE: "CorrectionSubjectLegalInvoice",
};

/** The events that are a STATE rather than a figure, said in words. */
const EVENT_LABEL: Partial<Record<CorrectionEvent, string>> = {
  WITHDRAWN: "CorrectionValueReopened",
  SUPERSEDED: "CorrectionValueCleared",
  RESOLVED: "CorrectionValueResolved",
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
          const eventLabel = EVENT_LABEL[entry.event];
          return (
            <div key={entry.id} className="space-y-1 border-s-2 ps-3">
              {/* WHICH figure, before anything else. An entry that does not name
                  its subject is read as being about the figure above it. */}
              <p className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
                {t(SUBJECT_LABEL[entry.subject])}
              </p>
              {/* The reason — the only part a person wrote, and the only part
                  that answers "why is this different from what I remember". */}
              <p className="text-sm font-medium">{entry.reason}</p>
              {/* Labelled rather than joined by an arrow. A directional glyph
                  between two figures has to be flipped for Arabic and reads
                  backwards the day it is not; "from" and "to" carry the same
                  meaning in either direction, and each figure is isolated in its
                  own `bdi` so a bidi run cannot reorder the digits around it. */}
              {(entry.previousAmountMinor !== undefined ||
                entry.newAmountMinor !== undefined ||
                eventLabel !== undefined) && (
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {entry.previousAmountMinor !== undefined && (
                    <span>
                      {t("CorrectionFrom")}{" "}
                      <bdi className="tabular-nums">{money(entry.previousAmountMinor)}</bdi>
                    </span>
                  )}
                  {entry.newAmountMinor !== undefined && (
                    <span>
                      {t("CorrectionTo")}{" "}
                      <bdi className="tabular-nums">{money(entry.newAmountMinor)}</bdi>
                    </span>
                  )}
                  {eventLabel !== undefined && <span>{t(eventLabel)}</span>}
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
