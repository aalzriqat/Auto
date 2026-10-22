import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LeadDialog } from "./LeadDialog";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { DEFAULT_ROLE_TEMPLATES } from "@/convex/utils/permissions";

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      if (name === "organizations:listMine") return [{ _id: "org-a", name: "Synthetic Dealer" }];
      if (name === "memberships:getMyMembership") {
        const role = DEFAULT_ROLE_TEMPLATES.find((candidate) => candidate.name === "RECEPTION");
        if (!role) throw new Error("Missing actual Reception template");
        return { roleName: role.name, permissions: [...role.permissions] };
      }
      if (name === "orgLeadSources:list") throw new Error("Synthetic backend view:settings refusal");
      if (["customers:selectorOptions", "vehicles:listAll", "orgPipelineStages:list"].includes(name)) return [];
      return null;
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useMutation: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/leads",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each([false, true])("Reception lead dialog open=%s preserves the settings boundary", (open) => {
  const role = DEFAULT_ROLE_TEMPLATES.find((candidate) => candidate.name === "RECEPTION");
  expect(role?.permissions).toContain("create:leads");
  expect(role?.permissions).not.toContain("view:settings");
  expect(() => render(<OrgProvider><LanguageProvider><LeadDialog open={open} onOpenChange={vi.fn()} /></LanguageProvider></OrgProvider>)).not.toThrow();
  if (open) expect(screen.getByRole("dialog")).toBeTruthy();
});
