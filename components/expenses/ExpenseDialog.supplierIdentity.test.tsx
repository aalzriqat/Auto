import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { Toaster, toast } from "sonner";
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

describe("P4a expense supplier identity explanation", () => {
  test.each([
    ["en", "unlinked"], ["ar", "unlinked"], ["en", "unavailable"], ["ar", "unavailable"],
  ] as const)("%s explains an %s vehicle before submit and renders the coded server refusal", async (locale, vehicleState) => {
    localStorage.setItem("autoflow-locale", locale);
    network.vehicles = vehicleState === "unavailable" ? [] : [{
      _id: pendingExpense.vehicleId, sourceType: "SOURCED", make: "Toyota", model: "Camry", year: 2024,
    }];
    network.mutate.mockReset();
    network.mutate.mockRejectedValue(new ConvexError({ code: "SUPPLIER_IDENTITY_UNRESOLVED", message: "Private diagnostic must not render" }));
    render(<LanguageProvider><ExpenseDialog open onOpenChange={() => undefined} expense={pendingExpense} /><Toaster /></LanguageProvider>);
    const hint = dictionaries[locale].CostBearerSupplierLinkRequired;
    expect(await screen.findByText(hint)).toBeTruthy();
    expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");
    // An older pending SUPPLIER expense is still shown truthfully. The server
    // remains the authority when this stale form is submitted.
    fireEvent.click(screen.getByRole("button", { name: dictionaries[locale].SaveChanges }));
    await waitFor(() => expect(network.mutate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(dictionaries[locale].ServerError_SUPPLIER_IDENTITY_UNRESOLVED)).toBeTruthy();
    expect(screen.queryByText("Private diagnostic must not render")).toBeNull();
  });
});
