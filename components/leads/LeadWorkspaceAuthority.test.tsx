import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import LeadWorkspacePage from "@/app/(dashboard)/[orgId]/leads/[leadId]/page";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";

const state = vi.hoisted(() => ({ canEdit: false }));
// Convex retains a query result's identity until its data changes. Keep that
// contract so the edit form's reset effect is tested without an artificial loop.
const leadProjection = {
  _id: "lead-a", _creationTime: 1_700_000_000_000, orgId: "org-a", customerId: "customer-a",
  stage: "NEW", source: "Website", customer: { _id: "customer-a", firstName: "Synthetic", lastName: "Buyer" },
  vehicle: null, assignedUser: null,
};
const emptyRows: never[] = [];
const organizations = [{ _id: "org-a", name: "Synthetic Dealer" }];
const readerMembership = { roleName: "Synthetic lead member", permissions: ["view:leads", "view:org"] };
const editorMembership = { roleName: "Synthetic lead member", permissions: ["view:leads", "view:org", "edit:leads", "view:customers", "view:vehicles", "view:users"] };
const relations = { tasks: emptyRows, quotes: emptyRows };
const emptyMessages = { total: 0, messages: emptyRows, unansweredCount: 0 };
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      if (name === "organizations:listMine") return organizations;
      if (name === "memberships:getMyMembership") return state.canEdit ? editorMembership : readerMembership;
      if (name === "leads:get") return leadProjection;
      if (name === "leadActivities:listForLead") return emptyRows;
      if (name === "leads:checkExistingOpenLead") return null;
      if (name === "leads:customerMessages") return emptyMessages;
      // The org's stored currency is read through the any-member status query (SCRUM-85).
      if (name === "orgSettings:get") return null;
      if (name === "orgSettings:getCurrencyStatus") return { configured: true, currency: "JOD", currencySymbol: "JD" };
      if (["customers:selectorOptions", "customers:get", "vehicles:listAll", "orgLeadSources:listForLeads", "orgPipelineStages:list", "orgCustomFields:list", "orgCustomFields:getValues", "customers:getRelations"].includes(name)) {
        if (!state.canEdit) throw new Error(`Synthetic backend picker refusal: ${name}`);
        if (name === "customers:getRelations") return relations;
        return emptyRows;
      }
      throw new Error(`Unexpected lead-detail fixture query: ${name}`);
    },
    usePaginatedQuery: (ref: never, args: unknown) => {
      if (args !== "skip" && !state.canEdit) throw new Error(`Synthetic backend picker refusal: ${getFunctionName(ref)}`);
      return { results: emptyRows, status: "Exhausted", loadMore: vi.fn() };
    },
    useMutation: () => vi.fn(), useAction: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a", leadId: "lead-a" }),
  usePathname: () => "/org-a/leads/lead-a", useRouter: () => ({ back: vi.fn(), replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => {
  state.canEdit = false;
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const page = () => <OrgProvider><LanguageProvider><LeadWorkspacePage /></LanguageProvider></OrgProvider>;

test("a read-only lead detail never subscribes to edit-only pickers", () => {
  render(page());
  expect(screen.getByRole("heading", { name: "Synthetic Buyer" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit Lead" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an authorized detail editor opens the real form and revocation removes it", () => {
  state.canEdit = true;
  const view = render(page());
  fireEvent.click(screen.getByRole("button", { name: "Edit Lead" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  state.canEdit = false;
  view.rerender(page());
  expect(screen.getByRole("heading", { name: "Synthetic Buyer" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});
