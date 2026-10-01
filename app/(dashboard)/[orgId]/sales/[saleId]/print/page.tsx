"use client";

import { Component, useEffect, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { useCurrencyFormatterInCurrency } from "@/hooks/useCurrencyFormatter";
import { supportedCurrencyScale } from "@/components/accounting/AccountingTabShared";
import { format } from "date-fns";
import { Loader2, Printer, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentLetterhead } from "@/components/print/DocumentLetterhead";

/** What the server says the document may state. `LOAD_FAILED` is local: the query could not run at all. */
type Economics =
  | FunctionReturnType<typeof api.sales.getBillOfSaleEconomics>
  | { kind: "UNAVAILABLE"; reason: "LOAD_FAILED" };
type StatedEconomics = Exclude<Economics, { kind: "UNAVAILABLE" }>;

type SaleWithParties = NonNullable<FunctionReturnType<typeof api.sales.get>>;
/** A sale whose vehicle and customer exist: the only thing the document can be printed for. */
type PrintableSale = SaleWithParties & {
  vehicle: NonNullable<SaleWithParties["vehicle"]>;
  customer: NonNullable<SaleWithParties["customer"]>;
};

function isPrintable(sale: SaleWithParties | null): sale is PrintableSale {
  return sale !== null && !!sale.vehicle && !!sale.customer;
}

/** The one status of the totals block, derived once from `economics`. `printable` is `status === "ready"`. */
type TotalsView =
  | { status: "loading" }
  | { status: "unavailable"; reason: string }
  | { status: "ready"; economics: StatedEconomics; scale: number };

function toTotalsView(economics: Economics | undefined): TotalsView {
  if (economics === undefined) return { status: "loading" };
  if (economics.kind === "UNAVAILABLE") return { status: "unavailable", reason: economics.reason };
  // A currency whose decimal scale is unknown cannot be printed correctly: say so rather than guess.
  const scale = supportedCurrencyScale(economics.currency);
  if (scale === null) return { status: "unavailable", reason: "CURRENCY_MISMATCH" };
  return { status: "ready", economics, scale };
}

/** Reason-specific text where it helps; every other reason shows the DEFAULT text. */
const UNAVAILABLE_TEXT_KEY: Record<string, string> = {
  NOT_COMPLETED: "BillOfSaleUnavailable_NOT_COMPLETED",
  LOAD_FAILED: "BillOfSaleUnavailable_LOAD_FAILED",
};

type Branding = {
  orgSettings: ReturnType<typeof useOrgSettings>;
  logoUrl: string | null | undefined;
};

/**
 * Catches the economics query throwing (an older backend that does not have the function yet, or
 * a refused read) and shows the unavailable state instead of a crashed legal document. Printing
 * is disabled in that state: a Bill of Sale never falls back to a number it did not get.
 */
class EconomicsBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("Bill of Sale economics failed to load", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function PrintBillOfSalePage() {
  const params = useParams();
  const { activeOrgId } = useOrg();
  const saleId = params.saleId as Id<"sales">;
  // Hoisted: the branding reads do not depend on the sale, so they subscribe with the first render.
  const orgSettings = useOrgSettings();
  const logoUrl = useQuery(api.orgSettings.getLogoUrl, activeOrgId ? { orgId: activeOrgId } : "skip");
  const branding: Branding = { orgSettings, logoUrl };

  useEffect(() => {
    document.body.classList.add("print-mode");
    return () => {
      document.body.classList.remove("print-mode");
    };
  }, []);

  // The throwing useQuery stays inside the boundary. Economics subscribes in parallel with sales.get.
  return (
    <EconomicsBoundary
      fallback={<BillOfSaleWithEconomics saleId={saleId} branding={branding} loadFailed />}
    >
      <BillOfSaleWithEconomics saleId={saleId} branding={branding} />
    </EconomicsBoundary>
  );
}

/**
 * Reads the sale and the one authoritative source of the totals. The economics query throws when
 * the backend lacks it: see EconomicsBoundary, which re-renders this with `loadFailed`.
 */
function BillOfSaleWithEconomics({
  saleId,
  branding,
  loadFailed = false,
}: {
  saleId: Id<"sales">;
  branding: Branding;
  loadFailed?: boolean;
}) {
  const router = useRouter();
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const sale = useQuery(api.sales.get, activeOrgId ? { orgId: activeOrgId, saleId } : "skip");
  const economics = useQuery(
    api.sales.getBillOfSaleEconomics,
    activeOrgId && !loadFailed ? { orgId: activeOrgId, saleId } : "skip"
  );

  if (sale === undefined) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isPrintable(sale)) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <p className="text-xl font-bold mb-4">{t("SaleRecordNotFound")}</p>
        <Button onClick={() => router.back()}>{t("GoBack")}</Button>
      </div>
    );
  }

  return (
    <BillOfSaleView
      sale={sale}
      economics={loadFailed ? { kind: "UNAVAILABLE", reason: "LOAD_FAILED" } : economics}
      branding={branding}
    />
  );
}

