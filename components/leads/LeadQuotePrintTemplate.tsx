"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { DocumentLetterhead, type OrgBranding } from "@/components/print/DocumentLetterhead";

interface LeadQuotePrintTemplateProps {
  customerName: string;
  vehicleSummary: string;
  estimatedPrice: number;
  dateStr: string;
  orgBranding?: OrgBranding;
}

/** Quick, informal price estimate printed directly from a lead — no VIN or persisted quote row yet. */
export function LeadQuotePrintTemplate({
  customerName,
  vehicleSummary,
  estimatedPrice,
  dateStr,
  orgBranding,
}: LeadQuotePrintTemplateProps) {
  const { t, isRtl } = useLanguage();
  // SCRUM-85: the organization's own stored symbol, never a guessed "JOD". With none,
  // the figure is replaced by "currency not configured" rather than printed in a currency nobody chose.
  const currencyLabel = orgBranding?.currencySymbol?.trim() || null;

  return (
    <div
      id="lead-quote-pdf-content"
      className="hidden print:block absolute inset-0 bg-white w-[210mm] h-[297mm] mx-auto text-black p-12 font-sans box-border"
      dir={isRtl ? "rtl" : "ltr"}
    >
      <DocumentLetterhead
        variant="quote"
        orgBranding={orgBranding}
        rightSlot={<p>{t("Date")}: {dateStr}</p>}
      />

      <div className="mt-6 mb-8">
        <p className="text-sm text-gray-600">{t("PreparedFor")}</p>
        <p className="text-lg font-bold">{customerName}</p>
      </div>

      <div className="mb-8">
        <h2 className="text-sm font-semibold uppercase text-gray-500 mb-2">{t("VehicleSpecs")}</h2>
        <p className="text-base">{vehicleSummary}</p>
      </div>

      <div className="mb-8">
        <h2 className="text-sm font-semibold uppercase text-gray-500 mb-2">{t("EstimatedPricing")}</h2>
        <p className="text-xl font-bold">
          {currencyLabel === null
            ? t("CurrencyNotConfigured")
            : `${estimatedPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${currencyLabel}`}
        </p>
      </div>

      <p className="text-xs text-gray-500 mt-12">{t("QuoteValidityNote")}</p>
    </div>
  );
}
