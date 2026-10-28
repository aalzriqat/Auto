/**
 * SCRUM-56 (SCRUM-760 c23812 ruling 8): the Collections "Sale balances" section renders the canonical sale debt the
 * server lists (`collections.listOpenSaleReceivables`), read-only, in the invoice's own currency and scale.
 * Component logic under mocked data only; no browser rendering and no backend is involved.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { SaleReceivablesSection } from "./SaleReceivablesSection";

type Row = {
  receivableDocumentId: string;
  documentNumber: string;
  customerName: string | null;
  vehicleLabel: string | null;
  originalAmountMinor: number;
  outstandingMinor: number;
  currency: string;
  scale: number;
  status: "OPEN" | "PARTIALLY_PAID";
  dueDate: number;
};

const paginated = vi.hoisted(() => ({
  state: { results: [] as unknown[], status: "Exhausted" as string, loadMore: vi.fn() },
}));

vi.mock("convex/react", () => ({ usePaginatedQuery: () => paginated.state }));
vi.mock("@/components/providers/LanguageProvider", () => ({ useLanguage: () => ({ t: (key: string) => key, isRtl: false }) }));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatterInCurrency: () => (amount: number, currency: string, digits: number) => `${amount.toFixed(digits)} ${currency}`,
}));

const ORG = "org_1" as Id<"organizations">;
const row = (over: Partial<Row> = {}): Row => ({
  receivableDocumentId: "doc_1", documentNumber: "INV-1", customerName: "Buyer fin1", vehicleLabel: "2024 Kia Sportage",
  originalAmountMinor: 500_000, outstandingMinor: 300_000, currency: "JOD", scale: 3, status: "OPEN",
  dueDate: Date.UTC(2026, 9, 28, 12), ...over,
});

describe("SaleReceivablesSection", () => {
  beforeEach(() => {
    paginated.state = { results: [], status: "Exhausted", loadMore: vi.fn() };
  });
  afterEach(cleanup);

  test("shows the canonical outstanding and original in the invoice's currency and scale, with no action buttons", () => {
    paginated.state.results = [row()];
    render(<SaleReceivablesSection orgId={ORG} statusFilter="ALL" />);

    expect(screen.getByText("CollectionSaleBalancesTitle")).toBeDefined();
    expect(screen.getByText("Buyer fin1")).toBeDefined();
    expect(screen.getByText("2024 Kia Sportage")).toBeDefined();
    expect(screen.getByText("300.000 JOD")).toBeDefined();
    expect(screen.getByText("500.000 JOD")).toBeDefined();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("renders nothing when no sale balance is owed", () => {
    const { container } = render(<SaleReceivablesSection orgId={ORG} statusFilter="ALL" />);
    expect(container.textContent).toBe("");
  });

  test("a status filter shows only the matching rows, and nothing when none match", () => {
    paginated.state.results = [row({ receivableDocumentId: "a", customerName: "Alpha" }), row({ receivableDocumentId: "b", customerName: "Beta", status: "PARTIALLY_PAID" })];
    const { rerender, container } = render(<SaleReceivablesSection orgId={ORG} statusFilter="PARTIALLY_PAID" />);
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeDefined();

    rerender(<SaleReceivablesSection orgId={ORG} statusFilter="OVERDUE" />);
    expect(container.textContent).toBe("");
  });

  test("a page of only paid invoices (no row yet, more pages) keeps loading instead of showing an empty state", () => {
    paginated.state = { results: [], status: "CanLoadMore", loadMore: vi.fn() };
    render(<SaleReceivablesSection orgId={ORG} statusFilter="ALL" />);

    expect(screen.getByText("CollectionSaleBalancesLoading")).toBeDefined();
    expect(paginated.state.loadMore).toHaveBeenCalledTimes(1);
  });

  test("offers Load more while there are more pages and rows are showing", () => {
    paginated.state = { results: [row()], status: "CanLoadMore", loadMore: vi.fn() };
    render(<SaleReceivablesSection orgId={ORG} statusFilter="ALL" />);

    expect(screen.getByText("LoadMore")).toBeDefined();
    expect(paginated.state.loadMore).not.toHaveBeenCalled();
  });

  test("falls back to the document number and an Unknown customer when the related rows are not readable", () => {
    paginated.state.results = [row({ customerName: null, vehicleLabel: null })];
    render(<SaleReceivablesSection orgId={ORG} statusFilter="ALL" />);

    expect(screen.getByText("Unknown")).toBeDefined();
    expect(screen.getByText("INV-1")).toBeDefined();
  });
});