/**
 * SCRUM-258: every total on this document comes from `economics`, never from the sale row's own
 * `loanAmount` / `downPayment` / `apr` / `termMonths`, and never from a finance-approval amount.
 */
function BillOfSaleView({
  sale,
  economics,
  branding,
}: {
  sale: PrintableSale;
  economics: Economics | undefined;
  branding: Branding;
}) {
  const router = useRouter();
  const { t, isRtl } = useLanguage();
  const { orgSettings, logoUrl } = branding;

  const { vehicle, customer } = sale;
  const orgName = orgSettings?.dealershipName || "AutoFlow";
  const view = toTotalsView(economics);
  const printable = view.status === "ready";

  return (
    <div className="min-h-screen bg-white">
      {/* Non-printable header */}
      <div className="print:hidden p-4 flex justify-between items-center bg-muted border-b">
        <Button variant="outline" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 me-2" /> {t("Back")}
        </Button>
        <Button onClick={() => window.print()} disabled={!printable}>
          <Printer className="h-4 w-4 me-2" /> {t("PrintDocumentBtn")}
        </Button>
      </div>

      {/* Printable Area */}
      <div className="max-w-4xl mx-auto p-4 sm:p-12 bg-white text-black" id="printable-area" dir={isRtl ? "rtl" : "ltr"}>
        <DocumentLetterhead
          variant="legal"
          titleLabel={t("BillOfSale")}
          orgBranding={{
            name: orgSettings?.dealershipName,
            legalName: orgSettings?.legalCompanyName,
            logoUrl,
            primaryColor: orgSettings?.primaryColor,
          }}
        />
        <p className="text-center text-sm mb-8 -mt-4">{t("OfficialRecordOfTransaction")}</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-12 mb-8">
          <div>
            <h2 className="text-lg font-bold border-b border-black mb-2 uppercase">{t("SellerInformation")}</h2>
            <p className="font-semibold">{orgName}</p>
            <p>{t("Salesperson")}: {sale.salesperson?.name || "—"}</p>
          </div>
          <div>
            <h2 className="text-lg font-bold border-b border-black mb-2 uppercase">{t("BuyerInformation")}</h2>
            <p className="font-semibold">{customer.firstName} {customer.lastName}</p>
            <p>{t("Address")}: {customer.address || "—"}</p>
            <p>{t("Phone")}: {customer.phone || "—"}</p>
            <p className="break-all">{t("Email")}: {customer.email || "—"}</p>
            <p>{t("NationalId")}: {customer.nationalId || "—"}</p>
          </div>
        </div>

        <div className="mb-8">
          <h2 className="text-lg font-bold border-b border-black mb-2 uppercase">{t("PrintVehicleDescription")}</h2>
          <table className="w-full text-left text-sm border-collapse break-words">
            <tbody>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("Make")}</th>
                <td className="py-2">{vehicle.make}</td>
                <th className="py-2 font-semibold">{t("Model")}</th>
                <td className="py-2">{vehicle.model}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("Year")}</th>
                <td className="py-2">{vehicle.year}</td>
                <th className="py-2 font-semibold">{t("Trim")}</th>
                <td className="py-2">{vehicle.trim || "—"}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("VIN")}</th>
                <td className="py-2 font-mono font-bold tracking-wider break-all">{vehicle.vin}</td>
                <th className="py-2 font-semibold">{t("Color")}</th>
                <td className="py-2">{vehicle.color}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("Mileage")}</th>
                <td className="py-2">{vehicle.mileage.toLocaleString()}</td>
                <th className="py-2 font-semibold">{t("FuelType")}</th>
                <td className="py-2">{vehicle.fuelType}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mb-12">
          <h2 className="text-lg font-bold border-b border-black mb-2 uppercase">{t("FinancialDetails")}</h2>
          <FinancialTotals sale={sale} view={view} />
        </div>

        <div className="mb-12">
          <p className="text-sm leading-relaxed mb-4 text-justify">{t("BillOfSaleDisclaimer")}</p>
          <p className="text-sm font-semibold mb-12">{t("OdometerStatement")}</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 sm:gap-12 mt-16">
            <div>
              <div className="border-b border-black h-8 mb-2"></div>
              <p className="font-semibold text-sm">{t("SellerSignature")}</p>
              <p className="text-xs mt-1">{t("Date")}: {format(sale.saleDate, "PP")}</p>
            </div>
            <div>
              <div className="border-b border-black h-8 mb-2"></div>
              <p className="font-semibold text-sm">{t("BuyerSignature")} ({customer.firstName} {customer.lastName})</p>
              <p className="text-xs mt-1">{t("Date")}: {format(sale.saleDate, "PP")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** U+2212, a true minus sign: unlike the hyphen it is not bidi-weak punctuation glued to the label. */
const MINUS_SIGN = "\u2212";

/** The sale type in the reader's language. An unknown value is "—", never a raw enum. */
function financingTypeLabel(financingType: string | undefined, t: (key: string) => string): string {
  if (financingType === "CASH") return t("Cash");
  if (financingType === "FINANCED") return t("Financed");
  return "—";
}

/** One line of the totals table. `total` is the bold closing line; `tone="credit"` marks a deduction. */
function Row({
  label,
  amount,
  sign,
  tone,
  total,
}: {
  label: string;
  amount: string;
  sign?: "+" | "-";
  tone?: "credit";
  total?: boolean;
}) {
  return (
    <tr
      className={[
        total ? "border-b-2 border-black bg-gray-50" : "border-b",
        tone === "credit" ? "text-red-700" : "",
      ].join(" ").trim()}
    >
      <th className={total ? "py-3 text-start font-bold text-base" : "py-2 text-start font-semibold"}>{label}</th>
      <td
        className={
          total
            ? "py-3 w-40 text-end tabular-nums whitespace-nowrap font-bold text-base"
            : "py-2 w-40 text-end tabular-nums whitespace-nowrap"
        }
      >
        {/* One isolated left-to-right unit: the sign never detaches from its figure in RTL. */}
        <bdi dir="ltr">
          {sign === "-" ? MINUS_SIGN : sign}
          {amount}
        </bdi>
      </td>
    </tr>
  );
}

/** The itemisation and the total. One branch per kind of economics: each states its own arithmetic. */
function FinancialTotals({ sale, view }: { sale: PrintableSale; view: TotalsView }) {
  const { t } = useLanguage();
  const formatInCurrency = useCurrencyFormatterInCurrency();

  if (view.status === "loading") {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (view.status === "unavailable") {
    const reasonKey = UNAVAILABLE_TEXT_KEY[view.reason] ?? "BillOfSaleUnavailable_DEFAULT";
    return (
      <div className="border border-black p-4 text-sm" role="alert">
        <p className="font-bold">{t("BillOfSaleFiguresUnavailable")}</p>
        <p className="mt-1">{t(reasonKey)}</p>
      </div>
    );
  }

  const { economics, scale } = view;
  const fmt = (amount: number) => formatInCurrency(amount, economics.currency, scale);

  return (
    <>
      <table className="w-full text-start text-sm border-collapse">
        <tbody>
          {economics.kind === "CASH" ? (
            <>
              <Row
                label={t(economics.vehicleSettledWithSupplier ? "VehiclePaidToSupplier" : "SalePrice")}
                amount={fmt(economics.vehicle)}
              />
              {economics.dealerFees > 0 && <Row label={t("DealerFees")} amount={fmt(economics.dealerFees)} />}
              {economics.taxes > 0 && <Row label={t("Taxes")} amount={fmt(economics.taxes)} />}
              {economics.warranty > 0 && <Row label={t("ExtendedWarranty")} amount={fmt(economics.warranty)} />}
              {economics.gap > 0 && <Row label={t("GAPInsurance")} amount={fmt(economics.gap)} />}
              <Row label={t("TotalBilled")} amount={fmt(economics.totalBilled)} />
              {economics.tradeInCredit > 0 && (
                <Row label={t("TradeInCredit")} amount={fmt(economics.tradeInCredit)} sign="-" tone="credit" />
              )}
              {economics.depositsApplied > 0 && (
                <Row label={t("DepositsApplied")} amount={fmt(economics.depositsApplied)} sign="-" tone="credit" />
              )}
              <Row label={t("BalanceDue")} amount={fmt(economics.balanceDue)} total />
            </>
          ) : (
            <>
              <Row label={t("VehiclePrice")} amount={fmt(economics.vehiclePrice)} />
              <Row label={t("DownPayment")} amount={fmt(economics.downPayment)} sign="-" tone="credit" />
              <Row label={t("ExecutionFees")} amount={fmt(economics.executionFees)} sign="+" />
              {economics.capitalisedCommission > 0 && (
                <Row label={t("CapitalisedCommission")} amount={fmt(economics.capitalisedCommission)} sign="+" />
              )}
              <Row label={t("AmountFinanced")} amount={fmt(economics.amountFinanced)} total />
            </>
          )}
        </tbody>
      </table>
      <p className="text-xs text-gray-500 mt-2">
        {t("PaymentMethodLabel")}: {financingTypeLabel(sale.financingType, t)}
        {economics.kind === "FINANCED" && (
          <>
            {" • "}
            {t("FinancingTermMonths")}: <bdi dir="ltr">{economics.termMonths}</bdi>
            {" • "}
            {economics.flatAnnualProfitRatePercent === null ? (
              t("RateNotStated")
            ) : (
              <>
                {t("FlatAnnualProfitRate")} <bdi dir="ltr">{economics.flatAnnualProfitRatePercent}%</bdi>
              </>
            )}
          </>
        )}
      </p>
    </>
  );
}
