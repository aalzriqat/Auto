/**
 * SCRUM-1012: the owner posts a bank's stored opening balance after cutover. The server decides who is offered what
 * (`bankAccounts.lateOpeningOffers`, `canPostLateOpening`); this panel only shows it, confirms it, and reports the
 * coded outcome in the user's language. Nothing the person types decides the amount or the date.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { dictionaries as appDictionaries } from "@/lib/i18n/dictionaries";
import { BankLateOpeningPanel } from "./BankLateOpeningPanel";

const dictionaries = appDictionaries as unknown as Record<"en" | "ar", Record<string, string>>;

const mocks = vi.hoisted(() => ({
  offers: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  locale: "en" as "en" | "ar",
}));

vi.mock("convex/react", () => ({
  useQuery: mocks.offers,
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "bankAccounts:postLateOpeningBalance") return mocks.post;
    throw new Error(`Unexpected mutation ${name}`);
  },
}));
vi.mock("@/components/ui/sonner", () => ({ toast: mocks.toast }));
vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      locale: mocks.locale,
      isRtl: mocks.locale === "ar",
      t: (key: string) => (dictionaries as Record<string, Record<string, string>>)[mocks.locale][key] ?? key,
    }),
  };
});

const orgId = "dealer" as Id<"organizations">;
const bankAccountId = "late-bank" as Id<"bankAccounts">;
const offer = {
  bankAccountId, name: "Late bank", currency: "JOD", amountMinor: 250_000,
  openingBalanceDate: Date.UTC(2026, 10, 20), canPostLateOpening: true,
};
const formatMinor = (minor: number, currency: string) => `${currency} ${(minor / 1000).toFixed(3)}`;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.locale = "en";
  mocks.offers.mockReturnValue([offer]);
});
afterEach(cleanup);

test("shows nothing while loading and nothing when the server offers no bank", () => {
  mocks.offers.mockReturnValue(undefined);
  const view = render(<BankLateOpeningPanel orgId={orgId} formatMinor={formatMinor} />);
  expect(view.container.textContent).toBe("");
  mocks.offers.mockReturnValue([]);
  view.rerender(<BankLateOpeningPanel orgId={orgId} formatMinor={formatMinor} />);
  expect(view.container.textContent).toBe("");
});

test("the action stays disabled when the server says this bank cannot be posted now", () => {
  mocks.offers.mockReturnValue([{ ...offer, canPostLateOpening: false }]);
  render(<BankLateOpeningPanel orgId={orgId} formatMinor={formatMinor} />);
  expect((screen.getByRole("button", { name: "Post opening balance" }) as HTMLButtonElement).disabled).toBe(true);
});

test.each([
  ["en", "This bank's opening balance date is before the organization's opening entry date"],
  ["ar", "تاريخ الرصيد الافتتاحي لهذا البنك أسبق من تاريخ قيد الافتتاح"],
] as const)("a bank dated before the opening says why in %s instead of the generic note", (locale, reason) => {
  mocks.locale = locale;
  mocks.offers.mockReturnValue([{ ...offer, canPostLateOpening: false, blockedReason: "LATE_BANK_OPENING_BEFORE_CUTOVER" }]);
  render(<BankLateOpeningPanel orgId={orgId} formatMinor={formatMinor} />);
  expect(screen.getByText(new RegExp(reason))).toBeTruthy();
  expect(screen.queryByText(dictionaries[locale].BankLateOpeningCannotNow)).toBeNull();
});

test("confirms bank, amount, date and the suspense account, then posts only the bank id and an identity", async () => {
  let finish: (value: unknown) => void = () => undefined;
  mocks.post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<BankLateOpeningPanel orgId={orgId} formatMinor={formatMinor} />);
  expect(screen.getByText("Late bank")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Post opening balance" }));
  const dialog = screen.getByRole("dialog");
  const text = within(dialog);
  expect(text.getByText("Late bank")).toBeTruthy();
  expect(text.getByText("JOD 250.000")).toBeTruthy();
  expect(text.getByText("2026-11-20")).toBeTruthy();
  expect(text.getByText(/Opening suspense \(1900\)/)).toBeTruthy();
  expect(mocks.post).not.toHaveBeenCalled();

  const confirm = text.getByRole("button", { name: "Post opening balance" }) as HTMLButtonElement;
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  // Loading: a second click cannot post twice while the first is in flight.
  expect(confirm.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.post).toHaveBeenCalledWith({ orgId, bankAccountId, idempotencyKey: expect.any(String) });

  finish({});
  await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Opening balance posted for this bank."));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a lost response retries under the same identity", async () => {
  mocks.post.mockRejectedValueOnce(new Error("Lost response")).mockResolvedValueOnce({});
  render(<BankLateOpeningPanel orgId={orgId} formatMinor={formatMinor} />);
  fireEvent.click(screen.getByRole("button", { name: "Post opening balance" }));
  const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Post opening balance" });
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  expect(mocks.post.mock.calls[1][0]).toEqual(mocks.post.mock.calls[0][0]);
});

test.each([
  ["en", "An opening balance has already been posted for this bank account."],
  ["ar", "سبق ترحيل رصيد افتتاحي لهذا الحساب البنكي."],
] as const)("a coded refusal is shown in %s and keeps the dialog open", async (locale, message) => {
  mocks.locale = locale;
  mocks.post.mockRejectedValue(new ConvexError({
    code: "LATE_BANK_OPENING_ALREADY_POSTED",
    message: "An opening balance has already been posted for this bank account.",
  }));
  render(<BankLateOpeningPanel orgId={orgId} formatMinor={formatMinor} />);
  fireEvent.click(screen.getByRole("button"));
  const dialog = screen.getByRole("dialog");
  expect(dialog.getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
  fireEvent.click(within(dialog).getByRole("button", { name: dictionaries[locale].BankLateOpeningPost }));
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(message));
  expect(screen.queryByRole("dialog")).not.toBeNull();
});
