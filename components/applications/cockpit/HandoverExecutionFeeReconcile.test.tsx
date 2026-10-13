/**
 * SCRUM-834: the finance company's execution fee, once its actual is recorded
 * and linked, still has to be reconciled before the deal can close — but the
 * dedicated execution-fee section offered no way to do it (the pilot deal:
 * expected 1,250 JOD, actual 1,500 JOD, "unreconciled" in closing readiness).
 *
 * Production-shaped: a FINANCE_COMPANY_FEE line, bound by `boundFeeId`, in the
 * payload `listDealCosts` serves. The bound line is acted on in its own section
 * and nowhere else; any OTHER live line, an unbound finance-company fee
 * included, is reconciled from the list (`HandoverCostRowRoutes.test.tsx`).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import {
  HandoverCostAttemptError,
  HandoverCostsPanel,
  type DirectHandoverPayment,
  type HandoverCostLine,
  type HandoverCostsData,
  type HandoverExecutionFee,
} from "./HandoverCostsPanel";

const t = (key: string) => (salesEn as Record<string, string>)[key] ?? key;
const money = (minor: number, currency: string) => `${(minor / 1000).toLocaleString("en-US")} ${currency}`;

const boundLine: HandoverCostLine = {
  _id: "fee1",
  feeType: "FINANCE_COMPANY_FEE",
  currency: "JOD",
  description: "Execution fee",
  estimatedAmountMinor: 1_250_000,
  actualAmountMinor: 1_500_000,
  paidBy: "DEALER",
  paidTo: "FINANCE_COMPANY",
  status: "ACTUAL_RECORDED",
};

const bound: HandoverExecutionFee = {
  expectedMinor: 1_250_000,
  boundFeeId: "fee1",
  unrecorded: false,
  withheld: false,
  eligibleFeeIds: [],
};

function costs(lines: HandoverCostLine[], executionFee: HandoverExecutionFee | null = bound): HandoverCostsData {
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
    executionFee,
  };
}

type Handlers = Partial<{
  onReconcile: (feeId: string, notes: string, expectedActualAmountMinor: number, expectedActualEvidenceRevision: number) => Promise<void>;
  onRecordActual: (feeId: string, values: unknown) => Promise<void>;
  onVoid: (feeId: string, reason: string) => Promise<void>;
  onRecordDirectPayment: (feeId: string, values: DirectHandoverPayment) => Promise<void>;
}>;

function panel(data: HandoverCostsData, handlers: Handlers, flags: { canManage?: boolean; canReconcile?: boolean; dealClosed?: boolean }) {
  return (
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
      canRecordDirectPayment={handlers.onRecordDirectPayment !== undefined}
      onRecordDirectPayment={handlers.onRecordDirectPayment}
    />
  );
}

function renderPanel(
  data: HandoverCostsData,
  handlers: Handlers = {},
  flags: { canManage?: boolean; canReconcile?: boolean; dealClosed?: boolean } = {}
) {
  const view = render(panel(data, handlers, flags));
  return {
    ...view,
    update: (next: HandoverCostsData, nextFlags: typeof flags = flags, nextHandlers: Handlers = handlers) =>
      view.rerender(panel(next, nextHandlers, nextFlags)),
  };
}

const section = () => screen.getByTestId("deal-execution-fee");

afterEach(cleanup);

describe("the bound execution fee can be reconciled from its own section", () => {
  test("shows expected, actual and the variance, and offers Reconcile", () => {
    renderPanel(costs([boundLine]), { onReconcile: async () => {} });
    const row = section();
    expect(within(row).getByText("1,250 JOD")).toBeTruthy();
    expect(within(row).getByText("1,500 JOD")).toBeTruthy();
    const variance = within(row).getByTestId("deal-execution-fee-variance");
    expect(variance.textContent).toContain(salesEn.ReconcileVarianceOver);
    expect(variance.textContent).toContain("250 JOD");
    expect(within(row).getByRole("button", { name: salesEn.ReconcileDealFee })).toBeTruthy();
  });

  test("the form keeps expected, actual and variance visible while the evidence note is typed, then pins the displayed actual", async () => {
    const onReconcile = vi.fn(async () => {});
    renderPanel(costs([boundLine]), { onReconcile });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));

    const form = screen.getByTestId("deal-execution-fee-reconcile-form");
    expect(within(form).getByText("1,250 JOD")).toBeTruthy();
    expect(within(form).getByText("1,500 JOD")).toBeTruthy();
    expect(within(form).getByTestId("reconcile-variance").textContent).toContain("250 JOD");
    // The variance is not a reason to wave the check through: the prompt says what to write.
    expect(within(form).getByText(salesEn.ReconcileVarianceNotesHint)).toBeTruthy();

    const confirm = within(form).getByRole("button", { name: salesEn.ConfirmReconcile }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const notes = within(form).getByLabelText(salesEn.ReconcileNotes);
    fireEvent.change(notes, { target: { value: "Company letter 77 confirms 1,500." } });
    // Still on screen after typing.
    expect(within(form).getByText("1,500 JOD")).toBeTruthy();
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("fee1", "Company letter 77 confirms 1,500.", 1_500_000, 0));
    await waitFor(() => expect(screen.queryByTestId("deal-execution-fee-reconcile-form")).toBeNull());
  });

  test("a refusal stays in the form with the server's reason, and the evidence note is kept", async () => {
    const onReconcile = vi.fn(async () => {
      throw new Error("This cost has already been reconciled.");
    });
    renderPanel(costs([boundLine]), { onReconcile });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    const form = screen.getByTestId("deal-execution-fee-reconcile-form");
    fireEvent.change(within(form).getByLabelText(salesEn.ReconcileNotes), { target: { value: "checked" } });
    fireEvent.click(within(form).getByRole("button", { name: salesEn.ConfirmReconcile }));

    expect((await within(form).findByRole("alert")).textContent).toContain("already been reconciled");
    expect((within(form).getByLabelText(salesEn.ReconcileNotes) as HTMLInputElement).value).toBe("checked");
    expect((within(form).getByRole("button", { name: salesEn.ConfirmReconcile }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("the submit is disabled while it is in flight", async () => {
    let release: () => void = () => {};
    const onReconcile = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    renderPanel(costs([boundLine]), { onReconcile });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    const form = screen.getByTestId("deal-execution-fee-reconcile-form");
    fireEvent.change(within(form).getByLabelText(salesEn.ReconcileNotes), { target: { value: "checked" } });
    const confirm = within(form).getByRole("button", { name: salesEn.ConfirmReconcile }) as HTMLButtonElement;
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(onReconcile).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(screen.queryByTestId("deal-execution-fee-reconcile-form")).toBeNull());
  });

  test("if the actual is re-recorded while the form is open, the check is not submitted against the new number", async () => {
    const onReconcile = vi.fn(async () => {});
    const view = renderPanel(costs([boundLine]), { onReconcile });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    const form = screen.getByTestId("deal-execution-fee-reconcile-form");
    fireEvent.change(within(form).getByLabelText(salesEn.ReconcileNotes), { target: { value: "matched 1,500" } });

    view.update(costs([{ ...boundLine, actualAmountMinor: 1_750_000 }]));

    const alert = await within(screen.getByTestId("deal-execution-fee-reconcile-form")).findByRole("alert");
    expect(alert.textContent).toContain(salesEn.ReconcileAmountChanged);
    expect(alert.textContent).toContain("1,750 JOD");
    const confirm = screen.getByRole("button", { name: salesEn.ConfirmReconcile }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onReconcile).not.toHaveBeenCalled();
  });

  test("the form pins the evidence revision it opened on, not just the amount", async () => {
    const onReconcile = vi.fn(async () => {});
    renderPanel(costs([{ ...boundLine, actualEvidenceRevision: 3 }]), { onReconcile });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    const form = screen.getByTestId("deal-execution-fee-reconcile-form");
    fireEvent.change(within(form).getByLabelText(salesEn.ReconcileNotes), { target: { value: "receipt 77" } });
    fireEvent.click(within(form).getByRole("button", { name: salesEn.ConfirmReconcile }));
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("fee1", "receipt 77", 1_500_000, 3));
  });

  test("a SAME-AMOUNT re-record while the form is open (new receipt or attachments) blocks the stale check; a fresh form pins the new evidence", async () => {
    const onReconcile = vi.fn(async () => {});
    const view = renderPanel(costs([{ ...boundLine, actualEvidenceRevision: 1 }]), { onReconcile });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    fireEvent.change(within(screen.getByTestId("deal-execution-fee-reconcile-form")).getByLabelText(salesEn.ReconcileNotes), {
      target: { value: "matched receipt 77" },
    });

    // Amount stays 1,500: only the evidence is replaced.
    view.update(costs([{ ...boundLine, actualEvidenceRevision: 2, receiptReference: "REC-2" }]));

    const form = screen.getByTestId("deal-execution-fee-reconcile-form");
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain(salesEn.ReconcileEvidenceChanged);
    expect(alert.textContent).not.toContain(salesEn.ReconcileAmountChanged);
    const confirm = within(form).getByRole("button", { name: salesEn.ConfirmReconcile }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.submit(form);
    expect(onReconcile).not.toHaveBeenCalled();

    // Retry with a fresh form: it pins the new revision.
    fireEvent.click(within(form).getByRole("button", { name: t("Cancel") }));
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    const fresh = screen.getByTestId("deal-execution-fee-reconcile-form");
    fireEvent.change(within(fresh).getByLabelText(salesEn.ReconcileNotes), { target: { value: "matched REC-2" } });
    fireEvent.click(within(fresh).getByRole("button", { name: salesEn.ConfirmReconcile }));
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("fee1", "matched REC-2", 1_500_000, 2));
  });

  test("the generic list form is pinned the same way (a handover type's own Reconcile)", async () => {
    const onReconcile = vi.fn(async () => {});
    const stamps: HandoverCostLine = {
      _id: "fee9", feeType: "STAMPS", currency: "JOD", description: "Stamps", estimatedAmountMinor: 5_000,
      actualAmountMinor: 6_000, paidBy: "DEALER", paidTo: "GOVERNMENT", status: "ACTUAL_RECORDED", actualEvidenceRevision: 1,
    };
    const view = renderPanel(costs([stamps], null), { onReconcile });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ReconcileDealFee }));
    fireEvent.change(screen.getByLabelText(salesEn.ReconcileNotes), { target: { value: "receipt 5" } });

    view.update(costs([{ ...stamps, actualEvidenceRevision: 2, receiptReference: "R-6" }], null));

    expect((await screen.findByRole("alert")).textContent).toContain(salesEn.ReconcileEvidenceChanged);
    expect((screen.getByRole("button", { name: salesEn.ConfirmReconcile }) as HTMLButtonElement).disabled).toBe(true);
    expect(onReconcile).not.toHaveBeenCalled();
  });

  test("an exact match shows no variance warning and needs no explanation of one", () => {
    renderPanel(costs([{ ...boundLine, actualAmountMinor: 1_250_000 }]), { onReconcile: async () => {} });
    expect(within(section()).getByTestId("deal-execution-fee-variance").textContent).toContain(salesEn.ReconcileVarianceNone);
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    expect(screen.queryByText(salesEn.ReconcileVarianceNotesHint)).toBeNull();
  });

  test("an unreadable expectation is said so and no variance is invented", () => {
    renderPanel(costs([boundLine], { ...bound, expectedMinor: null }), { onReconcile: async () => {} });
    expect(within(section()).queryByTestId("deal-execution-fee-variance")).toBeNull();
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    const form = screen.getByTestId("deal-execution-fee-reconcile-form");
    expect(within(form).getByText(salesEn.CostExpectedUnreadable)).toBeTruthy();
    expect(within(form).queryByTestId("reconcile-variance")).toBeNull();
  });
});

describe("who is offered the action, and when", () => {
  test("a manager without the confirm permission is told who can reconcile, and is not offered a button that refuses", () => {
    renderPanel(costs([boundLine]), { onReconcile: async () => {} }, { canReconcile: false });
    expect(within(section()).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
    expect(within(section()).getByTestId("deal-execution-fee-reconcile-waiting").textContent).toBe(salesEn.ReconcileNeedsAccountant);
  });

  test("an accountant who cannot edit costs can still reconcile", () => {
    renderPanel(costs([boundLine]), { onReconcile: async () => {} }, { canManage: false, canReconcile: true });
    expect(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee })).toBeTruthy();
    expect(within(section()).queryByRole("button", { name: salesEn.ExecutionFeeCorrectAmount })).toBeNull();
  });

  test("an already reconciled fee shows it, with no action", () => {
    renderPanel(costs([{ ...boundLine, status: "RECONCILED" }]), { onReconcile: async () => {} });
    const row = section();
    expect(within(row).getByText(salesEn.CostStatusReconciled)).toBeTruthy();
    expect(within(row).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
    expect(within(row).queryByTestId("deal-execution-fee-reconcile-waiting")).toBeNull();
  });

  test("a closed (frozen) deal offers no reconcile, does not claim to be waiting for an accountant, and says why at panel level", () => {
    renderPanel(costs([boundLine]), { onReconcile: async () => {} }, { dealClosed: true, canReconcile: false });
    expect(within(section()).queryByRole("button")).toBeNull();
    expect(within(section()).queryByTestId("deal-execution-fee-reconcile-waiting")).toBeNull();
    expect(screen.getByTestId("deal-handover-costs-frozen")).toBeTruthy();
  });

  test("a viewer who can neither manage nor reconcile sees no action and no waiting hint", () => {
    renderPanel(costs([boundLine]), { onReconcile: async () => {} }, { canManage: false, canReconcile: false });
    expect(within(section()).queryByRole("button")).toBeNull();
    expect(within(section()).queryByTestId("deal-execution-fee-reconcile-waiting")).toBeNull();
    expect(within(section()).queryByText(salesEn.ReconcileNeedsAccountant)).toBeNull();
  });

  test("no handler wired: no action and no dead end", () => {
    renderPanel(costs([boundLine]), {});
    expect(within(section()).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
    expect(within(section()).queryByTestId("deal-execution-fee-reconcile-waiting")).toBeNull();
  });

  test("a line recorded in another currency is not reconcilable here (its figures are not the deal's)", () => {
    renderPanel(costs([{ ...boundLine, currency: "USD" }]), { onReconcile: async () => {} });
    expect(within(section()).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
    expect(within(section()).getByTestId("deal-execution-fee-currency").textContent).toBe(salesEn.HandoverCostCurrencyDiffers);
  });

  test("a bound line with no recorded actual has nothing to reconcile", () => {
    const { actualAmountMinor: _omitted, ...withoutActual } = boundLine;
    void _omitted;
    renderPanel(costs([{ ...withoutActual, status: "ESTIMATED_ONLY" }]), { onReconcile: async () => {} });
    expect(within(section()).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
  });
});

describe("the bound line is acted on in its section; every other line is reconciled from the list", () => {
  test("a handover fee type keeps its own list action, and now pins the actual it displays", async () => {
    const onReconcile = vi.fn(async () => {});
    const stamps: HandoverCostLine = {
      _id: "fee9", feeType: "STAMPS", currency: "JOD", description: "Stamps", estimatedAmountMinor: 5_000,
      actualAmountMinor: 6_000, paidBy: "DEALER", paidTo: "GOVERNMENT", status: "ACTUAL_RECORDED",
    };
    renderPanel(costs([stamps], null), { onReconcile });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ReconcileDealFee }));
    fireEvent.change(screen.getByLabelText(salesEn.ReconcileNotes), { target: { value: "receipt 5" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ConfirmReconcile }));
    await waitFor(() => expect(onReconcile).toHaveBeenCalledWith("fee9", "receipt 5", 6_000, 0));
  });

  test("the execution-fee action never offers reconcile on the generic list copy of the same bound line", () => {
    renderPanel(costs([boundLine]), { onReconcile: async () => {} });
    // One action on the page, inside the dedicated section.
    expect(screen.getAllByRole("button", { name: salesEn.ReconcileDealFee })).toHaveLength(1);
  });
});

describe("a way to correct a wrong execution-fee actual (F3)", () => {
  test("Correct amount re-records the actual through the same server guards", async () => {
    const onRecordActual = vi.fn(async () => {});
    renderPanel(costs([boundLine]), { onReconcile: async () => {}, onRecordActual });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ExecutionFeeCorrectAmount }));
    const input = screen.getByLabelText(new RegExp(`^${salesEn.CostActual}`));
    fireEvent.change(input, { target: { value: "1250" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.SaveActualCost }));
    await waitFor(() =>
      expect(onRecordActual).toHaveBeenCalledWith("fee1", expect.objectContaining({ actualAmountMinor: 1_250_000, currency: "JOD" }))
    );
  });

  test("Remove cost voids the line with a reason", async () => {
    const onVoid = vi.fn(async () => {});
    renderPanel(costs([boundLine]), { onReconcile: async () => {}, onVoid });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.RemoveHandoverCost }));
    fireEvent.change(screen.getByLabelText(salesEn.VoidReasonLabel), { target: { value: "Entered on the wrong deal" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.ConfirmRemoveCost }));
    await waitFor(() => expect(onVoid).toHaveBeenCalledWith("fee1", "Entered on the wrong deal"));
  });

  test("a viewer who may not edit costs is offered neither", () => {
    renderPanel(costs([boundLine]), { onReconcile: async () => {} }, { canManage: false });
    expect(within(section()).queryByRole("button", { name: salesEn.ExecutionFeeCorrectAmount })).toBeNull();
    expect(within(section()).queryByRole("button", { name: salesEn.RemoveHandoverCost })).toBeNull();
  });
});

describe("one form at a time with the bound line's own direct-payment form", () => {
  // The bound finance-company line is also listed with the other costs, where its
  // payment is recorded: the section's forms and that payment form are rivals.
  const payable: HandoverCostLine = { ...boundLine, handoverPayment: "UNPAID", directPaymentEligible: true };
  const paymentForm = () => screen.queryByTestId("direct-payment-fee1-form");
  const paymentRow = () => screen.queryByTestId("deal-handover-payment-fee1");
  const sectionButtons = [
    { name: salesEn.ReconcileDealFee, open: () => screen.getByTestId("deal-execution-fee-reconcile-form") },
    { name: salesEn.ExecutionFeeCorrectAmount, open: () => screen.getByLabelText(new RegExp(`^${salesEn.CostActual}`)) },
    { name: salesEn.RemoveHandoverCost, open: () => screen.getByLabelText(salesEn.VoidReasonLabel) },
  ];
  const openPayment = () => {
    fireEvent.click(screen.getByRole("button", { name: salesEn.RecordDirectPayment }));
    fireEvent.change(screen.getByLabelText(salesEn.DirectPaymentMethodLabel), { target: { value: "CASH" } });
  };

  test.each(sectionButtons)("an idle payment form yields to the section's $name, and the two are never open together", ({ name, open }) => {
    renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
    fireEvent.click(screen.getByRole("button", { name: salesEn.RecordDirectPayment }));
    expect(paymentForm()).not.toBeNull();

    fireEvent.click(within(section()).getByRole("button", { name }));

    expect(open()).toBeTruthy();
    expect(paymentForm()).toBeNull();
    // Changing the amount reverses a direct payment: while a section form is open it is not offered at all.
    expect(paymentRow()).toBeNull();
    expect(screen.queryByRole("button", { name: salesEn.RecordDirectPayment })).toBeNull();
    expect(screen.getByTestId("deal-handover-costs").hasAttribute("data-active-task")).toBe(true);
  });

  test("closing the section's form brings the payment row back, and the panel stops reading as active", () => {
    renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    fireEvent.click(within(screen.getByTestId("deal-execution-fee-reconcile-form")).getByRole("button", { name: t("Cancel") }));
    expect(screen.queryByTestId("deal-execution-fee-reconcile-form")).toBeNull();
    expect(paymentRow()).not.toBeNull();
    expect(screen.getByTestId("deal-handover-costs").hasAttribute("data-active-task")).toBe(false);
  });

  describe("a section form that can no longer be shown does not leave the panel stuck", () => {
    const stuck = () => screen.getByTestId("deal-handover-costs").hasAttribute("data-active-task");

    test("Reconcile open, then another user reconciles the fee: the payment row returns and the panel stops reading as active", () => {
      const view = renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
      expect(paymentRow()).toBeNull();
      expect(stuck()).toBe(true);

      view.update(costs([{ ...payable, status: "RECONCILED" }]));

      expect(screen.queryByTestId("deal-execution-fee-reconcile-form")).toBeNull();
      expect(paymentRow()).not.toBeNull();
      expect(stuck()).toBe(false);
    });

    test("Reconcile open, then the fee is re-recorded in another currency: the same reset", () => {
      const view = renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));

      view.update(costs([{ ...payable, currency: "USD" }]));

      expect(paymentRow()).not.toBeNull();
      expect(stuck()).toBe(false);
    });

    test("Reconcile open, then the actual disappears: the same reset", () => {
      const view = renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));

      const { actualAmountMinor: _omitted, ...withoutActual } = payable;
      void _omitted;
      view.update(costs([{ ...withoutActual, status: "ESTIMATED_ONLY" }]));

      expect(paymentRow()).not.toBeNull();
      expect(stuck()).toBe(false);
    });

    test("Correct open, then the fee is re-recorded in another currency: the same reset", () => {
      const view = renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ExecutionFeeCorrectAmount }));
      expect(paymentRow()).toBeNull();

      view.update(costs([{ ...payable, currency: "USD" }]));

      expect(paymentRow()).not.toBeNull();
      expect(stuck()).toBe(false);
    });

    // One availability decision serves the reset, the form and the buttons: each
    // way the section can stop drawing a form must also end the marker.
    test("Reconcile open, then its handler is no longer wired: the form, the marker and the hidden payment row recover", () => {
      const payments = { onRecordDirectPayment: async () => {} };
      const view = renderPanel(costs([payable]), { onReconcile: async () => {}, ...payments });
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
      expect(paymentRow()).toBeNull();
      expect(stuck()).toBe(true);

      view.update(costs([payable]), undefined, payments);

      expect(screen.queryByTestId("deal-execution-fee-reconcile-form")).toBeNull();
      expect(within(section()).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
      expect(paymentRow()).not.toBeNull();
      expect(stuck()).toBe(false);
    });

    test("Remove open, then the fee is re-recorded in another currency: the form and the marker end with its button", () => {
      const view = renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.RemoveHandoverCost }));
      expect(screen.getByLabelText(salesEn.VoidReasonLabel)).toBeTruthy();
      expect(paymentRow()).toBeNull();

      view.update(costs([{ ...payable, currency: "USD" }]));

      expect(screen.queryByLabelText(salesEn.VoidReasonLabel)).toBeNull();
      expect(within(section()).queryByRole("button", { name: salesEn.RemoveHandoverCost })).toBeNull();
      expect(paymentRow()).not.toBeNull();
      expect(stuck()).toBe(false);
    });

    test("Correct open, then the actual disappears: the form and the marker end with its button", () => {
      const view = renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ExecutionFeeCorrectAmount }));
      expect(paymentRow()).toBeNull();

      const { actualAmountMinor: _omitted, ...withoutActual } = payable;
      void _omitted;
      view.update(costs([{ ...withoutActual, status: "ESTIMATED_ONLY" }]));

      expect(screen.queryByLabelText(new RegExp(`^${salesEn.CostActual}`))).toBeNull();
      expect(within(section()).queryByRole("button", { name: salesEn.ExecutionFeeCorrectAmount })).toBeNull();
      expect(paymentRow()).not.toBeNull();
      expect(stuck()).toBe(false);
    });

    test("control: Remove open, then the actual disappears: Remove needs no actual, so its form stays", () => {
      const view = renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.RemoveHandoverCost }));

      const { actualAmountMinor: _omitted, ...withoutActual } = payable;
      void _omitted;
      view.update(costs([{ ...withoutActual, status: "ESTIMATED_ONLY" }]));

      expect(screen.getByLabelText(salesEn.VoidReasonLabel)).toBeTruthy();
      expect(paymentRow()).toBeNull();
      expect(stuck()).toBe(true);
    });

    test("Reconcile open, then the bound line leaves the payload: the same reset", () => {
      const view = renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));

      view.update(costs([], { ...bound, boundFeeId: null, unrecorded: true }));

      expect(stuck()).toBe(false);
    });

    test("control: a re-recorded amount in the same currency keeps the form open (it alerts instead)", () => {
      const view = renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment: async () => {} });
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));

      view.update(costs([{ ...payable, actualAmountMinor: 1_750_000 }]));

      expect(screen.getByTestId("deal-execution-fee-reconcile-form")).toBeTruthy();
      expect(paymentRow()).toBeNull();
      expect(stuck()).toBe(true);
    });
  });

  describe("a section form ends when the right to use it ends", () => {
    const stuck = () => screen.getByTestId("deal-handover-costs").hasAttribute("data-active-task");
    const handlers = { onReconcile: async () => {}, onRecordDirectPayment: async () => {} };
    const open = (name: string) => fireEvent.click(within(section()).getByRole("button", { name }));
    const formPresent = (name: string) =>
      name === salesEn.ReconcileDealFee
        ? screen.queryByTestId("deal-execution-fee-reconcile-form") !== null
        : name === salesEn.ExecutionFeeCorrectAmount
          ? screen.queryByLabelText(new RegExp(`^${salesEn.CostActual}`)) !== null
          : screen.queryByLabelText(salesEn.VoidReasonLabel) !== null;

    test("Reconcile open, then the permission is revoked: the form, the active marker and the hidden payment row all recover", () => {
      const view = renderPanel(costs([payable]), handlers);
      open(salesEn.ReconcileDealFee);
      expect(paymentRow()).toBeNull();
      expect(stuck()).toBe(true);

      view.update(costs([payable]), { canReconcile: false });

      expect(formPresent(salesEn.ReconcileDealFee)).toBe(false);
      expect(paymentRow()).not.toBeNull();
      expect(stuck()).toBe(false);
    });

    test.each(sectionButtons)("$name open, then the deal closes: the form is gone and the panel stops reading as active", ({ name }) => {
      const view = renderPanel(costs([payable]), handlers);
      open(name);
      expect(formPresent(name)).toBe(true);
      expect(stuck()).toBe(true);

      view.update(costs([payable]), { dealClosed: true });

      expect(formPresent(name)).toBe(false);
      expect(stuck()).toBe(false);
    });

    test.each(sectionButtons.filter(({ name }) => name !== salesEn.ReconcileDealFee))(
      "$name open, then the right to edit costs is revoked: the form, the active marker and the hidden payment row all recover",
      ({ name }) => {
        const view = renderPanel(costs([payable]), handlers);
        open(name);
        expect(paymentRow()).toBeNull();

        view.update(costs([payable]), { canManage: false });

        expect(formPresent(name)).toBe(false);
        expect(paymentRow()).not.toBeNull();
        expect(stuck()).toBe(false);
      }
    );

    test("control: losing the right to edit costs does not close Reconcile, which rests on its own permission", () => {
      const view = renderPanel(costs([payable]), handlers);
      open(salesEn.ReconcileDealFee);

      view.update(costs([payable]), { canManage: false });

      expect(formPresent(salesEn.ReconcileDealFee)).toBe(true);
      expect(paymentRow()).toBeNull();
      expect(stuck()).toBe(true);
    });
  });

  describe("a section form belongs to the fee row it was opened on", () => {
    const stuck = () => screen.getByTestId("deal-handover-costs").hasAttribute("data-active-task");
    const rowA: HandoverCostLine = { ...boundLine, _id: "fee1", handoverPayment: "UNPAID", directPaymentEligible: true };
    // Same type, currency and actual as A: only the row id tells them apart.
    const rowB: HandoverCostLine = { ...rowA, _id: "fee2" };
    const boundTo = (feeId: string) => costs([rowA, rowB], { ...bound, boundFeeId: feeId });
    const handlers = { onReconcile: vi.fn(async () => {}), onRecordActual: vi.fn(async () => {}), onVoid: vi.fn(async () => {}), onRecordDirectPayment: async () => {} };
    afterEach(() => vi.clearAllMocks());
    const cases = [
      { name: salesEn.ReconcileDealFee, field: () => screen.getByLabelText(salesEn.ReconcileNotes), confirm: salesEn.ConfirmReconcile, probe: () => screen.queryByTestId("deal-execution-fee-reconcile-form") },
      { name: salesEn.ExecutionFeeCorrectAmount, field: () => screen.getByLabelText(new RegExp(`^${salesEn.CostActual}`)), confirm: salesEn.SaveActualCost, probe: () => screen.queryByLabelText(new RegExp(`^${salesEn.CostActual}`)) },
      { name: salesEn.RemoveHandoverCost, field: () => screen.getByLabelText(salesEn.VoidReasonLabel), confirm: salesEn.ConfirmRemoveCost, probe: () => screen.queryByLabelText(salesEn.VoidReasonLabel) },
    ];

    test.each(cases)("$name open on row A, then the fee is rebound to row B with the same actual: the form is dropped, not carried to B", ({ name, field, probe }) => {
      const view = renderPanel(boundTo("fee1"), handlers);
      fireEvent.click(within(section()).getByRole("button", { name }));
      fireEvent.change(field(), { target: { value: "1500" } });
      // A's payment row is replaced by the section form while it is open.
      expect(screen.queryByTestId("deal-handover-payment-fee1")).toBeNull();
      expect(stuck()).toBe(true);

      view.update(boundTo("fee2"));

      expect(probe()).toBeNull();
      expect(screen.queryByTestId("deal-handover-payment-fee1")).not.toBeNull();
      expect(screen.queryByTestId("deal-handover-payment-fee2")).not.toBeNull();
      expect(stuck()).toBe(false);
      expect(handlers.onReconcile).not.toHaveBeenCalled();
      expect(handlers.onRecordActual).not.toHaveBeenCalled();
      expect(handlers.onVoid).not.toHaveBeenCalled();
    });

    test("a form reopened after the rebind is fresh and acts on row B", async () => {
      const view = renderPanel(boundTo("fee1"), handlers);
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
      fireEvent.change(screen.getByLabelText(salesEn.ReconcileNotes), { target: { value: "note for A" } });

      view.update(boundTo("fee2"));
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));

      const notes = screen.getByLabelText(salesEn.ReconcileNotes) as HTMLInputElement;
      expect(notes.value).toBe("");
      fireEvent.change(notes, { target: { value: "note for B" } });
      fireEvent.click(screen.getByRole("button", { name: salesEn.ConfirmReconcile }));
      await waitFor(() => expect(handlers.onReconcile).toHaveBeenCalledWith("fee2", "note for B", 1_500_000, 0));
      expect(handlers.onReconcile).toHaveBeenCalledTimes(1);
    });

    test("control: the same row re-served keeps its form and its typed note", () => {
      const view = renderPanel(boundTo("fee1"), handlers);
      fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
      fireEvent.change(screen.getByLabelText(salesEn.ReconcileNotes), { target: { value: "kept" } });

      view.update(boundTo("fee1"));

      expect((screen.getByLabelText(salesEn.ReconcileNotes) as HTMLInputElement).value).toBe("kept");
      expect(stuck()).toBe(true);
    });
  });

  test.each(sectionButtons)("a payment in flight keeps its form: the section's $name is disabled and does nothing", async ({ name }) => {
    const onRecordDirectPayment = vi.fn(() => new Promise<void>(() => {}));
    renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment });
    openPayment();
    fireEvent.click(screen.getByRole("button", { name: salesEn.SaveDirectPayment }));
    await waitFor(() => expect(onRecordDirectPayment).toHaveBeenCalledTimes(1));

    const button = within(section()).getByRole("button", { name }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(paymentForm()).not.toBeNull();
    expect(screen.queryByTestId("deal-execution-fee-reconcile-form")).toBeNull();
    expect(screen.queryByLabelText(salesEn.VoidReasonLabel)).toBeNull();
  });

  test.each(sectionButtons)("a payment whose outcome is UNKNOWN keeps its frozen form: the section's $name is disabled", async ({ name }) => {
    const onRecordDirectPayment = vi.fn(async () => {
      throw new HandoverCostAttemptError("network dropped", "UNKNOWN");
    });
    renderPanel(costs([payable]), { onReconcile: async () => {}, onRecordDirectPayment });
    openPayment();
    fireEvent.click(screen.getByRole("button", { name: salesEn.SaveDirectPayment }));
    await screen.findByText("network dropped");

    const button = within(section()).getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(paymentForm()).not.toBeNull();
    expect(screen.getByLabelText(salesEn.DirectPaymentMethodLabel)).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("deal-execution-fee-reconcile-form")).toBeNull();
  });

  test("opening the add form closes a section form, and a section form closes an open add form", () => {
    renderPanel(costs([boundLine]), { onReconcile: async () => {} });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ReconcileDealFee }));
    expect(screen.getByTestId("deal-execution-fee-reconcile-form")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: salesEn.AddHandoverCost }));
    expect(screen.getByTestId("deal-handover-cost-add")).toBeTruthy();
    expect(screen.queryByTestId("deal-execution-fee-reconcile-form")).toBeNull();

    fireEvent.click(within(section()).getByRole("button", { name: salesEn.ExecutionFeeCorrectAmount }));
    expect(screen.queryByTestId("deal-handover-cost-add")).toBeNull();
    expect(screen.getByLabelText(new RegExp(`^${salesEn.CostActual}`))).toBeTruthy();
  });
});

describe("copy", () => {
  test("every new string has an Arabic twin", () => {
    for (const key of [
      "ReconcileVarianceOver", "ReconcileVarianceUnder", "ReconcileVarianceNone",
      "ReconcileVarianceNotesHint", "ReconcileAmountChanged", "ReconcileEvidenceChanged", "ExecutionFeeCorrectAmount",
    ] as const) {
      expect((salesEn as Record<string, string>)[key]).toBeTruthy();
      expect((salesAr as Record<string, string>)[key]).toBeTruthy();
      expect((salesAr as Record<string, string>)[key]).not.toBe((salesEn as Record<string, string>)[key]);
    }
  });
});

/**
 * SCRUM-834 (Codex P2): the bound execution fee, already RECONCILED, can be
 * re-recorded or removed only by whoever may confirm finance disbursements
 * (`assertMayUndoReconciliation`). The default SALES role manages costs without
 * it: the section tells that manager who can, and offers no refused button.
 */
