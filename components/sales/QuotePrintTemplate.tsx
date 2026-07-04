import { Doc } from "@/convex/_generated/dataModel";
import { WizardData } from "./wizard/types";
import { useLanguage } from "@/components/providers/LanguageProvider";

export interface OrgBranding {
  name?: string | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
  address?: string | null;
  phone?: string | null;
  currencySymbol?: string | null;
}

interface QuotePrintTemplateProps {
  paymentType: "CASH" | "INSTALLMENT";
  wizardData: WizardData;
  selectedVehicle?: Doc<"vehicles">;
  selectedCompany?: Doc<"financeCompanies">;
  selectedCustomer: Doc<"customers">;
  selectedResult: any;
  dateStr: string;
  orgBranding?: OrgBranding;
}

export function QuotePrintTemplate({
  wizardData: _wizardData,
  selectedVehicle,
  selectedCompany: _selectedCompany,
  selectedCustomer,
  selectedResult,
  dateStr,
  orgBranding,
}: QuotePrintTemplateProps) {
  const { t, isRtl } = useLanguage();
  const recipientName = selectedResult?.recipientName || `${selectedCustomer.firstName} ${selectedCustomer.lastName}`;

  const condition = (selectedVehicle?.mileage || 0) > 0 ? t("UsedVehicle" as any) : t("NewVehicle" as any);
  const additions = selectedVehicle?.notes || t("None" as any);

  const primary = orgBranding?.primaryColor ?? "#0f172a";
  const logoSrc = orgBranding?.logoUrl ?? "/logo.png";
  const orgName = orgBranding?.name ?? "";
  const orgAddress = orgBranding?.address ?? "";
  const orgPhone = orgBranding?.phone ?? "";
  const currencyLabel = orgBranding?.currencySymbol ?? "JOD";

  return (
    <div
      id="pdf-quote-content"
      className="hidden print:block absolute inset-0 bg-[#ffffff] w-[210mm] h-[297mm] mx-auto text-[#000000] p-12 font-sans relative overflow-hidden box-border"
      dir={isRtl ? "rtl" : "ltr"}
      style={{ boxSizing: "border-box" }}
    >
      {/* Decorative frame */}
      <div
        className="absolute inset-0 pointer-events-none z-0 m-4"
        style={{ border: `6px solid ${primary}` }}
      />
      <div className="absolute inset-0 pointer-events-none z-0 border border-[#dc2626] m-[22px]" />

      {/* Faint Logo Watermark — only shown when an org logo is configured */}
      {orgBranding?.logoUrl && (
        <div className="absolute inset-0 pointer-events-none z-0 flex items-center justify-center opacity-[0.03]">
          <img src={logoSrc} alt="" className="w-[120mm] object-contain rotate-[-12deg]" />
        </div>
      )}

      {/* Corner Accents — top-right */}
      <div className="absolute top-0 right-0 w-24 h-24 pointer-events-none z-0 overflow-hidden">
        <div className="absolute top-[-40px] right-[-40px] w-20 h-20 rotate-45" style={{ backgroundColor: primary }} />
        <div className="absolute top-[-30px] right-[-30px] w-20 h-20 bg-[#dc2626] rotate-45" />
      </div>
      {/* Corner Accents — bottom-left */}
      <div className="absolute bottom-0 left-0 w-24 h-24 pointer-events-none z-0 overflow-hidden">
        <div className="absolute bottom-[-40px] left-[-40px] w-20 h-20 rotate-45" style={{ backgroundColor: primary }} />
        <div className="absolute bottom-[-30px] left-[-30px] w-20 h-20 bg-[#dc2626] rotate-45" />
      </div>

      {/* Main Content */}
      <div className="relative z-10 flex flex-col justify-between h-full w-full">
        <div>
          {/* Header */}
          <div className="flex justify-between items-center border-b border-[#d0e0d8] pb-4 mb-6">
            <div className="flex items-center gap-4">
              <img src={logoSrc} alt="Dealer Logo" className="h-16 object-contain" />
            </div>
            <div className="text-end text-xs text-[#4b5563] space-y-1">
              <p className="font-bold" style={{ color: primary }}>{orgName}</p>
              <p>{t("Date" as any)}: {dateStr}</p>
            </div>
          </div>

          {/* Title */}
          <div className="mb-4 flex justify-center">
            <div
              className="text-center text-[#ffffff] px-8 py-2 rounded-md font-bold text-lg"
              style={{ backgroundColor: primary }}
            >
              {t("VehicleQuote" as any)}
            </div>
          </div>

          {/* Recipient */}
          <div className="mb-6">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-sm font-semibold text-[#4b5563]">{t("QuoteTo" as any)}</span>
              <span className="text-base font-bold" style={{ color: primary }}>{recipientName} {t("Respected" as any)}</span>
            </div>
            <div className="text-center my-2">
              <p className="text-sm font-semibold text-[#4b5563] inline-block pb-1 px-8">{t("Greeting" as any)}</p>
            </div>
          </div>

          {/* Vehicle Info */}
          <div className="mb-6">
            <h2
              className="text-base font-bold border-s-4 border-[#dc2626] ps-2 mb-3"
              style={{ color: primary }}
            >
              {t("VehicleSpecs" as any)}
            </h2>
            <table className="w-full text-xs border-collapse border border-[#e5e7eb]">
              <tbody>
                <tr className="border-b border-[#e5e7eb]">
                  <th scope="row" className="py-2.5 font-semibold text-[#374151] text-start w-1/3 bg-[#f0f4f2] px-3 border-e border-[#e5e7eb]">{t("VehicleType" as any)}:</th>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{selectedVehicle?.make ?? t("NotSpecified" as any)} {selectedVehicle?.model}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <th scope="row" className="py-2.5 font-semibold text-[#374151] text-start bg-[#f0f4f2] px-3 border-e border-[#e5e7eb]">{t("ManufactureYear" as any)}</th>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{selectedVehicle?.year}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <th scope="row" className="py-2.5 font-semibold text-[#374151] text-start bg-[#f0f4f2] px-3 border-e border-[#e5e7eb]">{t("BatteryFuelType" as any)}</th>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{selectedVehicle?.fuelType ?? t("NotSpecified" as any)} {selectedVehicle?.trim ? `(${selectedVehicle.trim})` : ""}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <th scope="row" className="py-2.5 font-semibold text-[#374151] text-start bg-[#f0f4f2] px-3 border-e border-[#e5e7eb]">{t("ConditionNewUsed" as any)}</th>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{condition}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <th scope="row" className="py-2.5 font-semibold text-[#374151] text-start bg-[#f0f4f2] px-3 border-e border-[#e5e7eb]">{t("ChassisNumberVIN" as any)}</th>
                  <td className="py-2.5 px-3 font-mono text-xs text-[#111827]">{selectedVehicle?.vin ?? t("PendingQuoteVIN" as any)}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <th scope="row" className="py-2.5 font-semibold text-[#374151] text-start bg-[#f0f4f2] px-3 border-e border-[#e5e7eb]">{t("AdditionsSpecs" as any)}</th>
                  <td className="py-2.5 px-3 text-[#374151] leading-relaxed">{additions}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Pricing */}
          <div className="mb-6">
            <h2
              className="text-base font-bold border-s-4 border-[#dc2626] ps-2 mb-3"
              style={{ color: primary }}
            >
              {t("FinancialDetails" as any)}
            </h2>
            <table className="w-full text-xs border-collapse border border-[#e5e7eb]">
              <tbody>
                <tr>
                  <th scope="row" className="py-3 font-semibold text-[#374151] text-start w-1/3 bg-[#f0f4f2] px-3 border-e border-[#e5e7eb]">{t("TotalVehiclePrice" as any)}</th>
                  <td className="py-3 px-3 font-bold text-base text-[#dc2626]">
                    {selectedResult?.totalFinancedAmount?.toLocaleString(undefined, { minimumFractionDigits: 2 })} {currencyLabel}
                  </td>
                </tr>
              </tbody>
            </table>
            <br />
            <p className="text-sm font-semibold text-[#4b5563] mt-2 text-center">{t("Respects" as any)}</p>
          </div>
        </div>

        {/* Signature & Footer */}
        <div>
          <div className="mb-16 flex justify-end">
            <div className="text-center w-60">
              <p className="font-bold text-sm" style={{ color: primary }}>({orgName})</p>
              <div className="mt-12 border-t border-dashed border-[#a0bfad] pt-2">
                <p className="text-xs text-[#6b7280]">{t("SealAndSignature" as any)}</p>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-[#e5e7eb] text-xs text-[#4b5563] text-center space-y-1">
            <p className="font-semibold" style={{ color: primary }}>{orgAddress}</p>
            <p dir="ltr" className="font-mono text-[#dc2626] font-bold">{orgPhone}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
