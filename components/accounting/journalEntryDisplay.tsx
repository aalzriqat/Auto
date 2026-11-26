"use client";

/**
 * SCRUM-1013 — how a General Ledger journal entry reads on screen.
 *
 * Every label comes from the structured display facts `accountingLedger`
 * returns (convex/accounting/journalDisplay.ts) through the EN/AR dictionaries,
 * never from the raw `sourceType: sourceId` key. Text that a person typed, bank
 * names, entry numbers and any stored English sentence are wrapped in `<bdi>` so
 * they keep their own direction inside Arabic, right-to-left prose — the same
 * isolation BankTransfersPanel and ChartOfAccountsManagement already use.
 */
import type { ReactNode } from "react";
import type { JournalEntryDisplay, JournalLineDisplay, TransferEndpoint } from "@/convex/accounting/journalDisplay";
import { interpolate } from "@/lib/i18n/interpolate";

export type JournalTranslate = (key: string) => string;

/** `t` returns the key itself when a dynamic key is missing; fall back instead of showing it. */
function labelOrNull(t: JournalTranslate, key: string): string | null {
  const value = t(key);
  return value && value !== key ? value : null;
}

export interface JournalEntryLike {
  memo?: string | null;
  status?: string | null;
  category?: string | null;
  display?: JournalEntryDisplay | null;
}

export function journalStatusLabel(t: JournalTranslate, status: string | null | undefined): string {
  if (!status) return "—";
  return labelOrNull(t, `JournalStatus_${status}`) ?? status;
}

/** The family label for the Source column. Unknown or missing facts read as a neutral "system entry". */
export function journalSourceLabel(t: JournalTranslate, entry: JournalEntryLike): string {
  const family = entry.display?.sourceFamily ?? (entry.category === "MANUAL" ? "MANUAL_JOURNAL" : "OTHER");
  return labelOrNull(t, `JournalSource_${family}`) ?? labelOrNull(t, "JournalSource_OTHER") ?? "—";
}

/** The localized headline of an entry, or null when only the stored sentence is known. */
export function journalHeadline(t: JournalTranslate, entry: JournalEntryLike): string | null {
  const display = entry.display;
  const family = display?.sourceFamily;
  const eventLabel = display?.eventType
    ? labelOrNull(t, `JournalEvent_${display.eventType}`)
    : family === "MANUAL_JOURNAL" || family === "OPENING_BALANCE"
      ? labelOrNull(t, `JournalSource_${family}`)
      : null;
  if (display?.isReversal) {
    return eventLabel ? interpolate(t("JournalReversalOf"), { event: eventLabel }) : labelOrNull(t, "JournalReversalEntry");
  }
  return eventLabel;
}

function endpointLabel(t: JournalTranslate, endpoint: TransferEndpoint): string {
  if (endpoint.kind === "CASH") return t("DashboardCashOnHand");
  return endpoint.bankName || t("JournalUnnamedBank");
}

/** Plain-text version of everything the description cell shows, for its tooltip. */
export function journalDescriptionText(t: JournalTranslate, entry: JournalEntryLike, locale: string): string {
  const headline = journalHeadline(t, entry);
  const transfer = entry.display?.transfer;
  const parts = [
    headline,
    transfer ? `${t("BankTransferFrom")} ${endpointLabel(t, transfer.from)} ${t("BankTransferTo")} ${endpointLabel(t, transfer.to)}` : null,
    entry.display?.note ?? null,
    secondaryStoredMemo(entry, headline, locale),
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

/**
 * The stored memo, when it still says something the built text does not.
 *
 * Without a headline the stored sentence is all there is, so it is shown
 * unchanged (never translated by guess). With one, the English memo is kept as a
 * secondary line in English only, where it can carry a party name the headline
 * does not; in Arabic it stays in the lines dialog as the recorded text.
 */
function secondaryStoredMemo(entry: JournalEntryLike, headline: string | null, locale: string): string | null {
  const memo = entry.memo?.trim() || null;
  if (!memo) return null;
  if (!headline) return memo;
  if (entry.display?.note) return null;
  if (locale === "ar") return null;
  return memo.toLowerCase() === headline.toLowerCase() ? null : memo;
}

/** The Description («البيان») cell of one journal entry row. */
export function JournalEntryDescription({ t, entry, locale, hideStoredMemo = false }: {
  t: JournalTranslate; entry: JournalEntryLike; locale: string;
  /** The lines dialog shows the stored memo on its own "recorded text" line. */
  hideStoredMemo?: boolean;
}): ReactNode {
  const display = entry.display;
  const headline = journalHeadline(t, entry);
  const transfer = display?.transfer;
  const stored = hideStoredMemo ? null : secondaryStoredMemo(entry, headline, locale);
  const linkClass = "block truncate text-xs text-muted-foreground";
  // Free text is truncated by its OWN `dir="auto"` box, so an English note inside
  // an Arabic cell is cut at the end of the note, not at its start.
  return (
    <div className="max-w-[320px] min-w-0">
      {headline && (
        <span className="block truncate font-medium" data-testid="journal-entry-headline">
          {headline}
          {transfer && (
            <>
              {": "}
              {t("BankTransferFrom")} <bdi>{endpointLabel(t, transfer.from)}</bdi>{" "}
              {t("BankTransferTo")} <bdi>{endpointLabel(t, transfer.to)}</bdi>
            </>
          )}
        </span>
      )}
      {display?.note && (
        <span className="flex min-w-0 gap-1 text-xs" data-testid="journal-entry-note">
          <span className="shrink-0">{t("JournalNote")}:</span>
          <bdi dir="auto" className="min-w-0 truncate">{display.note}</bdi>
        </span>
      )}
      {stored && (
        <bdi dir="auto" className={headline ? "block truncate text-xs text-muted-foreground" : "block truncate"}>
          {stored}
        </bdi>
      )}
      {display?.reversalOf && (
        <span className={linkClass} data-testid="journal-entry-reverses">
          {t("JournalReversesEntry")} <bdi dir="ltr" className="font-mono">{display.reversalOf.journalNumber}</bdi>
        </span>
      )}
      {display?.reversedBy && (
        <span className={linkClass} data-testid="journal-entry-reversed-by">
          {t("JournalReversedByEntry")} <bdi dir="ltr" className="font-mono">{display.reversedBy.journalNumber}</bdi>
        </span>
      )}
      {!headline && !stored && !hideStoredMemo && "-"}
    </div>
  );
}

export interface LedgerAccountLike {
  code: string;
  name: string;
  nameAr?: string | null;
}

/** Chart-of-accounts name in the user's language; English when no Arabic name was entered. */
export function localizedAccountName(account: LedgerAccountLike, locale: string): string {
  return (locale === "ar" ? account.nameAr || account.name : account.name) || "—";
}

/** The Description cell of one journal line in the lines dialog. */
export function JournalLineDescription({ t, line }: {
  t: JournalTranslate;
  line: { description?: string | null; display?: JournalLineDisplay | null };
}): ReactNode {
  const display = line.display;
  const leg = display?.transferLeg === "IN" ? t("JournalTransferIn")
    : display?.transferLeg === "OUT" ? t("JournalTransferOut")
      : null;
  const text = display ? display.description : line.description?.trim() || null;
  return (
    <>
      {leg ?? (text ? <bdi dir="auto">{text}</bdi> : !display?.isReversalLine && "-")}
      {display?.isReversalLine && (
        <span className="ms-1 text-xs text-muted-foreground">({t("JournalLineReversal")})</span>
      )}
    </>
  );
}
