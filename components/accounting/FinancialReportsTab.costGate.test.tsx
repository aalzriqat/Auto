/**
 * SCRUM-902 class sweep. The trial balance, income statement and balance sheet are refused by the backend without
 * view:cost_price, so the tab must not subscribe to them for such a role and must show a note instead of an error.
 * The VAT return tab carries no cost figures and stays open.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  granted: [] as string[],
  queried: [] as Array<{ name: string; skipped: boolean }>,
}));

vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_1" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    isLoading: false,
    isOwner: false,
    hasAllPermissions: (list: string[]) => list.every((p) => stubs.granted.includes(p)),
  }),
}));
vi.mock("./reports/TrialBalanceReport", () => ({ TrialBalanceReport: () => <div>trial-balance-body</div> }));
vi.mock("./reports/IncomeStatementReport", () => ({ IncomeStatementReport: () => <div>income-statement-body</div> }));
vi.mock("./reports/BalanceSheetReport", () => ({ BalanceSheetReport: () => <div>balance-sheet-body</div> }));
vi.mock("./reports/VatReturnReport", () => ({ VatReturnReport: () => <div>vat-return-body</div> }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      stubs.queried.push({ name: getFunctionName(reference), skipped: args === "skip" });
      return undefined;
    },
  };
});

import { FinancialReportsTab } from "./FinancialReportsTab";

const statementQueries = ["accountingReports:trialBalance", "accountingReports:incomeStatement", "accountingReports:balanceSheet"];
const live = (name: string) => stubs.queried.some((q) => q.name === name && !q.skipped);

beforeEach(() => {
  stubs.granted = [];
  stubs.queried.length = 0;
});
afterEach(cleanup);

describe("FinancialReportsTab without view:cost_price", () => {
  test("a finance-only role gets a note and no statement query", () => {
    stubs.granted = ["view:finance"];
    render(<FinancialReportsTab />);
    expect(screen.getByRole("status").textContent).toBe("FinancialStatementCostAccessRequired");
    expect(screen.queryByText("trial-balance-body")).toBeNull();
    for (const name of statementQueries) expect(live(name)).toBe(false);
  });

  test("the VAT return tab stays open to that role", () => {
    stubs.granted = ["view:finance"];
    render(<FinancialReportsTab />);
    fireEvent.mouseDown(screen.getByText("VatReturn"), { button: 0 });
    fireEvent.click(screen.getByText("VatReturn"));
    expect(live("vatReport:generateVatSummary")).toBe(true);
  });

  test("a role holding both grants reads the trial balance (positive control)", () => {
    stubs.granted = ["view:finance", "view:cost_price"];
    render(<FinancialReportsTab />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("trial-balance-body")).toBeTruthy();
    expect(live("accountingReports:trialBalance")).toBe(true);
  });
});
