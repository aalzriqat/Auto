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
import { format } from "date-fns";
import { Loader2, Printer, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentLetterhead } from "@/components/print/DocumentLetterhead";

/** What the server says the document may state. `LOAD_FAILED` is local: the query could not run at all. */
type Economics =
  | FunctionReturnType<typeof api.sales.getBillOfSaleEconomics>
  | { kind: "UNAVAILABLE"; reason: "LOAD_FAILED" };

type SaleWithParties = NonNullable<FunctionReturnType<typeof api.sales.get>>;

const LOAD_FAILED: Economics = { kind: "UNAVAILABLE", reason: "LOAD_FAILED" };

const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2 });

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
  const router = useRouter();
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const saleId = params.saleId as Id<"sales">;

  const sale = useQuery(api.sales.get, activeOrgId ? { orgId: activeOrgId, saleId } : "skip");

  useEffect(() => {
    document.body.classList.add("print-mode");
    return () => {
      document.body.classList.remove("print-mode");
    };
  }, []);

  if (sale === undefined) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (sale === null || !sale.vehicle || !sale.customer) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <p className="text-xl font-bold mb-4">{t("SaleRecordNotFound")}</p>
        <Button onClick={() => router.back()}>{t("GoBack")}</Button>
      </div>
    );
  }

  return (
    <EconomicsBoundary fallback={<BillOfSaleView sale={sale} economics={LOAD_FAILED} />}>
      <BillOfSaleWithEconomics sale={sale} />
    </EconomicsBoundary>
  );
}

/** Reads the one authoritative source of the totals. It throws when the backend lacks it: see EconomicsBoundary. */
function BillOfSaleWithEconomics({ sale }: { sale: SaleWithParties }) {
  const { activeOrgId } = useOrg();
  const economics = useQuery(
    api.sales.getBillOfSaleEconomics,
    activeOrgId ? { orgId: activeOrgId, saleId: sale._id } : "skip"
  );
  return <BillOfSaleView sale={sale} economics={economics} />;
}

/**
 * SCRUM-258: every total on this document comes from `economics`, never from the sale row's own
 * `loanAmount` / `downPayment` / `apr` / `termMonths`, and never from a finance-approval amount.
 */
