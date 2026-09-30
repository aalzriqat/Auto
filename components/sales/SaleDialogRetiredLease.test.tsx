/**
 * SCRUM-495 (owner rulings OR-6 / OR-7): the sale form and a retired LEASE sale.
 *
 * Three claims, each of which a plausible wrong implementation breaks:
 *  - a stored LEASE sale keeps showing what it is (a disabled "Lease (retired)"
 *    item), and Lease is not offered as a fresh choice on a CASH sale;
 *  - saving that sale WITHOUT touching the financing type does not resend
 *    `financingType` at all (the server refuses a change INTO a retired mode);
 *  - the form never maps LEASE to CASH, on load or on save.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Doc, Id } from "../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof import("vitest").vi.fn>>(),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    // One stable stub per function path, so a test can read what a mutation was called with.
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      if (!stubs.mutations.has(name)) stubs.mutations.set(name, vi.fn().mockResolvedValue(undefined));
      return stubs.mutations.get(name)!;
    },
  };
});

import { SaleDialog } from "./SaleDialog";

const ORG = "org1" as Id<"organizations">;
const CAR = "carOwned" as Id<"vehicles">;

function sale(financingType: "CASH" | "FINANCED" | "LEASE"): Doc<"sales"> {
  return {
    _id: "sale1" as Id<"sales">,
    _creationTime: Date.now(),
    orgId: ORG,
    vehicleId: CAR,
    customerId: "cust1" as Id<"customers">,
    salespersonId: "user1" as Id<"users">,
    salePrice: 12_500,
    saleDate: Date.now(),
    status: "COMPLETED",
    taxAmount: 0,
    financingType,
  } as unknown as Doc<"sales">;
}

const owned = {
  _id: CAR,
  orgId: ORG,
  make: "Toyota",
  model: "Camry",
  year: 2024,
  vin: "VIN1",
  sellingPrice: 12_500,
  status: "AVAILABLE",
  sourceType: "STOCK",
  purchasePrice: 9_500,
} as unknown as Doc<"vehicles">;

beforeEach(() => {
  cleanup();
  stubs.queryResults.clear();
  stubs.mutations.clear();
  stubs.queryResults.set("vehicles:listAll", [owned]);
});

const open = (s: Doc<"sales">) => render(<SaleDialog open onOpenChange={() => {}} sale={s} />);

describe("a retired LEASE sale in the sale form", () => {
  test("keeps showing Lease (retired) as the stored value, never CASH", async () => {
    open(sale("LEASE"));
    // The financing trigger reads the stored value; Radix also mirrors it in a hidden native select.
    await waitFor(() =>
      expect(screen.getAllByRole("combobox").some((c) => (c.textContent ?? "").includes("LeaseRetired"))).toBe(true)
    );
    const native = Array.from(document.querySelectorAll("select")).find((el) =>
      Array.from(el.options).some((o) => o.value === "LEASE")
    );
    expect(native?.value).toBe("LEASE");
  });

  test("saving it untouched does not resend the financing type, and never sends CASH", async () => {
    open(sale("LEASE"));
    fireEvent.click(screen.getByRole("button", { name: /SaveChanges/ }));

    await waitFor(() => expect(stubs.mutations.get("sales:update")).toHaveBeenCalledTimes(1));
    const args = stubs.mutations.get("sales:update")!.mock.calls[0][0] as Record<string, unknown>;
    expect(args).not.toHaveProperty("financingType");
    expect(Object.values(args)).not.toContain("CASH");
  });

  test("control: an untouched operated sale does not resend its financing type either", async () => {
    open(sale("CASH"));
    // A CASH sale offers no Lease item at all.
    expect(screen.queryByText("LeaseRetired")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /SaveChanges/ }));

    await waitFor(() => expect(stubs.mutations.get("sales:update")).toHaveBeenCalledTimes(1));
    const args = stubs.mutations.get("sales:update")!.mock.calls[0][0] as Record<string, unknown>;
    // Untouched CASH is not resent either: only a change is.
    expect(args).not.toHaveProperty("financingType");
  });
});
