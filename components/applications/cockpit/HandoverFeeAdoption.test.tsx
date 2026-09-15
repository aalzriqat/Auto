/**
 * The "not configured" state of the handover-cost checklist is now honest:
 * when the finance company has since configured fees, the notice says so, and
 * the owner's adopt action is offered only in the state the server accepts.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { salesEn } from "@/lib/i18n/domains/sales";
import { HandoverCostsPanel, type HandoverCostsData, type HandoverFeeAdoption } from "./HandoverCostsPanel";

const t = (key: string) => (salesEn as Record<string, string>)[key] ?? key;

function costs(adoption: HandoverFeeAdoption): HandoverCostsData {
  return {
    lines: [],
    summary: {
      lineCount: 0,
      estimatedTotalMinor: 0,
      actualTotalMinor: 0,
      linesAwaitingActual: 0,
      linesAwaitingReconciliation: 0,
    },
    summaryUnavailable: null,
    expected: {
      source: "NO_TEMPLATES",
      currency: "JOD",
      rows: [],
      expectedTotalMinor: null,
      expectedTotalReason: null,
      actualTotalMinor: 0,
      differenceMinor: null,
      unplannedLineIds: [],
      adoption,
    },
  };
}

function renderPanel(adoption: HandoverFeeAdoption, onAdopt?: (reason: string) => Promise<void>) {
  return render(
    <HandoverCostsPanel
      costs={costs(adoption)}
      loading={false}
      denomination={{ code: "JOD" }}
      scaleOf={() => 3}
      money={(minor) => `${minor / 1000} JOD`}
      canManage={true}
      dealClosed={false}
      t={t}
      onAdd={async () => {}}
      onAbandonAdd={() => {}}
      onRecordActual={async () => {}}
      onVoid={async () => {}}
      onAdoptCompanyFees={onAdopt}
    />
  );
}

afterEach(cleanup);

describe("fee-template adoption on the handover-cost checklist", () => {
  test("AVAILABLE: the notice names the live count and the owner can adopt with a reason", async () => {
    const onAdopt = vi.fn(async () => {});
    renderPanel({ state: "AVAILABLE", liveTemplateCount: 3, liveRuleVersion: 2, adopted: null }, onAdopt);
    const notice = screen.getByTestId("deal-handover-fee-adoption");
    expect(notice.textContent).toContain(salesEn.HandoverExpectedAdoptable);
    expect(notice.textContent).toContain("3");
    fireEvent.click(within(notice).getByRole("button", { name: salesEn.AdoptCompanyFees }));
    fireEvent.change(within(notice).getByLabelText(salesEn.AdoptCompanyFeesReason), { target: { value: "Configured late" } });
    fireEvent.click(within(notice).getByRole("button", { name: salesEn.AdoptCompanyFeesConfirm }));
    await waitFor(() => expect(onAdopt).toHaveBeenCalledWith("Configured late"));
  });

  test("AVAILABLE without the owner's authority: the notice, no action", () => {
    renderPanel({ state: "AVAILABLE", liveTemplateCount: 3, liveRuleVersion: 2, adopted: null });
    expect(screen.getByTestId("deal-handover-fee-adoption")).toBeTruthy();
    expect(screen.queryByRole("button", { name: salesEn.AdoptCompanyFees })).toBeNull();
  });

  test("blocked states explain themselves and offer nothing, even to the owner", () => {
    const onAdopt = vi.fn(async () => {});
    renderPanel({ state: "BLOCKED_COSTS_RECORDED", liveTemplateCount: 3, liveRuleVersion: 2, adopted: null }, onAdopt);
    expect(screen.getByTestId("deal-handover-fee-adoption").textContent).toContain(salesEn.HandoverExpectedAdoptBlockedCosts);
    expect(screen.queryByRole("button", { name: salesEn.AdoptCompanyFees })).toBeNull();
    cleanup();
    renderPanel({ state: "BLOCKED_DEAL_PROGRESSED", liveTemplateCount: 3, liveRuleVersion: 2, adopted: null }, onAdopt);
    expect(screen.getByTestId("deal-handover-fee-adoption").textContent).toContain(salesEn.HandoverExpectedAdoptBlockedProgressed);
  });

  test("COMPANY_TEMPLATES_UNREADABLE: the notice says the company's configuration must be corrected and offers nothing, even to the owner", () => {
    const onAdopt = vi.fn(async () => {});
    renderPanel({ state: "COMPANY_TEMPLATES_UNREADABLE", liveTemplateCount: 2, liveRuleVersion: 3, adopted: null }, onAdopt);
    const notice = screen.getByTestId("deal-handover-fee-adoption");
    expect(notice.textContent).toContain(salesEn.HandoverExpectedAdoptCompanyUnreadable);
    expect(notice.textContent).not.toContain(salesEn.HandoverExpectedAdoptable);
    expect(screen.queryByRole("button", { name: salesEn.AdoptCompanyFees })).toBeNull();
    expect(onAdopt).not.toHaveBeenCalled();
  });

  test("a company with no fees, or no snapshot, shows the plain not-configured sentence and no notice", () => {
    renderPanel({ state: "COMPANY_HAS_NO_TEMPLATES", liveTemplateCount: 0, liveRuleVersion: 1, adopted: null });
    expect(screen.getByText(salesEn.HandoverExpectedNotConfigured)).toBeTruthy();
    expect(screen.queryByTestId("deal-handover-fee-adoption")).toBeNull();
  });

  test("the server's refusal is shown in the adopt form", async () => {
    const onAdopt = vi.fn(async () => { throw new Error("Costs or custody have already been recorded on this deal without a policy"); });
    renderPanel({ state: "AVAILABLE", liveTemplateCount: 1, liveRuleVersion: 2, adopted: null }, onAdopt);
    const notice = screen.getByTestId("deal-handover-fee-adoption");
    fireEvent.click(within(notice).getByRole("button", { name: salesEn.AdoptCompanyFees }));
    fireEvent.change(within(notice).getByLabelText(salesEn.AdoptCompanyFeesReason), { target: { value: "x" } });
    fireEvent.click(within(notice).getByRole("button", { name: salesEn.AdoptCompanyFeesConfirm }));
    expect((await within(notice).findByRole("alert")).textContent).toContain("already been recorded");
  });
});
