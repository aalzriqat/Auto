import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { PrepaidExpensesTab } from "./PrepaidExpensesTab";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";

const fixture = vi.hoisted(() => ({ sourceKind: "OPENING", correctionAllowed: false }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/accounting",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return { useConvexAuth: () => ({ isAuthenticated: true }), useMutation: () => vi.fn(), useAction: () => vi.fn(),
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "organizations:listMine") return [{ _id: "org-a" }];
      if (name === "memberships:getMyMembership") return { roleName: "Accountant", permissions: ["view:finance", "manage:finance"] };
      if (name === "prepaidExpenses:listPendingCorrectionRequests") return [];
      if (name === "accountingReports:prepaidExpensesReconciliation") return { currencies: [], byCurrency: {}, isReconciled: true };
      if (name === "prepaidExpenses:listSchedules") return [{ _id: "schedule-a", sourceKind: fixture.sourceKind,
        sourceTitle: fixture.sourceKind === "UNAVAILABLE" ? null : "Synthetic unexpired service", expenseTitle: "Synthetic unexpired service", correctionAllowed: fixture.correctionAllowed,
        sourceUnavailableReason: null, currency: "JOD", totalMinor: 120000, recognizedMinor: 40000, remainingMinor: fixture.sourceKind === "UNAVAILABLE" ? null : 80000,
        dueMinor: fixture.sourceKind === "UNAVAILABLE" ? null : 40000, postedMinor: 40000, pendingMinor: 0, failedMinor: 0, pendingCorrectionMinor: 0, failedCorrectionMinor: 0,
        openFailureCount: 0, termMonths: 3, monthsRecognized: 1, monthsRemaining: 2, startYearMonth: "2026-01", status: "ACTIVE", createdAt: 1 }];
      throw new Error("Unexpected prepaid presentation fixture query " + name);
    } };
});
beforeEach(() => {
  fixture.sourceKind = "OPENING"; fixture.correctionAllowed = false;
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const page = () => <OrgProvider><LanguageProvider><PrepaidExpensesTab /></LanguageProvider></OrgProvider>;
test("native opening rows display their title and do not offer expense correction", () => {
  render(page());
  expect(screen.getByText("Synthetic unexpired service")).toBeTruthy();
  expect(screen.getByText("Opening balance")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Correct schedule" })).toBeNull();
});
test("verified expense rows retain their existing correction action", () => {
  fixture.sourceKind = "EXPENSE"; fixture.correctionAllowed = true;
  render(page());
  expect(screen.getByRole("button", { name: "Correct schedule" })).toBeTruthy();
});

test("an unavailable source is labelled unavailable and cannot offer correction", () => {
  fixture.sourceKind = "UNAVAILABLE";
  render(page());
  expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  expect(within(screen.getAllByRole("row")[1]).getAllByRole("cell")[4].textContent).toBe("Unavailable");
  expect(screen.queryByRole("button", { name: "Correct schedule" })).toBeNull();
});
