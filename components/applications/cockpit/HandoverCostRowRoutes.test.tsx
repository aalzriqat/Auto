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
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import {
  FEE_TYPE_LABEL,
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

  test("keeps the currency guard: a line in another currency is flagged and cannot be recorded or reconciled, but can be removed", async () => {
    const onVoid = vi.fn(async () => {});
    renderPanel(costs([lineOf(feeType, { currency: "USD" })]), { onReconcile: async () => {}, onVoid });
    expect(screen.getByTestId("deal-handover-cost-fee1-currency").textContent).toBe(salesEn.HandoverCostCurrencyDiffers);
    expect(maybeButton(salesEn.ReconcileDealFee)).toBeNull();
    expect(maybeButton(salesEn.RecordActualCost)).toBeNull();
    fireEvent.click(button(salesEn.RemoveHandoverCost));
    expect((screen.getByRole("button", { name: salesEn.ConfirmRemoveCost }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(salesEn.VoidReasonLabel), { target: { value: "Legacy USD line on a JOD deal" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ConfirmRemoveCost }));
    await waitFor(() => expect(onVoid).toHaveBeenCalledWith("fee1", "Legacy USD line on a JOD deal"));
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
    expect(row().textContent).toContain(t(FEE_TYPE_LABEL[feeType]));
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

  test("a withheld binding (no bound id served) leaves the row with its controls", () => {
    renderPanel(costs([lineOf("FINANCE_COMPANY_FEE")], { executionFee: { ...unbound, withheld: true } }), { onReconcile: async () => {} });
    expect(button(salesEn.ReconcileDealFee)).toBeTruthy();
    expect(button(salesEn.RemoveHandoverCost)).toBeTruthy();
  });
});

describe("a live line in another currency than the deal's (legacy) blocks closing, so it can be removed -- and only removed", () => {
  const foreign = (overrides: Partial<HandoverCostLine> = {}) => lineOf("LICENSING", { currency: "USD", ...overrides });

  test("an unreconciled and a reconciled foreign line both offer Remove, with the warning kept", () => {
    for (const status of ["ACTUAL_RECORDED", "RECONCILED"]) {
      renderPanel(costs([foreign({ status })]), { onReconcile: async () => {} });
      expect(screen.getByTestId("deal-handover-cost-fee1-currency")).toBeTruthy();
      expect(button(salesEn.RemoveHandoverCost)).toBeTruthy();
      cleanup();
    }
  });

  test("the removal is the manager's: an accountant who cannot edit costs, and a viewer, are offered nothing", () => {
    const accountant = renderPanel(costs([foreign()]), { onReconcile: async () => {} }, { canManage: false, canReconcile: true });
    expect(within(row()).queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("deal-handover-cost-fee1-currency")).toBeNull();
    accountant.unmount();
    renderPanel(costs([foreign()]), { onReconcile: async () => {} }, { canManage: false, canReconcile: false });
    expect(within(row()).queryByRole("button")).toBeNull();
  });

  test("a manager without the reconcile right still sees no 'waiting for an accountant' hint on a line that cannot be reconciled", () => {
    renderPanel(costs([foreign()]), { onReconcile: async () => {} }, { canManage: true, canReconcile: false });
    expect(screen.queryByTestId("deal-handover-reconcile-fee1-waiting")).toBeNull();
    expect(button(salesEn.RemoveHandoverCost)).toBeTruthy();
  });

  test("a frozen deal offers no removal (the cockpit withdraws canManage once economics are frozen)", () => {
    renderPanel(costs([foreign()]), { onReconcile: async () => {} }, { canManage: false, canReconcile: true, dealClosed: true });
    expect(within(row()).queryByRole("button")).toBeNull();
  });

  test("a refusal from the void handler stays in the form with the server's reason", async () => {
    const onVoid = vi.fn(async () => {
      throw new Error("This deal has been finalized.");
    });
    renderPanel(costs([foreign()]), { onVoid });
    fireEvent.click(button(salesEn.RemoveHandoverCost));
    fireEvent.change(screen.getByLabelText(salesEn.VoidReasonLabel), { target: { value: "wrong currency" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ConfirmRemoveCost }));
    expect((await screen.findByRole("alert")).textContent).toContain("finalized");
  });

  test("a configured (checklist) row whose actual is in another currency can be removed, and nothing else", async () => {
    const onVoid = vi.fn(async () => {});
    renderPanel(
      costs([foreign()], {
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
              actual: { feeId: "fee1", actualAmountMinor: 120_000, currency: "USD", status: "ACTUAL_RECORDED" },
            },
          ],
          expectedTotalMinor: 100_000,
          expectedTotalReason: null,
          actualTotalMinor: null,
          differenceMinor: null,
          unplannedLineIds: [],
        },
      }),
      { onReconcile: async () => {}, onVoid }
    );
    const checklistRow = screen.getByTestId("deal-handover-cost-fee1-currency").closest("li") as HTMLElement;
    expect(within(checklistRow).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
    expect(within(checklistRow).queryByRole("button", { name: salesEn.RecordActualCost })).toBeNull();
    fireEvent.click(within(checklistRow).getByRole("button", { name: salesEn.RemoveHandoverCost }));
    fireEvent.change(screen.getByLabelText(salesEn.VoidReasonLabel), { target: { value: "USD line" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ConfirmRemoveCost }));
    await waitFor(() => expect(onVoid).toHaveBeenCalledWith("fee1", "USD line"));
  });

  test("in Arabic the warning and the removal are labelled in Arabic", () => {
    const tAr = (key: string) => (salesAr as Record<string, string>)[key] ?? key;
    render(
      <HandoverCostsPanel
        costs={costs([foreign()])}
        loading={false}
        denomination={{ code: "JOD" }}
        scaleOf={() => 3}
        money={money}
        canManage
        canReconcile={false}
        dealClosed={false}
        costSource={{ kind: "PENDING" }}
        t={tAr}
        onAdd={async () => {}}
        onAbandonAdd={() => {}}
        onRecordActual={(async () => {}) as never}
        onVoid={async () => {}}
      />
    );
    expect(salesAr.HandoverCostCurrencyDiffers).not.toBe(salesEn.HandoverCostCurrencyDiffers);
    expect(screen.getByTestId("deal-handover-cost-fee1-currency").textContent).toBe(salesAr.HandoverCostCurrencyDiffers);
    expect(within(row()).getByRole("button", { name: salesAr.RemoveHandoverCost })).toBeTruthy();
  });
});

/**
 * SCRUM-834 (Codex P2): re-recording or removing a RECONCILED line undoes
 * somebody's check, and the backend asks for confirm:finance_disbursement for it
 * (`assertMayUndoReconciliation`). The default SALES role can manage costs
 * without holding it, so the screen must not offer that role a button the server
 * refuses -- it says who can instead.
 */
describe.each(["LICENSING", ...NON_HANDOVER_TYPES])("a RECONCILED %s line and a manager who cannot confirm finance disbursements", (feeType) => {
  const SALES = { canManage: true, canReconcile: false } as const;
  const reconciled = (overrides: Partial<HandoverCostLine> = {}) => lineOf(feeType, { status: "RECONCILED", ...overrides });
  const handoff = () => screen.queryByTestId("deal-handover-cost-fee1-reconciled-handoff");

  test("is offered neither Record actual nor Remove, and is told who can", () => {
    renderPanel(costs([reconciled()]), { onReconcile: async () => {} }, SALES);
    expect(maybeButton(salesEn.RecordActualCost)).toBeNull();
    expect(maybeButton(salesEn.RemoveHandoverCost)).toBeNull();
    expect(maybeButton(salesEn.ReconcileDealFee)).toBeNull();
    expect(handoff()?.textContent).toBe(salesEn.ReconciledNeedsAccountant);
    // Nothing is "waiting to be reconciled": it already is.
    expect(screen.queryByTestId("deal-handover-reconcile-fee1-waiting")).toBeNull();
  });

  test("the holder of the permission keeps the audited correction and removal, with no hand-off note", () => {
    renderPanel(costs([reconciled()]), { onReconcile: async () => {} }, { canManage: true, canReconcile: true });
    expect(button(salesEn.RecordActualCost)).toBeTruthy();
    expect(button(salesEn.RemoveHandoverCost)).toBeTruthy();
    expect(handoff()).toBeNull();
  });

  test("an UNRECONCILED line is still corrected and removed by the same manager, who is told an accountant must reconcile", () => {
    renderPanel(costs([lineOf(feeType)]), { onReconcile: async () => {} }, SALES);
    expect(button(salesEn.RecordActualCost)).toBeTruthy();
    expect(button(salesEn.RemoveHandoverCost)).toBeTruthy();
    expect(handoff()).toBeNull();
    expect(screen.getByTestId("deal-handover-reconcile-fee1-waiting")).toBeTruthy();
  });

  test("a reconciled line in another currency cannot be removed by that manager either", () => {
    renderPanel(costs([reconciled({ currency: "USD" })]), { onReconcile: async () => {} }, SALES);
    expect(screen.getByTestId("deal-handover-cost-fee1-currency")).toBeTruthy();
    expect(maybeButton(salesEn.RemoveHandoverCost)).toBeNull();
    expect(handoff()?.textContent).toBe(salesEn.ReconciledNeedsAccountant);
  });

  test("an unreconciled line in another currency is still removable by that manager (the legacy clean-up route)", () => {
    renderPanel(costs([lineOf(feeType, { currency: "USD" })]), { onReconcile: async () => {} }, SALES);
    expect(button(salesEn.RemoveHandoverCost)).toBeTruthy();
    expect(handoff()).toBeNull();
  });

  test("a configured (checklist) row gets the same rule", () => {
    const checklist = (status: string) =>
      costs([reconciled({ status })], {
        expected: {
          source: "COMPANY_RULE_SNAPSHOT",
          currency: "JOD",
          rows: [
            {
              templateIndex: 0,
              feeType,
              description: "Configured",
              expectedAmountMinor: 100_000,
              expectedAmountReason: null,
              duplicateIdentity: false,
              actual: { feeId: "fee1", actualAmountMinor: 120_000, currency: "JOD", status },
            },
          ],
          expectedTotalMinor: 100_000,
          expectedTotalReason: null,
          actualTotalMinor: 120_000,
          differenceMinor: -20_000,
          unplannedLineIds: [],
        } as never,
      });
    const view = renderPanel(checklist("RECONCILED"), { onReconcile: async () => {} }, SALES);
    expect(screen.queryByRole("button", { name: salesEn.RecordActualCost })).toBeNull();
    expect(screen.queryByRole("button", { name: salesEn.RemoveHandoverCost })).toBeNull();
    expect(handoff()?.textContent).toBe(salesEn.ReconciledNeedsAccountant);
    view.unmount();

    renderPanel(checklist("RECONCILED"), { onReconcile: async () => {} }, { canManage: true, canReconcile: true });
    expect(screen.getByRole("button", { name: salesEn.RecordActualCost })).toBeTruthy();
    expect(screen.getByRole("button", { name: salesEn.RemoveHandoverCost })).toBeTruthy();
  });
});

test("the hand-off to an authorized user reads in Arabic", () => {
  const tAr = (key: string) => (salesAr as Record<string, string>)[key] ?? key;
  render(
    <HandoverCostsPanel
      costs={costs([lineOf("LICENSING", { status: "RECONCILED" })])}
      loading={false}
      denomination={{ code: "JOD" }}
      scaleOf={() => 3}
      money={money}
      canManage
      canReconcile={false}
      dealClosed={false}
      costSource={{ kind: "PENDING" }}
      t={tAr}
      onAdd={async () => {}}
      onAbandonAdd={() => {}}
      onRecordActual={(async () => {}) as never}
      onVoid={async () => {}}
    />
  );
  expect(salesAr.ReconciledNeedsAccountant).not.toBe(salesEn.ReconciledNeedsAccountant);
  expect(screen.getByTestId("deal-handover-cost-fee1-reconciled-handoff").textContent).toBe(salesAr.ReconciledNeedsAccountant);
});

/**
 * SCRUM-834: the variance is stated, not left for the reader to subtract, and the
 * figures a checker is vouching for stay on screen while the note is typed.
 */
describe("the variance of a cost line, stated in words with its amount", () => {
  const varianceLine = (overrides: Partial<HandoverCostLine> = {}) =>
    lineOf("FINANCE_COMPANY_FEE", { estimatedAmountMinor: 1_250_000, actualAmountMinor: 1_500_000, ...overrides });

  test("an actual above the estimate says by how much, on the row", () => {
    renderPanel(costs([varianceLine()]), { onReconcile: async () => {} });
    const variance = screen.getByTestId("deal-handover-cost-fee1-variance");
    expect(variance.textContent).toContain(salesEn.ReconcileVarianceOver);
    expect(variance.textContent).toContain("250 JOD");
  });

  test("below, equal and absent estimates", () => {
    const below = renderPanel(costs([varianceLine({ actualAmountMinor: 1_000_000 })]), {});
    expect(screen.getByTestId("deal-handover-cost-fee1-variance").textContent).toContain(salesEn.ReconcileVarianceUnder);
    expect(screen.getByTestId("deal-handover-cost-fee1-variance").textContent).toContain("250 JOD");
    below.unmount();

    const equal = renderPanel(costs([varianceLine({ actualAmountMinor: 1_250_000 })]), {});
    expect(screen.getByTestId("deal-handover-cost-fee1-variance").textContent).toBe(salesEn.ReconcileVarianceNone);
    equal.unmount();

    const { estimatedAmountMinor: _estimate, ...noEstimate } = varianceLine();
    void _estimate;
    renderPanel(costs([noEstimate]), {});
    expect(screen.queryByTestId("deal-handover-cost-fee1-variance")).toBeNull();
  });

  test("no variance is invented without an actual or across two currencies", () => {
    const { actualAmountMinor: _actual, ...noActual } = varianceLine({ status: "ESTIMATED_ONLY" });
    void _actual;
    const first = renderPanel(costs([noActual]), {});
    expect(screen.queryByTestId("deal-handover-cost-fee1-variance")).toBeNull();
    first.unmount();
    renderPanel(costs([varianceLine({ currency: "USD" })]), {});
    expect(screen.queryByTestId("deal-handover-cost-fee1-variance")).toBeNull();
  });

  test("the reconcile form keeps the estimate, the actual and the variance on screen while the note is typed", async () => {
    const onReconcile = vi.fn(async () => {});
    renderPanel(costs([varianceLine()]), { onReconcile });
    fireEvent.click(button(salesEn.ReconcileDealFee));
    const form = screen.getByTestId("deal-handover-reconcile-fee1-form");
    expect(within(form).getByText("1,250 JOD")).toBeTruthy();
    expect(within(form).getByText("1,500 JOD")).toBeTruthy();
    expect(within(form).getByTestId("deal-handover-reconcile-fee1-variance").textContent).toContain("250 JOD");
    // The prompt says what to write when the figures differ.
    expect(within(form).getByText(salesEn.ReconcileVarianceNotesHint)).toBeTruthy();

    fireEvent.change(within(form).getByLabelText(salesEn.ReconcileNotes), { target: { value: "company letter 31 confirms 1,500" } });
    // Still on screen after typing.
    expect(within(form).getByText("1,500 JOD")).toBeTruthy();
    expect(within(form).getByTestId("deal-handover-reconcile-fee1-variance")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: salesEn.ConfirmReconcile }));
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("fee1", "company letter 31 confirms 1,500", 1_500_000, 0));
  });

  test("a line with no estimate shows its actual in the form and no variance or difference prompt", () => {
    const { estimatedAmountMinor: _estimate, ...noEstimate } = varianceLine();
    void _estimate;
    renderPanel(costs([noEstimate]), { onReconcile: async () => {} });
    fireEvent.click(button(salesEn.ReconcileDealFee));
    const form = screen.getByTestId("deal-handover-reconcile-fee1-form");
    expect(within(form).getByText("1,500 JOD")).toBeTruthy();
    expect(within(form).queryByTestId("deal-handover-reconcile-fee1-variance")).toBeNull();
    expect(within(form).queryByText(salesEn.ReconcileVarianceNotesHint)).toBeNull();
  });

  test("a matching actual shows no difference prompt", () => {
    renderPanel(costs([varianceLine({ actualAmountMinor: 1_250_000 })]), { onReconcile: async () => {} });
    fireEvent.click(button(salesEn.ReconcileDealFee));
    const form = screen.getByTestId("deal-handover-reconcile-fee1-form");
    expect(within(form).getByTestId("deal-handover-reconcile-fee1-variance").textContent).toBe(salesEn.ReconcileVarianceNone);
    expect(within(form).queryByText(salesEn.ReconcileVarianceNotesHint)).toBeNull();
  });

  test("in Arabic the variance and the form's figures are the Arabic strings", () => {
    const tAr = (key: string) => (salesAr as Record<string, string>)[key] ?? key;
    render(
      <HandoverCostsPanel
        costs={costs([varianceLine()])}
        loading={false}
        denomination={{ code: "JOD" }}
        scaleOf={() => 3}
        money={money}
        canManage
        canReconcile
        dealClosed={false}
        costSource={{ kind: "PENDING" }}
        t={tAr}
        onAdd={async () => {}}
        onAbandonAdd={() => {}}
        onRecordActual={(async () => {}) as never}
        onVoid={async () => {}}
        onReconcile={async () => {}}
      />
    );
    expect(screen.getByTestId("deal-handover-cost-fee1-variance").textContent).toContain(salesAr.ReconcileVarianceOver);
    fireEvent.click(within(row()).getByRole("button", { name: salesAr.ReconcileDealFee }));
    const form = screen.getByTestId("deal-handover-reconcile-fee1-form");
    expect(within(form).getByTestId("deal-handover-reconcile-fee1-variance").textContent).toContain(salesAr.ReconcileVarianceOver);
    expect(within(form).getByText(salesAr.ReconcileVarianceNotesHint)).toBeTruthy();
  });
});

