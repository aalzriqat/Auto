/**
 * SCRUM-961: the second person reviews a pending request. Approve sends the total and true-up the reviewer is looking
 * at, so a figure that changed in the meantime is refused by the backend; the requester is told someone else must
 * approve; a refusal is shown in the user's language; Dismiss closes the request.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { dictionaries as appDictionaries } from "@/lib/i18n/dictionaries";
import { PrepaidReclassReviewDialog } from "./PrepaidReclassReviewDialog";

const dictionaries = appDictionaries as unknown as Record<"en" | "ar", Record<string, string>>;

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  dismiss: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  locale: "en" as "en" | "ar",
}));

vi.mock("convex/react", () => ({
  // The status already names everyone, so the approver needs neither a query nor the team list.
  useQuery: () => { throw new Error("No query expected"); },
  usePaginatedQuery: () => { throw new Error("No team list expected"); },
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "openingPrepaidReclassification:approvePrepaidReclassification") return mocks.approve;
    if (name === "openingPrepaidReclassification:dismissPrepaidReclassification") return mocks.dismiss;
    throw new Error(`Unexpected mutation ${name}`);
  },
}));
vi.mock("@/components/ui/sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isOwner: false, membership: { userId: "approver" }, hasPermission: () => true }),
}));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatterInCurrency: () => (amount: number, currency: string, digits = 0) => `${currency} ${amount.toFixed(digits)}`,
}));
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
const schedule = {
  _id: "schedule-a" as Id<"prepaidExpenseSchedules">, currency: "JOD", title: "Establishment expenses", monthsRemaining: 5,
};
const requestedAt = Date.UTC(2026, 10, 26, 9);
const okFigures = {
  ok: true as const, trueUpMinor: 103_333, newTotalMinor: 7_128_000, newRecognizedMinor: 1_188_000,
  remainingMonths: 4, regularMonthlyMinor: 1_485_000, finalMonthlyMinor: 1_485_003,
};
type Figures = typeof okFigures | { ok: false; code: string };
const pending = {
  reclassificationId: "reclass-1" as Id<"openingPrepaidReclassifications">,
  requestedByMe: false, requestedBy: { userId: "sara" as Id<"users">, name: "Sara" as string | null }, requestedAt,
  totalMinor: 620_000, trueUpMinor: 103_333 as number | null,
  lines: [
    { userId: "amer" as Id<"users">, name: "Amer" as string | null, amountMinor: 470_000 },
    { userId: "thaer" as Id<"users">, name: "Thaer" as string | null, amountMinor: 150_000 },
  ],
  reason: "Advances paid before opening",
  figures: okFigures as Figures,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.locale = "en";
});

const en = (key: string) => dictionaries.en[key];
const renderDialog = (overrides: Partial<typeof pending> = {}, onClose = vi.fn()) =>
  render(<PrepaidReclassReviewDialog orgId={orgId} schedule={schedule} pending={{ ...pending, ...overrides }} onClose={onClose} />);
const figure = (label: string) => screen.getByText(label).closest("dt")?.nextElementSibling?.textContent;

test.each(["en", "ar"] as const)("shows in %s who asked and when, the reason, each person and every backend figure", (locale) => {
  mocks.locale = locale;
  renderDialog();
  const words = dictionaries[locale];
  const dialog = within(screen.getByRole("dialog"));
  expect(figure(words.PrepaidReclassRequestedBy)).toBe("Sara");
  expect(figure(words.PrepaidReclassRequestedOn)).toBe(new Date(requestedAt).toLocaleDateString(locale === "ar" ? "ar-JO" : "en-US"));
  expect(dialog.getByText("Advances paid before opening")).toBeTruthy();
  expect(dialog.getByText("Amer").closest("tr")?.textContent).toContain("JOD 470.000");
  expect(dialog.getByText("Thaer").closest("tr")?.textContent).toContain("JOD 150.000");
  expect(figure(words.PrepaidReclassTotal)).toBe("JOD 620.000");
  expect(figure(words.PrepaidReclassTrueUp)).toBe("JOD 103.333");
  expect(figure(words.PrepaidReclassNewTotal)).toBe("JOD 7128.000");
  expect(figure(words.PrepaidReclassNewRecognized)).toBe("JOD 1188.000");
  expect(figure(words.PrepaidReclassMonthsLeft)).toBe("4");
  expect(figure(words.PrepaidReclassMonthly)).toBe("JOD 1485.000");
  expect(figure(words.PrepaidReclassFinalMonthly)).toBe("JOD 1485.003");
});

test.each(["en", "ar"] as const)("an unresolved person (null name) is shown as the translated unknown-member text in %s", (locale) => {
  mocks.locale = locale;
  renderDialog({ requestedBy: { userId: "sara" as Id<"users">, name: null }, lines: [{ userId: "amer" as Id<"users">, name: null, amountMinor: 470_000 }] });
  const words = dictionaries[locale];
  expect(figure(words.PrepaidReclassRequestedBy)).toBe(words.PrepaidReclassUnknownMember);
  const row = within(screen.getByRole("dialog")).getAllByText(words.PrepaidReclassUnknownMember).map((node) => node.closest("tr")).find(Boolean);
  expect(row?.textContent).toContain("JOD 470.000");
});
test("when every remaining month is the same amount, only one monthly figure is shown", () => {
  renderDialog({ figures: { ...okFigures, finalMonthlyMinor: okFigures.regularMonthlyMinor } });
  expect(figure(en("PrepaidReclassMonthly"))).toBe("JOD 1485.000");
  expect(screen.queryByText(en("PrepaidReclassFinalMonthly"))).toBeNull();
});

test("approve sends the total and true-up that were displayed, once", async () => {
  let finish: (value: unknown) => void = () => undefined;
  mocks.approve.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const onClose = vi.fn();
  renderDialog({}, onClose);
  const approve = screen.getByRole("button", { name: en("PrepaidReclassApprove") }) as HTMLButtonElement;
  fireEvent.click(approve);
  expect(approve.disabled).toBe(true);
  fireEvent.click(approve);
  expect(mocks.approve).toHaveBeenCalledTimes(1);
  expect(mocks.approve).toHaveBeenCalledWith({
    orgId, reclassificationId: pending.reclassificationId, expectedTotalMinor: 620_000, expectedTrueUpMinor: 103_333,
  });
  finish({ eventId: "e", journalEntryId: "j", advanceIds: ["a1", "a2"], trueUpMinor: 103_333 });
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(mocks.toast.success).toHaveBeenCalledWith(en("PrepaidReclassApproved"));
});

test("the requester is told a different person must approve and cannot approve", () => {
  renderDialog({ requestedByMe: true });
  expect(screen.getByText(en("PrepaidReclassRequestedByYou"))).toBeTruthy();
  expect((screen.getByRole("button", { name: en("PrepaidReclassApprove") }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: en("PrepaidReclassDismiss") }) as HTMLButtonElement).disabled).toBe(false);
});

test.each([
  ["en", "Monthly recognition for this schedule is still queued, failed or does not match the ledger."],
  ["ar", dictionaries.ar.ServerError_PREPAID_RECLASS_RECOGNITION],
] as const)("when the backend cannot confirm the figures it says why in %s and approval is unavailable", (locale, message) => {
  mocks.locale = locale;
  renderDialog({ trueUpMinor: null, figures: { ok: false, code: "PREPAID_RECLASS_RECOGNITION" } });
  expect(screen.getByRole("dialog").textContent).toContain(message);
  expect(screen.queryByText(dictionaries[locale].PrepaidReclassNewTotal)).toBeNull();
  expect((screen.getByRole("button", { name: dictionaries[locale].PrepaidReclassApprove }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: dictionaries[locale].PrepaidReclassDismiss }) as HTMLButtonElement).disabled).toBe(false);
});

test.each([
  ["en", "The figures changed since you reviewed them. Review the updated figures and try again. Nothing was posted."],
  ["ar", dictionaries.ar.ServerError_PREPAID_RECLASS_FIGURES],
] as const)("a changed-figures refusal is shown in %s, never raw, and keeps the dialog open", async (locale, message) => {
  mocks.locale = locale;
  mocks.approve.mockRejectedValue(new ConvexError({ code: "PREPAID_RECLASS_FIGURES", message: "raw server text" }));
  const onClose = vi.fn();
  renderDialog({}, onClose);
  expect(screen.getByRole("dialog").getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
  fireEvent.click(screen.getByRole("button", { name: dictionaries[locale].PrepaidReclassApprove }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(message));
  expect(screen.queryByText("raw server text")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

test("dismiss closes the request", async () => {
  mocks.dismiss.mockResolvedValue(null);
  const onClose = vi.fn();
  renderDialog({}, onClose);
  fireEvent.click(screen.getByRole("button", { name: en("PrepaidReclassDismiss") }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(mocks.dismiss).toHaveBeenCalledWith({ orgId, reclassificationId: pending.reclassificationId });
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(mocks.toast.success).toHaveBeenCalledWith(en("PrepaidReclassDismissed"));
});
