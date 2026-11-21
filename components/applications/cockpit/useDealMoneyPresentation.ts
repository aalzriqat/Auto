import { useMemo } from "react";
import { scaleForCurrency } from "@/components/accounting/AccountingTabShared";
import type { Locale } from "@/lib/i18n/dictionaries";
import { formatMinorAmount } from "@/lib/moneyDisplay";
import type { DealCockpitData } from "./DealStagePresentation";

export function safeScaleForCurrency(currency: string | null | undefined, fallback = 2): number {
  if (!currency) return fallback;
  try {
    return scaleForCurrency(currency);
  } catch {
    return fallback;
  }
}

export function useDealMoneyPresentation({
  deal,
  currency,
  locale,
  pinnedDecisionCurrency,
  t,
}: Readonly<{
  deal: DealCockpitData | null | undefined;
  currency: Readonly<{ code: string; symbol: string }>;
  locale: Locale;
  pinnedDecisionCurrency?: string | null;
  t: (key: string) => string;
}>) {
  // Never a hardcoded ÷1000. JOD, KWD, BHD and OMR are three-decimal; most
  // currencies are two. Baking one scale in would be a 100x error everywhere
  // else — the same trap the accounting screens already solved with this helper.
  // CX-3. The scale comes from the currency the SERVER pinned on this deal, not
  // from whatever the org is configured with today. `economicsCurrency` is
  // snapshotted per application, so an in-flight JOD deal on an org that later
  // switches to USD would otherwise be rescaled at the wrong power of ten —
  // 5,000,000 minor units rendering as 50,000 USD instead of 5,000 JOD, and the
  // same wrong factor feeding the receipt dialog.
  /**
   * The denomination the SERVER vouches for, or null.
   *
   * This screen is a money-READING surface. Everything below used to fall from
   * the deal's currency to the org's to a hardcoded default, and then through a
   * scaler that answers 2 for anything it does not recognise — so a legacy row
   * carrying "JD" showed 11,500,000 fils as 115,000. Refusing the handover
   * protects the irreversible step and does nothing for the figure a dealer
   * reads off the page.
   *
   * When it is null there is no honest way to spell these amounts, so they are
   * withheld and the reason is stated. Absent, unsupported and non-canonical
   * all land here, matching exactly what the writers refuse.
   */
  // Only a payload that CARRIES the projection can be judged by it. The cash
  // variant comes from `sales.dealCockpit`, which projects no denomination at
  // all — reading its absence as "unusable" would have hidden the figures on
  // every live cash sale, which is a far worse fault than the one this guards.
  const hasDenominationProjection = deal != null && "denomination" in deal;
  const denomination = hasDenominationProjection ? deal.denomination : null;
  /**
   * Whether economics are actually ON the record.
   *
   * NOT `Boolean(deal.money)`. That object is permission-shaped: `dealCockpit`
   * builds it for any caller holding `view:finance` and returns zeroed party
   * rows for a deal where nothing has ever been recorded. Using it here put the
   * red restatement panel on every freshly created financed deal for the OWNER,
   * telling them to record again something that was never recorded once.
   *
   * The stage rail is the real signal, and the server derives it from the
   * unredacted row — so it is equally true for a caller whose money is withheld.
   */
  const economicsRecorded = !hasDenominationProjection
    ? false
    : "economicsRecorded" in deal
      ? deal.economicsRecorded === true
      : // UNKNOWN, and unknown must not read as "nothing recorded".
        //
        // A response from the previous backend carries `denomination` but not
        // `economicsRecorded`, and on this repository that pairing is the
        // DEFAULT after a merge rather than an exotic rollback: pushing to
        // `main` auto-deploys the frontend, while the Convex functions stay on
        // the old version until someone deploys them by hand. So a new client
        // talks to an old server on every merge, for as long as that gap lasts.
        //
        // Reading the absent field as `false` switched the guard off in exactly
        // that window — a legacy row denominated in something unspellable would
        // have gone back to the guessing scale and rendered 11,500,000 minor
        // units as 115,000. Assuming instead that money MAY be recorded costs a
        // restatement panel on a deal that has none, and only until the backend
        // catches up. One of those errors is a wrong number on a real deal.
        true;
  const denominationUnusable = hasDenominationProjection && denomination === null && economicsRecorded;
  const dealCurrency = denomination?.code ?? deal?.money?.currency ?? currency.code;
  const factor = useMemo(
    () => Math.pow(10, denomination?.scale ?? safeScaleForCurrency(dealCurrency, 2)),
    [denomination, dealCurrency]
  );
  // A SHORT currency marker, and a locale-appropriate one.
  //
  // `currency.format` renders "دينار اردني" in Arabic, which on a screen
  // carrying a dozen amounts wrapped every figure onto two lines on mobile and
  // buried the headline; the approved mockup uses "د.أ". But the symbol is
  // configured per org and is Arabic, so using it unconditionally put "د.أ"
  // next to Latin digits on the English screen — an RTL run beside an LTR one,
  // which is the bidi case this file is careful about everywhere else. Each
  // locale gets the short form that belongs to it.
  // The org's symbol only stands for the org's own currency; on a deal pinned to
  // a different one it would label the amount as something it is not.
  const marker =
    locale === "ar" && dealCurrency === currency.code ? currency.symbol : dealCurrency;
  const money = (minor: number) => `${formatMinorAmount(minor, factor)} ${marker}`;

  // The discrepancy's own figures.
  //
  // Scaled by the currency the DISCREPANCY was pinned to, which is not
  // necessarily `dealCurrency`: the money block can be withheld entirely, and
  // this strip still has to render. Falling back to the deal's currency and
  // then the org's mirrors what the server does, so the two never disagree
  // about the scale. A missing figure renders as unknown rather than as zero —
  // "the advice says nothing" and "the advice says nought" are different
  // claims, and only one of them is ever true here.
  // DELIBERATELY still the guessing scaler. See SCRUM-88 before changing it.
  //
  // This strip does render a legacy "JD" row at the wrong scale, and an earlier
  // revision of this PR tried to fix that here by switching to the strict
  // `denominationOf`. That made things worse, not better: this same factor
  // prefills the editable amount in the dialog rendered by `useDealAdviceCorrection`,
  // while the submit path converts back with `scaleForCurrency`. Making only
  // the display side strict left the two disagreeing, so an operator opening
  // the dialog to correct a reference and submitting without touching the
  // amount persisted 100x the recorded figure over the advice and its audit
  // row. A display fault became a write corruption.
  //
  // The two sides have to move together — display, prefill, submit and a
  // server-side denomination guard on the amend mutation, which currently takes
  // no currency argument and so cannot check one. That is a change to a shipped
  // financial correction flow, not a hunk in a release-verification pass, and
  // it is tracked separately. Keeping main's behavior here is the smaller risk:
  // wrong on screen, but internally consistent, and it round-trips exactly.
  const discrepancy = deal?.settlementAdviceDiscrepancy ?? null;
  const discrepancyCurrency = discrepancy?.currency ?? dealCurrency;
  const discrepancyFactor = useMemo(
    () => Math.pow(10, safeScaleForCurrency(discrepancyCurrency, 2)),
    [discrepancyCurrency]
  );
  const discrepancyMarker =
    locale === "ar" && discrepancyCurrency === currency.code ? currency.symbol : discrepancyCurrency;
  const discrepancyMoney = (minor: number) =>
    `${formatMinorAmount(minor, discrepancyFactor)} ${discrepancyMarker}`;

  // The economics block is denominated in the APPLICATION's pinned currency,
  // which the money block need not even be present to establish — a MANAGER
  // recording an approval has no money block at all, so falling back to the
  // deal's and then the org's mirrors what the server does rather than
  // rescaling a JOD figure at a USD scale.
  const decisionCurrency = pinnedDecisionCurrency ?? dealCurrency;
  const decisionFactor = useMemo(
    () => Math.pow(10, safeScaleForCurrency(decisionCurrency, 2)),
    [decisionCurrency]
  );
  const decisionMarker =
    locale === "ar" && decisionCurrency === currency.code ? currency.symbol : decisionCurrency;
  /**
   * A figure at the denomination the SERVER served with it (`{code, scale}`),
   * for the summary's evidence facts. No guessing scaler: a served figure
   * without a served denomination is withheld, and the marker follows the
   * same locale rule as every other amount on the screen.
   */
  const servedMoney = (minor: number, served: { code: string; scale: number } | null) => {
    if (denominationUnusable || served === null) return null;
    const servedMarker =
      locale === "ar" && served.code === currency.code ? currency.symbol : served.code;
    return `${formatMinorAmount(minor, Math.pow(10, served.scale))} ${servedMarker}`;
  };
  // Withheld outright rather than approximated: a figure the operator cannot
  // tell is wrong is worse than a visible blank beside the restatement notice.
  const decisionMoney = (minor: number) =>
    denominationUnusable
      ? "—"
      : `${formatMinorAmount(minor, decisionFactor)} ${decisionMarker}`;
  const adviceRecordedLabel =
    discrepancy?.recordedMinor != null ? discrepancyMoney(discrepancy.recordedMinor) : t("Unknown");
  const adviceApprovedLabel =
    discrepancy?.approvedMinor != null ? discrepancyMoney(discrepancy.approvedMinor) : t("Unknown");
  // Only when BOTH are known. A difference computed against an unknown is not a
  // smaller difference, it is not a difference.
  const adviceDifferenceLabel =
    discrepancy?.recordedMinor != null && discrepancy?.approvedMinor != null
      ? discrepancyMoney(Math.abs(discrepancy.recordedMinor - discrepancy.approvedMinor))
      : null;

  return {
    denominationUnusable,
    dealCurrency,
    factor,
    money,
    discrepancy,
    discrepancyFactor,
    decisionFactor,
    decisionMoney,
    servedMoney,
    adviceRecordedLabel,
    adviceApprovedLabel,
    adviceDifferenceLabel,
  };
}