/**
 * SCRUM-834 (Codex exact-head review, P2): a configured (checklist) fee row had
 * its expected and actual figures but no stated difference, and its reconcile
 * form carried neither the figures nor the discrepancy prompt, so the person
 * writing the evidence note had no quantified gap in front of them. The
 * invariant, for this row as for every other: a variance is drawn only between
 * a readable expectation and a recorded actual in the SAME currency, and
 * nothing is invented otherwise.
 */
describe("a configured (checklist) fee row states its variance and keeps it in its reconcile form", () => {
  type RowOverrides = {
    expectedAmountMinor?: number | null;
    actual?: { feeId: string; actualAmountMinor: number | undefined; currency: string; status: string } | null;
  };
  const ACTUAL = { feeId: "fee1", actualAmountMinor: 1_500_000, currency: "JOD", status: "ACTUAL_RECORDED" };

  function configured(rowOverrides: RowOverrides = {}, lineOverrides: Partial<HandoverCostLine> = {}) {
    const expectedAmountMinor = rowOverrides.expectedAmountMinor === undefined ? 1_250_000 : rowOverrides.expectedAmountMinor;
    const actual = rowOverrides.actual === undefined ? ACTUAL : rowOverrides.actual;
    const lines = actual === null ? [] : [lineOf("LICENSING", { estimatedAmountMinor: 1_250_000, actualAmountMinor: actual.actualAmountMinor, currency: actual.currency, status: actual.status, ...lineOverrides })];
    return costs(lines, {
      expected: {
        source: "COMPANY_RULE_SNAPSHOT",
        currency: "JOD",
        rows: [
          {
            templateIndex: 0,
            feeType: "LICENSING",
            description: "Plates",
            expectedAmountMinor,
            expectedAmountReason: expectedAmountMinor === null ? "UNSAFE_AMOUNT" : null,
            duplicateIdentity: false,
            actual,
          },
        ],
        expectedTotalMinor: expectedAmountMinor,
        expectedTotalReason: null,
        actualTotalMinor: null,
        differenceMinor: null,
        unplannedLineIds: [],
      } as never,
    });
  }
  const checklistRow = () => screen.getByTestId("deal-handover-expected-0");
  const variance = () => screen.queryByTestId("deal-handover-expected-0-variance");
  const openForm = () => {
    fireEvent.click(within(checklistRow()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    return screen.getByTestId("deal-handover-expected-reconcile-0-form");
  };
  const formVariance = (form: HTMLElement) => within(form).queryByTestId("deal-handover-expected-reconcile-0-variance");

  test("an actual above the expectation says by how much, on the row", () => {
    renderPanel(configured(), { onReconcile: async () => {} });
    expect(variance()?.textContent).toContain(salesEn.ReconcileVarianceOver);
    expect(variance()?.textContent).toContain("250 JOD");
  });

  test("below and equal", () => {
    const below = renderPanel(configured({ actual: { ...ACTUAL, actualAmountMinor: 1_000_000 } }), {});
    expect(variance()?.textContent).toContain(salesEn.ReconcileVarianceUnder);
    expect(variance()?.textContent).toContain("250 JOD");
    below.unmount();
    renderPanel(configured({ actual: { ...ACTUAL, actualAmountMinor: 1_250_000 } }), {});
    expect(variance()?.textContent).toBe(salesEn.ReconcileVarianceNone);
  });

  test("an unreadable expectation draws no variance, on the row or in the form, and the form says so", () => {
    renderPanel(configured({ expectedAmountMinor: null }), { onReconcile: async () => {} });
    expect(variance()).toBeNull();
    const form = openForm();
    expect(within(form).getByText(salesEn.CostExpectedUnreadable)).toBeTruthy();
    expect(within(form).getByText("1,500 JOD")).toBeTruthy();
    expect(formVariance(form)).toBeNull();
    expect(within(form).queryByText(salesEn.ReconcileVarianceNotesHint)).toBeNull();
  });

  test("a position with no recorded actual, or an actual with no amount, draws no variance", () => {
    const none = renderPanel(configured({ actual: null }), { onReconcile: async () => {} });
    expect(variance()).toBeNull();
    none.unmount();
    renderPanel(configured({ actual: { ...ACTUAL, actualAmountMinor: undefined, status: "ESTIMATED_ONLY" } }), { onReconcile: async () => {} });
    expect(variance()).toBeNull();
  });

  test("an actual recorded in another currency draws no variance, and cannot be reconciled from here", () => {
    renderPanel(configured({ actual: { ...ACTUAL, currency: "USD" } }), { onReconcile: async () => {} });
    expect(variance()).toBeNull();
    expect(within(checklistRow()).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
    expect(screen.getByTestId("deal-handover-cost-fee1-currency")).toBeTruthy();
  });

  test("the reconcile form keeps the expected, the actual, the quantified variance and the discrepancy prompt while the note is typed", async () => {
    const onReconcile = vi.fn(async () => {});
    renderPanel(configured(), { onReconcile });
    const form = openForm();
    expect(within(form).getByText("1,250 JOD")).toBeTruthy();
    expect(within(form).getByText("1,500 JOD")).toBeTruthy();
    expect(formVariance(form)?.textContent).toContain(salesEn.ReconcileVarianceOver);
    expect(formVariance(form)?.textContent).toContain("250 JOD");
    expect(within(form).getByText(salesEn.ReconcileVarianceNotesHint)).toBeTruthy();

    fireEvent.change(within(form).getByLabelText(salesEn.ReconcileNotes), { target: { value: "company letter 31 confirms 1,500" } });
    // Still on screen after typing.
    expect(within(form).getByText("1,500 JOD")).toBeTruthy();
    expect(formVariance(form)?.textContent).toContain("250 JOD");
    expect(within(form).getByText(salesEn.ReconcileVarianceNotesHint)).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: salesEn.ConfirmReconcile }));
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("fee1", "company letter 31 confirms 1,500", 1_500_000, 0));
  });

  test("a matching actual shows 'matches' and no discrepancy prompt in the form", () => {
    renderPanel(configured({ actual: { ...ACTUAL, actualAmountMinor: 1_250_000 } }), { onReconcile: async () => {} });
    const form = openForm();
    expect(formVariance(form)?.textContent).toBe(salesEn.ReconcileVarianceNone);
    expect(within(form).queryByText(salesEn.ReconcileVarianceNotesHint)).toBeNull();
  });

  test("the permission guards are unchanged: an accountant can open it, SALES is told who can, a viewer sees the variance and no action", () => {
    const accountant = renderPanel(configured(), { onReconcile: async () => {} }, { canManage: false, canReconcile: true });
    expect(openForm()).toBeTruthy();
    accountant.unmount();

    const sales = renderPanel(configured(), { onReconcile: async () => {} }, { canManage: true, canReconcile: false });
    expect(within(checklistRow()).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
    expect(screen.getByTestId("deal-handover-reconcile-fee1-waiting")).toBeTruthy();
    expect(variance()?.textContent).toContain("250 JOD");
    sales.unmount();

    renderPanel(configured(), { onReconcile: async () => {} }, { canManage: false, canReconcile: false });
    expect(within(checklistRow()).queryByRole("button")).toBeNull();
    expect(variance()?.textContent).toContain("250 JOD");
  });

  test("in Arabic the row's variance and the form's figures, variance and prompt are the Arabic strings", () => {
    const tAr = (key: string) => (salesAr as Record<string, string>)[key] ?? key;
    render(
      <HandoverCostsPanel
        costs={configured()}
        loading={false}
        denomination={{ code: "JOD" }}
        scaleOf={() => 3}
        money={money}
        canManage
        canReconcile
        dealClosed={false}
        costSource={{ kind: "PENDING" }}
        t={tAr}
        onAdd={async () => {}}
        onAbandonAdd={() => {}}
        onRecordActual={(async () => {}) as never}
        onVoid={async () => {}}
        onReconcile={async () => {}}
      />
    );
    expect(variance()?.textContent).toContain(salesAr.ReconcileVarianceOver);
    fireEvent.click(within(checklistRow()).getByRole("button", { name: salesAr.ReconcileDealFee }));
    const form = screen.getByTestId("deal-handover-expected-reconcile-0-form");
    expect(formVariance(form)?.textContent).toContain(salesAr.ReconcileVarianceOver);
    expect(within(form).getByText(salesAr.ReconcileVarianceNotesHint)).toBeTruthy();
  });
});
