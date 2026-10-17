/**
 * SCRUM-239: a CLEARED finance-company cheque's return is recorded from the DEAL
 * ("Cheque returned by bank"), so Collections never offers Return on it - the
 * server refuses it with FINANCE_CHEQUE_RETURN_FROM_DEAL anyway. A HELD or
 * DEPOSITED FC cheque keeps Return (returnCheque supports it). A customer's
 * cheque keeps Return. The Collections row says where the FC cheque is handled.
 */
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import type { Doc } from "@/convex/_generated/dataModel";
import { salesAr } from "@/lib/i18n/domains/sales";

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  paginated: new Map<string, unknown[]>(),
  mutations: new Map<string, (...args: unknown[]) => unknown>(),
  t: (key: string): string => key,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => stubs.t(key), isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (n: number) => `${n} JOD`,
}));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => k, retire: () => {} }),
}));
vi.mock("@/components/accounting/collections/CashDrawerPanel", () => ({ CashDrawerPanel: () => null }));
vi.mock("@/components/accounting/collections/PaymentLinksPanel", () => ({ PaymentLinksPanel: () => null }));
vi.mock("@/components/accounting/collections/InstallmentCalendar", () => ({ InstallmentCalendar: () => null }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    usePaginatedQuery: (reference: never) => ({
      results: stubs.paginated.get(getFunctionName(reference)) ?? [],
      status: "Exhausted",
      loadMore: () => {},
    }),
    useMutation: (reference: never) => stubs.mutations.get(getFunctionName(reference)) ?? vi.fn(),
  };
});

import { CollectionsTab } from "./CollectionsTab";

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

const cheque = (over: Record<string, unknown>) =>
  ({
    _id: "c1",
    _creationTime: 0,
    orgId: "org1",
    chequeDate: Date.UTC(2026, 9, 12),
    customerName: "Layla Haddad",
    vehicleLabel: "Toyota Camry 2024",
    bank: "Arab Bank",
    chequeNumber: "004512",
    status: "CLEARED",
    amount: 20000,
    ...over,
  }) as unknown as Doc<"postDatedCheques">;

afterEach(() => {
  cleanup();
  stubs.queryResults.clear();
  stubs.paginated.clear();
  stubs.mutations.clear();
  stubs.t = (key: string) => key;
});

async function openChequesTab() {
  stubs.queryResults.set("collections:summary", {
    totalOutstanding: 0, overdueOutstanding: 0, dueToday: 0, collectedToday: 0, upcomingChequeTotal: 0,
  });
  render(<CollectionsTab />);
  const tab = screen.getByRole("tab", { name: "Cheques" });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.focus(tab);
  // The rows paint once the tab's content mounts.
  await screen.findAllByText("004512", undefined, { timeout: 3000 });
}

