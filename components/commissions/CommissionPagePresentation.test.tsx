import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import CommissionsPage from "@/app/(dashboard)/[orgId]/commissions/page";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";

const state = vi.hoisted(() => ({ save: vi.fn(async () => undefined) }));
// Projection payloads at the SDK boundary, not persisted sale fixtures.
const rows = [
  { commissionStatus: "NOT_SET", commissionAmount: undefined },
  { commissionStatus: "NO_COMMISSION", commissionAmount: 0 },
  { commissionStatus: "UNPAID", commissionAmount: 125 },
  { commissionStatus: "PAID", commissionAmount: 125, commissionPaidAt: 1_700_000_000_000 },
  { commissionStatus: "VOID", commissionAmount: 125 },
  { commissionStatus: "PENDING_SALE", commissionAmount: undefined },
].map((row) => ({ ...row, _id: `sale-${row.commissionStatus}`, salespersonId: "rep-a",
  salespersonName: "Synthetic representative", vehicleSummary: `Synthetic ${row.commissionStatus}`,
  customerName: "Synthetic customer", saleDate: 1_700_000_000_000, salePrice: 10_000,
  canSetAmount: row.commissionStatus === "NOT_SET", salespersonOffboarded: false }));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Synthetic Dealer" }];
      if (name === "memberships:getMyMembership") return { roleName: "CUSTOM", permissions: ["view:org", "view:commissions", "manage:commissions"] };
      if (name === "orgSettings:getCommissionMode") return "MANUAL";
      if (name === "memberships:list") return { page: [], isDone: true, continueCursor: "" };
      throw new Error(`Unexpected commission presentation query: ${name}`);
    },
    usePaginatedQuery: (ref: never) => {
      if (getFunctionName(ref) !== "sales:listCommissionsPaginated") throw new Error("Unexpected commission page query");
      return { results: rows, status: "Exhausted", loadMore: vi.fn() };
    },
    useMutation: (ref: never) => getFunctionName(ref) === "sales:setCommissionAmount" ? state.save : vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/commissions",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => {
  state.save.mockClear();
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<OrgProvider><LanguageProvider><CommissionsPage /></LanguageProvider></OrgProvider>);

test("commission rows preserve decided, undecided and cancelled status presentation", () => {
  mount();
  for (const [status, label] of [["NOT_SET", "Not set"], ["NO_COMMISSION", "No commission"],
    ["UNPAID", "Unpaid"], ["VOID", "Sale cancelled"], ["PENDING_SALE", "Sale not completed"]]) {
    const row = screen.getByRole("row", { name: new RegExp(`Synthetic ${status}`) });
    expect(within(row).getByText(label, { exact: true })).toBeTruthy();
    if (status !== "UNPAID") expect(within(row).queryByRole("button", { name: "Mark Paid" })).toBeNull();
  }
  const paid = screen.getByRole("row", { name: /Synthetic PAID/ });
  expect(within(paid).getByText(/^Paid /)).toBeTruthy();
  expect(within(paid).queryByRole("button", { name: "Mark Paid" })).toBeNull();
  expect(within(screen.getByRole("row", { name: /Synthetic UNPAID/ })).getByRole("button", { name: "Mark Paid" })).toBeTruthy();
});

test("setting an undecided commission still edits and submits its own row", async () => {
  mount();
  const row = screen.getByRole("row", { name: /Synthetic NOT_SET/ });
  fireEvent.click(within(row).getByRole("button", { name: "Set commission" }));
  const amount = within(row).getByRole("spinbutton", { name: "Commission" });
  expect((amount as HTMLInputElement).value).toBe("");
  fireEvent.change(amount, { target: { value: "75" } });
  fireEvent.keyDown(amount, { key: "Enter" });
  await waitFor(() => expect(state.save).toHaveBeenCalledWith({ orgId: "org-a", saleId: "sale-NOT_SET", commissionAmount: 75 }));
});
