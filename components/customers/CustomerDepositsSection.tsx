"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { interpolate } from "@/lib/i18n/interpolate";
import {
  depositClassificationKey,
  depositStatusKey,
  formatDepositAmount,
  sortDepositsNewestFirst,
  type CustomerDepositRow,
} from "@/components/customers/customerDepositsPresentation";

/** The server's page size for `customers.getRelations`' deposits; used only to word the truncation notice. */
export const CUSTOMER_DEPOSITS_PAGE_SIZE = 100;

/**
 * The neighbouring customer dialog sections' date style, with Western digits so a row's date and its
 * amount use the same numerals (the money display policy, lib/moneyDisplay.ts).
 */
function formatDepositDate(timestamp: number, locale: "en" | "ar"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-US", {
    dateStyle: "medium",
    numberingSystem: "latn",
  }).format(timestamp);
}

interface CustomerDepositsSectionProps {
  /** `undefined` while the relations query is loading. */
  deposits: ReadonlyArray<CustomerDepositRow> | undefined;
  /** The server read a 101st row: the list is the newest page, not everything. */
  truncated: boolean;
  /**
   * The same permission the backend gates on (VIEW_SALES). A role without it gets an empty list from the
   * server, so the section must not render at all: "no deposits" would be a claim the screen cannot make.
   */
  canView: boolean;
  /** The organization's currency, for a legacy row that carries none of its own. */
  organizationCurrency?: string;
}

/**
 * A customer's current deposits on their record: classification (security / reservation), amount at the
 * currency's full scale, status, the linked vehicle when there is one, newest first.
 *
 * Layout uses logical alignment (the table's `text-start`). Amounts are isolated in a `<bdi dir="ltr">`
 * so digits and currency keep their order; localized dates retain the screen's direction.
 * Read-only: the pilot containment forbids refunding or forfeiting an opening deposit, so no row action
 * is offered here (WAI-ARIA: the table is a plain data table, the notices are `status` / `note` regions).
 */
export function CustomerDepositsSection({
  deposits,
  truncated,
  canView,
  organizationCurrency,
}: Readonly<CustomerDepositsSectionProps>) {
  const { t, locale } = useLanguage();
  if (!canView) return null;

  const headingId = "customer-deposits-heading";
  const rows = deposits === undefined ? [] : sortDepositsNewestFirst(deposits);

  return (
    <section aria-labelledby={headingId} data-testid="customer-deposits">
      <h3 id={headingId} className="font-semibold text-sm mb-1">
        {t("CustomerDeposits")}
      </h3>
      <p className="text-xs text-muted-foreground mb-3">{t("CustomerDepositsDesc")}</p>
      {deposits === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("CustomerDepositsLoading")}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">{t("CustomerDepositsEmpty")}</p>
      ) : (
        <Table aria-labelledby={headingId}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("CustomerDepositColType")}</TableHead>
              <TableHead scope="col">{t("CustomerDepositColAmount")}</TableHead>
              <TableHead scope="col">{t("CustomerDepositColStatus")}</TableHead>
              <TableHead scope="col">{t("CustomerDepositColVehicle")}</TableHead>
              <TableHead scope="col">{t("CustomerDepositColDate")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const money = formatDepositAmount(row, organizationCurrency);
              return (
                <TableRow key={row._id}>
                  <TableCell>
                    <span className="font-medium">{t(depositClassificationKey(row))}</span>
                    {row.origin === "OPENING" && (
                      <Badge variant="outline" className="ms-2">
                        {t("OpeningDepositBadge")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <bdi dir="ltr">
                      {money.amount}
                      {money.currency ? ` ${money.currency === "JOD" ? t("JOD") : money.currency}` : ""}
                    </bdi>
                  </TableCell>
                  <TableCell>{t(depositStatusKey(row.status))}</TableCell>
                  <TableCell>{row.vehicleDesc ?? "—"}</TableCell>
                  <TableCell>{formatDepositDate(row.createdAt, locale)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {truncated && (
        <p role="note" className="mt-3 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          {interpolate(t("CustomerDepositsTruncated"), { count: String(CUSTOMER_DEPOSITS_PAGE_SIZE) })}
        </p>
      )}
    </section>
  );
}
