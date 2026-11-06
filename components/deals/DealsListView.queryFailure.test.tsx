// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MoneySurfaceErrorBoundary } from "@/components/accounting/MoneySurfaceErrorBoundary";
import { dictionaries, type Locale } from "@/lib/i18n/dictionaries";
import { DealRowFiguresContext, DealsListView, type DealRow, type RowFigures, type UseDealRowFigures } from "./DealsListView";

const goodFigures: NonNullable<RowFigures> = {
  photoUrl: null,
  consigned: false,
  stages: [{ key: "APPLICATION", state: "CURRENT" }],
  sellingPriceMinor: 15_000_000,
  sellingPriceReason: null,
  netProfitMinor: 640_500,
  netProfitReason: null,
  currency: "JOD",
};

function deal(key: string, org = "org1"): DealRow {
  return {
    key, href: `/${org}/applications/${key}/deal`, kind: "FINANCED",
    customerName: key, vehicleDesc: "2024 Kia Sportage", financierLabel: "Finance company",
    statusLabel: "Approved", statusTone: "active", reason: "READY_FOR_HANDOVER",
    waitingOn: "DEALERSHIP", since: Date.UTC(2026, 8, 1), salespersonName: "Sales One",
    amountLabel: null, dealNumber: key === "affected" ? 123 : 124,
    source: { kind: "APPLICATION", id: key },
  };
}

function list(useFigures: UseDealRowFigures, locale: Locale, org = "org1") {
  const dictionary: Readonly<Record<string, string>> = dictionaries[locale];
  return (
    <MoneySurfaceErrorBoundary fallback={<p data-testid="dashboard-error">Dashboard failed</p>}>
      <DealRowFiguresContext.Provider value={useFigures}>
        <div dir={locale === "ar" ? "rtl" : "ltr"}>
          <DealsListView rows={[deal("affected", org), deal("healthy", org)]} loading={false}
            canLoadMore={false} loadingMore={false} complete onLoadMore={vi.fn()}
            newDealHref={null} t={(key) => dictionary[key] ?? key} locale={locale} />
        </div>
      </DealRowFiguresContext.Provider>
    </MoneySurfaceErrorBoundary>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const states = ["missing endpoint", "ordinary error", "loading", "null", "success"] as const;
test.each((["en", "ar"] as const).flatMap((locale) => states.map((state) => ({ locale, state }))))(
  "SCRUM-917 $locale: $state affects only its row, in cards and table",
  ({ locale, state }) => {
    // The injected hook is the subscription seam. Thrown query errors happen
    // during render, before a backend handler can return its null fallback.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const useFigures: UseDealRowFigures = (row) => {
      if (row.key === "healthy" || state === "success") return goodFigures;
      if (state === "loading") return undefined;
      if (state === "null") return null;
      throw new Error(state === "missing endpoint"
        ? "Could not find public function for 'dealListRow:figures'"
        : "Synthetic authorization failure");
    };
    render(list(useFigures, locale));
    expect(screen.queryByTestId("dashboard-error")).toBeNull();
    for (const layout of ["card", "row"]) {
      const affected = screen.getByTestId(`deal-${layout}-affected`);
      const healthy = screen.getByTestId(`deal-${layout}-healthy`);
      expect(within(healthy).getAllByText("640.500").length).toBeGreaterThan(0);
      expect(within(healthy).getAllByText("15,000").length).toBeGreaterThan(0);
      expect(within(affected).getByTestId("deal-row-number").textContent).toBe("D-000123");
      expect(affected.querySelector('bdi[dir="ltr"]')).not.toBeNull();
      expect(within(affected).getByRole("link").getAttribute("href")).toBe("/org1/applications/affected/deal");
      if (state === "loading") {
        expect(affected.querySelector('[data-fact="step-loading"]')).not.toBeNull();
        expect(within(affected).queryByText(dictionaries[locale].DealsRowDetailsUnavailable)).toBeNull();
      } else if (state === "success") {
        expect(within(affected).getAllByText("640.500").length).toBeGreaterThan(0);
      } else {
        expect(within(affected).getAllByText(dictionaries[locale].DealsRowDetailsUnavailable).length).toBeGreaterThan(0);
        expect(within(affected).queryByText("640.500")).toBeNull();
        expect(affected.textContent).not.toContain("Could not find");
        expect(affected.textContent).not.toContain("Synthetic authorization");
        for (const profit of affected.querySelectorAll('[data-fact="net-profit"]')) {
          expect(profit.textContent).toContain("—");
          expect(profit.textContent).not.toMatch(/\d/);
        }
      }
    }
    fireEvent.change(screen.getByRole("textbox", { name: dictionaries[locale].SearchDeals }), { target: { value: "healthy" } });
    expect(screen.queryByTestId("deal-row-affected")).toBeNull();
    expect(screen.getByTestId("deal-row-healthy")).toBeTruthy();
  }
);

test("SCRUM-917: switching org with the same row key clears a failed row", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const useFigures: UseDealRowFigures = (row) => {
    if (row.key === "affected" && row.href.startsWith("/org1/")) throw new Error("Synthetic failure");
    return goodFigures;
  };
  const view = render(list(useFigures, "en"));
  expect(within(screen.getByTestId("deal-row-affected")).getAllByText("Deal details unavailable").length).toBeGreaterThan(0);
  view.rerender(list(useFigures, "en", "org2"));
  for (const layout of ["card", "row"]) {
    const affected = screen.getByTestId(`deal-${layout}-affected`);
    expect(within(affected).queryByText("Deal details unavailable")).toBeNull();
    expect(within(affected).getAllByText("640.500").length).toBeGreaterThan(0);
  }
});

test("SCRUM-917: unmounting unseen rows disconnects their viewport observers", () => {
  const observers: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor() { observers.push(this); }
  });
  const view = render(list(() => undefined, "en"));
  expect(observers).toHaveLength(4);
  expect(observers.every((observer) => observer.observe.mock.calls.length === 1)).toBe(true);
  view.unmount();
  expect(observers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
});
