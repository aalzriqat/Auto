import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import {
  disbursementDenominationRefusal,
  finalizeDenominationRefusal,
} from "@/components/applications/settlementDenomination";
import type { useCurrency } from "@/hooks/useCurrency";
import { formatMinorAmount, formatMoneyAmount } from "@/lib/moneyDisplay";
import type { FinancingPlanFacts } from "./FinancingPlanPanel";
import { safeScaleForCurrency } from "./useDealMoneyPresentation";

export function buildFinancedDealMoney({
  app,
  deal,
  orgCurrency,
  locale,
  canRecordSupplierRoute,
  canConfirmFinanceDisbursement,
  t,
}: Readonly<{
  app: FunctionReturnType<typeof api.applications.get> | undefined;
  deal:
    | FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
    | undefined;
  orgCurrency: ReturnType<typeof useCurrency>;
  locale: string;
  canRecordSupplierRoute: boolean;
  canConfirmFinanceDisbursement: boolean;
  t: (key: string) => string;
}>) {
  const currencyMarker = (cur: string) => {
    if (cur === orgCurrency.code) {
      if (locale === "ar") {
        return (
          orgCurrency.symbol ??
          (cur === "JOD" ? "د.أ" : orgCurrency.displayLabel)
        );
      }
      return orgCurrency.displayLabel;
    }
    return cur;
  };

  // ---- the same derivations the Review dialog made, from the same payload ----
  // The dealer-side economics are denominated in the application's OWN pinned
  // currency, not the org's current one; the customer's principal is read at
  // the org scale, as the dialog reads it. Absent means the row predates the
  // field, and the org's currency is then the only reading available.
  const orgScale = safeScaleForCurrency(orgCurrency.code, 2);
  const orgFactor = Math.pow(10, orgScale);
  const economicsCurrencyCode = app?.economicsCurrency ?? orgCurrency.code;
  const economicsScale = safeScaleForCurrency(economicsCurrencyCode, 2);
  const economicsFactor = Math.pow(10, economicsScale);
  /**
   * What the finance company actually owes the dealership — the figure
   * `confirmDisbursement` compares against.
   *
   * `finalizeDeal` freezes `financedSaleNetReceivableMinor`: the principal
   * less every deposit the dealership holds and every cost the company
   * withholds. The server checks the caller's amount against THAT first, and
   * only a legacy row that predates the field is checked against the
   * principal. Sending the principal unconditionally — as the Review dialog
   * still does — is a guaranteed refusal on any deal with an applied deposit
   * or a withheld fee, from a dialog that offers no way to type the right
   * number. The same value is displayed and sent, so what the operator
   * confirms is what the server receives. SCRUM-241 owns making this a
   * server-projected authority; until then the frozen snapshot is read here.
   */
  const principalMinor = Math.round(
    (app?.quote?.totalFinancedAmount ?? 0) * orgFactor,
  );
  const frozenNetMinor = app?.financedSaleNetReceivableMinor;
  const expectedDisbursementMinor = frozenNetMinor ?? principalMinor;
  const expectsFinanceCompanyDisbursement = Boolean(
    app?.companyId && expectedDisbursementMinor > 0,
  );
  const isConsignedDeal = app?.vehicle?.sourceType === "SOURCED";
  const settlesDirectToSupplier =
    isConsignedDeal && app?.supplierSettlementRoute === "DIRECT_TO_SUPPLIER";
  const supplierName = app?.vehicle?.sourcedFromName ?? undefined;
  const formatEconomics = (minor: number) => {
    return `${formatMinorAmount(minor, economicsFactor)} ${
      economicsCurrencyCode === orgCurrency.code
        ? currencyMarker(economicsCurrencyCode)
        : economicsCurrencyCode
    }`;
  };
  /**
   * The customer's plan, read straight off the quote `applications.get`
   * already serves this caller. Nothing is computed from anything else: a
   * figure the quote does not carry is shown as unavailable. The national
   * identifier is exactly the field the Review dialog shows the same caller,
   * masked here by default.
   */
  const financingPlan: FinancingPlanFacts | undefined =
    app && app.quote
      ? {
          financierName: deal?.financeCompanyName || null,
          currency: economicsCurrencyCode,
          vehiclePrice:
            app.targetSellingAmountMinor !== undefined
              ? app.targetSellingAmountMinor / economicsFactor
              : app.quote.vehiclePrice,
          downPayment:
            app.customerFirstPaymentMinor !== undefined
              ? app.customerFirstPaymentMinor / economicsFactor
              : app.quote.downPayment,
          termMonths: app.quote.termMonths,
          monthlyInstallment: app.quote.monthlyInstallment,
          totalFinancedAmount: app.quote.totalFinancedAmount,
          nationalId: app.customer?.nationalId?.trim() || null,
        }
      : undefined;
  const formatPlanMajor = (major: number, currency: string) => {
    const scale = safeScaleForCurrency(currency, 2);
    return `${formatMoneyAmount(major, currency, scale)} ${
      currency === orgCurrency.code ? currencyMarker(currency) : currency
    }`;
  };
  /**
   * The frozen net is built in the deal's PINNED currency
   * (`resolveFinancedSalePlan` runs in `app.economicsCurrency ?? org`), so it is
   * spelled at that scale with that label. The legacy principal is a
   * quote-major figure the server scales by the ORG currency, so it keeps the
   * org denomination. Mixing the two — a JOD-scale factor over a USD-pinned
   * integer — is a 10× lie beside a confirm button.
   */
  const expectedDisbursementLabel =
    frozenNetMinor !== undefined
      ? formatEconomics(frozenNetMinor)
      : orgCurrency.format(principalMinor / orgFactor);
  /**
   * The server's currency boundary, mirrored (SCRUM-241, see
   * `settlementDenomination.ts`). The close is refused for EVERY pinned deal
   * whose currency drifted from the org's current one — the sale would post
   * under the wrong label — so it is withheld here with the reason. The
   * receipt on a closed deal is NOT: it settles the receivable in the
   * receivable's own denomination, whatever the org setting says now. Only a
   * deal with a named finance company settling through the dealership has
   * that receipt, and the one refusal left on it is an unrecognised pin.
   */
  const finalizeDenominationBlock = app
    ? finalizeDenominationRefusal(app.economicsCurrency, orgCurrency.code)
    : undefined;
  const disbursementDenominationBlock =
    app?.companyId && !settlesDirectToSupplier
      ? disbursementDenominationRefusal(app.economicsCurrency)
      : undefined;
  /**
   * The recorded currency beside the org's current one. Structured rather
   * than one string: under an RTL base a money run and its code swap order
   * ("USD 15,625") unless each run is its own LTR isolate.
   */
  const finalizeDenominationDetail =
    finalizeDenominationBlock && app
      ? {
          recordedLabel: t("RecordedEconomicsCurrency"),
          recordedAmount: app.economicsCurrency ?? orgCurrency.code,
          orgLabel: t("OrganisationCurrencyLabel"),
          orgCurrency: orgCurrency.code,
        }
      : undefined;
  const disbursementDenominationDetail = disbursementDenominationBlock
    ? {
        recordedLabel: t("RecordedSettlementAmount"),
        recordedAmount: expectedDisbursementLabel,
        orgLabel: t("OrganisationCurrencyLabel"),
        orgCurrency: orgCurrency.code,
      }
    : undefined;
  // The route is a decision about a deal that has not posted yet; once it
  // closes, changing it is a correction and the server refuses it there too.
  // Keyed on MANAGE_SUPPLIER_SETTLEMENT, matching the server.
  const canChooseSettlementRoute =
    app != null &&
    canRecordSupplierRoute &&
    isConsignedDeal &&
    app.status !== "CLOSED" &&
    app.status !== "CANCELLED";
  /**
   * SCRUM-447 N1-A: the cheque states in which `confirmDisbursement` REFUSES
   * (a cleared cheque awaiting accounting review, a live cheque whose face was
   * never recorded, a returned/cancelled one awaiting correction, or no payment
   * registered on a closed deal). The rail withholds the confirmation exactly
   * there and names the cheque panel's own notice, in the panel's order, so it
   * never offers a step the server would refuse. Review comes first, as on the
   * server, where a CLEARED row is named first.
   */
  const chequeDisbursementBlockKey: string | undefined =
    deal?.chequeNeedsAccountingReview === true
      ? "FcAccountingReviewNotice"
      : deal?.chequeFaceUnrecorded === true
        ? "FcChequeFaceUnrecordedNotice"
        : deal?.chequeNeedsCorrection === true
          ? "FcCorrectNeededNotice"
          : deal?.expectedPaymentReRegistrable === true
            ? "FcReRegisterNotice"
            : undefined;
  // On the direct route the company pays the supplier, so there is no
  // dealership receipt to confirm — `confirmDisbursement` would invent cash.
  const canConfirmDisbursement =
    app != null &&
    canConfirmFinanceDisbursement &&
    app.status === "CLOSED" &&
    expectsFinanceCompanyDisbursement &&
    !settlesDirectToSupplier &&
    !app.disbursedAt &&
    !(
      deal?.forward?.applies === true &&
      deal.forward.state !== "SETTLED" &&
      deal.forward.state !== "NOT_DUE"
    ) &&
    disbursementDenominationBlock === undefined &&
    chequeDisbursementBlockKey === undefined;
  // Gated on the SERVER's own answer (`canSettleDirectToSupplier`), not on
  // `companyId`, which is unset on every MANUAL_FINANCE_COMPANY deal.
  const canConfirmSupplierDisbursement =
    app != null &&
    canConfirmFinanceDisbursement &&
    app.status === "CLOSED" &&
    settlesDirectToSupplier &&
    app.canSettleDirectToSupplier &&
    !app.supplierDisbursementStatus;

  return {
    economicsCurrencyCode,
    economicsFactor,
    currencyMarker,
    formatEconomics,
    isConsignedDeal,
    settlesDirectToSupplier,
    supplierName,
    financingPlan,
    formatPlanMajor,
    expectedDisbursementLabel,
    expectedDisbursementMinor,
    finalizeDenominationBlock,
    disbursementDenominationBlock,
    finalizeDenominationDetail,
    disbursementDenominationDetail,
    canChooseSettlementRoute,
    chequeDisbursementBlockKey,
    canConfirmDisbursement,
    canConfirmSupplierDisbursement,
  };
}
