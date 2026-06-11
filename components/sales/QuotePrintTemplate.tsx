import { Doc } from "@/convex/_generated/dataModel";
import { WizardData } from "./wizard/types";

interface QuotePrintTemplateProps {
  paymentType: "CASH" | "INSTALLMENT";
  wizardData: WizardData;
  selectedVehicle?: Doc<"vehicles">;
  selectedCompany?: Doc<"financeCompanies">;
  selectedCustomer: Doc<"customers">;
  selectedResult: any;
  dateStr: string;
}

export function QuotePrintTemplate({
  paymentType,
  wizardData,
  selectedVehicle,
  selectedCompany,
  selectedCustomer,
  selectedResult,
  dateStr,
}: QuotePrintTemplateProps) {
  const isCash = paymentType === "CASH";
  const recipientName = selectedResult?.recipientName || `${selectedCustomer.firstName} ${selectedCustomer.lastName}`;

  // Calculate condition automatically based on mileage
  const condition = (selectedVehicle?.mileage || 0) > 0 ? "مستعمل" : "جديد";

  // Extract Battery / Additions from notes
  const rawNotes = selectedVehicle?.notes || "";
  let additions = rawNotes || "لا يوجد";

  return (
    <div
      id="pdf-quote-content"
      className="hidden print:block absolute inset-0 bg-[#ffffff] w-[210mm] h-[297mm] mx-auto text-[#000000] p-12 font-sans relative overflow-hidden box-border"
      dir="rtl"
      style={{ boxSizing: "border-box" }}
    >
      {/* Decorative Brand Background Patterns */}
      <div className="absolute inset-0 pointer-events-none z-0 border-[6px] border-[#104f32] m-4" />
      <div className="absolute inset-0 pointer-events-none z-0 border border-[#dc2626] m-[22px]" />

      {/* Faint Logo Watermark in Center */}
      <div className="absolute inset-0 pointer-events-none z-0 flex items-center justify-center opacity-[0.03]">
        <img src="/BloomLogo.png" alt="" className="w-[120mm] object-contain rotate-[-12deg]" />
      </div>

      {/* Top and Bottom Corner Accents */}
      <div className="absolute top-0 right-0 w-24 h-24 pointer-events-none z-0 overflow-hidden">
        <div className="absolute top-[-40px] right-[-40px] w-20 h-20 bg-[#104f32] rotate-45" />
        <div className="absolute top-[-30px] right-[-30px] w-20 h-20 bg-[#dc2626] rotate-45" />
      </div>
      <div className="absolute bottom-0 left-0 w-24 h-24 pointer-events-none z-0 overflow-hidden">
        <div className="absolute bottom-[-40px] left-[-40px] w-20 h-20 bg-[#104f32] rotate-45" />
        <div className="absolute bottom-[-30px] left-[-30px] w-20 h-20 bg-[#dc2626] rotate-45" />
      </div>

      {/* Main Content Wrapper - relative to sit above background */}
      <div className="relative z-10 flex flex-col justify-between h-full w-full">
        <div>
          {/* Header with Logo */}
          <div className="flex justify-between items-center border-b border-[#d0e0d8] pb-4 mb-6">
            <div className="flex items-center gap-4">
              <img src="/BloomLogo.png" alt="Dealer Logo" className="h-16 object-contain" />
              <div>
              </div>
            </div>
            <div className="text-left text-xs text-[#4b5563] space-y-1">
              <p className="font-bold text-[#104f32]">مؤسسة عصر الازدهار للسيارات</p>
              <p>التاريخ: {dateStr}</p>
            </div>
          </div>

          {/* Document Title - Centered */}
          <div className="mb-4 flex justify-center">
            <div className="text-center bg-[#104f32] text-[#ffffff] px-8 py-2 rounded-md font-bold text-lg">
              عرض سعر مركبة
            </div>
          </div>

          {/* Recipient info */}
          <div className="mb-6">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-sm font-semibold text-[#4b5563]">السادة /</span>
              <span className="text-base font-bold text-[#104f32]">{recipientName} المحترمين</span>
            </div>
            {/* Centered Greeting */}
            <div className="text-center my-2">
              <p className="text-sm font-semibold text-[#4b5563] inline-block pb-1 px-8">تحية طيبة وبعد،،،</p>
            </div>
          </div>

          {/* Vehicle Info */}
          <div className="mb-6">
            <h2 className="text-base font-bold text-[#104f32] border-r-4 border-[#dc2626] pr-2 mb-3">مواصفات المركبة</h2>
            <table className="w-full text-xs border-collapse border border-[#e5e7eb]">
              <tbody>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] w-1/3 bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">نوع المركبة:</td>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{selectedVehicle?.make || "غير محدد"} {selectedVehicle?.model}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">سنة الصنع:</td>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{selectedVehicle?.year}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">سعة البطارية / نوع الوقود:</td>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{selectedVehicle?.fuelType || "غير محدد"} {selectedVehicle?.trim ? `(${selectedVehicle.trim})` : ''}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">الحالة (جديد / مستعمل):</td>
                  <td className="py-2.5 px-3 font-medium text-[#111827]">{condition}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">رقم الهيكل (VIN):</td>
                  <td className="py-2.5 px-3 font-mono text-xs text-[#111827]">{selectedVehicle?.vin || "قيد الانتظار"}</td>
                </tr>
                <tr className="border-b border-[#e5e7eb]">
                  <td className="py-2.5 font-semibold text-[#374151] bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">الإضافات / المواصفات:</td>
                  <td className="py-2.5 px-3 text-[#374151] leading-relaxed">{additions}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Pricing Info */}
          <div className="mb-6">
            <h2 className="text-base font-bold text-[#104f32] border-r-4 border-[#dc2626] pr-2 mb-3">التفاصيل المالية</h2>
            <table className="w-full text-xs border-collapse border border-[#e5e7eb]">
              <tbody>
                <tr>
                  <td className="py-3 font-semibold text-[#374151] w-1/3 bg-[#f0f4f2] px-3 border-l border-[#e5e7eb]">سعر المركبة الإجمالي:</td>
                  <td className="py-3 px-3 font-bold text-base text-[#dc2626]">
                    {selectedResult?.totalFinancedAmount?.toLocaleString(undefined, { minimumFractionDigits: 2 })} دينار أردني
                  </td>
                </tr>
              </tbody>
            </table>
            <br></br>
            <p className="text-sm font-semibold text-[#4b5563] mt-2 text-center">وتفضلوا بقبول فائق الإحترام</p>
          </div>
        </div>

        {/* Bottom Section - Signature & Footer */}
        <div>
          {/* Signature Section */}
          <div className="mb-16 flex justify-end">
            <div className="text-center w-60">
              <p className="font-bold text-[#104f32] text-sm">(مؤسسة عصر الازدهار للسيارات)</p>
              <div className="mt-12 border-t border-dashed border-[#a0bfad] pt-2">
                <p className="text-xs text-[#6b7280]">الختم والتوقيع</p>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="pt-4 border-t border-[#e5e7eb] text-xs text-[#4b5563] text-center space-y-1">
            <p className="font-semibold text-[#104f32]">عمان - وادي صقره- قرب صندوق الائتمان العسكري</p>
            <p dir="ltr" className="font-mono text-[#dc2626] font-bold">0790888360 | 0790888360</p>
          </div>
        </div>
      </div>
    </div>
  );
}
