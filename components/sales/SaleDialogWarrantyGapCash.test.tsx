/**
 * SCRUM-504 follow-up (R3 F1): warranty and GAP entry is independent of the financing type.
 *
 * FINANCED is selectable only for a sale that already has its finance application, so the
 * warranty/GAP inputs may not live inside the FINANCED-only block: the server still accepts
 * and bills them on a CASH sale (customerBilledLinesMinor). The APR/term (rate) inputs stay
 * FINANCED-only.
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

function cashSale(): Doc<"sales"> {
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
    financingType: "CASH",
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

const open = () => render(<SaleDialog open onOpenChange={() => {}} sale={cashSale()} />);
const setNumber = (label: string, value: number) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value: String(value) } });

describe("warranty and GAP entry on a CASH sale", () => {
  test("the warranty and GAP inputs are present while CASH is selected", () => {
    open();
    expect(screen.getByLabelText("Warranty")).toBeTruthy();
    expect(screen.getByLabelText("GAPInsurance")).toBeTruthy();
  });

  test("the FINANCED-only rate inputs stay hidden for CASH", () => {
    open();
    expect(screen.queryByLabelText("APR")).toBeNull();
    expect(screen.queryByLabelText("TermMonths")).toBeNull();
  });

  test("a CASH sale with a warranty sends warrantySold and its term fields; GAP likewise", async () => {
    open();
    setNumber("Warranty", 450);
    setNumber("WarrantyCost", 200);
    setNumber("WarrantyTermMonths", 24);
    setNumber("GAPInsurance", 300);
    setNumber("GAPCost", 120);
    setNumber("GAPTermMonths", 36);
    fireEvent.click(screen.getByRole("button", { name: /SaveChanges/ }));
    await waitFor(() => expect(stubs.mutations.get("sales:update")).toHaveBeenCalledTimes(1));
    const args = stubs.mutations.get("sales:update")!.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({
      warrantySold: 450,
      warrantyCost: 200,
      warrantyTermMonths: 24,
      gapSold: 300,
      gapCost: 120,
      gapTermMonths: 36,
    });
    expect(args).not.toHaveProperty("financingType");
  });
});
