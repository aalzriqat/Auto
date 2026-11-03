// @vitest-environment jsdom
/**
 * SCRUM-891: the Pilot Role Audit's Deals journey opens a deal by clicking the
 * list's own link (`main a[href="<deal path>"]`). Two facts about the list decide
 * whether that works, and both are pinned here at the lowest level that can see them:
 *
 * 1. MEMBERSHIP: a CASH draft sale and a freshly created application (the audit's
 *    four fixtures) are on the list's DEFAULT view, at exactly the href the audit
 *    builds. So a missing row is not the failure.
 * 2. PAINT: every deal is rendered TWICE, a card (hidden from the container's
 *    `@2xl` width up) before a table row (hidden below it). The first anchor in
 *    document order is therefore display:none on a wide screen, which is why a
 *    bare `.first()` cannot be clicked at desktop width.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DealsListView } from "./DealsListView";
import { mergeDealRows, type ApplicationListRow, type SaleListRow } from "./dealRows";

const t = (key: string) => key;
const ORG = "org_1";

const draftCashSale: SaleListRow = {
  _id: "sale_cash_draft",
  status: "PENDING",
  saleDate: 1_800_000_000_000,
  salePrice: 15_000,
  customerName: "QA TEST G8",
  vehicleSummary: "2024 Playwright G8",
  salespersonName: "Owner",
  financingType: "CASH",
};

// What api.applications.createFromQuote stores: PENDING_DOCS, no deposit held.
const newApplication: ApplicationListRow = {
  _id: "app_new",
  status: "PENDING_DOCS",
  createdAt: 1_800_000_000_100,
  customerName: "QA TEST G8",
  vehicleDesc: "2024 Playwright G8",
  companyName: "QA Finance",
  companyLabelKey: null,
  salespersonName: "Owner",
  financedAmount: 12_000,
  hasPendingDepositResolution: false,
};

function renderMerged() {
  const rows = mergeDealRows([newApplication], [draftCashSale], ORG, t, (n) => String(n));
  return render(
    <DealsListView
      rows={rows}
      loading={false}
      canLoadMore={false}
      loadingMore={false}
      complete
      onLoadMore={() => {}}
      newDealHref={null}
      t={t}
    />,
  );
}

const SALE_PATH = `/${ORG}/sales/${draftCashSale._id}/deal`;
const APP_PATH = `/${ORG}/applications/${newApplication._id}/deal`;

describe("Deals list rows as the role audit reads them", () => {
  afterEach(cleanup);

  test.each([SALE_PATH, APP_PATH])("%s is on the default view at exactly that href", (path) => {
    const { container } = renderMerged();
    expect(container.querySelectorAll(`a[href="${path}"]`).length).toBeGreaterThan(0);
  });

  test.each([SALE_PATH, APP_PATH])("%s is painted twice: a card first, then a table row", (path) => {
    const { container } = renderMerged();
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>(`a[href="${path}"]`));
    expect(links).toHaveLength(2);

    const [first, second] = links;
    const cards = first.closest('[data-testid="deals-cards"]');
    expect(cards).not.toBeNull();
    // Hidden from the container's @2xl width up: display:none on a wide screen.
    expect(cards!.className).toContain("@2xl:hidden");

    // The table sits in a wrapper that is hidden below @2xl and displayed above it.
    const tableBox = second.closest("div.hidden");
    expect(tableBox).not.toBeNull();
    expect(tableBox!.className).toContain("@2xl:block");
    expect(tableBox!.contains(first)).toBe(false);
  });
});
