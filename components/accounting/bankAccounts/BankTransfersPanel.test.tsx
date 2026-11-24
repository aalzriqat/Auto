import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { economicDateInputToMs, economicTodayDateInput } from "@/lib/dateInput";
import { BankTransfersPanel } from "./BankTransfersPanel";

const mocks = vi.hoisted(() => ({
  recent: vi.fn(),
  record: vi.fn(),
  reverse: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  isRtl: false,
}));

vi.mock("convex/react", () => ({
  useQuery: mocks.recent,
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "bankTransfers:record") return mocks.record;
    if (name === "bankTransfers:reverse") return mocks.reverse;
    throw new Error(`Unexpected mutation ${name}`);
  },
}));

vi.mock("@/components/ui/sonner", () => ({ toast: mocks.toast }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    isRtl: mocks.isRtl,
    locale: mocks.isRtl ? "ar" : "en",
    t: (key: string) => key,
  }),
}));

const orgId = "dealer" as Id<"organizations">;
const bankId = "local-bank" as Id<"bankAccounts">;
const dollarsId = "dollar-bank" as Id<"bankAccounts">;
const accounts = [
  { _id: bankId, name: "Local Bank", currency: "JOD", isActive: true },
  { _id: dollarsId, name: "Dollar Bank", currency: "USD", isActive: true },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.recent.mockReturnValue([]);
  mocks.isRtl = false;
});

test("records exact Arabic minor units and reuses the same identity after a lost response", async () => {
  mocks.isRtl = true;
  mocks.record.mockRejectedValueOnce(new Error("Lost response")).mockResolvedValueOnce({});
  render(<BankTransfersPanel orgId={orgId} accounts={accounts} canManageFinance />);

  fireEvent.click(screen.getByRole("button", { name: "BankTransferRecord" }));
  const dialog = screen.getByRole("dialog");
  const form = within(dialog);
  expect(dialog.getAttribute("dir")).toBe("rtl");
  const submit = form.getByRole("button", { name: "BankTransferRecord" }) as HTMLButtonElement;
  fireEvent.change(form.getByLabelText("BankTransferFrom"), { target: { value: dollarsId } });
  fireEvent.change(form.getByLabelText("BankTransferTo"), { target: { value: bankId } });
  expect(form.getByRole("alert").textContent).toBe("BankTransferCurrencyMismatch");
  expect(submit.disabled).toBe(true);

  fireEvent.change(form.getByLabelText("BankTransferFrom"), { target: { value: "cash" } });
  fireEvent.change(form.getByLabelText(/Amount/), { target: { value: "١٢٦٫٤٠٠" } });
  fireEvent.change(form.getByLabelText("BankTransferReference"), { target: { value: "Deposit confirmation" } });
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("BankTransferRecordFailed"));

  fireEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.record).toHaveBeenCalledTimes(2);
  const [[first], [second]] = mocks.record.mock.calls;
  expect(first).toMatchObject({
    orgId, fromBankAccountId: null, toBankAccountId: bankId, currency: "JOD", amountMinor: 126_400,
    accountingDate: economicDateInputToMs(economicTodayDateInput()), reference: "Deposit confirmation",
    idempotencyKey: expect.any(String),
  });
  expect(second).toEqual(first);
});

test("shows posted movement to a viewer and requires a reason to reverse it", async () => {
  const eventId = "posted-transfer" as Id<"accountingEvents">;
  const accountingDate = economicDateInputToMs(economicTodayDateInput());
  mocks.recent.mockReturnValue([{
    eventId, accountingDate, currency: "JOD", amountMinor: 126_400, reference: "Bank confirmation",
    toBankName: "Local Bank", fromBankName: null, reversed: false,
  }]);
  mocks.reverse.mockResolvedValue({});
  const view = render(<BankTransfersPanel orgId={orgId} accounts={accounts} canManageFinance={false} />);
  expect(screen.getByText("Bank confirmation")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /BankTransferRecord|BankTransferReverse/ })).toBeNull();

  view.rerender(<BankTransfersPanel orgId={orgId} accounts={accounts} canManageFinance />);
  fireEvent.click(screen.getByRole("button", { name: "BankTransferReverse" }));
  const form = within(screen.getByRole("dialog"));
  const submit = form.getByRole("button", { name: "BankTransferReverse" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(form.getByLabelText("BankTransferReversalReason"), { target: { value: "Incorrect bank receipt" } });
  fireEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.reverse).toHaveBeenCalledWith({
    orgId, eventId, accountingDate, reason: "Incorrect bank receipt", idempotencyKey: expect.any(String),
  });
});
