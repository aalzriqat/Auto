/**
 * SCRUM-469 round 1 (SOL-01 / OPUS-F1). A payment method is an attribute of ONE
 * money movement. In the vehicle dialog that means:
 *   - a refund method chosen for one payout is not carried into the NEXT payout
 *     of the same held deposit (its `releaseCount` generation advanced);
 *   - a retry of the SAME unresolved attempt (same generation) keeps its method;
 *   - the reservation deposit's method does not survive closing the dialog.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

const state = vi.hoisted(() => ({
  deposits: [] as Array<Record<string, unknown>>,
  reservationCalls: [] as Array<Record<string, unknown>>,
  /** Outcome of the next createReservation call: a lost response, or success. */
  reservationOutcomes: [] as Array<"lost" | "ok" | "mismatch">,
  toastError: [] as string[],
}));

vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const Ctx = React.createContext<(v: string) => void>(() => undefined);
  return {
    Select: ({ onValueChange, children }: { onValueChange: (v: string) => void; children: React.ReactNode }) => (
      <Ctx.Provider value={onValueChange}>{children}</Ctx.Provider>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value }: { value: string }) => {
      const pick = React.useContext(Ctx);
      return <button type="button" data-testid={`item-${value}`} onClick={() => pick(value)} />;
    },
  };
});

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "deposits:listByVehicle") return state.deposits;
      if (name === "customers:list") return { page: [{ _id: "cust_1", firstName: "Dana", lastName: "K" }] };
      if (name === "vehicles:getRelations") return { testDrives: [], workOrders: [], leads: [], sales: [], tasks: [], expenses: [] };
      return undefined;
    },
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      if (getFunctionName(reference) !== "vehicles:createReservation") return undefined;
      state.reservationCalls.push(args);
      const outcome = state.reservationOutcomes.shift();
      if (outcome === "lost") throw new Error("Network error: response lost");
      if (outcome === "mismatch") {
        throw new Error("Idempotency key reused with different request content. Use a new key for a different operation.");
      }
      return undefined;
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => ({}) }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: () => true, isLoading: false }),
}));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (intent: string) => intent, retire: () => undefined }),
}));
vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: (message: string) => state.toastError.push(message) },
}));
vi.mock("@/components/test_drives/TestDriveDialog", () => ({ TestDriveDialog: () => null }));
vi.mock("@/components/work_orders/WorkOrderDialog", () => ({ WorkOrderDialog: () => null }));
vi.mock("@/components/vehicles/VehicleValuationsTab", () => ({ VehicleValuationsTab: () => null }));
vi.mock("@/components/vehicles/VehicleMarketingTab", () => ({ VehicleMarketingTab: () => null }));
vi.mock("@/components/payments/PaymentMethodSelect", () => ({
  PaymentMethodSelect: ({
    value,
    onValueChange,
    placeholder,
  }: {
    value: string | undefined;
    onValueChange: (method: string) => void;
    placeholder?: string;
  }) => (
    <select
      data-testid={`method-${placeholder}`}
      value={value ?? ""}
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="" />
      <option value="CASH">CASH</option>
      <option value="BANK_TRANSFER">BANK_TRANSFER</option>
    </select>
  ),
}));

import { VehicleDetailsDialog } from "./VehicleDetailsDialog";

const vehicle = {
  _id: "veh_1",
  year: 2024,
  make: "Toyota",
  model: "Camry",
  status: "AVAILABLE",
  mileage: 1000,
  sellingPrice: 20000,
  purchasePrice: 15000,
  vin: "VIN123",
  color: "White",
  fuelType: "PETROL",
  transmission: "AUTOMATIC",
} as never;

const deposit = (releaseCount: number) => ({
  _id: "dep_1",
  amount: 1000,
  status: "HELD",
  releaseCount,
});

const ui = (open = true): ReactElement => (
  <VehicleDetailsDialog vehicle={vehicle} open={open} onOpenChange={() => undefined} canViewPurchasePrice />
);
const refundSelect = () => screen.getByTestId("method-RefundChooseMethod") as HTMLSelectElement;
const refundButton = () => screen.getByRole("button", { name: "Refund", hidden: true }) as HTMLButtonElement;

