/**
 * SCRUM-961: what an opening prepaid row shows about moving part of it to employee advances. The backend status query
 * decides everything: eligible (an action), blocked (its translated reason, no action), pending (a notice and a review
 * action), approved (the posted record). A user without finance and payroll management does not ask and sees nothing.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { dictionaries as appDictionaries } from "@/lib/i18n/dictionaries";
import { OpeningPrepaidReclassification } from "./OpeningPrepaidReclassification";

const dictionaries = appDictionaries as unknown as Record<"en" | "ar", Record<string, string>>;

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  advances: vi.fn(),
  permissions: ["manage:finance", "manage:payroll", "view:payroll", "view:users"] as string[],
  locale: "en" as "en" | "ar",
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) => {
    const name = getFunctionName(ref);
    if (name === "openingPrepaidReclassification:prepaidReclassificationStatus") {
      const result = mocks.status(args);
      return args === "skip" ? undefined : result;
    }
    if (args === "skip") return undefined;
    if (name === "payroll:listAdvances") return mocks.advances(args);
    if (name === "openingPrepaidReclassification:previewPrepaidReclassification") return undefined;
    throw new Error(`Unexpected query ${name}`);
  },
  usePaginatedQuery: () => ({ results: [{ userId: "amer", userName: "Amer" }], status: "Exhausted" }),
  useMutation: () => vi.fn(),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "dealer" }) }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    isOwner: false, membership: { userId: "me" },
    hasPermission: (permission: string) => mocks.permissions.includes(permission),
  }),
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

const schedule = {
  _id: "schedule-a" as Id<"prepaidExpenseSchedules">, currency: "JOD", title: "Establishment expenses", monthsRemaining: 5,
};
const idle = { eligible: false, blockedReason: null, reclassifiedMinor: null, pending: null, approved: null };
const en = (key: string) => dictionaries.en[key];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.locale = "en";
  mocks.permissions = ["manage:finance", "manage:payroll", "view:payroll", "view:users"];
  mocks.status.mockReturnValue({ ...idle, eligible: true });
  mocks.advances.mockReturnValue([]);
});

test("a user without payroll management does not ask the backend and sees no action", () => {
  mocks.permissions = ["view:finance", "manage:finance"];
  const view = render(<OpeningPrepaidReclassification schedule={schedule} />);
  expect(mocks.status).toHaveBeenCalledWith("skip");
  expect(view.container.textContent).toBe("");
});

test("shows a loading line while the status is read", () => {
  mocks.status.mockReturnValue(undefined);
  render(<OpeningPrepaidReclassification schedule={schedule} />);
  expect(mocks.status).toHaveBeenCalledWith({ orgId: "dealer", scheduleId: schedule._id });
  expect(screen.getByRole("status").textContent).toContain(en("PrepaidReclassStatusLoading"));
});

test("an eligible schedule offers the action, which opens the request dialog", () => {
  render(<OpeningPrepaidReclassification schedule={schedule} />);
  fireEvent.click(screen.getByRole("button", { name: en("PrepaidReclassAction") }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByLabelText("Employee 1")).toBeTruthy();
});

test.each([
  ["en", "Monthly recognition for this schedule is still queued, failed or does not match the ledger."],
  ["ar", dictionaries.ar.ServerError_PREPAID_RECLASS_RECOGNITION],
] as const)("a blocked schedule shows the backend reason in %s and no action", (locale, reason) => {
  mocks.locale = locale;
  mocks.status.mockReturnValue({ ...idle, blockedReason: "PREPAID_RECLASS_RECOGNITION" });
  render(<OpeningPrepaidReclassification schedule={schedule} />);
  expect(screen.getByText(new RegExp(reason.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("a pending request shows its total and a review action instead of a new request", () => {
  mocks.status.mockReturnValue({
    ...idle, blockedReason: "PREPAID_RECLASS_PENDING",
    pending: { reclassificationId: "reclass-1", requestedByMe: false, requestedBy: { userId: "sara", name: "Sara" },
      requestedAt: Date.UTC(2026, 10, 26), totalMinor: 620_000, trueUpMinor: 103_333,
      lines: [{ userId: "amer", name: "Amer", amountMinor: 620_000 }], reason: "Advances",
      figures: { ok: true, trueUpMinor: 103_333, newTotalMinor: 7_128_000, newRecognizedMinor: 1_188_000,
        remainingMonths: 4, regularMonthlyMinor: 1_485_000, finalMonthlyMinor: 1_485_000 } },
  });
  render(<OpeningPrepaidReclassification schedule={schedule} />);
  expect(screen.getByText(/JOD 620\.000/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: en("PrepaidReclassAction") })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en("PrepaidReclassReview") }));
  expect(screen.getByRole("button", { name: en("PrepaidReclassApprove") })).toBeTruthy();
});

const approvedAt = Date.UTC(2026, 10, 27, 9);
const approved = {
  reclassificationId: "reclass-1", totalMinor: 620_000, trueUpMinor: 103_333, advanceIds: ["adv-1", "adv-2"],
  approvedAt, approvedBy: { userId: "huda", name: "Huda" }, eventId: "event-1", journalEntryId: "journal-1",
  journalNumber: "JE-000123" as string | null,
  lines: [{ userId: "amer", name: "Amer", amountMinor: 470_000 }, { userId: "thaer", name: "Thaer", amountMinor: 150_000 }],
  reason: "Advances paid before opening",
};
const approvedFigure = (label: string) => screen.getByText(label).closest("dt")?.nextElementSibling?.textContent;

test.each(["en", "ar"] as const)("an approved change shows in %s what moved, who approved it and when, each person and the journal", (locale) => {
  mocks.locale = locale;
  const words = dictionaries[locale];
  mocks.status.mockReturnValue({ ...idle, blockedReason: "PREPAID_RECLASS_ALREADY", reclassifiedMinor: 620_000, approved });
  render(<OpeningPrepaidReclassification schedule={schedule} />);
  expect(screen.getByText(/JOD 620\.000/)).toBeTruthy();
  expect(screen.getByText(/JOD 103\.333/)).toBeTruthy();
  expect(approvedFigure(words.PrepaidReclassApprovedBy)).toBe("Huda");
  expect(approvedFigure(words.PrepaidReclassApprovedOn)).toBe(new Date(approvedAt).toLocaleDateString(locale === "ar" ? "ar-JO" : "en-US"));
  expect(approvedFigure("Amer")).toBe("JOD 470.000");
  expect(approvedFigure("Thaer")).toBe("JOD 150.000");
  const journal = screen.getByText("JE-000123");
  expect(journal.getAttribute("dir")).toBe("ltr");
  expect(approvedFigure(words.PrepaidReclassJournal)).toBe("JE-000123");
  expect(screen.getByRole("link", { name: words.PrepaidReclassViewAdvances }).getAttribute("href")).toBe("/dealer/payroll");
  expect(screen.queryByText(words.ServerError_PREPAID_RECLASS_ALREADY)).toBeNull();
  expect(mocks.advances).not.toHaveBeenCalled();
});

test("an approved change without a journal number omits that line, and the payroll link needs payroll access", () => {
  mocks.permissions = ["manage:finance", "manage:payroll"];
  mocks.status.mockReturnValue({ ...idle, blockedReason: "PREPAID_RECLASS_ALREADY", approved: { ...approved, journalNumber: null } });
  render(<OpeningPrepaidReclassification schedule={schedule} />);
  expect(screen.getByText(en("PrepaidReclassApprovedBy"))).toBeTruthy();
  expect(screen.queryByText(en("PrepaidReclassJournal"))).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
