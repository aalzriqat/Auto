import { render, screen } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { expect, test, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { DashboardLiquidity } from "./DashboardLiquidity";

const hooks = vi.hoisted(() => ({ query: vi.fn(), paginated: vi.fn() }));

vi.mock("convex/react", () => ({
  useQuery: hooks.query,
  usePaginatedQuery: hooks.paginated,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ locale: "en", t: (key: string) => key }),
}));

test("the Dashboard resolves missing bank figures in bounded groups and preserves a verified zero", () => {
  const orgId = "dealer" as Id<"organizations">;
  const banks = Array.from({ length: 15 }, (_, index) => ({
    id: `bank-${index + 1}` as Id<"bankAccounts">,
    name: `Bank ${index + 1}`,
    currency: "JOD",
    active: true,
  }));
  hooks.paginated.mockReturnValue({ results: banks, status: "Exhausted" });
  const requestedGroups: Id<"bankAccounts">[][] = [];
  hooks.query.mockImplementation((ref: FunctionReference<"query">, args: { bankIds: Id<"bankAccounts">[] } | "skip") => {
    if (getFunctionName(ref) === "dashboardLiquidity:liquidity") {
      return { cash: [], banks: [{ id: banks[0].id, balanceMinor: 0 }] };
    }
    if (getFunctionName(ref) !== "dashboardLiquidity:bankBalancesForPage" || args === "skip") {
      throw new Error("Unexpected Dashboard query");
    }
    requestedGroups.push(args.bankIds);
    return args.bankIds.filter(id => id !== banks[14].id)
      .map(id => ({ id, balanceMinor: Number(id.slice(5)) * 1000 + 321 }));
  });

  render(<DashboardLiquidity orgId={orgId} />);

  expect(requestedGroups).toEqual([
    banks.slice(1, 12).map(bank => bank.id),
    banks.slice(12).map(bank => bank.id),
  ]);
  expect(screen.getByText("Bank 1").closest("li")?.textContent).toMatch(/0\s+JOD$/);
  expect(screen.getByText("Bank 14").closest("li")?.textContent).toContain("14.321");
  expect(screen.getByText("Bank 15").closest("li")?.textContent).toContain("FigureUnavailable");
});
