/**
 * SCRUM-469. Recording a supplier's repayment books the receipt to the account
 * its method names, so the picker starts empty, the button is refused until one
 * is chosen, and the chosen method is exactly what reaches
 * `supplierCostRecoveries.recordReceipt`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_1" }),
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: false, hasPermission: () => true }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/payments/PaymentMethodSelect", () => ({
  PaymentMethodSelect: ({
    value,
    onValueChange,
    ariaLabel,
  }: {
    value: string | undefined;
    onValueChange: (method: string) => void;
    ariaLabel?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      data-testid="method-select"
      value={value ?? ""}
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="" />
      <option value="CASH">CASH</option>
      <option value="BANK_TRANSFER">BANK_TRANSFER</option>
    </select>
  ),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: () => ({
      complete: true,
      items: [
        {
          _id: "rec_1",
          sourcedFromName: "Supplier Co",
          currency: "JOD",
          amountDueMinor: 500_000,
          amountRecoveredMinor: 0,
          remainingMinor: 500_000,
          status: "OPEN",
          sourcePostingState: "POSTED",
          expenseTitle: "Tyres",
          vehicleLabel: "2020 Toyota Camry",
        },
      ],
    }),
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      stubs.calls.push({ name: getFunctionName(reference), args });
    },
  };
});

import { SupplierCostRecoveriesSection } from "./SupplierCostRecoveriesSection";

beforeEach(() => {
  stubs.calls.length = 0;
});
afterEach(cleanup);

function openDialog() {
  render(<SupplierCostRecoveriesSection />);
  fireEvent.click(screen.getByRole("button", { name: "RecordRecoveryReceipt" }));
  return screen.getByRole("dialog");
}
const record = (dialog: HTMLElement) =>
  within(dialog).getAllByRole("button", { name: "RecordRecoveryReceipt" }).at(-1) as HTMLButtonElement;

describe("SupplierCostRecoveriesSection receipt method (SCRUM-469)", () => {
  test("opens with no method: recording is refused and the reason is on screen", () => {
    const dialog = openDialog();
    expect((within(dialog).getByTestId("method-select") as HTMLSelectElement).value).toBe("");
    expect(within(dialog).getByRole("alert").textContent).toBe("MoneyMethodRequired");
    expect(record(dialog).disabled).toBe(true);
    fireEvent.click(record(dialog));
    expect(stubs.calls).toHaveLength(0);
  });

  test("sends exactly the chosen method", async () => {
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByTestId("method-select"), { target: { value: "BANK_TRANSFER" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(record(dialog).disabled).toBe(false);
    fireEvent.click(record(dialog));
    await waitFor(() => expect(stubs.calls).toHaveLength(1));
    expect(stubs.calls[0]!.args).toMatchObject({ recoveryId: "rec_1", amountMinor: 500_000, method: "BANK_TRANSFER" });
  });

  test("the last choice is not remembered when the dialog is opened again", () => {
    let dialog = openDialog();
    fireEvent.change(within(dialog).getByTestId("method-select"), { target: { value: "CASH" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "RecordRecoveryReceipt" }));
    dialog = screen.getByRole("dialog");
    expect((within(dialog).getByTestId("method-select") as HTMLSelectElement).value).toBe("");
  });
});
