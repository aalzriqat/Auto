import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { CashNoCostApprovalQueue } from "./CashNoCostApprovalQueue";

const state = vi.hoisted(() => ({
  page: { results: [] as Array<{ applicationId: Id<"financeApplications">; dealReference: string; confirmVersion: number }>,
    status: "Exhausted", loadMore: vi.fn() },
  confirm: vi.fn(), queryNames: [] as string[],
}));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    usePaginatedQuery: (reference: never) => {
      state.queryNames.push(getFunctionName(reference));
      return state.page;
    },
    useQuery: () => { throw new Error("This queue must not read a full application or known-id capability"); },
    useMutation: (reference: never) => getFunctionName(reference) === "cashDealCloseout:confirmNoCosts"
      ? state.confirm : vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  state.page = { results: [], status: "Exhausted", loadMore: vi.fn() };
  state.confirm.mockReset();
  state.queryNames = [];
});
const orgId = "org1" as Id<"organizations">;
const applicationId = "application1" as Id<"financeApplications">;

test("confirms the discovered version with only the narrow paginated read and masks private errors", async () => {
  state.page.results = [{ applicationId, dealReference: "D-001042", confirmVersion: 7 }];
  state.confirm.mockRejectedValueOnce(new Error("PRIVATE_BACKEND_DETAIL"));
  render(<CashNoCostApprovalQueue orgId={orgId} />);
  expect(screen.getByText("D-001042")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "CashNoCostConfirm" }));
  await waitFor(() => expect(state.confirm).toHaveBeenCalledWith({ orgId, applicationId, expectedVersion: 7 }));
  expect((await screen.findByRole("alert")).textContent).toBe("CashNoCostSaveFailed");
  expect(screen.queryByText("PRIVATE_BACKEND_DETAIL")).toBeNull();
  expect(new Set(state.queryNames)).toEqual(new Set(["cashDealCloseout:listPendingNoCostConfirmations"]));
});

test("keeps an empty intermediate page reachable and reports empty only when exhausted", () => {
  state.page.status = "CanLoadMore";
  const view = render(<CashNoCostApprovalQueue orgId={orgId} />);
  expect(screen.queryByText("CashNoCostQueueEmpty")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "RefundApprovalLoadMore" }));
  expect(state.page.loadMore).toHaveBeenCalledWith(10);
  state.page.status = "Exhausted";
  view.rerender(<CashNoCostApprovalQueue orgId={orgId} />);
  expect(screen.getByText("CashNoCostQueueEmpty")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("shows initial loading without an empty verdict", () => {
  state.page.status = "LoadingFirstPage";
  render(<CashNoCostApprovalQueue orgId={orgId} />);
  expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText("CashNoCostQueueEmpty")).toBeNull();
});
