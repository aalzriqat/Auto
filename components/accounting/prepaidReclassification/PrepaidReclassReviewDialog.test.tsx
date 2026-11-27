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
  useQuery: () => { throw new Error("No query expected"); },
  usePaginatedQuery: (ref: FunctionReference<"query">, args: unknown) => {
    if (getFunctionName(ref) !== "memberships:list") throw new Error("Unexpected paginated query");
    return args === "skip" ? { results: [], status: "LoadingFirstPage" } : {
      results: [{ userId: "amer", userName: "Amer" }, { userId: "thaer", userName: "Thaer" }], status: "Exhausted",
    };
  },
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
const pending = {
  reclassificationId: "reclass-1" as Id<"openingPrepaidReclassifications">,
  requestedByMe: false, totalMinor: 620_000, trueUpMinor: 103_333 as number | null,
  lines: [{ userId: "amer" as Id<"users">, amountMinor: 470_000 }, { userId: "thaer" as Id<"users">, amountMinor: 150_000 }],
  reason: "Advances paid before opening",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.locale = "en";
});

const en = (key: string) => dictionaries.en[key];
const renderDialog = (overrides: Partial<typeof pending> = {}, onClose = vi.fn()) =>
  render(<PrepaidReclassReviewDialog orgId={orgId} schedule={schedule} pending={{ ...pending, ...overrides }} onClose={onClose} />);

test("shows each person, the total, the true-up and the reason", () => {
  renderDialog();
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("Amer")).toBeTruthy();
  expect(dialog.getByText("JOD 470.000")).toBeTruthy();
  expect(dialog.getByText("Thaer")).toBeTruthy();
  expect(dialog.getByText("JOD 150.000")).toBeTruthy();
  expect(dialog.getByText("JOD 620.000")).toBeTruthy();
  expect(dialog.getByText("JOD 103.333")).toBeTruthy();
  expect(dialog.getByText("Advances paid before opening")).toBeTruthy();
  expect(dialog.getByText(en("PrepaidReclassRequestedByOther"))).toBeTruthy();
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

test("without a backend true-up the figures are unconfirmed and approval is unavailable", () => {
  renderDialog({ trueUpMinor: null });
  expect(screen.getByText(en("PrepaidReclassFiguresUnavailable"))).toBeTruthy();
  expect((screen.getByRole("button", { name: en("PrepaidReclassApprove") }) as HTMLButtonElement).disabled).toBe(true);
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