beforeEach(() => {
  state.deposits = [deposit(0)];
  state.reservationCalls = [];
  state.reservationOutcomes = [];
  state.toastError = [];
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

describe("vehicle dialog: method is per money movement (SCRUM-469 round 1)", () => {
  test("a partial payout (releaseCount advances) clears the refund method for the NEXT payout", () => {
    const view = render(ui());
    fireEvent.change(refundSelect(), { target: { value: "CASH" } });
    expect(refundSelect().value).toBe("CASH");
    expect(refundButton().disabled).toBe(false);

    state.deposits = [deposit(1)];
    view.rerender(ui());

    expect(refundSelect().value).toBe("");
    expect(refundButton().disabled).toBe(true);
  });

  test("control: the SAME generation (a retry of the unresolved attempt) keeps its method", () => {
    const view = render(ui());
    fireEvent.change(refundSelect(), { target: { value: "CASH" } });

    state.deposits = [deposit(0)];
    view.rerender(ui());

    expect(refundSelect().value).toBe("CASH");
    expect(refundButton().disabled).toBe(false);
  });

  test("a reservation deposit method does not survive closing and reopening the dialog", () => {
    const view = render(ui());
    const amount = screen.getAllByRole("spinbutton", { hidden: true })[0] as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "50" } });
    const method = () => screen.getByTestId("method-DepositChooseMethod") as HTMLSelectElement;
    fireEvent.change(method(), { target: { value: "CASH" } });
    expect(method().value).toBe("CASH");

    view.rerender(ui(false));
    view.rerender(ui(true));
    fireEvent.change(screen.getAllByRole("spinbutton", { hidden: true })[0]!, { target: { value: "50" } });

    expect(method().value).toBe("");
  });

  test("a reservation whose response was lost keeps its idempotency key across close/reopen; a confirmed success mints a new one", async () => {
    state.reservationOutcomes = ["lost", "ok", "ok"];
    const view = render(ui());
    const method = () => screen.getByTestId("method-DepositChooseMethod") as HTMLSelectElement;
    const fill = () => {
      fireEvent.click(screen.getByTestId("item-cust_1"));
      fireEvent.change(screen.getAllByRole("spinbutton", { hidden: true })[0]!, { target: { value: "50" } });
      fireEvent.change(method(), { target: { value: "CASH" } });
    };
    const submitReservation = async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "CreateReservation", hidden: true }).at(-1)!);
      await waitFor(() => expect(state.reservationCalls.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    fill();
    await submitReservation();
    expect(state.reservationCalls).toHaveLength(1);
    const firstKey = state.reservationCalls[0]!.idempotencyKey;

    // Server state unknown (lost response). Close, reopen the SAME vehicle, retry.
    view.rerender(ui(false));
    view.rerender(ui(true));
    expect(method().value).toBe("");
    fireEvent.change(method(), { target: { value: "CASH" } });
    await submitReservation();
    await waitFor(() => expect(state.reservationCalls).toHaveLength(2));
    expect(state.reservationCalls[1]!.idempotencyKey).toBe(firstKey);

    // Confirmed success retires the identity: the NEXT reservation is a new command.
    fill();
    await submitReservation();
    await waitFor(() => expect(state.reservationCalls).toHaveLength(3));
    expect(state.reservationCalls[2]!.idempotencyKey).not.toBe(firstKey);
  });

  test("a changed request under a kept key is refused with a readable localized message, not the raw server text", async () => {
    state.reservationOutcomes = ["mismatch"];
    render(ui());
    fireEvent.click(screen.getByTestId("item-cust_1"));
    fireEvent.change(screen.getAllByRole("spinbutton", { hidden: true })[0]!, { target: { value: "50" } });
    fireEvent.change(screen.getByTestId("method-DepositChooseMethod"), { target: { value: "BANK_TRANSFER" } });
    fireEvent.click(screen.getAllByRole("button", { name: "CreateReservation", hidden: true }).at(-1)!);
    await waitFor(() => expect(state.toastError).toHaveLength(1));
    expect(state.toastError[0]).toBe("ReservationAttemptChanged");
  });
});