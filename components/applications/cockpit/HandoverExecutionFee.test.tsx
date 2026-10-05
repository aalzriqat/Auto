/**
 * SCRUM-690 F-PNTR-1: the execution fee's own row on the handover-cost
 * checklist. The deal cannot finalize while the fee is unrecorded, so the
 * row must offer a way out — record it (zero if not charged), or link the
 * finance-company fee line already recorded for it — and, once linked, show
 * which line it is and let it be unlinked with a reason.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { salesEn } from "@/lib/i18n/domains/sales";
import { HandoverCostsPanel, type HandoverCostLine, type HandoverCostsData, type HandoverExecutionFee } from "./HandoverCostsPanel";

const t = (key: string) => (salesEn as Record<string, string>)[key] ?? key;

const feeLine: HandoverCostLine = {
  _id: "fee1",
  feeType: "FINANCE_COMPANY_FEE",
  currency: "JOD",
  description: "Company fee",
  actualAmountMinor: 700_000,
  paidBy: "DEALER",
  paidTo: "FINANCE_COMPANY",
  status: "PENDING",
};

function costs(executionFee: HandoverExecutionFee | null, lines: HandoverCostLine[] = [feeLine]): HandoverCostsData {
  return {
    lines,
    summary: {
      lineCount: lines.length,
      estimatedTotalMinor: 0,
      actualTotalMinor: 700_000,
      linesAwaitingActual: 0,
      linesAwaitingReconciliation: 0,
    },
    summaryUnavailable: null,
    expected: null,
    executionFee,
  };
}

function renderPanel(
  executionFee: HandoverExecutionFee | null,
  handlers: Partial<{
    onRecordExecutionFee: (values: unknown) => Promise<void>;
    onLinkExecutionFee: (feeId: string) => Promise<void>;
    onUnlinkExecutionFee: (feeId: string, reason: string) => Promise<void>;
  }> = {},
  { canManage = true, dealClosed = false } = {}
) {
  return render(
    <HandoverCostsPanel
      costs={costs(executionFee)}
      loading={false}
      denomination={{ code: "JOD" }}
      scaleOf={() => 3}
      money={(minor) => `${minor / 1000} JOD`}
      canManage={canManage}
      dealClosed={dealClosed}
      costSource={{ kind: "PENDING" }}
      t={t}
      onAdd={async () => {}}
      onAbandonAdd={() => {}}
      onRecordActual={async () => {}}
      onVoid={async () => {}}
      onRecordExecutionFee={handlers.onRecordExecutionFee}
      onLinkExecutionFee={handlers.onLinkExecutionFee}
      onUnlinkExecutionFee={handlers.onUnlinkExecutionFee}
    />
  );
}

const unrecorded: HandoverExecutionFee = {
  expectedMinor: 700_000,
  boundFeeId: null,
  unrecorded: true,
  withheld: false,
  eligibleFeeIds: ["fee1"],
};

afterEach(cleanup);

describe("execution fee row", () => {
  test("no position: no row", () => {
    renderPanel(null);
    expect(screen.queryByTestId("deal-execution-fee")).toBeNull();
  });

  test("unrecorded: says so, shows the expectation, and offers record and link", () => {
    renderPanel(unrecorded, { onRecordExecutionFee: async () => {}, onLinkExecutionFee: async () => {} });
    const row = screen.getByTestId("deal-execution-fee");
    expect(within(row).getByTestId("deal-execution-fee-unrecorded")).toBeTruthy();
    expect(within(row).getByText("700 JOD")).toBeTruthy();
    expect(within(row).getByRole("button", { name: salesEn.ExecutionFeeRecord })).toBeTruthy();
    expect(within(row).getByRole("option", { name: /Company fee · 700 JOD/ })).toBeTruthy();
  });

  test("nothing linkable but costs exist: steers to remove-then-record, never silently to a second record (Opus seat F-2)", () => {
    renderPanel({ ...unrecorded, eligibleFeeIds: [] }, { onRecordExecutionFee: async () => {}, onLinkExecutionFee: async () => {} });
    const row = screen.getByTestId("deal-execution-fee");
    expect(within(row).getByTestId("deal-execution-fee-recorded-elsewhere").textContent).toBe(salesEn.ExecutionFeeRecordedElsewhere);
    expect(within(row).queryByRole("button", { name: salesEn.ExecutionFeeLink })).toBeNull();
  });

  test("a linkable line exists: no remove-first note", () => {
    renderPanel(unrecorded, { onLinkExecutionFee: async () => {} });
    expect(screen.queryByTestId("deal-execution-fee-recorded-elsewhere")).toBeNull();
  });

  test("linking sends the chosen line's id", async () => {
    const onLink = vi.fn(async () => {});
    renderPanel(unrecorded, { onLinkExecutionFee: onLink });
    const row = screen.getByTestId("deal-execution-fee");
    const link = within(row).getByRole("button", { name: salesEn.ExecutionFeeLink });
    expect((link as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(row).getByLabelText(salesEn.ExecutionFeeLinkLabel), { target: { value: "fee1" } });
    fireEvent.click(link);
    await waitFor(() => expect(onLink).toHaveBeenCalledWith("fee1"));
  });

  test("recording an explicit zero is submitted as 0", async () => {
    const onRecord = vi.fn(async () => {});
    renderPanel(unrecorded, { onRecordExecutionFee: onRecord });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ExecutionFeeRecord }));
    const form = screen.getByTestId("deal-handover-expected-record--1");
    fireEvent.change(within(form).getAllByRole("textbox")[0], { target: { value: "0" } });
    fireEvent.submit(form);
    await waitFor(() => expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ actualAmountMinor: 0, currency: "JOD" })));
  });

  test("linked: names the line, offers unlink with a reason, offers no record", async () => {
    const onUnlink = vi.fn(async () => {});
    renderPanel(
      { ...unrecorded, boundFeeId: "fee1", unrecorded: false, eligibleFeeIds: [] },
      { onRecordExecutionFee: async () => {}, onUnlinkExecutionFee: onUnlink }
    );
    const row = screen.getByTestId("deal-execution-fee");
    expect(within(row).getByTestId("deal-execution-fee-linked").textContent).toContain("Company fee");
    expect(within(row).queryByRole("button", { name: salesEn.ExecutionFeeRecord })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: salesEn.ExecutionFeeUnlink }));
    fireEvent.change(within(row).getByLabelText(salesEn.VoidReasonLabel), { target: { value: "Wrong line" } });
    fireEvent.click(within(row).getByRole("button", { name: salesEn.ExecutionFeeUnlink }));
    await waitFor(() => expect(onUnlink).toHaveBeenCalledWith("fee1", "Wrong line"));
  });

  test("withheld: says the estimate is withheld", () => {
    renderPanel({ ...unrecorded, withheld: true });
    expect(screen.getByTestId("deal-execution-fee-withheld")).toBeTruthy();
  });

  test("a closed deal offers no action", () => {
    renderPanel(unrecorded, { onRecordExecutionFee: async () => {}, onLinkExecutionFee: async () => {} }, { dealClosed: true });
    const row = screen.getByTestId("deal-execution-fee");
    expect(within(row).queryByRole("button")).toBeNull();
  });
});
