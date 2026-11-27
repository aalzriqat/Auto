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
    pending: { reclassificationId: "reclass-1", requestedByMe: false, totalMinor: 620_000, trueUpMinor: 103_333,
      lines: [{ userId: "amer", amountMinor: 620_000 }], reason: "Advances" },
  });
  render(<OpeningPrepaidReclassification schedule={schedule} />);
  expect(screen.getByText(/JOD 620\.000/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: en("PrepaidReclassAction") })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: en("PrepaidReclassReview") }));
  expect(screen.getByRole("button", { name: en("PrepaidReclassApprove") })).toBeTruthy();
});

test("an approved change shows the amount moved, the true-up, the posting date and where the advances are", () => {
  mocks.status.mockReturnValue({
    ...idle, blockedReason: "PREPAID_RECLASS_ALREADY", reclassifiedMinor: 620_000,
    approved: { reclassificationId: "reclass-1", totalMinor: 620_000, trueUpMinor: 103_333, advanceIds: ["adv-1"] },
  });
  mocks.advances.mockReturnValue([
    { _id: "adv-1", prepaidReclassificationId: "reclass-1", date: Date.UTC(2026, 10, 27, 9), userName: "Amer", amountMinor: 620_000, currency: "JOD" },
    { _id: "adv-other", date: Date.UTC(2026, 0, 1), userName: "Other", amountMinor: 1, currency: "JOD" },
  ]);
  render(<OpeningPrepaidReclassification schedule={schedule} />);
  expect(screen.getByText(/JOD 620\.000/)).toBeTruthy();
  expect(screen.getByText(/JOD 103\.333/)).toBeTruthy();
  expect(screen.getByText(/2026-11-27/)).toBeTruthy();
  expect(screen.queryByText(/2026-01-01/)).toBeNull();
  expect(screen.getByRole("link", { name: en("PrepaidReclassViewAdvances") }).getAttribute("href")).toBe("/dealer/payroll");
  expect(screen.queryByText(en("ServerError_PREPAID_RECLASS_ALREADY"))).toBeNull();
});
