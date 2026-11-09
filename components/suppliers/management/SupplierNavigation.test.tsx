import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { SupplierStatementSection } from "./SupplierStatementSection";
import { SupplierRelationshipsSection } from "./SupplierRelationshipsSection";

const world = vi.hoisted(() => ({ locale: "en" as "en" | "ar", permissions: [] as string[],
  loading: false, error: false, incomplete: false, empty: false, loadMore: vi.fn(), calls: [] as unknown[] }));
vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries: messages } = await import("@/lib/i18n/dictionaries");
  return { useLanguage: () => ({ locale: world.locale, dir: world.locale === "ar" ? "rtl" : "ltr", isRtl: world.locale === "ar", t: (key: string) => messages[world.locale][key as keyof typeof messages.en] ?? key }) };
});
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ isLoading: false, hasPermission: (key: string) => world.permissions.includes(key) }) }));
const context = { role: "AP", occurredAt: 1794301200000, counterparty: "Synthetic supplier", source: { kind: "VEHICLE", id: "vehicle1", label: "2024 Toyota Camry", href: "/org1/vehicles?highlightId=vehicle1" } };
const openRow = { kind: "PAYABLE", id: "pay1", currency: "JOD", outstandingMinor: 9500000, disputedMinor: 0, dueAt: null, dueDate: null, rule: "NO_AGREED_DATE", explanation: "", daysOverdue: null, bucket: "NO_DUE_DATE", context };
const section = { rows: [openRow], totals: [], complete: true };
vi.mock("convex/react", async importOriginal => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return { ...actual,
    useQuery: (query: Parameters<typeof getFunctionName>[0], args: unknown) => {
      world.calls.push(args);
      if (args === "skip") return undefined;
      if (world.error) throw new Error("private server detail");
      const name = getFunctionName(query);
      if (name === "subscriptions.getOrgSubscription") return { planDetails: { gates: { accounting: true } } };
      if (world.loading) return undefined;
      if (name === "supplierStatement:outstanding" || name === "supplierStatement.outstanding") return { supplierId: "sup1", payable: section, receivable: { rows: [], totals: [], complete: true } };
      if (name === "supplierStatement:settled" || name === "supplierStatement.settled") return { supplierId: "sup1", payable: { rows: [{ kind: "PAYABLE", id: "pay1", currency: "JOD", status: "PAID", dueMinor: 9500000, settledMinor: 9500000, settlement: "COMPLETE", lastChangedAt: 1794301200000, basis: "RECORDED", context }], totals: [], complete: true, unverifiedCount: 0 }, receivable: { rows: [], totals: [], complete: true, unverifiedCount: 0 } };
      if (name.includes("getOrgSubscription")) return { planDetails: { gates: { accounting: true } } };
      return undefined;
    },
    usePaginatedQuery: (_query: unknown, args: unknown) => {
      world.calls.push(args);
      if (args !== "skip" && world.error) throw new Error("private server detail");
      return { results: world.empty ? [] : [{ vehicleId: "vehicle1", label: "2024 Toyota Camry", model: "SOURCED", status: "AVAILABLE", href: "/org1/vehicles?highlightId=vehicle1" }], status: world.loading ? "LoadingFirstPage" : (world.incomplete ? "CanLoadMore" : "Exhausted"), loadMore: world.loadMore };
    },
  };
});
const props = { orgId: "org1" as never, supplierId: "sup1" as never };
beforeEach(() => {
  world.locale = "en";
  world.permissions = [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.VIEW_COST_PRICE, PERMISSIONS.VIEW_VEHICLES];
  world.loading = false; world.error = false; world.incomplete = false; world.empty = false;
  world.calls = []; world.loadMore.mockClear();
});
afterEach(cleanup);

describe.each(["en", "ar"] as const)("supplier navigation %s", locale => {
  const text = dictionaries[locale];
  test("outstanding and settled rows show source links, role, timestamp and payee", () => {
    world.locale = locale;
    render(<SupplierStatementSection {...props} />);
    expect(screen.getByRole("link", { name: "2024 Toyota Camry" })).toHaveAttribute("href", "/org1/vehicles?highlightId=vehicle1");
    expect(screen.getByText(text.SuppliersRowAP)).toBeInTheDocument();
    expect(screen.getByText(/Synthetic supplier/)).toBeInTheDocument();
    expect(screen.getByText(/9,500/)).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: text.SuppliersTabSettled }), { button: 0, ctrlKey: false });
    expect(screen.getByRole("link", { name: "2024 Toyota Camry" })).toBeInTheDocument();
    expect(screen.getByText(text.SuppliersRowAP)).toBeInTheDocument();
  });
  test("unavailable target permission leaves the statement label and cost access gates the whole statement", () => {
    world.locale = locale;
    world.permissions = [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.VIEW_COST_PRICE];
    const view = render(<SupplierStatementSection {...props} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("2024 Toyota Camry")).toBeInTheDocument();
    view.unmount();
    world.permissions = [PERMISSIONS.VIEW_FINANCE];
    world.calls = [];
    const hidden = render(<SupplierStatementSection {...props} />);
    expect(hidden.container).not.toHaveTextContent("9,500");
    expect(world.calls.filter(args => args !== "skip")).toHaveLength(0);
  });
  test("relationships use stock labels, ownership, status, RTL and honest incomplete pagination", () => {
    world.locale = locale; world.incomplete = true;
    const { container } = render(<SupplierRelationshipsSection {...props} />);
    expect(container.querySelector('[dir]')).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect(screen.getAllByRole("link", { name: "2024 Toyota Camry" })[0]).toHaveAttribute("href", "/org1/vehicles?highlightId=vehicle1");
    expect(screen.getAllByText(text.SuppliersRelationshipsSourced).length).toBeGreaterThan(0);
    expect(screen.getAllByText(text.SuppliersRelationshipsIncomplete).length).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent("9,500");
    fireEvent.click(screen.getAllByRole("button", { name: text.SuppliersRelationshipsMore })[0]);
    expect(world.loadMore).toHaveBeenCalledWith(25);
  });
  test("loading, empty and error states are localized and hide raw errors", () => {
    world.locale = locale; world.loading = true;
    const view = render(<SupplierRelationshipsSection {...props} />);
    expect(screen.getAllByText(text.SuppliersRelationshipsLoading).length).toBeGreaterThan(0);
    view.unmount(); world.loading = false; world.empty = true;
    const empty = render(<SupplierRelationshipsSection {...props} />);
    expect(screen.getAllByText(text.SuppliersRelationshipsEmpty).length).toBeGreaterThan(0);
    empty.unmount(); world.error = true;
    const error = render(<SupplierRelationshipsSection {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent(text.SuppliersRelationshipsError);
    expect(error.container).not.toHaveTextContent("private server detail");
  });
  test("relationships with no vehicle permission have labels without links and no finance skips reads", () => {
    world.locale = locale; world.permissions = [PERMISSIONS.VIEW_FINANCE];
    const view = render(<SupplierRelationshipsSection {...props} />);
    expect(screen.getAllByText("2024 Toyota Camry").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    view.unmount(); world.permissions = []; world.calls = [];
    render(<SupplierRelationshipsSection {...props} />);
    expect(world.calls.filter(args => args !== "skip")).toHaveLength(0);
  });
});
