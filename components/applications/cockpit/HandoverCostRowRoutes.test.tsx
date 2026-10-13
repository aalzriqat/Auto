/**
 * SCRUM-834: closing readiness judges EVERY live cost line, but the list's
 * record / reconcile / remove controls used to be drawn only for the eight
 * handover fee types. An unplanned APPRAISAL_FEE, ADMINISTRATIVE_FEE or
 * COMMISSION, or an unbound finance-company fee, could therefore leave a deal
 * "awaiting actual" or "awaiting reconciliation" with no way to clear it.
 *
 * Production-shaped payloads from `listDealCosts`: the fee type is the only
 * thing that varies, so each row below is the SAME line in a different type.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { salesEn } from "@/lib/i18n/domains/sales";
import {
  HandoverCostsPanel,
  type HandoverCostLine,
  type HandoverCostsData,
  type HandoverExecutionFee,
} from "./HandoverCostsPanel";

const t = (key: string) => (salesEn as Record<string, string>)[key] ?? key;
const money = (minor: number, currency: string) => `${(minor / 1000).toLocaleString("en-US")} ${currency}`;

/** Fee types the add form never offers but the server records and closing judges. */
const NON_HANDOVER_TYPES = ["APPRAISAL_FEE", "ADMINISTRATIVE_FEE", "COMMISSION", "FINANCE_COMPANY_FEE"] as const;

const lineOf = (feeType: string, overrides: Partial<HandoverCostLine> = {}): HandoverCostLine => ({
  _id: "fee1",
  feeType,
  currency: "JOD",
  description: "Unplanned charge",
  estimatedAmountMinor: 100_000,
  actualAmountMinor: 120_000,
  paidBy: "DEALER",
  paidTo: "OTHER",
  status: "ACTUAL_RECORDED",
  ...overrides,
});

/** A finance-company fee that is NOT the bound execution fee. */
const unbound: HandoverExecutionFee = {
  expectedMinor: 1_250_000,
  boundFeeId: null,
  unrecorded: true,
  withheld: false,
  eligibleFeeIds: [],
};

function costs(lines: HandoverCostLine[], extra: Partial<HandoverCostsData> = {}): HandoverCostsData {
  return {
    lines,
    summary: {
      lineCount: lines.length,
      estimatedTotalMinor: 0,
      actualTotalMinor: lines.reduce((sum, line) => sum + (line.actualAmountMinor ?? 0), 0),
      linesAwaitingActual: 0,
      linesAwaitingReconciliation: 1,
    },
    summaryUnavailable: null,
    expected: null,
    executionFee: null,
    ...extra,
  };
}

type Handlers = Partial<{
  onReconcile: (feeId: string, notes: string, expectedActualAmountMinor: number, expectedActualEvidenceRevision: number) => Promise<void>;
  onRecordActual: (feeId: string, values: unknown) => Promise<void>;
  onVoid: (feeId: string, reason: string) => Promise<void>;
}>;
type Flags = { canManage?: boolean; canReconcile?: boolean; dealClosed?: boolean };

function renderPanel(data: HandoverCostsData, handlers: Handlers = {}, flags: Flags = {}) {
  return render(
    <HandoverCostsPanel
      costs={data}
      loading={false}
      denomination={{ code: "JOD" }}
      scaleOf={() => 3}
      money={money}
      canManage={flags.canManage ?? true}
      canReconcile={flags.canReconcile ?? true}
      dealClosed={flags.dealClosed ?? false}
      costSource={{ kind: "PENDING" }}
      t={t}
      onAdd={async () => {}}
      onAbandonAdd={() => {}}
      onRecordActual={(handlers.onRecordActual ?? (async () => {})) as never}
      onVoid={handlers.onVoid ?? (async () => {})}
      onReconcile={handlers.onReconcile}
    />
  );
}

const row = (id = "fee1") => screen.getByTestId(`deal-handover-cost-${id}`);
const button = (name: string, id = "fee1") => within(row(id)).getByRole("button", { name });
const maybeButton = (name: string, id = "fee1") => within(row(id)).queryByRole("button", { name });

afterEach(cleanup);