function BillOfSaleView({ sale, economics }: { sale: SaleWithParties; economics: Economics | undefined }) {
  const router = useRouter();
  const { activeOrgId } = useOrg();
  const { t, isRtl } = useLanguage();
  const orgSettings = useOrgSettings();
  const logoUrl = useQuery(
    api.orgSettings.getLogoUrl,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const { vehicle, customer } = sale;
  if (!vehicle || !customer) return null;
  const orgName = orgSettings?.dealershipName || "AutoFlow";
  const currencySymbol = orgSettings?.currencySymbol || "JOD";
  const printable = economics !== undefined && economics.kind !== "UNAVAILABLE";

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
      <div className="max-w-4xl mx-auto p-12 bg-white text-black" id="printable-area" dir={isRtl ? "rtl" : "ltr"}>
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

        <div className="grid grid-cols-2 gap-12 mb-8">
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
            <p>{t("Email")}: {customer.email || "—"}</p>
            <p>{t("NationalId")}: {customer.nationalId || "—"}</p>
          </div>
        </div>

        <div className="mb-8">
          <h2 className="text-lg font-bold border-b border-black mb-2 uppercase">{t("PrintVehicleDescription")}</h2>
          <table className="w-full text-left text-sm border-collapse">
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
                <td className="py-2 font-mono font-bold tracking-wider">{vehicle.vin}</td>
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
          <FinancialTotals sale={sale} economics={economics} currencySymbol={currencySymbol} />
        </div>

        <div className="mb-12">
          <p className="text-sm leading-relaxed mb-4 text-justify">{t("BillOfSaleDisclaimer")}</p>
          <p className="text-sm font-semibold mb-12">{t("OdometerStatement")}</p>

          <div className="grid grid-cols-2 gap-12 mt-16">
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

/** The itemisation and the total. One branch per kind of economics: each states its own arithmetic. */
function FinancialTotals({
  sale,
  economics,
  currencySymbol,
}: {
  sale: SaleWithParties;
  economics: Economics | undefined;
  currencySymbol: string;
}) {
  const { t } = useLanguage();

  if (economics === undefined) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (economics.kind === "UNAVAILABLE") {
    const reasonKey =
      economics.reason === "NOT_COMPLETED" || economics.reason === "LOAD_FAILED"
        ? (`BillOfSaleUnavailable_${economics.reason}` as const)
        : "BillOfSaleUnavailable_DEFAULT";
    return (
      <div className="border border-black p-4 text-sm" role="alert">
        <p className="font-bold">{t("BillOfSaleFiguresUnavailable")}</p>
        <p className="mt-1">{t(reasonKey)}</p>
      </div>
    );
  }

  const unit = economics.currency || currencySymbol;

  return (
    <>
      <table className="w-full text-left text-sm border-collapse">
        <tbody>
          {economics.kind === "CASH" ? (
            <>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("SalePrice")}</th>
                <td className="py-2 text-right">{money(sale.salePrice)} {currencySymbol}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("DealerFees")}</th>
                <td className="py-2 text-right">{money(sale.dealerFees || 0)} {currencySymbol}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("Taxes")}</th>
                <td className="py-2 text-right">{money(sale.taxAmount || 0)} {currencySymbol}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("ExtendedWarranty")}</th>
                <td className="py-2 text-right">{money(sale.warrantySold || 0)} {currencySymbol}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("GAPInsurance")}</th>
                <td className="py-2 text-right">{money(sale.gapSold || 0)} {currencySymbol}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("TotalBilled")}</th>
                <td className="py-2 text-right">{money(economics.totalBilled)} {unit}</td>
              </tr>
              {economics.tradeInCredit > 0 && (
                <tr className="border-b text-red-700">
                  <th className="py-2 font-semibold">{t("TradeInCredit")}</th>
                  <td className="py-2 text-right">-{money(economics.tradeInCredit)} {unit}</td>
                </tr>
              )}
              {economics.depositsApplied > 0 && (
                <tr className="border-b text-red-700">
                  <th className="py-2 font-semibold">{t("DepositsApplied")}</th>
                  <td className="py-2 text-right">-{money(economics.depositsApplied)} {unit}</td>
                </tr>
              )}
              <tr className="border-b-2 border-black bg-gray-50">
                <th className="py-3 font-bold text-base">{t("BalanceDue")}</th>
                <td className="py-3 text-right font-bold text-base">{money(economics.balanceDue)} {unit}</td>
              </tr>
            </>
          ) : (
            <>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("VehiclePrice")}</th>
                <td className="py-2 text-right">{money(economics.vehiclePrice)} {unit}</td>
              </tr>
              <tr className="border-b text-red-700">
                <th className="py-2 font-semibold">{t("DownPayment")}</th>
                <td className="py-2 text-right">-{money(economics.downPayment)} {unit}</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("ExecutionFees")}</th>
                <td className="py-2 text-right">+{money(economics.executionFees)} {unit}</td>
              </tr>
              {economics.capitalisedCommission > 0 && (
                <tr className="border-b">
                  <th className="py-2 font-semibold">{t("CapitalisedCommission")}</th>
                  <td className="py-2 text-right">+{money(economics.capitalisedCommission)} {unit}</td>
                </tr>
              )}
              <tr className="border-b-2 border-black bg-gray-50">
                <th className="py-3 font-bold text-base">{t("AmountFinanced")}</th>
                <td className="py-3 text-right font-bold text-base">{money(economics.amountFinanced)} {unit}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
      <p className="text-xs text-gray-500 mt-2">
        {t("PaymentMethodLabel")}: {sale.financingType}
        {economics.kind === "FINANCED"
          ? ` • ${economics.termMonths} ${t("Months")} • ${
              economics.flatAnnualProfitRatePercent === null
                ? t("RateNotStated")
                : `${t("FlatAnnualProfitRate")} ${economics.flatAnnualProfitRatePercent}%`
            }`
          : ""}
      </p>
    </>
  );
}
