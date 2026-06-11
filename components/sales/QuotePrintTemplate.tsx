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
  // If we can't parse it reliably, we just show the raw notes
  const rawNotes = selectedVehicle?.notes || "";
  let batteryCapacity = "غير محدد";
  let additions = rawNotes || "لا يوجد";

  // If notes look like "Battery: 60kWh | Additions: Leather seats"
  // But without a strict schema, we just put it in additions.

  return (
    <div
      id="pdf-quote-content"
      className="hidden print:block absolute inset-0 bg-[#ffffff] w-[210mm] min-h-[297mm] mx-auto text-[#000000] p-10 font-sans"
      dir="rtl"
    >
      {/* Header with Logo */}
      <div className="flex justify-between items-center border-b-2 border-[#1f2937] pb-6 mb-8">
        <div className="flex items-center gap-4">
          <img src="/BloomLogo.png" alt="Dealer Logo" className="h-20 object-contain" />
          <div>

            {/* <p className="text-[#4b5563] mt-1">{isCash ? "دفع نقدي" : "تقسيط"}</p> */}
          </div>
        </div>
        <div className="text-left text-sm text-[#4b5563] space-y-1">


        </div>
      </div>

      {/* Recipient info */}
      <div className="mb-8">
        <h1 className="text-center mb-6 text-2xl font-bold text-[#111827]">عرض سعر مركبة</h1>
        <p className="text-lg font-bold text-[#1f2937] mb-2">التاريخ: {dateStr}</p>
        <h2 className="text-lg font-bold text-[#1f2937] mb-2">موجه إلى السادة:</h2>
        <p className="text-xl font-semibold">{recipientName}</p>
      </div>

      {/* Vehicle Info */}
      <div className="mb-8">
        <h2 className="text-xl font-bold text-[#1f2937] border-b pb-2 mb-4">مواصفات المركبة</h2>
        <table className="w-full text-sm border-collapse">
          <tbody>
            <tr className="border-b">
              <td className="py-3 font-semibold text-[#374151] w-1/3 bg-[#f9fafb] px-3">نوع المركبة:</td>
              <td className="py-3 px-3">{selectedVehicle?.make || "غير محدد"} {selectedVehicle?.model}</td>
            </tr>
            <tr className="border-b">
              <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">سنة الصنع:</td>
              <td className="py-3 px-3">{selectedVehicle?.year}</td>
            </tr>
            <tr className="border-b">
              <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">سعة البطارية / نوع الوقود:</td>
              <td className="py-3 px-3">{selectedVehicle?.fuelType || "غير محدد"} {selectedVehicle?.trim ? `(${selectedVehicle.trim})` : ''}</td>
            </tr>
            <tr className="border-b">
              <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">الحالة (جديد / مستعمل):</td>
              <td className="py-3 px-3">{condition}</td>
            </tr>
            <tr className="border-b">
              <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">رقم الهيكل (VIN):</td>
              <td className="py-3 px-3 font-mono text-xs">{selectedVehicle?.vin || "قيد الانتظار"}</td>
            </tr>
            <tr className="border-b">
              <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">الإضافات / المواصفات:</td>
              <td className="py-3 px-3">{additions}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Pricing Info */}
      <div className="mb-12">
        <h2 className="text-xl font-bold text-[#1f2937] border-b pb-2 mb-4">التفاصيل المالية</h2>


        <table className="w-full text-sm border-collapse">
          <tbody>
            <tr className="border-b">
              <td className="py-3 font-semibold text-[#374151] w-1/3 bg-[#f9fafb] px-3">سعر المركبة (دينار):</td>
              <td className="py-3 px-3 font-bold text-lg">{selectedResult?.totalFinancedAmount?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            </tr>
            {/* <tr className="border-b">
                <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">الإجمالي للدفع:</td>
                <td className="py-3 px-3 font-bold text-lg">{selectedResult?.totalFinancedAmount?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
              </tr> */}
          </tbody>
        </table>
        {/* ) //(
        //   <table className="w-full text-sm border-collapse">
        //     <tbody>
        //       <tr className="border-b">
        //         <td className="py-3 font-semibold text-[#374151] w-1/3 bg-[#f9fafb] px-3">سعر المركبة (دينار):</td>
        //         <td className="py-3 px-3 font-bold">{(wizardData.vehiclePrice + (wizardData.desiredProfit || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        //       </tr>
        //       <tr className="border-b">
        //         <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">جهة التمويل:</td>
        //         <td className="py-3 px-3 font-bold">{selectedCompany?.name || "غير محدد"}</td>
        //       </tr>
        //       <tr className="border-b">
        //         <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">الدفعة المقدمة:</td>
        //         <td className="py-3 px-3">{wizardData.downPayment?.toLocaleString()} دينار</td>
        //       </tr>
        //       <tr className="border-b">
        //         <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">المدة (أشهر):</td>
        //         <td className="py-3 px-3">{wizardData.termMonths} شهر</td>
        //       </tr>
        //       <tr className="border-b">
        //         <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">نسبة الربح السنوية:</td>
        //         <td className="py-3 px-3">{selectedResult?.profitRateApplied}%</td>
        //       </tr>
        //       <tr className="border-b">
        //         <td className="py-3 font-semibold text-[#374151] bg-[#f9fafb] px-3">إجمالي التمويل:</td>
        //         <td className="py-3 px-3">{selectedResult?.totalFinancedAmount?.toLocaleString(undefined, { minimumFractionDigits: 2 })} دينار</td>
        //       </tr>
        //       <tr>
        //         <td className="py-4 font-bold text-[#111827] bg-[#f3f4f6] px-3 text-lg">القسط الشهري:</td>
        //         <td className="py-4 px-3 font-bold text-xl text-[#4338ca]">{selectedResult?.monthlyInstallment?.toLocaleString(undefined, { minimumFractionDigits: 2 })} دينار</td>
        //       </tr>
        //     </tbody>
        //   </table>
        // )} */}
      </div>

      {/* Signature Section */}
      <div className="mt-24 mb-12 flex justify-end">
        <div className="text-center w-64">
          <p className="font-bold text-[#1f2937] text-lg">(مؤسسة عصر الازدهار للسيارات)</p>
          <div className="mt-16 border-t border-[#1f2937] pt-2">
            <p className="text-sm text-[#4b5563]">الختم والتوقيع</p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-auto pt-8 border-t border-[#e5e7eb] text-sm text-[#6b7280] text-center space-y-1">
        <p>عمان - وادي صقره- قرب صندوق الائتمان العسكري</p>
        <p dir="ltr" className="inline-block">0790888360 | 07 9088 8360</p>
      </div>
    </div>
  );
}