describe.each(NON_HANDOVER_TYPES)("an unplanned %s that stops the deal closing", (feeType) => {
  test("is reconciled from its row, pinning the amount and evidence revision it displays", async () => {
    const onReconcile = vi.fn(async () => {});
    renderPanel(costs([lineOf(feeType, { actualEvidenceRevision: 2 })]), { onReconcile });
    fireEvent.click(button(salesEn.ReconcileDealFee));
    fireEvent.change(screen.getByLabelText(salesEn.ReconcileNotes), { target: { value: "matched receipt 9" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ConfirmReconcile }));
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("fee1", "matched receipt 9", 120_000, 2));
    await waitFor(() => expect(screen.queryByLabelText(salesEn.ReconcileNotes)).toBeNull());
  });

  test("has its actual corrected from its row, in the line's own currency", async () => {
    const onRecordActual = vi.fn(async () => {});
    renderPanel(costs([lineOf(feeType)]), { onReconcile: async () => {}, onRecordActual });
    fireEvent.click(button(salesEn.RecordActualCost));
    fireEvent.change(screen.getByLabelText(new RegExp(`^${salesEn.CostActual}`)), { target: { value: "95" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.SaveActualCost }));
    await waitFor(() =>
      expect(onRecordActual).toHaveBeenCalledWith("fee1", expect.objectContaining({ actualAmountMinor: 95_000, currency: "JOD" }))
    );
  });

  test("is removed from its row with a stated reason", async () => {
    const onVoid = vi.fn(async () => {});
    renderPanel(costs([lineOf(feeType)]), { onReconcile: async () => {}, onVoid });
    fireEvent.click(button(salesEn.RemoveHandoverCost));
    expect((screen.getByRole("button", { name: salesEn.ConfirmRemoveCost }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(salesEn.VoidReasonLabel), { target: { value: "Charged to the wrong deal" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ConfirmRemoveCost }));
    await waitFor(() => expect(onVoid).toHaveBeenCalledWith("fee1", "Charged to the wrong deal"));
  });

  test("with no actual yet can have one recorded, and offers nothing to reconcile", () => {
    const { actualAmountMinor: _omitted, ...withoutActual } = lineOf(feeType, { status: "ESTIMATED_ONLY" });
    void _omitted;
    renderPanel(costs([withoutActual]), { onReconcile: async () => {} });
    expect(button(salesEn.RecordActualCost)).toBeTruthy();
    expect(maybeButton(salesEn.ReconcileDealFee)).toBeNull();
  });

  test("already reconciled offers no second reconciliation, only the audited correction and removal", () => {
    renderPanel(costs([lineOf(feeType, { status: "RECONCILED" })]), { onReconcile: async () => {} });
    expect(maybeButton(salesEn.ReconcileDealFee)).toBeNull();
    expect(button(salesEn.RecordActualCost)).toBeTruthy();
    expect(button(salesEn.RemoveHandoverCost)).toBeTruthy();
  });

  test("keeps the rights split: an accountant reconciles only, a manager is told who can", () => {
    const view = renderPanel(costs([lineOf(feeType)]), { onReconcile: async () => {} }, { canManage: false, canReconcile: true });
    expect(button(salesEn.ReconcileDealFee)).toBeTruthy();
    expect(maybeButton(salesEn.RecordActualCost)).toBeNull();
    expect(maybeButton(salesEn.RemoveHandoverCost)).toBeNull();
    view.unmount();

    renderPanel(costs([lineOf(feeType)]), { onReconcile: async () => {} }, { canManage: true, canReconcile: false });
    expect(maybeButton(salesEn.ReconcileDealFee)).toBeNull();
    expect(screen.getByTestId("deal-handover-reconcile-fee1-waiting").textContent).toBe(salesEn.ReconcileNeedsAccountant);
    expect(button(salesEn.RecordActualCost)).toBeTruthy();
  });

  test("keeps the currency guard: a line in another currency is flagged, never edited or reconciled here", () => {
    renderPanel(costs([lineOf(feeType, { currency: "USD" })]), { onReconcile: async () => {} });
    expect(screen.getByTestId("deal-handover-cost-fee1-currency").textContent).toBe(salesEn.HandoverCostCurrencyDiffers);
    expect(within(row()).queryByRole("button")).toBeNull();
  });

  test("keeps the freeze guard: once the sale is recognised no control is offered", () => {
    // The cockpit withdraws `canManage` itself once the economics are frozen
    // (DealCockpit's `canManage: … && !frozen`); the panel withdraws reconcile.
    renderPanel(costs([lineOf(feeType)]), { onReconcile: async () => {} }, { canManage: false, canReconcile: true, dealClosed: true });
    expect(within(row()).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("deal-handover-costs-frozen")).toBeTruthy();
  });

  test("a viewer who can neither manage nor reconcile sees the row and no control", () => {
    renderPanel(costs([lineOf(feeType)]), { onReconcile: async () => {} }, { canManage: false, canReconcile: false });
    expect(within(row()).queryByRole("button")).toBeNull();
    expect(within(row()).queryByTestId("deal-handover-reconcile-fee1-waiting")).toBeNull();
    expect(row().textContent).toContain(t(feeType === "APPRAISAL_FEE" ? "FeeTypeAppraisal" : feeType === "ADMINISTRATIVE_FEE" ? "FeeTypeAdministrative" : feeType === "COMMISSION" ? "FeeTypeCommission" : "FeeTypeFinanceCompany"));
  });

  test("outside the checklist (a frozen policy with its own rows) it is still reconcilable", async () => {
    const onReconcile = vi.fn(async () => {});
    const planned = lineOf("LICENSING", { _id: "fee0", description: "Plates", status: "RECONCILED" });
    renderPanel(
      costs([planned, lineOf(feeType)], {
        expected: {
          source: "COMPANY_RULE_SNAPSHOT",
          currency: "JOD",
          rows: [
            {
              templateIndex: 0,
              feeType: "LICENSING",
              description: "Plates",
              expectedAmountMinor: 100_000,
              expectedAmountReason: null,
              duplicateIdentity: false,
              actual: { feeId: "fee0", actualAmountMinor: 120_000, currency: "JOD", status: "RECONCILED" },
            },
          ],
          expectedTotalMinor: 100_000,
          expectedTotalReason: null,
          actualTotalMinor: 240_000,
          differenceMinor: -140_000,
          unplannedLineIds: ["fee1"],
        },
      }),
      { onReconcile }
    );
    fireEvent.click(button(salesEn.ReconcileDealFee));
    fireEvent.change(screen.getByLabelText(salesEn.ReconcileNotes), { target: { value: "invoice 31" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ConfirmReconcile }));
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("fee1", "invoice 31", 120_000, 0));
  });
});

