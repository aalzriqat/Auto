/**
 * SCRUM-443 — a dealer-borne handover cost is either charged to the employee
 * custody that paid it, or paid directly by the dealership and recorded here.
 *
 * The screen never derives "paid": it renders the server's verdict
 * (`handoverPayment`), offers the direct-payment action only to a caller who
 * may confirm a finance disbursement, and tells everyone else who can.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import { commonEn } from "@/lib/i18n/domains/common";
import {
  HandoverCostAttemptError,
  HandoverCostsPanel,
  type DirectHandoverPayment,
  type HandoverCostLine,
  type HandoverCostsData,
} from "./HandoverCostsPanel";
import { closingReasonText } from "./DealClosingReadinessList";

const dictionary = { ...(commonEn as Record<string, string>), ...(salesEn as Record<string, string>) };
const t = (key: string) => dictionary[key] ?? key;

function line(over: Partial<HandoverCostLine> = {}): HandoverCostLine {
  return {
    _id: "fee1",
    feeType: "LICENSING",
    currency: "JOD",
    actualAmountMinor: 90_000,
    paidBy: "DEALER",
    paidTo: "GOVERNMENT",
    status: "ACTUAL_RECORDED",
    handoverPayment: "UNPAID",
    directPaymentEligible: true,
    ...over,
  };
}

function data(lines: HandoverCostLine[]): HandoverCostsData {
  return {
    lines,
    summary: { lineCount: lines.length, estimatedTotalMinor: 0, actualTotalMinor: 0, linesAwaitingActual: 0, linesAwaitingReconciliation: 0 },
    summaryUnavailable: null,
    expected: null,
  };
}

function renderPanel(
  lines: HandoverCostLine[],
  props: {
    canRecordDirectPayment?: boolean;
    onRecordDirectPayment?: (feeId: string, values: DirectHandoverPayment) => Promise<void>;
    onAbandonDirectPayment?: (feeId: string, intentId: string) => void;
    dealClosed?: boolean;
  } = {}
) {
  return render(
    <HandoverCostsPanel
      costs={data(lines)}
      loading={false}
      denomination={{ code: "JOD" }}
      scaleOf={() => 3}
      money={(minor) => `${minor / 1000} JOD`}
      canManage={true}
      dealClosed={props.dealClosed ?? false}
      costSource={{ kind: "PENDING" }}
      t={t}
      onAdd={async () => {}}
      onAbandonAdd={() => {}}
      onRecordActual={async () => {}}
      onVoid={async () => {}}
      canRecordDirectPayment={props.canRecordDirectPayment}
      onRecordDirectPayment={props.onRecordDirectPayment}
      onAbandonDirectPayment={props.onAbandonDirectPayment}
    />
  );
}

afterEach(cleanup);

describe("the direct-payment action", () => {
  test("a caller who may confirm disbursements records the payment with a required method", async () => {
    const onRecord = vi.fn(async () => {});
    renderPanel([line()], { canRecordDirectPayment: true, onRecordDirectPayment: onRecord });

    expect(screen.getByTestId("deal-handover-payment-fee1").getAttribute("data-state")).toBe("UNPAID");
    fireEvent.click(screen.getByRole("button", { name: salesEn.RecordDirectPayment }));

    // No default method: it decides which account the money left.
    const save = screen.getByRole("button", { name: salesEn.SaveDirectPayment });
    expect(save).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText(salesEn.DirectPaymentMethodLabel), { target: { value: "BANK_TRANSFER" } });
    fireEvent.change(screen.getByLabelText(salesEn.ReceiptReferenceLabel), { target: { value: "TRX-9" } });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);

    await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1));
    const [feeId, values] = onRecord.mock.calls[0] as unknown as [string, DirectHandoverPayment];
    expect(feeId).toBe("fee1");
    expect(values.method).toBe("BANK_TRANSFER");
    expect(values.reference).toBe("TRX-9");
    expect(values.intentId).toEqual(expect.any(String));
    expect(Number.isFinite(values.paidAt)).toBe(true);
    // Closed on success.
    await waitFor(() => expect(screen.queryByTestId("direct-payment-fee1-form")).toBeNull());
  });

  test("every method offered is one the server accepts, each labelled", () => {
    renderPanel([line()], { canRecordDirectPayment: true, onRecordDirectPayment: async () => {} });
    fireEvent.click(screen.getByRole("button", { name: salesEn.RecordDirectPayment }));
    const select = screen.getByLabelText(salesEn.DirectPaymentMethodLabel) as HTMLSelectElement;
    const offered = Array.from(select.options).map((option) => option.value).filter(Boolean).sort();
    expect(offered).toEqual(["BANK_TRANSFER", "CARD", "CASH", "CHEQUE"]);
    expect(Array.from(select.options).map((o) => o.textContent)).toContain(commonEn.PaymentMethod_BANK_TRANSFER);
  });

  test("a lost response freezes the fields and the retry replays the SAME identity", async () => {
    const onRecord = vi
      .fn<(feeId: string, values: DirectHandoverPayment) => Promise<void>>()
      .mockRejectedValueOnce(new HandoverCostAttemptError("network dropped", "UNKNOWN"))
      .mockResolvedValueOnce(undefined);
    const onAbandon = vi.fn();
    renderPanel([line()], { canRecordDirectPayment: true, onRecordDirectPayment: onRecord, onAbandonDirectPayment: onAbandon });
    fireEvent.click(screen.getByRole("button", { name: salesEn.RecordDirectPayment }));
    fireEvent.change(screen.getByLabelText(salesEn.DirectPaymentMethodLabel), { target: { value: "CASH" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.SaveDirectPayment }));

    await screen.findByText("network dropped");
    expect(screen.getByLabelText(salesEn.DirectPaymentMethodLabel)).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: salesEn.RetryHandoverCost }));

    await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(2));
    expect(onRecord.mock.calls[1][1]).toEqual(onRecord.mock.calls[0][1]);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  test("a refusal is the server's answer: nothing committed, the next attempt is a new identity", async () => {
    const onRecord = vi
      .fn<(feeId: string, values: DirectHandoverPayment) => Promise<void>>()
      .mockRejectedValueOnce(new HandoverCostAttemptError("Choose another period.", "REFUSED"))
      .mockResolvedValueOnce(undefined);
    renderPanel([line()], { canRecordDirectPayment: true, onRecordDirectPayment: onRecord });
    fireEvent.click(screen.getByRole("button", { name: salesEn.RecordDirectPayment }));
    fireEvent.change(screen.getByLabelText(salesEn.DirectPaymentMethodLabel), { target: { value: "CARD" } });
    fireEvent.click(screen.getByRole("button", { name: salesEn.SaveDirectPayment }));
    await screen.findByText("Choose another period.");
    // Still editable.
    expect(screen.getByLabelText(salesEn.DirectPaymentMethodLabel)).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: salesEn.SaveDirectPayment }));
    await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(2));
    expect(onRecord.mock.calls[1][1].intentId).not.toBe(onRecord.mock.calls[0][1].intentId);
  });
});

describe("who is offered the action, and what everyone else is told", () => {
  test("a caller without disbursement authority is told who can, and sees no button", () => {
    renderPanel([line()], { canRecordDirectPayment: false, onRecordDirectPayment: async () => {} });
    expect(screen.queryByRole("button", { name: salesEn.RecordDirectPayment })).toBeNull();
    expect(screen.getByTestId("deal-handover-payment-fee1-waiting").textContent).toBe(salesEn.DirectPaymentWaiting);
  });

  test("an employee-paid line points at custody, never at a direct payment", () => {
    renderPanel([line({ paidBy: "EMPLOYEE", directPaymentEligible: false })], {
      canRecordDirectPayment: true,
      onRecordDirectPayment: async () => {},
    });
    expect(screen.queryByRole("button", { name: salesEn.RecordDirectPayment })).toBeNull();
    expect(screen.getByTestId("deal-handover-payment-fee1-custody").textContent).toBe(salesEn.HandoverPaymentNeedsCustody);
  });

  test("a line in another currency than the deal is not offered a payment", () => {
    renderPanel([line({ currency: "USD" })], { canRecordDirectPayment: true, onRecordDirectPayment: async () => {} });
    expect(screen.queryByRole("button", { name: salesEn.RecordDirectPayment })).toBeNull();
  });

  test("a closed deal offers nothing to record", () => {
    renderPanel([line()], { canRecordDirectPayment: true, onRecordDirectPayment: async () => {}, dealClosed: true });
    expect(screen.queryByRole("button", { name: salesEn.RecordDirectPayment })).toBeNull();
  });
});

describe("each state of the server's verdict is shown as it is", () => {
  test("paid from custody and paid directly are marked, with no action", () => {
    renderPanel(
      [
        line({ _id: "a", handoverPayment: "PAID_CUSTODY" }),
        line({
          _id: "b",
          handoverPayment: "PAID_DIRECT",
          directPayment: { method: "CHEQUE", amountMinor: 90_000, paidAt: Date.UTC(2026, 8, 20), reference: "CHQ-1" },
        }),
      ],
      { canRecordDirectPayment: true, onRecordDirectPayment: async () => {} }
    );
    expect(screen.getByTestId("deal-handover-payment-a").textContent).toBe(salesEn.HandoverPaymentPaidCustody);
    const direct = screen.getByTestId("deal-handover-payment-b").textContent ?? "";
    expect(direct).toContain(salesEn.HandoverPaymentPaidDirect);
    expect(direct).toContain(commonEn.PaymentMethod_CHEQUE);
    expect(direct).toContain("2026-09-20");
    expect(direct).toContain("CHQ-1");
    expect(screen.queryByRole("button", { name: salesEn.RecordDirectPayment })).toBeNull();
  });

  test("a line with no actual is told to record its amount first; a zero actual shows no payment row", () => {
    renderPanel(
      [
        line({ _id: "n", actualAmountMinor: undefined, handoverPayment: "NO_ACTUAL", directPaymentEligible: false }),
        line({ _id: "z", actualAmountMinor: 0, handoverPayment: "ZERO_ACTUAL", directPaymentEligible: false }),
      ],
      { canRecordDirectPayment: true, onRecordDirectPayment: async () => {} }
    );
    expect(screen.getByTestId("deal-handover-payment-n").textContent).toBe(salesEn.HandoverPaymentNoActual);
    expect(screen.queryByTestId("deal-handover-payment-z")).toBeNull();
  });

  test("a payload that predates the payment state renders no payment row at all", () => {
    renderPanel([line({ handoverPayment: undefined, directPaymentEligible: undefined })], { canRecordDirectPayment: true });
    expect(screen.queryByTestId("deal-handover-payment-fee1")).toBeNull();
  });
});

describe("the readiness reasons point at the lines, in both languages", () => {
  const enT = (key: string) => (salesEn as Record<string, string>)[key] ?? key;
  const arT = (key: string) => (salesAr as Record<string, string>)[key] ?? key;

  test.each(["HANDOVER_COSTS_UNPAID", "HANDOVER_COSTS_NO_ACTUAL", "HANDOVER_COSTS_CONFLICT"] as const)(
    "%s names the count and the Handover costs section, in EN and AR",
    (code) => {
      const en = closingReasonText(enT, code, { count: 2 }, "diagnostic");
      const ar = closingReasonText(arT, code, { count: 2 }, "diagnostic");
      expect(en.translated).toBe(true);
      expect(en.text).toContain("2");
      expect(en.text).not.toContain("{count}");
      expect(ar.text).toContain("2");
      expect(ar.text).not.toContain("{count}");
      expect(ar.text).toMatch(/[؀-ۿ]/);
    }
  );

  test("the unpaid reason names both ways out: direct payment, or the custody that paid", () => {
    const en = closingReasonText(enT, "HANDOVER_COSTS_UNPAID", { count: 1 }, "").text;
    expect(en).toMatch(/direct payment/i);
    expect(en).toMatch(/custody/i);
    expect(en).toContain("Handover costs");
  });

  test("below the finance tier the reason is the withheld sentence, with no count", () => {
    const withheld = closingReasonText(enT, "WITHHELD_HANDOVER_COSTS_PAID", undefined, "d").text;
    expect(withheld).toBe(salesEn.ClosingReason_WITHHELD_HANDOVER_COSTS_PAID);
    expect(withheld).not.toMatch(/\d/);
  });

  test("the check has a label in both languages", () => {
    expect(salesEn.ClosingCheck_HANDOVER_COSTS_PAID).toBeTruthy();
    expect(salesAr.ClosingCheck_HANDOVER_COSTS_PAID).toMatch(/[؀-ۿ]/);
  });
});
