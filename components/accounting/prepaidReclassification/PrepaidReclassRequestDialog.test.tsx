/**
 * SCRUM-961: the request dialog for moving part of an opening prepaid schedule into employee advances. The backend owns
 * every figure: the dialog sums only the person's own lines for the preview call, shows the backend preview, and sends
 * the lines and reason. It cannot submit without lines or a reason, and a coded refusal is shown in the user's language.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { dictionaries as appDictionaries } from "@/lib/i18n/dictionaries";
import { PrepaidReclassRequestDialog } from "./PrepaidReclassRequestDialog";

const dictionaries = appDictionaries as unknown as Record<"en" | "ar", Record<string, string>>;

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  request: vi.fn(),
  members: [] as Array<{ userId: string; userName: string }>,
  toast: { success: vi.fn(), error: vi.fn() },
  locale: "en" as "en" | "ar",
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    if (name === "openingPrepaidReclassification:previewPrepaidReclassification") return mocks.preview(args);
    throw new Error(`Unexpected query ${name}`);
  },
  usePaginatedQuery: (ref: FunctionReference<"query">, args: unknown) => {
    if (getFunctionName(ref) !== "memberships:list") throw new Error("Unexpected paginated query");
    return args === "skip" ? { results: [], status: "LoadingFirstPage" } : { results: mocks.members, status: "Exhausted" };
  },
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "openingPrepaidReclassification:requestPrepaidReclassification") return mocks.request;
    throw new Error(`Unexpected mutation ${name}`);
  },
}));
vi.mock("@/components/ui/sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isOwner: false, membership: { userId: "requester" }, hasPermission: () => true }),
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
const okPreview = {
  ok: true, newTotalMinor: 7_128_000, newRecognizedMinor: 1_188_000, trueUpMinor: 103_333,
  remainingMonths: 4, regularMonthlyMinor: 1_485_000, finalMonthlyMinor: 1_485_003,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.locale = "en";
  mocks.members = [
    { userId: "requester", userName: "Requester" },
    { userId: "amer", userName: "Amer" },
    { userId: "thaer", userName: "Thaer" },
  ];
  mocks.preview.mockReturnValue(okPreview);
});

const en = (key: string) => dictionaries.en[key];
const renderDialog = (onClose = vi.fn()) =>
  render(<PrepaidReclassRequestDialog orgId={orgId} schedule={schedule} onClose={onClose} />);

function fillLine(index: number, userId: string, amount: string) {
  const words = dictionaries[mocks.locale];
  fireEvent.change(screen.getByLabelText(words.PrepaidReclassEmployeeN.replace("{n}", String(index))), { target: { value: userId } });
  fireEvent.change(screen.getByLabelText(words.PrepaidReclassAmountN.replace("{n}", String(index))), { target: { value: amount } });
}

test("cannot submit without a valid line: shows why and sends nothing", () => {
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: en("PrepaidReclassSubmit") }));
  expect(screen.getByText(en("PrepaidReclassLinesRequired"))).toBeTruthy();
  expect(mocks.request).not.toHaveBeenCalled();
});

test("cannot submit without a reason: shows why and sends nothing", () => {
  renderDialog();
  fillLine(1, "amer", "470");
  fireEvent.click(screen.getByRole("button", { name: en("PrepaidReclassSubmit") }));
  expect(screen.getByText(en("PrepaidReclassReasonRequired"))).toBeTruthy();
  expect(screen.getByLabelText(en("PrepaidReclassReason")).getAttribute("aria-invalid")).toBe("true");
  expect(mocks.request).not.toHaveBeenCalled();
});

test("the requester is not offered as a beneficiary", () => {
  renderDialog();
  const options = within(screen.getByLabelText("Employee 1")).getAllByRole("option").map((option) => option.textContent);
  expect(options).toContain("Amer");
  expect(options).not.toContain("Requester");
});

test("asks the backend for the preview of the summed lines and shows its figures in plain words", () => {
  renderDialog();
  expect(screen.getByText(en("PrepaidReclassPreviewEmpty"))).toBeTruthy();
  fillLine(1, "amer", "470");
  fireEvent.click(screen.getByRole("button", { name: en("PrepaidReclassAddLine") }));
  fillLine(2, "thaer", "150.000");
  expect(mocks.preview).toHaveBeenLastCalledWith({ orgId, scheduleId: schedule._id, totalMinor: 620_000 });
  const figures = screen.getByRole("region", { name: en("PrepaidReclassPreviewTitle") });
  const text = within(figures);
  expect(text.getByText(en("PrepaidReclassMoved"))).toBeTruthy();
  expect(text.getByText("JOD 620.000")).toBeTruthy();
  expect(text.getByText(en("PrepaidReclassTrueUp"))).toBeTruthy();
  expect(text.getByText("JOD 103.333")).toBeTruthy();
  expect(text.getByText("JOD 7128.000")).toBeTruthy();
  expect(text.getByText("JOD 1188.000")).toBeTruthy();
  // Months and monthly amounts are the backend's, not the row's stale monthsRemaining (5).
  expect(text.getByText(en("PrepaidReclassMonthsLeft")).nextElementSibling?.textContent).toBe("4");
  expect(text.getByText(en("PrepaidReclassMonthly")).nextElementSibling?.textContent).toBe("JOD 1485.000");
  expect(text.getByText(en("PrepaidReclassFinalMonthly")).nextElementSibling?.textContent).toBe("JOD 1485.003");
});

test("an amount with more decimals than the currency allows is not sent for preview", () => {
  renderDialog();
  fillLine(1, "amer", "470.0001");
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(screen.getByText(en("PrepaidReclassPreviewEmpty"))).toBeTruthy();
});

test("shows a loading line while the backend works out the preview", () => {
  mocks.preview.mockReturnValue(undefined);
  renderDialog();
  fillLine(1, "amer", "470");
  expect(screen.getByRole("status").textContent).toContain(en("PrepaidReclassPreviewLoading"));
});

test.each([
  ["en", "The total must be less than what is still unrecognized in this prepaid schedule."],
  ["ar", dictionaries.ar.ServerError_PREPAID_RECLASS_AMOUNT],
] as const)("a backend preview refusal is shown in %s and blocks the request", (locale, message) => {
  mocks.locale = locale;
  mocks.preview.mockReturnValue({ ok: false, code: "PREPAID_RECLASS_AMOUNT" });
  renderDialog();
  fillLine(1, "amer", "9000");
  expect(screen.getByRole("alert").textContent).toContain(message);
  const submit = screen.getByRole("button", { name: dictionaries[locale].PrepaidReclassSubmit }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
});

test.each([
  ["en", "A person who receives one of these advances cannot request or approve this change."],
  ["ar", dictionaries.ar.ServerError_PREPAID_RECLASS_BENEFICIARY],
] as const)("a coded request refusal is shown in %s, never raw, and keeps the dialog open", async (locale, message) => {
  mocks.locale = locale;
  mocks.request.mockRejectedValue(new ConvexError({ code: "PREPAID_RECLASS_BENEFICIARY", message: "raw server text" }));
  const onClose = vi.fn();
  renderDialog(onClose);
  fillLine(1, "amer", "470");
  fireEvent.change(screen.getByLabelText(dictionaries[locale].PrepaidReclassReason), { target: { value: "Advance paid before opening" } });
  fireEvent.click(screen.getByRole("button", { name: dictionaries[locale].PrepaidReclassSubmit }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(message));
  expect(screen.queryByText("raw server text")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

test("sends exactly the typed lines in minor units and the trimmed reason, then closes", async () => {
  mocks.request.mockResolvedValue({ reclassificationId: "reclass-1", version: 1 });
  const onClose = vi.fn();
  renderDialog(onClose);
  fillLine(1, "amer", "470");
  fireEvent.click(screen.getByRole("button", { name: en("PrepaidReclassAddLine") }));
  fillLine(2, "thaer", "150");
  fireEvent.change(screen.getByLabelText(en("PrepaidReclassReason")), { target: { value: "  Advances paid before opening  " } });
  const submit = screen.getByRole("button", { name: en("PrepaidReclassSubmit") });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.request).toHaveBeenCalledWith({
    orgId, scheduleId: schedule._id, reason: "Advances paid before opening",
    lines: [{ userId: "amer", amountMinor: 470_000 }, { userId: "thaer", amountMinor: 150_000 }],
  });
  expect(mocks.toast.success).toHaveBeenCalledWith(en("PrepaidReclassRequested"));
});
