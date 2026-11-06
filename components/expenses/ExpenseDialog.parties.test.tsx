import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { fromMinorUnits } from "@/convex/utils/money";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { ExpenseDialog } from "./ExpenseDialog";

// Only network and the authenticated organization context are replaced. The
// form, language provider, picker, error translator and toast renderer are real.
const network = vi.hoisted(() => ({ vehicles: [] as Array<Partial<Doc<"vehicles">>>, mutate: vi.fn() }));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_p4a" }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      if (name === "vehicles:listAll") return network.vehicles;
      if (name === "suppliers:list") return { page: [{ _id: "garage_p4b", displayName: "Garage", status: "ACTIVE" }] };
      if (name === "memberships:getMyMembership") return { permissions: ["manage:finance"] };
      if (name === "orgSettings:get") return { currency: "JOD" };
      return undefined;
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useMutation: () => network.mutate,
  };
});

const pendingExpense: Doc<"expenses"> = {
  _id: "expense_p4a" as Id<"expenses">, _creationTime: 0,
  orgId: "org_p4a" as Id<"organizations">, vehicleId: "vehicle_p4a" as Id<"vehicles">,
  title: "Supplier transport", amount: fromMinorUnits(200000, "JOD"), date: Date.UTC(2026, 0, 1), category: "TRANSPORT",
  status: "PENDING", costBearer: "SUPPLIER", paymentMethod: "CASH",
};

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

afterEach(() => {
  toast.dismiss();
  vi.unstubAllGlobals();
});

describe("P4b distinct expense parties", () => {
  test.each([
    ["en", "Supplier bearing the cost"],
    ["ar", "المورّد المتحمل للتكلفة"],
  ] as const)("%s names the vehicle supplier separately from the selected payee in a read-only field", async (locale, label) => {
    localStorage.setItem("autoflow-locale", locale);
    network.vehicles = [{ _id: pendingExpense.vehicleId, sourceType: "SOURCED", sourcedSupplierId: "supplier_bearer" as Id<"suppliers">,
      sourcedFromName: "Vehicle supplier snapshot", make: "Toyota", model: "Camry", year: 2024 }];
    render(<LanguageProvider><ExpenseDialog open onOpenChange={() => undefined} expense={pendingExpense} /></LanguageProvider>);
    const bearer = await screen.findByRole("textbox", { name: label });
    expect(bearer).toHaveProperty("value", "Vehicle supplier snapshot");
    expect(bearer).toHaveProperty("readOnly", true);
    const picker = screen.getByRole("combobox", { name: dictionaries[locale].ExpenseServicePayee });
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Garage" }));
    expect(bearer).toHaveProperty("value", "Vehicle supplier snapshot");
    expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");
  });

  test.each(["en", "ar"] as const)("%s selects canonical payee and submits no client bearer id", async locale => {
    localStorage.setItem("autoflow-locale", locale);
    network.vehicles = [{ _id: pendingExpense.vehicleId, sourceType: "SOURCED", sourcedSupplierId: "supplier_bearer" as Id<"suppliers">,
      sourcedFromName: "Vehicle supplier", make: "Toyota", model: "Camry", year: 2024 }];
    network.mutate.mockReset();
    network.mutate.mockResolvedValue(null);
    render(<LanguageProvider><ExpenseDialog open onOpenChange={() => undefined} expense={pendingExpense} /></LanguageProvider>);
    const copy = dictionaries[locale] as Record<string, string>;
    const picker = await screen.findByRole("combobox", { name: copy.ExpenseServicePayee ?? "Service provider / payee" });
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Garage" }));
    expect(screen.getByText(copy.ExpenseBearerExplanation ?? "Recovered from the vehicle supplier, not the payee.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: dictionaries[locale].SaveChanges }));
    await waitFor(() => expect(network.mutate).toHaveBeenCalledTimes(1));
    const payload = network.mutate.mock.calls[0][0];
    expect(payload.vendorSupplierId).toBe("garage_p4b");
    expect(payload).not.toHaveProperty("costBearerSupplierId");
    expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");
  });

  test.each(["en", "ar"] as const)("%s keeps free-text payee for showroom expenses", async locale => {
    localStorage.setItem("autoflow-locale", locale);
    network.vehicles = [];
    render(<LanguageProvider><ExpenseDialog open onOpenChange={() => undefined} expense={{ ...pendingExpense, vehicleId: undefined, costBearer: "SHOWROOM", vendor: "Office shop" }} /></LanguageProvider>);
    expect(await screen.findByDisplayValue("Office shop")).toBeTruthy();
    const copy = dictionaries[locale] as Record<string, string>;
    expect(screen.queryByRole("combobox", { name: copy.ExpenseServicePayee ?? "Service provider / payee" })).toBeNull();
  });

  test.each(["en", "ar"] as const)("%s locks a paid payee and leaves legacy notes edits free of unchanged vehicle assignment", async locale => {
    localStorage.setItem("autoflow-locale", locale);
    network.vehicles = [];
    network.mutate.mockReset();
    network.mutate.mockResolvedValue(null);
    render(<LanguageProvider><ExpenseDialog open onOpenChange={() => undefined} expense={{ ...pendingExpense, status: "PAID", vendor: "Historical garage", vendorSupplierId: "garage_p4b" as Id<"suppliers"> }} /></LanguageProvider>);
    const copy = dictionaries[locale] as Record<string, string>;
    const picker = await screen.findByRole("combobox", { name: copy.ExpenseServicePayee });
    expect(picker.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(copy.ExpensePayeeLocked)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(copy.AnyExtraDetails), { target: { value: "History note" } });
    fireEvent.click(screen.getByRole("button", { name: copy.SaveChanges }));
    await waitFor(() => expect(network.mutate).toHaveBeenCalledTimes(1));
    expect(network.mutate.mock.calls[0][0]).toMatchObject({ notes: "History note", vehicleId: undefined, paymentMethod: undefined, date: undefined });
  });

});
