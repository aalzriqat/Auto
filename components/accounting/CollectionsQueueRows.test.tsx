/**
 * SCRUM-56 — what the Collections screen does with a queue that now holds two
 * kinds of debt.
 *
 * The backend tests prove the queue contains a completed sale's balance. These
 * prove the screen can actually work it: that a sale invoice is recognisable,
 * that collecting against one addresses the CANONICAL document rather than a
 * legacy row it does not have, and that the legacy-only workflows are absent
 * from it instead of being offered and then refused by the server.
 *
 * The rendered gate for this screen cannot run while SCRUM-95 keeps the shared
 * Convex dev deployment disabled, so these assert the wiring the screenshot
 * would have.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (amount: number) => `JD ${amount}`,
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: () => true, isLoading: false }),
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));

vi.mock("./collections/CashDrawerPanel", () => ({ CashDrawerPanel: () => null }));
vi.mock("./collections/PaymentLinksPanel", () => ({ PaymentLinksPanel: () => null }));
vi.mock("./collections/InstallmentCalendar", () => ({ InstallmentCalendar: () => null }));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  recordPayment: vi.fn(),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useMutation: (reference: never) =>
      getFunctionName(reference) === "collections:recordPayment" ? stubs.recordPayment : vi.fn(),
  };
});

import { CollectionsTab } from "./CollectionsTab";
import { api } from "@/convex/_generated/api";
import { getFunctionName } from "convex/server";

const { queryResults, recordPayment } = stubs;

const DUE = Date.UTC(2026, 7, 20);

function canonicalRow(overrides: Record<string, unknown> = {}) {
  return {
    key: "canonical:doc1",
    origin: "CANONICAL",
    receivableDocumentId: "doc1" as Id<"receivableDocuments">,
    customerId: "cust1" as Id<"customers">,
    customerName: "Nora Khaled",
    vehicleLabel: "2023 Mazda CX-5",
    saleId: "sale1" as Id<"sales">,
    title: "INV-1",
    originalAmount: 22000,
    outstandingAmount: 22000,
    dueDate: DUE,
    status: "OVERDUE",
    ...overrides,
  };
}

function legacyRow(overrides: Record<string, unknown> = {}) {
  return {
    key: "legacy:rec1",
    origin: "LEGACY",
    receivableId: "rec1" as Id<"receivables">,
    customerId: "cust1" as Id<"customers">,
    customerName: "Layla Nasser",
    title: "Installment 1",
    sourceType: "INTERNAL_INSTALLMENT",
    originalAmount: 1000,
    outstandingAmount: 400,
    dueDate: DUE,
    status: "PARTIALLY_PAID",
    ...overrides,
  };
}

function renderWithQueue(items: unknown[], truncated = false) {
  queryResults.clear();
  queryResults.set(getFunctionName(api.collections.listCollectionQueue), { items, truncated });
  render(<CollectionsTab />);
}

afterEach(() => {
  cleanup();
  recordPayment.mockReset();
  queryResults.clear();
});

describe("SCRUM-56 — the Collections queue on screen", () => {
  test("a completed sale's balance is listed and labelled as a sale invoice", () => {
    renderWithQueue([canonicalRow()]);

    expect(screen.getByText("Nora Khaled")).toBeTruthy();
    expect(screen.getByText("2023 Mazda CX-5")).toBeTruthy();
    expect(screen.getByText("CollectionSaleInvoice")).toBeTruthy();
    expect(screen.getAllByText("JD 22000").length).toBeGreaterThan(0);
  });

  test("collecting against a sale invoice addresses the canonical document, never a legacy id", async () => {
    renderWithQueue([canonicalRow()]);

    // The row's only action is "record payment".
    const row = screen.getByText("Nora Khaled").closest("tr")!;
    const actions = row.querySelectorAll("button");
    expect(actions).toHaveLength(1);

    fireEvent.click(actions[0]);
    fireEvent.change(screen.getByPlaceholderText(/AmountDue/), { target: { value: "22000" } });
    fireEvent.click(screen.getByText("Record"));

    expect(recordPayment).toHaveBeenCalledTimes(1);
    const call = recordPayment.mock.calls[0][0];
    expect(call.receivableDocumentId).toBe("doc1");
    expect(call.receivableId).toBeUndefined();
    expect(call.amount).toBe(22000);
  });

  test("a hand-created balance keeps its cheque, reschedule and refund actions", () => {
    renderWithQueue([legacyRow()]);

    const row = screen.getByText("Layla Nasser").closest("tr")!;
    expect(row.querySelectorAll("button")).toHaveLength(4);
  });

  test("collecting against a hand-created balance still addresses its legacy row", () => {
    renderWithQueue([legacyRow()]);

    const row = screen.getByText("Layla Nasser").closest("tr")!;
    fireEvent.click(row.querySelectorAll("button")[0]);
    fireEvent.change(screen.getByPlaceholderText(/AmountDue/), { target: { value: "400" } });
    fireEvent.click(screen.getByText("Record"));

    const call = recordPayment.mock.calls[0][0];
    expect(call.receivableId).toBe("rec1");
    expect(call.receivableDocumentId).toBeUndefined();
  });

  test("a duplicate representation is marked, and its amount reads as not counted", () => {
    renderWithQueue([legacyRow({ duplicateRepresentation: true })]);

    expect(screen.getByLabelText("CollectionDuplicateRepresentation")).toBeTruthy();
    // The caption is what stops a collector adding this figure into the total
    // the summary reports, so it is the assertion that matters.
    expect(screen.getByText("CollectionCountedOnSaleInvoice")).toBeTruthy();
  });

  test("an ordinary balance is not captioned, and keeps its full weight", () => {
    renderWithQueue([legacyRow()]);

    expect(screen.queryByText("CollectionCountedOnSaleInvoice")).toBeNull();
    expect(screen.queryByLabelText("CollectionDuplicateRepresentation")).toBeNull();
  });

  test("a queue that hit its bound says so instead of looking complete", () => {
    renderWithQueue([legacyRow()], true);

    expect(screen.getByText(/CollectionQueueTruncated/)).toBeTruthy();
  });

  test("a queue that did not hit its bound shows no truncation notice", () => {
    renderWithQueue([legacyRow()]);

    expect(screen.queryByText(/CollectionQueueTruncated/)).toBeNull();
  });
});
