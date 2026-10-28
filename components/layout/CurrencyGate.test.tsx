/**
 * SCRUM-85 / SCRUM-760 c23812 ruling 9: on a money screen, an organization with no
 * stored currency sees "currency not configured" instead of the screen. Other
 * screens render as before. Only the owner is offered the settings link.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CurrencyGate, isMoneyRoute } from "./CurrencyGate";

const fixture = vi.hoisted(() => ({
  state: { status: "unconfigured" } as { status: "loading" | "unconfigured" | "configured"; code?: string; symbol?: string | null },
  pathname: "/org-a/sales/sales",
  isOwner: false,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ usePathname: () => fixture.pathname }));
vi.mock("convex/react", () => ({
  useQuery: () => ({ isSystemOwnerRole: fixture.isOwner }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org-a" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/useOrgCurrencyState", () => ({ useOrgCurrencyState: () => fixture.state }));

beforeEach(() => {
  fixture.state = { status: "unconfigured" };
  fixture.pathname = "/org-a/sales/sales";
  fixture.isOwner = false;
});
afterEach(cleanup);

const mount = () => render(<CurrencyGate><div data-testid="screen">screen</div></CurrencyGate>);

describe("isMoneyRoute", () => {
  test.each([
    "/org-a/dashboard", "/org-a/accounting/reports", "/org-a/sales/sales", "/org-a/expenses",
    "/org-a/payroll", "/org-a/vehicles/v1", "/org-a/leads", "/org-a/customers",
  ])("%s is a money screen", (pathname) => {
    expect(isMoneyRoute(pathname, "org-a")).toBe(true);
  });

  test.each(["/org-a/settings/general", "/org-a/team", "/org-a/tasks", "/org-a", "/org-a/"])(
    "%s is not a money screen",
    (pathname) => {
      expect(isMoneyRoute(pathname, "org-a")).toBe(false);
    },
  );

  test("a path under another organization, or with no organization, is never a money screen", () => {
    expect(isMoneyRoute("/org-b/sales/sales", "org-a")).toBe(false);
    expect(isMoneyRoute("/org-a/sales/sales", null)).toBe(false);
    expect(isMoneyRoute(null, "org-a")).toBe(false);
  });
});

describe("CurrencyGate", () => {
  test("an unconfigured org on a money screen sees the not-configured panel and not the screen", () => {
    mount();
    expect(screen.queryByTestId("screen")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("CurrencyNotConfigured")).toBeTruthy();
    expect(screen.getByText("ServerError_CURRENCY_NOT_CONFIGURED")).toBeTruthy();
  });

  test("only the owner is offered the link to choose a currency", () => {
    mount();
    expect(screen.queryByText("CurrencyNotConfiguredChoose")).toBeNull();
    cleanup();
    fixture.isOwner = true;
    mount();
    const link = screen.getByText("CurrencyNotConfiguredChoose");
    expect(link.getAttribute("href")).toBe("/org-a/settings/general");
  });

  test("an unconfigured org on a settings screen still sees the screen (the owner must reach it to choose)", () => {
    fixture.pathname = "/org-a/settings/general";
    mount();
    expect(screen.getByTestId("screen")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test.each(["configured", "loading"] as const)("a %s org sees the screen", (status) => {
    fixture.state = status === "configured" ? { status, code: "JOD", symbol: null } : { status };
    mount();
    expect(screen.getByTestId("screen")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
