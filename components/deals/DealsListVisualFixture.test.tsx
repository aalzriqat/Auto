/**
 * SCRUM-694 Gate B bridge: renders the REAL Deals list (`DealsListView`) with
 * the REAL dictionaries to static markup for
 * `playwright/visual/deals-list.visual.spec.ts`.
 *
 * The rows are shaped like production ones: Arabic and English customer names,
 * one long enough to wrap if a cell let it, cash and financed, a stopped deal,
 * a held deposit. The bridge switches to "All deals" before capturing, so every
 * row is painted, not just the queue.
 *
 * Gated on `DEALS_LIST_VISUAL_FIXTURE=1`; writes only into the fresh per-run
 * directory named by `DEALS_LIST_VISUAL_FIXTURE_DIR`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { DealsListView, type DealRow } from "./DealsListView";

const GENERATE = process.env.DEALS_LIST_VISUAL_FIXTURE === "1";
const OUT_DIR = process.env.DEALS_LIST_VISUAL_FIXTURE_DIR;

afterEach(cleanup);

function rows(t: (key: string) => string): DealRow[] {
  const base = Date.UTC(2026, 9, 3, 9, 0);
  const day = 86_400_000;
  return [
    {
      key: "app_pntr",
      href: "/org1/applications/app_pntr/deal",
      kind: "FINANCED",
      customerName: "عبدالرحمن محمد عبدالله الزعبي",
      vehicleDesc: "Hyundai Elantra 2022",
      financierLabel: "البنك الإسلامي الأردني",
      statusLabel: t("Closed"),
      statusTone: "done",
      reason: "AWAITING_RECEIPT",
      waitingOn: "OTHERS",
      since: base,
      salespersonName: "Sales Agent One",
      amountLabel: "10,850.000 JOD",
    },
    {
      key: "app_2",
      href: "/org1/applications/app_2/deal",
      kind: "FINANCED",
      customerName: "Layla Haddad",
      vehicleDesc: "Kia Sportage 2024",
      financierLabel: "Jordan Auto Finance",
      statusLabel: t("Approved"),
      statusTone: "active",
      reason: "READY_FOR_HANDOVER",
      waitingOn: "DEALERSHIP",
      since: base - day,
      salespersonName: "سامي خليل",
      amountLabel: "15,000.000 JOD",
    },
    {
      key: "sale_1",
      href: "/org1/sales/sale_1/deal",
      kind: "CASH",
      customerName: "محمود يوسف",
      vehicleDesc: "Toyota Corolla 2019",
      financierLabel: null,
      statusLabel: t("SaleStatusPending"),
      statusTone: "active",
      reason: "CASH_PENDING",
      waitingOn: "DEALERSHIP",
      since: base - 2 * day,
      salespersonName: "Sales Agent One",
      amountLabel: "9,800.000 JOD",
    },
    {
      key: "app_3",
      href: "/org1/applications/app_3/deal",
      kind: "FINANCED",
      customerName: "QA TEST Financed Customer With A Long Name",
      vehicleDesc: "Mercedes-Benz E-Class E200 Avantgarde 2021",
      financierLabel: "Capital Bank Auto Finance Division",
      statusLabel: t("Rejected"),
      statusTone: "stopped",
      reason: "DEPOSIT_PENDING",
      waitingOn: "DEALERSHIP",
      since: base - 5 * day,
      salespersonName: "Sales Agent Two",
      amountLabel: "32,400.000 JOD",
    },
    {
      key: "app_4",
      href: "/org1/applications/app_4/deal",
      kind: "FINANCED",
      customerName: "Omar Saleh",
      vehicleDesc: "Nissan Sunny 2020",
      financierLabel: "Jordan Auto Finance",
      statusLabel: t("UnderReview"),
      statusTone: "neutral",
      reason: "AWAITING_DECISION",
      waitingOn: "OTHERS",
      since: base - 9 * day,
      salespersonName: "سامي خليل",
      amountLabel: null,
    },
  ];
}

describe.skipIf(!GENERATE)("SCRUM-694 deals list visual fixture", () => {
  test.each(["en", "ar"] as const)("writes the %s markup", (locale) => {
    expect(OUT_DIR, "DEALS_LIST_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    mkdirSync(resolve(OUT_DIR!), { recursive: true });
    const table = dictionaries[locale] as Record<string, string>;
    const t = (key: string) => table[key] || (dictionaries.en as Record<string, string>)[key] || key;
    for (const key of ["DealsTitle", "DealsAll", "DealsCustomerVehicleColumn", "OpenDealRow"]) {
      expect(table[key], `${locale} dictionary lacks ${key}`).toBeTruthy();
    }
    for (const view of ["needs", "all"] as const) {
      const { container } = render(
        <DealsListView
          rows={rows(t)}
          loading={false}
          canLoadMore
          loadingMore={false}
          complete={false}
          onLoadMore={() => undefined}
          newDealHref="/org1/sales"
          t={t}
          locale={locale}
        />
      );
      if (view === "all") fireEvent.click(screen.getByRole("tab", { name: new RegExp(table.DealsAll) }));
      writeFileSync(resolve(OUT_DIR!, `deals-${view}-${locale}.html`), container.innerHTML);
      cleanup();
    }
  });
});
