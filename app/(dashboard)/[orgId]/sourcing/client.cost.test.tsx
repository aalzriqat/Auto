/**
 * SCRUM-902: the sourcing screen needs view:cost_price as well as view:finance (the server requires the pair). Without it
 * the screen asks for nothing and shows a truthful note in English and Arabic: no figures and no empty tables.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";

let locale: "en" | "ar" = "en";
let permissions: string[] = [];
let permissionsLoading = false;
const queryArgs: Array<{ name: string; args: unknown }> = [];

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (ref: { name?: string }, args: unknown) => {
    queryArgs.push({ name: String(ref?.name), args });
    if (args === "skip") return undefined;
    if (String(ref?.name).includes("listPipeline")) return [];
    if (String(ref?.name).includes("sourcingPayables:list")) return [];
    return undefined;
  },
}));
vi.mock("@/convex/_generated/api", () => ({
  api: {
    sourcingPayables: {
      list: { name: "sourcingPayables:list" },
      listPipeline: { name: "sourcingPayables:listPipeline" },
      listPaymentBankOptions: { name: "sourcingPayables:listPaymentBankOptions" },
      markPaid: { name: "sourcingPayables:markPaid" },
    },
    vehicles: { markSourcedVehicleArrived: { name: "vehicles:markSourcedVehicleArrived" } },
  },
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: permissionsLoading, hasPermission: (p: string) => permissions.includes(p) }),
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    locale,
    t: (key: string) => (dictionaries[locale] as Record<string, string>)[key] ?? key,
  }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/sourcing/SupplierCostRecoveriesSection", () => ({ SupplierCostRecoveriesSection: () => null }));
vi.mock("@/components/payments/PaymentMethodSelect", () => ({ PaymentMethodSelect: () => null }));

import { SourcingClient } from "./client";

const text = (l: "en" | "ar") => (dictionaries[l] as Record<string, string>).SourcingCostAccessRequired;

beforeEach(() => {
  locale = "en";
  permissions = [];
  permissionsLoading = false;
  queryArgs.length = 0;
});
afterEach(cleanup);

describe("SCRUM-902 sourcing screen cost gate", () => {
  test.each(["en", "ar"] as const)("finance without cost-price access: a truthful note in %s and no query is sent", (l) => {
    locale = l;
    permissions = ["view:finance", "manage:finance"];
    render(<SourcingClient />);
    expect(text(l)).toBeTruthy();
    expect(screen.getByRole("note").textContent).toBe(text(l));
    expect(screen.queryByRole("table")).toBeNull();
    const sourcingQueries = queryArgs.filter((q) => q.name === "sourcingPayables:list" || q.name === "sourcingPayables:listPipeline");
    expect(sourcingQueries.length).toBeGreaterThan(0);
    expect(sourcingQueries.every((q) => q.args === "skip")).toBe(true);
  });

  test("the English and Arabic notes differ", () => {
    expect(text("en")).not.toBe(text("ar"));
  });

  test("control: finance with cost-price access queries the lists and shows no note", () => {
    permissions = ["view:finance", "view:cost_price"];
    render(<SourcingClient />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(queryArgs.some((q) => q.name === "sourcingPayables:list" && q.args !== "skip")).toBe(true);
  });

  test("while permissions load nothing is queried and the note is not shown yet", () => {
    permissionsLoading = true;
    render(<SourcingClient />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(queryArgs.filter((q) => q.name.startsWith("sourcingPayables:list")).every((q) => q.args === "skip")).toBe(true);
  });
});