describe("a RECONCILED bound execution fee and a manager who cannot confirm finance disbursements", () => {
  const reconciledLine: HandoverCostLine = { ...boundLine, status: "RECONCILED" };
  const handoff = () => screen.queryByTestId("deal-execution-fee-reconciled-handoff");

  test("is offered neither Correct amount nor Remove, and is told who can", () => {
    renderPanel(costs([reconciledLine]), { onReconcile: async () => {} }, { canManage: true, canReconcile: false });
    expect(within(section()).queryByRole("button", { name: salesEn.ExecutionFeeCorrectAmount })).toBeNull();
    expect(within(section()).queryByRole("button", { name: salesEn.RemoveHandoverCost })).toBeNull();
    expect(within(section()).queryByRole("button", { name: salesEn.ReconcileDealFee })).toBeNull();
    expect(handoff()?.textContent).toBe(salesEn.ReconciledNeedsAccountant);
    expect(within(section()).queryByTestId("deal-execution-fee-reconcile-waiting")).toBeNull();
  });

  test("the holder keeps Correct amount and Remove, with no hand-off note", () => {
    renderPanel(costs([reconciledLine]), { onReconcile: async () => {} }, { canManage: true, canReconcile: true });
    expect(within(section()).getByRole("button", { name: salesEn.ExecutionFeeCorrectAmount })).toBeTruthy();
    expect(within(section()).getByRole("button", { name: salesEn.RemoveHandoverCost })).toBeTruthy();
    expect(handoff()).toBeNull();
  });

  test("an UNRECONCILED fee is still corrected and removed by that manager", () => {
    renderPanel(costs([boundLine]), { onReconcile: async () => {} }, { canManage: true, canReconcile: false });
    expect(within(section()).getByRole("button", { name: salesEn.ExecutionFeeCorrectAmount })).toBeTruthy();
    expect(within(section()).getByRole("button", { name: salesEn.RemoveHandoverCost })).toBeTruthy();
    expect(handoff()).toBeNull();
  });

  test("a form opened while the fee was unreconciled closes when it becomes reconciled and the viewer cannot undo that", async () => {
    const view = renderPanel(costs([boundLine]), { onReconcile: async () => {}, onVoid: async () => {} }, { canManage: true, canReconcile: false });
    fireEvent.click(within(section()).getByRole("button", { name: salesEn.RemoveHandoverCost }));
    expect(screen.getByLabelText(salesEn.VoidReasonLabel)).toBeTruthy();

    // Somebody else reconciles it while this manager's removal form is open.
    view.update(costs([reconciledLine]), { canManage: true, canReconcile: false });

    await waitFor(() => expect(screen.queryByLabelText(salesEn.VoidReasonLabel)).toBeNull());
    expect(handoff()?.textContent).toBe(salesEn.ReconciledNeedsAccountant);
  });
});
