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
import {
  DealRowFiguresContext,
  DealsListView,
  type DealRow,
  type RowFigures,
  type UseDealRowFigures,
} from "./DealsListView";

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
      amountLabel: null,
      dealNumber: 1042,
      source: { kind: "APPLICATION", id: "app_pntr" },
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
      amountLabel: null,
      dealNumber: 1043,
      source: { kind: "APPLICATION", id: "app_2" },
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
      dealNumber: 1044,
      source: { kind: "SALE", id: "sale_1" },
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
      amountLabel: null,
      source: { kind: "APPLICATION", id: "app_3" },
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
      source: { kind: "APPLICATION", id: "app_4" },
    },
  ];
}

/** A 4:3 swatch standing in for a car photo, inline so the static page needs no server. */
const PHOTO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="#94a3b8"/></svg>');

/**
 * Each row's cockpit facts in every state the list must paint: a photo and a
 * consigned car, a negative profit, a profit withheld for want of cost access,
 * a stopped deal, and one row still loading.
 */
const FIGURES: Record<string, RowFigures> = {
  app_pntr: {
    photoUrl: PHOTO,
    consigned: true,
    stages: [
      { key: "APPLICATION", state: "COMPLETE" },
      { key: "HANDOVER", state: "COMPLETE" },
      { key: "SETTLEMENT", state: "CURRENT" },
    ],
    sellingPriceMinor: 10_850_000,
    sellingPriceReason: null,
    netProfitMinor: 640_500,
    netProfitReason: null,
    currency: "JOD",
  },
  app_2: {
    photoUrl: null,
    consigned: false,
    stages: [
      { key: "APPLICATION", state: "COMPLETE" },
      { key: "CREDIT_DECISION", state: "COMPLETE" },
      { key: "DELIVERY_ACTIONS", state: "BLOCKED" },
    ],
    sellingPriceMinor: 15_000_000,
    sellingPriceReason: null,
    netProfitMinor: -125_000,
    netProfitReason: null,
    currency: "JOD",
  },
  sale_1: {
    photoUrl: PHOTO,
    consigned: false,
    stages: [{ key: "SALE_AGREED", state: "CURRENT" }],
    sellingPriceMinor: null,
    sellingPriceReason: null,
    netProfitMinor: null,
    netProfitReason: "CostAccessRequired",
    currency: "JOD",
  },
  app_3: {
    photoUrl: null,
    consigned: false,
    stages: [
      { key: "APPLICATION", state: "COMPLETE" },
      { key: "CREDIT_DECISION", state: "STOPPED" },
    ],
    sellingPriceMinor: 32_400_000,
    sellingPriceReason: null,
    netProfitMinor: null,
    netProfitReason: "ProfitNotCalculable",
    currency: "JOD",
  },
  // app_4 is absent: its facts are still loading.
};

const useFixtureFigures: UseDealRowFigures = (row) => FIGURES[row.key];

describe.skipIf(!GENERATE)("SCRUM-694 deals list visual fixture", () => {
  test.each(["en", "ar"] as const)("writes the %s markup", (locale) => {
    expect(OUT_DIR, "DEALS_LIST_VISUAL_FIXTURE_DIR must name this run's fresh directory").toBeTruthy();
    mkdirSync(resolve(OUT_DIR!), { recursive: true });
    const table = dictionaries[locale] as Record<string, string>;
    const t = (key: string) => table[key] || (dictionaries.en as Record<string, string>)[key] || key;
    for (const key of ["DealsTitle", "DealsAll", "DealsCarColumn", "DealsNetProfitColumn", "OpenDealRow"]) {
      expect(table[key], `${locale} dictionary lacks ${key}`).toBeTruthy();
    }
    for (const view of ["needs", "all"] as const) {
      const { container } = render(
        <DealRowFiguresContext.Provider value={useFixtureFigures}>
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
        </DealRowFiguresContext.Provider>
      );
      if (view === "all") fireEvent.click(screen.getByRole("tab", { name: new RegExp(table.DealsAll) }));
      writeFileSync(resolve(OUT_DIR!, `deals-${view}-${locale}.html`), container.innerHTML);
      cleanup();
    }
  });
});