describe("Collections, Cheques tab: Return", () => {
  test("clearance requires choosing its destination bank, even when only one is offered", async () => {
    stubs.queryResults.set("collections:listReceiptBankOptions", {
      banks: [{ _id: "bank1", name: "Operating bank", currency: "JOD" }], truncated: false,
    });
    const clearCheque = vi.fn().mockResolvedValue("payment1");
    stubs.mutations.set("collections:clearCheque", clearCheque);
    stubs.paginated.set("collections:listCheques", [cheque({ _id: "c1", isFinanceCompanyCheque: false, status: "DEPOSITED" })]);
    await openChequesTab();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Clear" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const trigger = within(dialog).getByRole("combobox", { name: "ReceiptBankAccount" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: /Operating bank/ }));
    fireEvent.click(confirm);
    await waitFor(() => expect(clearCheque).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org1", chequeId: "c1", bankAccountId: "bank1",
    })));
  });

  test("a positive return fee asks which bank paid that fee", async () => {
    stubs.queryResults.set("collections:listReceiptBankOptions", {
      banks: [{ _id: "fee-bank", name: "Fee bank", currency: "JOD" }], truncated: false,
    });
    const returnClearedCheque = vi.fn().mockResolvedValue(undefined);
    stubs.mutations.set("collections:returnClearedCheque", returnClearedCheque);
    stubs.paginated.set("collections:listCheques", [cheque({ _id: "c1", isFinanceCompanyCheque: false, status: "CLEARED" })]);
    await openChequesTab();
    fireEvent.click(screen.getByRole("button", { name: "Return" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("BankFeeMinorOptional"), { target: { value: "500" } });
    const confirm = within(dialog).getAllByRole("button", { name: "Return" }).at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const trigger = within(dialog).getByRole("combobox", { name: "ChequeReturnFeeBank" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: /Fee bank/ }));
    fireEvent.click(confirm);
    await waitFor(() => expect(returnClearedCheque).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org1", chequeId: "c1", bankFeeMinor: 500, bankFeeBankAccountId: "fee-bank",
    })));
  });

  test("canceling one return does not prefill another cheque's fee or bank", async () => {
    stubs.queryResults.set("collections:listReceiptBankOptions", {
      banks: [{ _id: "fee-bank", name: "Fee bank", currency: "JOD" }], truncated: false,
    });
    stubs.paginated.set("collections:listCheques", [
      cheque({ _id: "c1", isFinanceCompanyCheque: false }),
      cheque({ _id: "c2", chequeNumber: "009999", isFinanceCompanyCheque: false }),
    ]);
    await openChequesTab();
    fireEvent.click(screen.getAllByRole("button", { name: "Return" })[0]);
    const firstDialog = await screen.findByRole("dialog");
    fireEvent.change(within(firstDialog).getByPlaceholderText("BankFeeMinorOptional"), { target: { value: "500" } });
    const trigger = within(firstDialog).getByRole("combobox", { name: "ChequeReturnFeeBank" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: /Fee bank/ }));
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getAllByRole("button", { name: "Return" })[1]);
    const nextDialog = await screen.findByRole("dialog");
    expect((within(nextDialog).getByPlaceholderText("BankFeeMinorOptional") as HTMLInputElement).value).toBe("");
    expect(within(nextDialog).queryByRole("combobox", { name: "ChequeReturnFeeBank" })).toBeNull();
  });

  test.each(["HELD", "DEPOSITED"])(
    "a %s finance-company cheque keeps an enabled Return (returnCheque supports pre-clear FC bounces)",
    async (status) => {
      stubs.paginated.set("collections:listCheques", [
        cheque({ _id: "c1", isFinanceCompanyCheque: true, status }),
      ]);
      await openChequesTab();
      const ret = screen.getByRole("button", { name: "Return" }) as HTMLButtonElement;
      expect(ret.disabled).toBe(false);
    },
  );

  test("a CLEARED finance-company cheque has no Return (nor Clear/Replace); its deal handles it", async () => {
    stubs.paginated.set("collections:listCheques", [
      cheque({ _id: "c1", isFinanceCompanyCheque: true, status: "CLEARED" }),
    ]);
    await openChequesTab();
    expect(screen.getByText("FcHandledFromDeal")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Return" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  });

  test.each([true, false])(
    "a RETURNED cheque (finance-company: %s) has Return disabled - it is terminal for returning",
    async (isFinanceCompanyCheque) => {
      stubs.paginated.set("collections:listCheques", [
        cheque({ _id: "c1", isFinanceCompanyCheque, status: "RETURNED" }),
      ]);
      await openChequesTab();
      const ret = screen.getByRole("button", { name: "Return" }) as HTMLButtonElement;
      expect(ret.disabled).toBe(true);
    },
  );

  test("a customer's cheque keeps Return", async () => {
    stubs.paginated.set("collections:listCheques", [
      cheque({ _id: "c2", isFinanceCompanyCheque: false, customerName: "Omar Nasser" }),
    ]);
    await openChequesTab();
    expect(screen.getByRole("button", { name: "Return" })).toBeTruthy();
    expect(screen.queryByText("FcHandledFromDeal")).toBeNull();
  });

  test("both kinds side by side: exactly one Return, on the customer's row", async () => {
    stubs.paginated.set("collections:listCheques", [
      cheque({ _id: "c1", isFinanceCompanyCheque: true, status: "CLEARED" }),
      cheque({ _id: "c2", isFinanceCompanyCheque: false, customerName: "Omar Nasser" }),
    ]);
    await openChequesTab();
    expect(screen.getAllByRole("button", { name: "Return" })).toHaveLength(1);
    expect(screen.getAllByText("FcHandledFromDeal")).toHaveLength(1);
  });
});

describe("Collections, Cheques tab: the Return dialog shows a translated refusal", () => {
  test("a coded CHEQUE_ALREADY_RETURNED refusal is rendered in Arabic, not as raw JSON", async () => {
    // Only the server-error dictionary is Arabic here; button labels stay keys.
    stubs.t = (key: string) => (key.startsWith("ServerError_") ? (salesAr as Record<string, string>)[key] ?? key : key);
    const returnCheque = vi.fn().mockRejectedValue(
      new ConvexError({ code: "CHEQUE_ALREADY_RETURNED", message: "This cheque has already been returned, so it cannot be returned again. Nothing has been changed." })
    );
    stubs.mutations.set("collections:returnCheque", returnCheque);
    stubs.paginated.set("collections:listCheques", [cheque({ _id: "c1", isFinanceCompanyCheque: false, status: "HELD" })]);
    await openChequesTab();
    fireEvent.click(screen.getAllByRole("button", { name: "Return" })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Return" }).at(-1)!);
    await waitFor(() => expect(returnCheque).toHaveBeenCalledTimes(1));
    const { toast } = await import("@/components/ui/sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const shown = String(vi.mocked(toast.error).mock.calls.at(-1)?.[0]);
    expect(shown).toBe((salesAr as Record<string, string>).ServerError_CHEQUE_ALREADY_RETURNED);
    expect(shown).not.toContain('{"code"');
  });

  test("a coded CHEQUE_BANK_FEE_INVALID refusal on a cleared customer cheque is rendered in Arabic, not as raw JSON", async () => {
    stubs.t = (key: string) => (key.startsWith("ServerError_") ? (salesAr as Record<string, string>)[key] ?? key : key);
    const returnClearedCheque = vi.fn().mockRejectedValue(
      new ConvexError({ code: "CHEQUE_BANK_FEE_INVALID", message: "The bank fee must be a whole, non-negative amount in minor currency units. Nothing has been changed." })
    );
    stubs.mutations.set("collections:returnClearedCheque", returnClearedCheque);
    stubs.paginated.set("collections:listCheques", [cheque({ _id: "c3", isFinanceCompanyCheque: false, status: "CLEARED" })]);
    await openChequesTab();
    fireEvent.click(screen.getAllByRole("button", { name: "Return" })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Return" }).at(-1)!);
    await waitFor(() => expect(returnClearedCheque).toHaveBeenCalledTimes(1));
    const { toast } = await import("@/components/ui/sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const shown = String(vi.mocked(toast.error).mock.calls.at(-1)?.[0]);
    expect(shown).toBe((salesAr as Record<string, string>).ServerError_CHEQUE_BANK_FEE_INVALID);
    expect(shown).toMatch(/[\u0600-\u06FF]/);
    expect(shown).not.toContain('{"code"');
  });

  test("after a coded CHEQUE_RETURN_KEY_CONFLICT the next submit mints a FRESH idempotency key (the kept key is dead for that content)", async () => {
    const returnClearedCheque = vi
      .fn()
      .mockRejectedValueOnce(
        new ConvexError({ code: "CHEQUE_RETURN_KEY_CONFLICT", message: "This same request was already sent with a different cheque, reason or bank fee. Nothing has been changed. Close and reopen the dialog to try again." })
      )
      .mockResolvedValue(undefined);
    stubs.mutations.set("collections:returnClearedCheque", returnClearedCheque);
    stubs.paginated.set("collections:listCheques", [cheque({ _id: "c3", isFinanceCompanyCheque: false, status: "CLEARED" })]);
    await openChequesTab();
    fireEvent.click(screen.getAllByRole("button", { name: "Return" })[0]);
    const dialog = await screen.findByRole("dialog");
    const submit = () => fireEvent.click(within(dialog).getAllByRole("button", { name: "Return" }).at(-1)!);
    submit();
    await waitFor(() => expect(returnClearedCheque).toHaveBeenCalledTimes(1));
    const { toast } = await import("@/components/ui/sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    submit();
    await waitFor(() => expect(returnClearedCheque).toHaveBeenCalledTimes(2));
    const [first, second] = returnClearedCheque.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(second).not.toBe(first);
  });

  test("control: an unrelated lost response (plain error) keeps the same key for the retry", async () => {
    const returnClearedCheque = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue(undefined);
    stubs.mutations.set("collections:returnClearedCheque", returnClearedCheque);
    stubs.paginated.set("collections:listCheques", [cheque({ _id: "c3", isFinanceCompanyCheque: false, status: "CLEARED" })]);
    await openChequesTab();
    fireEvent.click(screen.getAllByRole("button", { name: "Return" })[0]);
    const dialog = await screen.findByRole("dialog");
    const submit = () => fireEvent.click(within(dialog).getAllByRole("button", { name: "Return" }).at(-1)!);
    submit();
    await waitFor(() => expect(returnClearedCheque).toHaveBeenCalledTimes(1));
    const { toast } = await import("@/components/ui/sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    submit();
    await waitFor(() => expect(returnClearedCheque).toHaveBeenCalledTimes(2));
    const [first, second] = returnClearedCheque.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(second).toBe(first);
  });
});
