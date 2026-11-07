// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { dictionaries, type Locale } from "@/lib/i18n/dictionaries";
import { DealRowFiguresContext, DealsListView, type DealRow, type RowFigures } from "./DealsListView";

/** Browser boundary: only explicitly intersected targets become near, unlike jsdom's fallback. */
class ControlledIntersectionObserver {
  static targets = new Map<Element, ControlledIntersectionObserver>();
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) { ControlledIntersectionObserver.targets.set(target, this); }
  disconnect() {
    for (const [target, observer] of ControlledIntersectionObserver.targets) {
      if (observer === this) ControlledIntersectionObserver.targets.delete(target);
    }
  }
  static intersect(target: Element) {
    const observer = this.targets.get(target);
    if (!observer) return; // A latched near target has already disconnected.
    observer.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
  }
}

const figures: NonNullable<RowFigures> = {
  photoUrl: null, consigned: true, stages: [{ key: "APPLICATION", state: "CURRENT" }],
  sellingPriceMinor: 15_000_000, sellingPriceReason: null,
  netProfitMinor: 640_500, netProfitReason: null, currency: "JOD",
};

function deal(key: string): DealRow {
  return {
    key, href: `/org1/applications/${key}/deal`, kind: "FINANCED", customerName: key,
    vehicleDesc: "2024 Kia Sportage", financierLabel: "Finance company", statusLabel: "Approved",
    statusTone: "active", reason: "READY_FOR_HANDOVER", waitingOn: "DEALERSHIP",
    since: Date.UTC(2026, 8, 1), salespersonName: "Sales One", amountLabel: null,
    source: { kind: "APPLICATION", id: key },
  };
}

afterEach(() => {
  cleanup();
  ControlledIntersectionObserver.targets.clear();
  vi.unstubAllGlobals();
});

test("SCRUM-925: either responsive copy resolves shared lazy figures in EN and AR", () => {
  for (const locale of ["en", "ar"] as const) {
    for (const layout of ["card", "row"] as const) {
      checkSharedRead(locale, layout);
      cleanup();
      ControlledIntersectionObserver.targets.clear();
    }
  }
});

function checkSharedRead(locale: Locale, layout: "card" | "row") {
    vi.stubGlobal("IntersectionObserver", ControlledIntersectionObserver);
    const dictionary: Readonly<Record<string, string>> = dictionaries[locale];
    const active = new Map<string, number>();
    // The supplied hook is the live subscription boundary; count active reads,
    // rather than renders (React may render an enabled hook more than once).
    const useFigures = vi.fn(function useFigures(row: DealRow, enabled: boolean): RowFigures {
      useEffect(() => {
        if (!enabled) return;
        active.set(row.source.id, (active.get(row.source.id) ?? 0) + 1);
        return () => { active.set(row.source.id, (active.get(row.source.id) ?? 0) - 1); };
      }, [row.source.id, enabled]);
      return enabled ? figures : undefined;
    });
    render(
      <DealRowFiguresContext.Provider value={useFigures}>
        <div dir={locale === "ar" ? "rtl" : "ltr"}>
          <DealsListView rows={[deal("near"), deal("far")]} loading={false} canLoadMore={false}
            loadingMore={false} complete onLoadMore={() => {}} newDealHref={null}
            t={(key) => dictionary[key] ?? key} locale={locale} />
        </div>
      </DealRowFiguresContext.Provider>
    );
    expect(useFigures.mock.calls.filter(([, enabled]) => enabled)).toHaveLength(0);
    expect.soft(useFigures.mock.calls.filter(([row, enabled]) => row.source.id === "near" && !enabled)).toHaveLength(1);
    useFigures.mockClear();
    const visible = screen.getByTestId(`deal-${layout}-near`);
    const other = screen.getByTestId(`deal-${layout === "card" ? "row" : "card"}-near`);
    act(() => ControlledIntersectionObserver.intersect(visible));
    expect(useFigures.mock.calls.filter(([row, enabled]) => row.source.id === "near" && enabled)).toHaveLength(1);
    for (const copy of [visible, other]) {
      expect.soft(copy.querySelectorAll(".animate-pulse")).toHaveLength(0);
      expect.soft(within(copy).queryAllByText(dictionary.DealsFigureLoading)).toHaveLength(0);
      expect.soft(within(copy).queryAllByText("15,000").length).toBeGreaterThan(0);
      expect.soft(within(copy).queryAllByText("640.500").length).toBeGreaterThan(0);
      expect(copy.querySelector('bdi[dir="ltr"]')?.textContent).toBe("15,000");
    }
    expect(active.get("near")).toBe(1);
    expect(useFigures.mock.calls.filter(([row, enabled]) => row.source.id === "far" && enabled)).toHaveLength(0);
    for (const copy of ["card", "row"]) {
      expect(screen.getByTestId(`deal-${copy}-far`).querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    }
    // Switching layouts must keep the existing read, rather than subscribe twice.
    act(() => ControlledIntersectionObserver.intersect(other));
    expect(active.get("near")).toBe(1);
    expect(active.has("far")).toBe(false);
}
