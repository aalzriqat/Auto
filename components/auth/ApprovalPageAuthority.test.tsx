import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ApprovalsPage from "@/app/(dashboard)/[orgId]/approvals/page";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { DEFAULT_ROLE_TEMPLATES } from "@/convex/utils/permissions";

const state = vi.hoisted(() => ({ role: "ACCOUNTANT", pending: undefined as unknown[] | undefined }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      const role = DEFAULT_ROLE_TEMPLATES.find((candidate) => candidate.name === state.role);
      if (!role) throw new Error("Missing actual role template");
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Synthetic Dealer" }];
      if (name === "memberships:getMyMembership") return { roleName: role.name, permissions: [...role.permissions] };
      if (name === "orgSettings:get") return null;
      if (name === "approvals:listPendingApprovals") {
        if (!role.permissions.includes("approve:requests")) throw new Error("Synthetic approval refusal");
        return [];
      }
      if (name === "depositRequests:listPending") {
        if (!role.permissions.includes("confirm:finance_disbursement")) throw new Error("Synthetic deposit refusal");
        return state.pending;
      }
      throw new Error("Unexpected network query: " + name);
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useMutation: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/approvals",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => { state.role = "ACCOUNTANT"; state.pending = undefined;
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<OrgProvider><LanguageProvider><ApprovalsPage /></LanguageProvider></OrgProvider>);

test.each(["SALES", "RECEPTION"])("%s sees a calm refusal when neither approval queue is authorized", (role) => {
  state.role = role;
  mount();
  expect(screen.getByRole("heading", { name: "Access Not Allowed" })).toBeTruthy();
});

test("accountant unresolved deposit queue stays visibly loading", () => {
  mount();
  expect(screen.getByTestId("pending-deposit-loading").getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByTestId("pending-deposit-empty")).toBeNull();
});

test("accountant resolved empty deposit queue has a truthful visible empty state", () => {
  state.pending = [];
  mount();
  expect(screen.getByTestId("pending-deposit-empty").textContent).toBe("No deposits are waiting for confirmation.");
  expect(screen.queryByTestId("pending-deposit-loading")).toBeNull();
});

test("manager's independent profit approval queue remains available", () => {
  state.role = "MANAGER";
  mount();
  expect(screen.getByText("No pending approvals")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Access Not Allowed" })).toBeNull();
});
