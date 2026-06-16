"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { format } from "date-fns";
import { Loader2, Printer, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

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

  const { vehicle, customer } = sale;
  const orgName = "Auto Dealership";

  return (
    <div className="min-h-screen bg-white">
      {/* Non-printable header */}
      <div className="print:hidden p-4 flex justify-between items-center bg-muted border-b">
        <Button variant="outline" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 me-2" /> {t("Back")}
        </Button>
        <Button onClick={() => window.print()}>
          <Printer className="h-4 w-4 me-2" /> {t("PrintDocumentBtn")}
        </Button>
      </div>

      {/* Printable Area */}
      <div className="max-w-4xl mx-auto p-12 bg-white text-black" id="printable-area">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold uppercase tracking-widest border-b-4 border-black pb-4 mb-2">
            {t("BillOfSale")}
          </h1>
          <p className="text-xl font-semibold">{orgName}</p>
          <p className="text-sm">{t("OfficialRecordOfTransaction")}</p>
        </div>

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
          <table className="w-full text-left text-sm border-collapse">
            <tbody>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("SalePrice")}</th>
                <td className="py-2 text-right">{sale.salePrice.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("DealerFees")}</th>
                <td className="py-2 text-right">{(sale.dealerFees || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("Taxes")}</th>
                <td className="py-2 text-right">{(sale.taxAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("ExtendedWarranty")}</th>
                <td className="py-2 text-right">{(sale.warrantySold || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</td>
              </tr>
              <tr className="border-b">
                <th className="py-2 font-semibold">{t("GAPInsurance")}</th>
                <td className="py-2 text-right">{(sale.gapSold || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</td>
              </tr>
              <tr className="border-b text-red-700">
                <th className="py-2 font-semibold">{t("TradeInAllowance")}</th>
                <td className="py-2 text-right">-{(sale.tradeInValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</td>
              </tr>
              <tr className="border-b text-red-700">
                <th className="py-2 font-semibold">{t("DownPayment")}</th>
                <td className="py-2 text-right">-{(sale.downPayment || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</td>
              </tr>
              <tr className="border-b-2 border-black bg-gray-50">
                <th className="py-3 font-bold text-base">{t("TotalAmountDueFinanced")}</th>
                <td className="py-3 text-right font-bold text-base">{(sale.loanAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</td>
              </tr>
            </tbody>
          </table>
          <p className="text-xs text-gray-500 mt-2">
            {t("PaymentMethodLabel")}: {sale.financingType}
            {sale.financingType === "FINANCED" && sale.termMonths && sale.apr
              ? ` • ${sale.termMonths} ${t("Months")} @ ${sale.apr}% APR`
              : ""}
          </p>
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
