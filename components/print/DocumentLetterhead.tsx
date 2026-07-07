"use client";

import type { ReactNode } from "react";
import { useLanguage } from "@/components/providers/LanguageProvider";

/**
 * Shared org-branding shape for every printed/PDF document in the app
 * (quotes, bill of sale, receipt vouchers, ...). `legalName` is the
 * officially registered company name; `name` is the dealership/trade name.
 */
export interface OrgBranding {
  name?: string | null;
  legalName?: string | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
  address?: string | null;
  phone?: string | null;
  currencySymbol?: string | null;
}

interface DocumentLetterheadProps {
  orgBranding?: OrgBranding;
  /** "quote" keeps the decorative marketing header used on the wizard quote PDF; "legal" is a crisper, formal letterhead for contracts/vouchers. */
  variant: "quote" | "legal";
  /** Extra content rendered next to the identity block — e.g. a date, in the "quote" variant. */
  rightSlot?: ReactNode;
  /** Document title shown under the identity block — only used by the "legal" variant. */
  titleLabel?: string;
}

export function DocumentLetterhead({ orgBranding, variant, rightSlot, titleLabel }: DocumentLetterheadProps) {
  const { t } = useLanguage();
  const primary = orgBranding?.primaryColor ?? "#0f172a";
  const logoSrc = orgBranding?.logoUrl;
  const tradeName = orgBranding?.name ?? "";
  const legalName = orgBranding?.legalName ?? "";
  const address = orgBranding?.address ?? "";
  const phone = orgBranding?.phone ?? "";
  const showTradeNameSeparately = Boolean(tradeName && tradeName !== legalName);

  if (variant === "legal") {
    return (
      <div className="text-center mb-8 pb-4" style={{ borderBottom: `3px double ${primary}` }}>
        {logoSrc && <img src={logoSrc} alt="" className="h-14 object-contain mx-auto mb-2" />}
        {legalName && (
          <p className="text-xl font-bold tracking-wide" style={{ color: primary }}>
            {legalName}
          </p>
        )}
        {showTradeNameSeparately && (
          <p className="text-sm text-gray-600">
            {legalName ? `${t("TradingAs")} ` : ""}
            {tradeName}
          </p>
        )}
        {!legalName && !showTradeNameSeparately && tradeName && (
          <p className="text-xl font-bold tracking-wide" style={{ color: primary }}>
            {tradeName}
          </p>
        )}
        {titleLabel && (
          <p className="text-xs uppercase tracking-widest text-gray-500 mt-2">{titleLabel}</p>
        )}
        {(address || phone) && (
          <p className="text-xs text-gray-500 mt-1">{[address, phone].filter(Boolean).join(" · ")}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex justify-between items-center border-b border-[#d0e0d8] pb-4 mb-6">
      <div className="flex items-center gap-4">
        {logoSrc && <img src={logoSrc} alt="Dealer Logo" className="h-16 object-contain" />}
      </div>
      <div className="text-end text-xs text-[#4b5563] space-y-1">
        {legalName && legalName !== tradeName && <p className="text-[10px] text-[#6b7280]">{legalName}</p>}
        {tradeName && (
          <p className="font-bold" style={{ color: primary }}>
            {tradeName}
          </p>
        )}
        {rightSlot}
      </div>
    </div>
  );
}
