import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LeadDialog } from "./LeadDialog";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { DEFAULT_ROLE_TEMPLATES } from "@/convex/utils/permissions";
const sources = vi.hoisted(() => ({ value: null as { _id: string; label: string }[] | null }));

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
      if (name === "orgLeadSources:listForLeads") return sources.value;
      if (["customers:selectorOptions", "vehicles:listAll", "orgPipelineStages:list"].includes(name)) return [];
      return null;
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useMutation: () => vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/leads",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
beforeEach(() => {
  sources.value = [{ _id: "source-a", label: "Synthetic configured channel" }];
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each([false, true])("Reception lead dialog open=%s preserves the settings boundary", (open) => {
  const role = DEFAULT_ROLE_TEMPLATES.find((candidate) => candidate.name === "RECEPTION");
  expect(role?.permissions).toContain("create:leads");
  expect(role?.permissions).not.toContain("view:settings");
  expect(() => render(<OrgProvider><LanguageProvider><LeadDialog open={open} onOpenChange={vi.fn()} /></LanguageProvider></OrgProvider>)).not.toThrow();
  if (open) expect(screen.getByRole("dialog")).toBeTruthy();
});

test("Reception sees the configured lead source instead of a built-in fallback", () => {
  render(<OrgProvider><LanguageProvider><LeadDialog open onOpenChange={vi.fn()} /></LanguageProvider></OrgProvider>);
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Lead Source" }), { key: "ArrowDown" });
  expect(screen.getByRole("listbox")).toBeTruthy();
  expect(screen.getByRole("option", { name: "Synthetic configured channel" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Facebook" })).toBeNull();
});

test("Disabling every configured lead source does not restore built-in choices", () => {
  sources.value = [];
  render(<OrgProvider><LanguageProvider><LeadDialog open onOpenChange={vi.fn()} /></LanguageProvider></OrgProvider>);
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Lead Source" }), { key: "ArrowDown" });
  expect(screen.queryByRole("option", { name: "Facebook" })).toBeNull();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
});

test("An unconfigured dealer retains built-in lead source choices", () => {
  sources.value = null;
  render(<OrgProvider><LanguageProvider><LeadDialog open onOpenChange={vi.fn()} /></LanguageProvider></OrgProvider>);
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Lead Source" }), { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "Facebook" })).toBeTruthy();
});
