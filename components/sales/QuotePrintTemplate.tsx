import { Doc } from "@/convex/_generated/dataModel";
import { WizardData } from "./wizard/types";

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
  const recipientName = selectedResult?.recipientName || `${selectedCustomer.firstName} ${selectedCustomer.lastName}`;

  const condition = (selectedVehicle?.mileage || 0) > 0 ? "مستعمل" : "جديد";
  const additions = selectedVehicle?.notes || "لا يوجد";

  const primary = orgBranding?.primaryColor ?? "#104f32";
  const logoSrc = orgBranding?.logoUrl ?? "/BloomLogo.png";
  const orgName = orgBranding?.name ?? "مؤسسة عصر الازدهار للسيارات";
  const orgAddress = orgBranding?.address ?? "عمان - وادي صقره- قرب صندوق الائتمان العسكري";
  const orgPhone = orgBranding?.phone ?? "0790888360 | 0790888360";
  const currencyLabel = orgBranding?.currencySymbol ?? "JOD";

  return (
    <div
      id="pdf-quote-content"
      className="hidden print:block absolute inset-0 bg-[#ffffff] w-[210mm] h-[297mm] mx-auto text-[#000000] p-12 font-sans relative overflow-hidden box-border"
      dir="rtl"
      style={{ boxSizing: "border-box" }}
    >
      {/* Decorative frame */}
      <div
        className="absolute inset-0 pointer-events-none z-0 m-4"
        style={{ border: `6px solid ${primary}` }}
      />
      <div className="absolute inset-0 pointer-events-none z-0 border border-[#dc2626] m-[22px]" />

      {/* Faint Logo Watermark */}
      <div className="absolute inset-0 pointer-events-none z-0 flex items-center justify-center opacity-[0.03]">
        <img src={logoSrc} alt="" className="w-[120mm] object-contain rotate-[-12deg]" />
      </div>

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
            <div className="text-left text-xs text-[#4b5563] space-y-1">
              <p className="font-bold" style={{ color: primary }}>{orgName}</p>
              <p>التاريخ: {dateStr}</p>
            </div>
          </div>

          {/* Title */}
          <div className="mb-4 flex justify-center">
            <div
              className="text-center text-[#ffffff] px-8 py-2 rounded-md font-bold text-lg"
              style={{ backgroundColor: primary }}
            >
              عرض سعر مركبة
            </div>
          </div>

          {/* Recipient */}
          <div className="mb-6">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-sm font-semibold text-[#4b5563]">السادة /</span>
              <span className="text-base font-bold" style={{ color: primary }}>{recipientName} المحترمين</span>
            </div>
            <div className="text-center my-2">
              <p className="text-sm font-semibold text-[#4b5563] inline-block pb-1 px-8">تحية طيبة وبعد،،،</p>
            </div>
          </div>

          {/* Vehicle Info */}
          <div className="mb-6">
            <h2
              className="text-base font-bold border-r-4 border-[#dc2626] pr-2 mb-3"
              style={{ color: primary }}
            >
              مواصفات المركبة
            </h2>
            <table className="w-full text-xs border-collapse border border-[#e5e7eb]">
              <tbody>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] w-1/3 bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">نوع المركبة:</td>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{selectedVehicle?.make ?? "غير محدد"} {selectedVehicle?.model}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">سنة الصنع:</td>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{selectedVehicle?.year}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">سعة البطارية / نوع الوقود:</td>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{selectedVehicle?.fuelType ?? "غير محدد"} {selectedVehicle?.trim ? `(${selectedVehicle.trim})` : ""}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">الحالة (جديد / مستعمل):</td>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{condition}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">رقم الهيكل (VIN):</td>
                  <td className="py-2.5 px-3 font-mono text-xs text-[#111827]">{selectedVehicle?.vin ?? "قيد الانتظار"}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">الإضافات / المواصفات:</td>
                  <td className="py-2.5 px-3 text-[#374151] leading-relaxed">{additions}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Pricing */}
          <div className="mb-6">
            <h2
              className="text-base font-bold border-r-4 border-[#dc2626] pr-2 mb-3"
              style={{ color: primary }}
            >
              التفاصيل المالية
            </h2>
            <table className="w-full text-xs border-collapse border border-[#e5e7eb]">
              <tbody>
                <tr>
                  <td className="py-3 font-semibold text-[#374151] w-1/3 bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">سعر المركبة الإجمالي:</td>
                  <td className="py-3 px-3 font-bold text-base text-[#dc2626]">
                    {selectedResult?.totalFinancedAmount?.toLocaleString(undefined, { minimumFractionDigits: 2 })} {currencyLabel}
                  </td>
                </tr>
              </tbody>
            </table>
            <br />
            <p className="text-sm font-semibold text-[#4b5563] mt-2 text-center">وتفضلوا بقبول فائق الإحترام</p>
          </div>
        </div>

        {/* Signature & Footer */}
        <div>
          <div className="mb-16 flex justify-end">
            <div className="text-center w-60">
              <p className="font-bold text-sm" style={{ color: primary }}>({orgName})</p>
              <div className="mt-12 border-t border-dashed border-[#a0bfad] pt-2">
                <p className="text-xs text-[#6b7280]">الختم والتوقيع</p>
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
