/**
 * SCRUM-724 mount: the deal page renders the invoice-receipts money panel beside
 * the cockpit. The panel's `useQuery` rethrows a failed query during render, so it
 * sits behind its own error boundary: a failure there must degrade to a localized
 * alert in the panel's place and never take the deal cockpit down with it. The
 * boundary is keyed by org + sale, so moving to another deal clears it.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  activeOrgId: "org1" as string | null,
  saleId: "sale1" as string | undefined,
  panelThrowsFor: new Set<string>(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: stubs.activeOrgId }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ saleId: stubs.saleId }),
}));
vi.mock("@/components/applications/cockpit/useStageDeepLink", () => ({
  useStageDeepLink: () => undefined,
}));
vi.mock("@/components/applications/cockpit/DealCockpit", () => ({
  SaleDealCockpit: ({ orgId, saleId }: { orgId: string; saleId: string }) =>
    <div data-testid="cockpit">{`${orgId}/${saleId}`}</div>,
}));
vi.mock("@/components/applications/cockpit/DealInvoiceReceiptsPanel", () => ({
  DealInvoiceReceiptsPanel: ({ orgId, saleId }: { orgId: string; saleId: string }) => {
    if (stubs.panelThrowsFor.has(saleId)) throw new Error("[CONVEX Q(collections:saleInvoiceReceiptStatus)] Server Error");
    return <div data-testid="deal-invoice-receipts">{`${orgId}/${saleId}`}</div>;
  },
}));

import { SaleDealCockpitClient } from "./client";

afterEach(() => {
  cleanup();
  stubs.activeOrgId = "org1";
  stubs.saleId = "sale1";
  stubs.panelThrowsFor.clear();
  vi.restoreAllMocks();
});

describe("SCRUM-724 deal page mount", () => {
  test("renders the cockpit and the invoice-receipts panel for the same org and sale", () => {
    render(<SaleDealCockpitClient />);
    expect(screen.getByTestId("cockpit").textContent).toBe("org1/sale1");
    expect(screen.getByTestId("deal-invoice-receipts").textContent).toBe("org1/sale1");
  });

  test("before the org is verified, neither the cockpit nor the money panel queries", () => {
    stubs.activeOrgId = null;
    render(<SaleDealCockpitClient />);
    expect(screen.queryByTestId("cockpit")).toBeNull();
    expect(screen.queryByTestId("deal-invoice-receipts")).toBeNull();
  });

  test("a failing money panel degrades to a localized alert; the cockpit stays and nothing raw is shown", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    stubs.panelThrowsFor.add("sale1");
    render(<SaleDealCockpitClient />);
    expect(screen.getByTestId("cockpit")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("DealReceiptPanelLoadFailed");
    expect(document.body.textContent).not.toMatch(/CONVEX|Server Error/);
    expect(logged).toHaveBeenCalled();
  });

  test("moving to another deal clears a previous panel failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubs.panelThrowsFor.add("sale1");
    const { rerender } = render(<SaleDealCockpitClient />);
    expect(screen.getByRole("alert")).toBeTruthy();
    stubs.saleId = "sale2";
    rerender(<SaleDealCockpitClient />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("deal-invoice-receipts").textContent).toBe("org1/sale2");
  });
});
