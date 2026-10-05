/**
 * SCRUM-641 F6: the deleted-vehicle refusal reaches the operator in THEIR language.
 *
 * The three screens that call a door guarded by `assertVehicleNotDeleted` used the English-only
 * `getErrorMessage`, so an Arabic user saw the server's English text. Each now resolves the coded error
 * through `getLocalizedErrorMessage` with the REAL Arabic dictionary (not an identity translator, which
 * would pass either way).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { dictionaries } from "../../lib/i18n/dictionaries";
import type { Id } from "../../convex/_generated/dataModel";

const AR_DELETED = "تم حذف هذه السيارة ولم يعد بالإمكان تسعيرها أو حجزها أو بيعها أو استلام عربون عليها.";
const ar = (key: string) => (dictionaries.ar as Record<string, string>)[key] ?? key;
const deletedError = () =>
  new ConvexError({ code: "VEHICLE_DELETED", message: "This vehicle has been deleted and can no longer be quoted, reserved, sold or take a deposit." });

const stubs = vi.hoisted(() => ({
  queryResult: undefined as unknown,
  mutationError: undefined as unknown,
  toastError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: () => stubs.queryResult,
  useMutation: () => async () => {
    throw stubs.mutationError;
  },
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => ar(key), isRtl: true, locale: "ar" }),
}));

vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({ currency: "USD" }),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: (message: string) => stubs.toastError(message) },
}));

import { ProfitApprovalNotice } from "./ProfitApprovalNotice";
import { DepositAllocationPanel } from "./wizard/components/DepositAllocationPanel";

function renderNotice(verdict: Record<string, unknown>) {
  render(
    <ProfitApprovalNotice
      approval={{
        verdict,
        blocked: true,
        request: { orgId: "org1" as Id<"organizations">, vehicleId: "veh1" as Id<"vehicles">, salePrice: 1000 },
      } as never}
    />
  );
}

beforeEach(() => {  stubs.toastError.mockClear();
  stubs.mutationError = deletedError();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SCRUM-641 F6: Arabic wording for a deleted-vehicle refusal", () => {
  test("the Arabic dictionary carries the VEHICLE_DELETED sentence", () => {
    expect(ar("ServerError_VEHICLE_DELETED")).toBe(AR_DELETED);
  });

  test("ProfitApprovalNotice: a VEHICLE_DELETED verdict renders the Arabic sentence", () => {
    renderNotice({ status: "VEHICLE_DELETED" });

    expect(screen.getByRole("alert").textContent).toContain(AR_DELETED);
  });

  test("ProfitApprovalNotice: a failed approval request toasts the Arabic sentence, not the English one", async () => {
    renderNotice({ status: "REQUIRED", margin: 0, minimumProfit: 100 });

    fireEvent.click(screen.getByRole("button", { name: ar("ProfitApprovalRequestAction") }));
    await waitFor(() => expect(stubs.toastError).toHaveBeenCalledTimes(1));
    expect(stubs.toastError).toHaveBeenCalledWith(AR_DELETED);
  });

  test("DepositAllocationPanel: a failed save toasts the Arabic sentence", async () => {
    stubs.queryResult = {
      isMultiVehicle: true,
      heldTotalMinor: 5000,
      availableForAllocationMinor: 5000,
      scale: 0,
      vehicles: [
        { vehicleId: "v1", label: "Car 1", unitPrice: 3000, status: undefined, allocatedMinor: undefined },
        { vehicleId: "v2", label: "Car 2", unitPrice: 20000, status: undefined, allocatedMinor: undefined },
      ],
      vehiclesWithoutAllocation: [],
    };
    render(<DepositAllocationPanel orgId={"org1" as Id<"organizations">} quoteId={"q1" as Id<"quotes">} />);
    fireEvent.click(screen.getByRole("button", { name: ar("DepositAllocationSave") }));
    await waitFor(() => expect(stubs.toastError).toHaveBeenCalledTimes(1));
    expect(stubs.toastError).toHaveBeenCalledWith(AR_DELETED);
  });

  test("QuoteDepositManager: both catch sites resolve through the localizing helper", () => {
    const source = readFileSync(join(__dirname, "../deposits/QuoteDepositManager.tsx"), "utf8");
    expect(source).not.toMatch(/\bgetErrorMessage\(/);
    expect(source.match(/getLocalizedErrorMessage\(error, t\)/g)?.length).toBe(2);
  });
});
