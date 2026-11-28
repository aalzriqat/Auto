"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import type { ExpenseProposalValues } from "./expense.schema";
import { unsupportedProposalFields } from "./newExpenseFormValues";

/**
 * The check-before-saving notice at the top of an expense form the assistant
 * filled (SCRUM-1039). It is rendered inside the dialog's description, so a
 * screen reader reads it with the title when the form opens, and it has no close
 * control: it stays for as long as the form is open.
 *
 * Spans with `block` rather than divs and paragraphs, because the description
 * element is itself a paragraph.
 */
export function ExpenseAssistantNotice({ proposal }: { proposal: ExpenseProposalValues }) {
  const { t } = useLanguage();
  const unsupported = unsupportedProposalFields(proposal);
  return (
    <span className="mt-3 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-start text-sm text-amber-900">
      <span className="block font-medium">{t("ExpenseAssistantNoticeTitle")}</span>
      {unsupported.category && <span className="mt-1 block">{t("ExpenseAssistantNoticeCategory")}</span>}
      {unsupported.paymentMethod && <span className="mt-1 block">{t("ExpenseAssistantNoticePaymentMethod")}</span>}
    </span>
  );
}
