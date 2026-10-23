import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { RoleGuard } from "@/components/auth/RoleGuard";
import type { Id } from "@/convex/_generated/dataModel";
import { OpeningCommissionLiabilitiesPanel } from "./OpeningCommissionLiabilitiesPanel";

type Row = { _id: string; employeeName: string; currency: string; amountMinor: number | null; remainingMinor: number | null; sourceStatus: string; notYetEffective?: boolean; payrollAvailable: boolean };
const fixture = vi.hoisted(() => ({ permissions: ["view:commissions"], rows: [] as Row[] | undefined, calls: [] as Array<{ name: string; args: unknown }> }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }), usePathname: () => "/org-a/commissions", useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return { useConvexAuth: () => ({ isAuthenticated: true }), useQuery: (reference: never, args: unknown) => {
    const name = getFunctionName(reference); fixture.calls.push({ name, args });
    if (args === "skip") return undefined;
    if (name === "organizations:listMine") return [{ _id: "org-a" }];
    if (name === "memberships:getMyMembership") return { roleName: "Employee", permissions: fixture.permissions };
    if (name === "openingCommissionLiabilities:list") return fixture.rows;
    throw new Error("Unexpected commission SDK boundary query " + name);
  } };
});
beforeEach(() => {
  fixture.permissions = ["view:commissions"]; fixture.rows = []; fixture.calls = [];
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function page() { return <OrgProvider><LanguageProvider><RoleGuard permissions={["view:commissions"]}><OpeningCommissionLiabilitiesPanel orgId={"org-a" as Id<"organizations">} /></RoleGuard></LanguageProvider></OrgProvider>; }

test("real permission guard never mounts the protected opening query for a denied actor", () => {
  fixture.permissions = [];
  render(page());
  expect(fixture.calls.some(call => call.name === "openingCommissionLiabilities:list")).toBe(false);
  expect(screen.queryByText("Opening employee commissions")).toBeNull();
});

for (const locale of ["en", "ar"]) {
  test(`readonly opening projection preserves null source evidence and exact currency amount in ${locale}`, () => {
    vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
    fixture.rows = [
      { _id: "owed", employeeName: "Synthetic own employee", currency: "JOD", amountMinor: 100003, remainingMinor: 100003, sourceStatus: "AVAILABLE", payrollAvailable: true },
      { _id: "missing", employeeName: "Synthetic unavailable source", currency: "JOD", amountMinor: null, remainingMinor: null, sourceStatus: "UNAVAILABLE", payrollAvailable: false },
    ];
    render(page());
    expect(screen.getByText("Synthetic own employee")).toBeTruthy();
    expect(screen.getByText("Synthetic unavailable source")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(2);
    const expected = `${(100.003).toLocaleString(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} JOD`;
    expect(screen.getAllByText(expected)).toHaveLength(2);
    expect(screen.getByText(locale === "en" ? "Source unavailable — finance review required" : "المصدر غير متاح — يلزم مراجعة مالية")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(fixture.calls.filter(call => call.name === "openingCommissionLiabilities:list").every(call => JSON.stringify(call.args) === '{"orgId":"org-a"}')).toBe(true);
  });
}

test("unresolved data renders a loading state and an empty projection adds no phantom debt", () => {
  fixture.rows = undefined;
  const view = render(page());
  expect(screen.getByRole("status").textContent).toBe("Loading opening commissions…");
  expect(screen.queryByRole("table")).toBeNull();
  fixture.rows = [];
  view.rerender(page());
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});


test("future source is not presented as paid when its currently recognized balance is zero", () => {
  fixture.rows = [{ _id: "future", employeeName: "Synthetic future employee", currency: "JOD", amountMinor: 100003, remainingMinor: 0, sourceStatus: "AVAILABLE", notYetEffective: true, payrollAvailable: false }];
  render(page());
  expect(screen.getByText("Not yet effective")).toBeTruthy();
  expect(screen.queryByText("Settled in payroll")).toBeNull();
});
