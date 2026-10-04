/**
 * SCRUM-628 F-06: the cost panel returned nothing while its query loaded and
 * then appeared, pushing every input below it down the page. A viewer who will
 * see the panel gets a placeholder of the same height while it loads; a viewer
 * who will never see it still gets nothing.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  total: undefined as number | undefined,
  permissions: ["view:expenses"] as string[],
  permissionsLoading: false,
  orgId: "org1" as string | null,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: stubs.orgId }),
}));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (n: number) => `${n} JOD`,
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    isLoading: stubs.permissionsLoading,
    hasPermission: (permission: string) => stubs.permissions.includes(permission),
  }),
}));
vi.mock("convex/react", () => ({
  useQuery: (_ref: unknown, args: unknown) => (args === "skip" ? undefined : stubs.total),
}));

import { VehicleCostBar } from "./VehicleCostBar";
import { PERMISSIONS } from "@/convex/utils/permissions";

function renderBar() {
  return render(<VehicleCostBar vehicleId="v1" purchasePrice={10_000} salePrice={11_000} />);
}

afterEach(() => {
  cleanup();
  stubs.total = undefined;
  stubs.permissions = [PERMISSIONS.VIEW_EXPENSES];
  stubs.permissionsLoading = false;
  stubs.orgId = "org1";
});

describe("VehicleCostBar — no layout shift (SCRUM-628 F-06)", () => {
  test("holds the panel's place while the expense total loads", () => {
    stubs.permissions = [PERMISSIONS.VIEW_EXPENSES];
    renderBar();
    const placeholder = screen.getByTestId("vehicle-cost-bar-loading");
    expect(placeholder.getAttribute("aria-busy")).toBe("true");
  });

  test("the loaded panel replaces the placeholder", () => {
    stubs.permissions = [PERMISSIONS.VIEW_EXPENSES];
    stubs.total = 500;
    renderBar();
    expect(screen.queryByTestId("vehicle-cost-bar-loading")).toBeNull();
    expect(screen.getByText("VehicleCostBreakdown")).toBeTruthy();
  });

  test("a viewer without the expense permission gets nothing, not a placeholder", () => {
    stubs.permissions = [];
    const { container } = renderBar();
    expect(container.innerHTML).toBe("");
  });

  test("with no active organization it renders nothing rather than a skeleton that never resolves", () => {
    stubs.orgId = null;
    const { container } = renderBar();
    expect(container.innerHTML).toBe("");
  });
});
