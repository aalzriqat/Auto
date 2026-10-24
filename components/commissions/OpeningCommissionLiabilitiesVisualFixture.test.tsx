/** Real commission panel and providers with synthetic SDK rows for a static browser replay. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { OrgProvider } from "@/components/providers/OrgProvider";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { OpeningCommissionLiabilitiesPanel } from "./OpeningCommissionLiabilitiesPanel";

const fixture = vi.hoisted(() => ({ locale: "en" }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-a" }),
  usePathname: () => "/org-a/commissions", useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return { useConvexAuth: () => ({ isAuthenticated: true }), useQuery: (reference: never, args: unknown) => {
    if (args === "skip") return undefined;
    switch (getFunctionName(reference)) {
      case "organizations:listMine": return [{ _id: "org-a" }];
      case "memberships:getMyMembership": return { roleName: "Payroll manager", permissions: ["view:commissions"] };
      case "openingCommissionLiabilities:list": return [
        { _id: "owed", employeeName: "Synthetic owed employee", currency: "JOD", amountMinor: 100003,
          remainingMinor: 100003, sourceStatus: "AVAILABLE", notYetEffective: false, payrollAvailable: true },
        { _id: "future", employeeName: "Synthetic future employee", currency: "JOD", amountMinor: 200005,
          remainingMinor: 0, sourceStatus: "AVAILABLE", notYetEffective: true, payrollAvailable: false },
        { _id: "unavailable", employeeName: "Synthetic unavailable employee", currency: "JOD", amountMinor: null,
          remainingMinor: null, sourceStatus: "UNAVAILABLE", notYetEffective: false, payrollAvailable: false },
      ];
      default: throw new Error(`Unexpected commission fixture query: ${getFunctionName(reference)}`);
    }
  } };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each(["en", "ar"] as const)("opening commission liabilities visual fixture %s", (locale) => {
  fixture.locale = locale;
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
  render(<OrgProvider><LanguageProvider><RoleGuard permissions={["view:commissions"]}>
    <main className="mx-auto max-w-5xl p-4"><OpeningCommissionLiabilitiesPanel orgId={"org-a" as Id<"organizations">} /></main>
  </RoleGuard></LanguageProvider></OrgProvider>);
  expect(screen.getByText("Synthetic owed employee")).toBeTruthy();
  expect(screen.getByText("Synthetic future employee")).toBeTruthy();
  expect(screen.getByText("Synthetic unavailable employee")).toBeTruthy();
  const directory = process.env.OPENING_COMMISSION_VISUAL_FIXTURE_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, `opening-commission-${locale}.html`), document.body.innerHTML);
  }
});
