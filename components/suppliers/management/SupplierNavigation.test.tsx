import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { SupplierStatementSection } from "./SupplierStatementSection";
import { SupplierRelationshipsSection } from "./SupplierRelationshipsSection";
import { SupplierRowDetails } from "./SupplierRowDetails";

const world = vi.hoisted(() => ({ locale: "en" as "en" | "ar", permissions: [] as string[],
  loading: false, error: false, incomplete: false, empty: false, loadMore: vi.fn(), calls: [] as unknown[] }));
vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries: messages } = await import("@/lib/i18n/dictionaries");
  return { useLanguage: () => ({ locale: world.locale, dir: world.locale === "ar" ? "rtl" : "ltr", isRtl: world.locale === "ar", t: (key: string) => messages[world.locale][key as keyof typeof messages.en] ?? key }) };
});
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ isLoading: false, hasPermission: (key: string) => world.permissions.includes(key) }) }));
const context = { role: "AP", occurredAt: 1794301200000, counterparty: "Synthetic supplier", source: { kind: "VEHICLE", id: "vehicle1", label: "2024 Toyota Camry", href: "/org1/vehicles?supplierVehicleId=vehicle1" } };
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
      if (name.includes("getMySubscription")) return { planDetails: { gates: { accounting: true } } };
      return undefined;
    },
    usePaginatedQuery: (_query: unknown, args: unknown) => {
      world.calls.push(args);
      if (args !== "skip" && world.error) throw new Error("private server detail");
      let status = "Exhausted";
      if (world.loading) status = "LoadingFirstPage";
      else if (world.incomplete) status = "CanLoadMore";
      const owned = typeof args === "object" && args !== null && "kind" in args && args.kind === "OWNED";
      const row = owned ? { vehicleId: "vehicle2", label: "2023 Kia Sportage", model: "OWNED_ON_ACCOUNT", status: "SOLD", href: "/org1/vehicles?supplierVehicleId=vehicle2" } : { vehicleId: "vehicle1", label: "2024 Toyota Camry", model: "SOURCED", status: "AVAILABLE", href: "/org1/vehicles?supplierVehicleId=vehicle1" };
      return { results: world.empty ? [] : [row], status, loadMore: world.loadMore };
    },
  };
});
const props = { orgId: "org1" as never, supplierId: "sup1" as never };
function saveRender(name: string, container: HTMLElement) {
  const directory = process.env.SUPPLIER_NAVIGATION_RENDER_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${name}-${world.locale}.html`), container.innerHTML);
}
function resetWorld() {
  world.locale = "en";
  world.permissions = [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.VIEW_COST_PRICE, PERMISSIONS.VIEW_VEHICLES];
  world.loading = false; world.error = false; world.incomplete = false; world.empty = false;
  world.calls = []; world.loadMore.mockClear();
}
beforeEach(resetWorld);
afterEach(cleanup);

describe("supplier navigation", () => {
  test("outstanding and settled rows show source links, role, timestamp and payee", () => {
    for (const locale of ["en", "ar"] as const) {
      resetWorld();
      const text = dictionaries[locale];
      world.locale = locale;
      const view = render(<SupplierStatementSection {...props} />);
      expect(screen.getByRole("link", { name: "2024 Toyota Camry" }).getAttribute("href")).toBe("/org1/vehicles?supplierVehicleId=vehicle1");
      expect(screen.getByText(text.SuppliersRowAP)).not.toBeNull();
      expect(screen.getByText(/Synthetic supplier/)).not.toBeNull();
      expect(screen.getByText(/9,500/)).not.toBeNull();
      expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-10T09:00:00.000Z");
      saveRender("outstanding", view.container);
      fireEvent.mouseDown(screen.getByRole("tab", { name: text.SuppliersTabSettled }), { button: 0, ctrlKey: false });
      expect(screen.getByRole("link", { name: "2024 Toyota Camry" })).not.toBeNull();
      expect(screen.getByText(text.SuppliersRowAP)).not.toBeNull();
      saveRender("settled", view.container);
      cleanup();
    }
  });
  test("unavailable target permission leaves the statement label and cost access gates the whole statement", () => {
    for (const locale of ["en", "ar"] as const) {
      resetWorld();
      world.locale = locale;
      world.permissions = [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.VIEW_COST_PRICE];
      const view = render(<SupplierStatementSection {...props} />);
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.getByText("2024 Toyota Camry")).not.toBeNull();
      view.unmount();
      world.permissions = [PERMISSIONS.VIEW_FINANCE];
      world.calls = [];
      const hidden = render(<SupplierStatementSection {...props} />);
      expect(hidden.container.textContent).not.toContain("9,500");
      expect(world.calls.filter(args => args !== "skip")).toHaveLength(0);
      cleanup();
    }
  });
  test("relationships use stock labels, ownership, status, RTL and honest incomplete pagination", () => {
    for (const locale of ["en", "ar"] as const) {
      resetWorld();
      const text = dictionaries[locale];
      world.locale = locale; world.incomplete = true;
      const { container } = render(<SupplierRelationshipsSection {...props} />);
      expect(container.querySelector('[dir]')?.getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
      expect(screen.getAllByRole("link", { name: "2024 Toyota Camry" })[0].getAttribute("href")).toBe("/org1/vehicles?supplierVehicleId=vehicle1");
      expect(screen.getAllByText(text.SuppliersRelationshipsSourced).length).toBeGreaterThan(0);
      expect(screen.getAllByText(text.SuppliersRelationshipsIncomplete).length).toBeGreaterThan(0);
      expect(container.textContent).not.toContain("9,500");
      saveRender("relationships", container);
      fireEvent.click(screen.getAllByRole("button", { name: text.SuppliersRelationshipsMore })[0]);
      expect(world.loadMore).toHaveBeenCalledWith(25);
      cleanup();
    }
  });
  test("loading, empty and error states are localized and hide raw errors", () => {
    for (const locale of ["en", "ar"] as const) {
      resetWorld();
      const text = dictionaries[locale];
      world.locale = locale; world.loading = true;
      const view = render(<SupplierRelationshipsSection {...props} />);
      expect(screen.getAllByText(text.SuppliersRelationshipsLoading).length).toBeGreaterThan(0);
      saveRender("loading", view.container);
      view.unmount(); world.loading = false; world.empty = true;
      const empty = render(<SupplierRelationshipsSection {...props} />);
      expect(screen.getAllByText(text.SuppliersRelationshipsEmpty).length).toBeGreaterThan(0);
      saveRender("empty", empty.container);
      empty.unmount(); world.error = true;
      const error = render(<SupplierRelationshipsSection {...props} />);
      expect(screen.getByRole("alert").textContent).toContain(text.SuppliersRelationshipsError);
      expect(error.container.textContent).not.toContain("private server detail");
      saveRender("error", error.container);
      cleanup();
    }
  });
  test("relationships with no vehicle permission have labels without links and no finance skips reads", () => {
    for (const locale of ["en", "ar"] as const) {
      resetWorld();
      world.locale = locale; world.permissions = [PERMISSIONS.VIEW_FINANCE];
      const view = render(<SupplierRelationshipsSection {...props} />);
      expect(screen.getAllByText("2024 Toyota Camry").length).toBeGreaterThan(0);
      expect(screen.queryByRole("link")).toBeNull();
      view.unmount(); world.permissions = []; world.calls = [];
      render(<SupplierRelationshipsSection {...props} />);
      expect(world.calls.filter(args => args !== "skip")).toHaveLength(0);
      cleanup();
    }
  });
  test("receivable metadata identifies the payer and keeps opening labels plain without opening access", () => {
    for (const locale of ["en", "ar"] as const) {
      resetWorld();
      const text = dictionaries[locale];
      world.locale = locale;
      const view = render(<SupplierRowDetails context={{ role: "AR", occurredAt: null, counterparty: "Synthetic payer", source: { kind: "OPENING", id: "draft1", label: "Opening claim", href: "/org1/accounting?section=settings" } }} />);
      expect(screen.getByText(text.SuppliersRowAR)).not.toBeNull();
      expect(view.container.textContent).toContain(text.SuppliersRowPayer);
      expect(view.container.textContent).toContain(text.SuppliersRowUnknownTime);
      expect(screen.getByText("Opening claim")).not.toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
      view.rerender(<SupplierRowDetails context={{ role: "AR", occurredAt: null, counterparty: "", source: null }} />);
      expect(view.container.textContent).toContain(text.SuppliersRowSourceUnavailable);
      expect(view.container.textContent).toContain(text.SuppliersRowUnknownParty);
      cleanup();
    }
  });
});
