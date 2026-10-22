/**
 * SCRUM-226-2: the failed-outbox subscription must be gated on the
 * server-resolved permission list, not on `hasPermission`.
 *
 * Previously, `hasPermission` returned true for any role named "OWNER". The server gates
 * `listFailedEvents` on the real resolved set (getMyMembership grants every
 * permission only to a QUALIFIED system owner). An unqualified "OWNER"-named
 * role with view:finance but no manage:finance therefore subscribed, the
 * server refused, and Convex re-threw during render, crashing the Reconcile tab.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Id } from "../../convex/_generated/dataModel";

const state = vi.hoisted(() => ({
  roleName: "OWNER",
  isSystemOwnerRole: false,
  permissions: [] as string[],
  paginatedArgs: undefined as unknown,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));

// Use the real permission hook over the simulated SDK membership.
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
  useQuery: (reference: never) => getFunctionName(reference) === "memberships:getMyMembership" ? state : ({
    chartInitialized: true,
    systemAccountsValid: true,
    currentOpenPeriod: null,
    missingSystemAccountKeys: [],
    pendingEvents: [],
    hasMorePendingEvents: false,
    recentPeriods: [],
  }),
  useMutation: () => vi.fn(),
  usePaginatedQuery: (_ref: unknown, args: unknown) => {
    state.paginatedArgs = args;
    return { results: [], status: "Exhausted", loadMore: vi.fn() };
  },
};
});

vi.mock("./AccountingTabShared", () => ({
  errorMessage: (e: unknown) => String(e),
  LoadingAccountingState: () => null,
}));
vi.mock("./setup/AccountingPeriodsTable", () => ({
  AccountingPeriodsTable: () => null,
  accountingPeriodActionKey: () => "k",
}));
vi.mock("./setup/CreateAccountingPeriodDialog", () => ({ CreateAccountingPeriodDialog: () => null }));
vi.mock("./setup/ClosePeriodReviewDialog", () => ({ ClosePeriodReviewDialog: () => null }));
vi.mock("./setup/PendingAccountingEventsTable", () => ({ PendingAccountingEventsTable: () => null }));
vi.mock("./setup/SetupStatusCards", () => ({ SetupStatusCards: () => null }));
vi.mock("./setup/OpeningBalanceCard", () => ({ OpeningBalanceCard: () => null }));
vi.mock("./setup/OpeningBalanceApprovalPanel", () => ({ OpeningBalanceApprovalPanel: () => null }));
vi.mock("./setup/SystemAccountConflictsPanel", () => ({ SystemAccountConflictsPanel: () => null }));

import { AccountingSetupTab } from "./AccountingSetupTab";

const ORG = "org1" as Id<"organizations">;

describe("AccountingSetupTab failed-events subscription (SCRUM-226-2)", () => {
  beforeEach(() => {
    state.paginatedArgs = undefined;
  });
  afterEach(() => cleanup());

  test("OWNER-named role with view:finance only does NOT subscribe", () => {
    state.roleName = "OWNER";
    state.permissions = ["view:finance"];
    render(<AccountingSetupTab view="close" />);
    expect(state.paginatedArgs).toBe("skip");
  });

  test("a membership holding manage:finance subscribes with { orgId }", () => {
    state.roleName = "Accountant";
    state.permissions = ["view:finance", "manage:finance"];
    render(<AccountingSetupTab view="close" />);
    expect(state.paginatedArgs).toEqual({ orgId: ORG });
  });

  test("the settings view never subscribes, even with manage:finance", () => {
    state.roleName = "Accountant";
    state.permissions = ["manage:finance"];
    render(<AccountingSetupTab view="settings" />);
    expect(state.paginatedArgs).toBe("skip");
  });
});