describe("an unbound finance-company fee, with and without an execution-fee section", () => {
  test("where the deal expects an execution fee, an UNBOUND finance fee is reconciled from the list while the section stays a link / record surface", async () => {
    const onReconcile = vi.fn(async () => {});
    renderPanel(
      costs([lineOf("FINANCE_COMPANY_FEE", { description: "Admin charge" })], { executionFee: { ...unbound, eligibleFeeIds: ["fee1"] } }),
      { onReconcile }
    );
    expect(screen.getByTestId("deal-execution-fee")).toBeTruthy();
    expect(within(screen.getByTestId("deal-execution-fee")).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
    fireEvent.click(button(salesEn.ReconcileDealFee));
    fireEvent.change(screen.getByLabelText(salesEn.ReconcileNotes), { target: { value: "letter 4" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ConfirmReconcile }));
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("fee1", "letter 4", 120_000, 0));
  });

  test("where the deal expects none, there is no section and the row still has its route", () => {
    renderPanel(costs([lineOf("FINANCE_COMPANY_FEE")], { executionFee: null }), { onReconcile: async () => {} });
    expect(screen.queryByTestId("deal-execution-fee")).toBeNull();
    expect(button(salesEn.ReconcileDealFee)).toBeTruthy();
  });

  test("the BOUND line is acted on in the section only, never twice", () => {
    renderPanel(costs([lineOf("FINANCE_COMPANY_FEE")], { executionFee: { ...unbound, boundFeeId: "fee1", unrecorded: false } }), {
      onReconcile: async () => {},
    });
    expect(within(row()).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
    expect(within(row()).queryByRole("button", { name: salesEn.RemoveHandoverCost })).toBeNull();
    expect(screen.getAllByRole("button", { name: salesEn.ReconcileDealFee })).toHaveLength(1);
    expect(within(screen.getByTestId("deal-execution-fee")).getByRole("button", { name: salesEn.ReconcileDealFee })).toBeTruthy();
  });

  test("a binding the section cannot show (the position names no usable line) leaves the row with its controls", () => {
    // `boundFeeId: null` while a second line carries a stale binding: the server
    // reads that as ambiguous and serves no bound id, so no section owns the row.
    renderPanel(costs([lineOf("FINANCE_COMPANY_FEE")], { executionFee: { ...unbound, withheld: true } }), { onReconcile: async () => {} });
    expect(button(salesEn.ReconcileDealFee)).toBeTruthy();
    expect(button(salesEn.RemoveHandoverCost)).toBeTruthy();
  });
});
