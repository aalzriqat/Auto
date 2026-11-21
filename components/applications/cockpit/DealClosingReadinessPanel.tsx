import type { ComponentProps, ReactNode } from "react";
import { ClipboardCheck, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatLocalized } from "@/lib/dateLocale";
import type { Locale } from "@/lib/i18n/dictionaries";
import {
  DealClosingReadinessList,
  type ClosingReadinessView,
} from "./DealClosingReadinessList";

/** The same labels the legal-invoice dialog offers, so the record reads as it was entered. */
const LEGAL_INVOICE_ISSUED_TO_LABEL: Record<string, string> = {
  FINANCE_COMPANY: "PartyFinancier",
  CUSTOMER: "Customer",
  OTHER: "Other",
};

export type DealClosingChecklist = {
  readiness: ClosingReadinessView | undefined;
  serviceUnavailable?: boolean;
  legalInvoice?: {
    amountMinor?: number;
    number?: string;
    date?: number;
    issuedTo?: string;
    /** Absent once the server freezes the deal's economics (SCRUM-691 F-PNTR-5). */
    onRecord?: () => void;
  };
};

export function DealClosingReadinessPanel({
  closingChecklist,
  destinations,
  noCostCloseout,
  money,
  locale,
  t,
}: Readonly<{
  closingChecklist: DealClosingChecklist;
  destinations: ComponentProps<typeof DealClosingReadinessList>["destinations"];
  noCostCloseout?: ReactNode;
  money: (minor: number) => string;
  locale: Locale;
  t: (key: string) => string;
}>) {
  return (
    <Card data-testid="deal-closing-checklist">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <ClipboardCheck
            className="h-4 w-4 shrink-0 text-primary"
            aria-hidden
          />
          {t("ClosingReadinessHeading")}
        </CardTitle>
        {closingChecklist.legalInvoice?.onRecord && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={closingChecklist.legalInvoice.onRecord}
          >
            <FileText className="h-4 w-4 me-1.5" />
            {t("RecordLegalInvoice")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <DealClosingReadinessList
          readiness={closingChecklist.readiness}
          serviceUnavailable={closingChecklist.serviceUnavailable}
          destinations={destinations}
          t={t}
        />
        {noCostCloseout}
        {closingChecklist.legalInvoice &&
          (closingChecklist.legalInvoice.amountMinor !== undefined ? (
            <dl
              className="grid grid-cols-2 gap-4 rounded-md bg-muted/40 p-3 text-xs sm:grid-cols-4"
              data-testid="deal-legal-invoice"
            >
              <div>
                <dt className="text-muted-foreground">
                  {t("LegalInvoiceAmount")}
                </dt>
                <dd className="font-semibold tabular-nums">
                  <bdi dir="ltr">
                    {money(closingChecklist.legalInvoice.amountMinor)}
                  </bdi>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("LegalInvoiceNumber")}
                </dt>
                <dd className="font-medium">
                  {closingChecklist.legalInvoice.number ?? "-"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("LegalInvoiceDate")}
                </dt>
                <dd className="font-medium">
                  {closingChecklist.legalInvoice.date
                    ? formatLocalized(
                        closingChecklist.legalInvoice.date,
                        "d MMM yyyy",
                        locale,
                      )
                    : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("LegalInvoiceIssuedTo")}
                </dt>
                <dd className="font-medium">
                  {closingChecklist.legalInvoice.issuedTo
                    ? t(
                        LEGAL_INVOICE_ISSUED_TO_LABEL[
                          closingChecklist.legalInvoice.issuedTo
                        ] ?? closingChecklist.legalInvoice.issuedTo,
                      )
                    : "-"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("LegalInvoiceNotRecorded")}
            </p>
          ))}
      </CardContent>
    </Card>
  );
}
