/** SCRUM-760 c23862 / SCRUM-761: real page and providers; synthetic SDK responses only. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";

const fixture = vi.hoisted(() => ({ state: "loaded" }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }),
  usePathname: () => "/org-a/commissions", useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const rows = ["UNPAID", "NOT_SET"].map((commissionStatus, index) => ({
    _id: `sale-${index}`, _creationTime: 1, orgId: "org-a", salespersonId: "employee-a",
    salespersonName: "Synthetic employee", vehicleSummary: `Synthetic ${commissionStatus}`,
    customerName: "Synthetic customer", saleDate: 1_790_000_000_000, salePrice: 20000,
    status: "COMPLETED", commissionStatus, canSetAmount: true, salespersonOffboarded: false,
    commissionAmount: index === 0 ? 100 : undefined, paidByName: null,
  }));
  return { useConvexAuth: () => ({ isAuthenticated: true }), useMutation: () => vi.fn(),
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      switch (getFunctionName(reference)) {
        case "organizations:listMine": return [{ _id: "org-a" }];
        case "memberships:getMyMembership": return { permissions: ["view:commissions", "manage:commissions"] };
        case "memberships:list": return { page: [], isDone: true, continueCursor: "" };
        case "orgSettings:getCommissionMode": return "MANUAL";
        case "openingCommissionLiabilities:list": return [];
        default: throw new Error(`Unexpected RT11 commission query: ${getFunctionName(reference)}`);
      }
    }, usePaginatedQuery: () => ({ results: fixture.state === "loaded" ? rows : [],
      status: fixture.state === "loading" ? "LoadingFirstPage" : "Exhausted", loadMore: vi.fn() }) };
});

// The optional path points to a git-show copy, never a replacement of the worktree source.
const { default: CommissionsPage } = await import(process.env.RT11_COMMISSION_COMPONENT ||
  "@/app/(dashboard)/[orgId]/commissions/page") as typeof import("@/app/(dashboard)/[orgId]/commissions/page");
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each(["en", "ar"] as const)("RT11 commission page markup %s", (locale) => {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
  for (const state of ["loaded", "loading", "empty"]) {
    fixture.state = state;
    render(<OrgProvider><LanguageProvider><main className="p-3 md:p-8"><CommissionsPage /></main></LanguageProvider></OrgProvider>);
    expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");
    const directory = process.env.RT11_COMMISSION_FIXTURE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, `commission-${locale}-${state}.html`), document.body.innerHTML);
    }
    cleanup();
  }
});
