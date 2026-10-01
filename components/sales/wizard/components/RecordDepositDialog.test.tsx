/**
 * SCRUM-444. The deposit dialog is one door with two behaviours, chosen by the
 * caller's authority and not by anything they can click:
 *
 *  - without `confirm:finance_disbursement` it can only REQUEST — it never
 *    reaches `deposits.create`, and it never asks for a payment method;
 *  - with it, it records real money and REFUSES to submit without a method
 *    (there is no default: the method picks the account debited).
 *
 * The translator is the identity on the key, so an assertion names the string
 * the component asked for.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";

const stubs = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  permissions: [] as string[],
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.includes(permission),
  }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      const name = getFunctionName(reference);
      stubs.calls.push({ name, args });
      return name === "deposits:create" ? "deposit1" : "request1";
    },
  };
});
// A native select: Radix's portal-driven Select is not what is under test.
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

import { RecordDepositDialog } from "./RecordDepositDialog";

const CONFIRM = "confirm:finance_disbursement";

function renderDialog() {
  const onRecorded = vi.fn();
  const onRequested = vi.fn();
  render(
    <RecordDepositDialog
      open
      onOpenChange={() => {}}
      quoteId={"quote1" as Id<"quotes">}
      onRecorded={onRecorded}
      onRequested={onRequested}
    />
  );
  return { onRecorded, onRequested };
}

async function submitAmount(amount: string) {
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: /^(RecordDeposit|RequestDeposit)$/ }));
}

beforeEach(() => {
  stubs.calls.length = 0;
  stubs.permissions = [];
});
afterEach(cleanup);

describe("RecordDepositDialog — request vs record", () => {
  test("without the authority it REQUESTS, and never asks for a method or reaches deposits.create", async () => {
    const { onRecorded, onRequested } = renderDialog();
    expect(screen.getByText("RequestDepositDesc")).toBeTruthy();
    expect(screen.queryByTestId("deposit-method-field")).toBeNull();

    await submitAmount("1500");

    await waitFor(() => expect(onRequested).toHaveBeenCalledWith("request1"));
    expect(onRecorded).not.toHaveBeenCalled();
    expect(stubs.calls.map((c) => c.name)).toEqual(["depositRequests:request"]);
    expect(stubs.calls[0].args).toMatchObject({ orgId: "org1", quoteId: "quote1", amount: 1500 });
    expect(stubs.calls[0].args.idempotencyKey).toEqual(expect.any(String));
    expect(stubs.calls.some((c) => c.name === "deposits:create")).toBe(false);
  });

  test("with the authority it records, and refuses to submit until a method is chosen", async () => {
    stubs.permissions = [CONFIRM];
    const { onRecorded, onRequested } = renderDialog();
    expect(screen.getByText("RecordDepositDesc")).toBeTruthy();
    expect(screen.getByTestId("deposit-method-field")).toBeTruthy();

    await submitAmount("1500");
    await screen.findByText("DepositMethodRequired");
    expect(stubs.calls).toEqual([]);

    fireEvent.change(screen.getByTestId("method-select"), { target: { value: "BANK_TRANSFER" } });
    fireEvent.click(screen.getByRole("button", { name: "RecordDeposit" }));

    await waitFor(() => expect(onRecorded).toHaveBeenCalledWith("deposit1"));
    expect(onRequested).not.toHaveBeenCalled();
    expect(stubs.calls.map((c) => c.name)).toEqual(["deposits:create"]);
    expect(stubs.calls[0].args).toMatchObject({
      orgId: "org1",
      quoteId: "quote1",
      amount: 1500,
      method: "BANK_TRANSFER",
    });
  });
});
