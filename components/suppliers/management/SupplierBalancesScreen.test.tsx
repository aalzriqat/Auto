import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const world = vi.hoisted(() => ({ locale: "en" as "en" | "ar", permissions: ["view:finance", "view:cost_price"], calls: [] as Array<{ name: string; args: unknown }> }));
vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  return { useLanguage: () => ({ locale: world.locale, isRtl: world.locale === "ar", t: (key: string) => (dictionaries[world.locale] as Record<string, string>)[key] ?? key }) };
});
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ isLoading: false, hasPermission: (p: string) => world.permissions.includes(p) }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return { useQuery: (reference: never, args: unknown) => {
    world.calls.push({ name: getFunctionName(reference), args });
    if (args === "skip") return undefined;
    if (getFunctionName(reference) === "subscriptions:getMySubscription") return { planDetails: { gates: { accounting: true } } };
    return undefined;
  } };
});
import { SupplierBalancesScreen, SupplierBalancesView, type SupplierBalancesData } from "./SupplierBalancesScreen";
import { dictionaries } from "@/lib/i18n/dictionaries";
import type { Id } from "@/convex/_generated/dataModel";
const ORG = "org" as Id<"organizations">;
const data: SupplierBalancesData = { complete: true, isDone: true, continueCursor: "", page: [{
  supplierId: "supplier" as Id<"suppliers">, supplier: "Bloom", complete: true, currencies: [{ currency: "JOD", payableMinor: 5500001,
    receivableMinor: 3200000, netMinor: -2300001, overduePayableMinor: 5500001, overdueReceivableMinor: 200000,
    disputedPayableMinor: 5500001, disputedReceivableMinor: 0, oldestDueDate: "2026-11-06" }],
}] };
afterEach(cleanup);
beforeEach(() => { world.locale = "en"; world.permissions = ["view:finance", "view:cost_price"]; world.calls.length = 0; });
describe("SCRUM-929 supplier balances screen", () => {
  test.each(["en", "ar"] as const)("%s displays exact currency amounts, direction and statement links", locale => {
    world.locale = locale;
    const d = dictionaries[locale] as Record<string, string>;
    const view = render(<SupplierBalancesView orgId={ORG} data={data} />);
    expect(screen.getAllByRole("link", { name: "Bloom" }).every(a => a.getAttribute("href") === "/org/suppliers/supplier")).toBe(true);
    expect(screen.getAllByText(d.SuppliersBalancesYouOwe).length).toBeGreaterThan(0);
    expect(screen.getAllByText(d.SuppliersBalancesOwesYou).length).toBeGreaterThan(0);
    expect(view.container.textContent).toContain("5,500.001");
    expect(view.container.textContent).toContain("-2,300.001");
    expect(view.container.textContent).toContain(d.SuppliersBalancesNetYouOwe);
    expect(view.container.querySelector('[dir="rtl"]') !== null).toBe(locale === "ar");
  });
  test.each(["en", "ar"] as const)("%s empty and partial are distinct", locale => {
    world.locale = locale;
    const d = dictionaries[locale] as Record<string, string>;
    const { rerender } = render(<SupplierBalancesView orgId={ORG} data={{ ...data, page: [] }} />);
    expect(screen.getByText(d.SuppliersBalancesEmpty)).toBeTruthy();
    rerender(<SupplierBalancesView orgId={ORG} data={{ ...data, complete: false, page: [{ ...data.page[0]!, complete: false, currencies: [] }] }} />);
    expect(screen.getByText(d.SuppliersBalancesPartial)).toBeTruthy();
    expect(screen.getAllByText(d.SuppliersStmtTotalUnavailable).length).toBeGreaterThan(0);
    expect(screen.queryByText(d.SuppliersBalancesEmpty)).toBeNull();
    expect(screen.queryByText(/5,500/)).toBeNull();
  });
  test("loading is announced", () => {
    render(<SupplierBalancesView orgId={ORG} data={undefined} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
  test.each(["en", "ar"] as const)("%s withheld skips the cost query", locale => {
    world.locale = locale; world.permissions = ["view:finance"];
    render(<SupplierBalancesScreen orgId={ORG} />);
    expect(screen.getByText((dictionaries[locale] as Record<string, string>).SuppliersBalancesWithheld)).toBeTruthy();
    expect(world.calls.filter(c => c.name === "supplierBalances:list").every(c => c.args === "skip")).toBe(true);
  });
});
