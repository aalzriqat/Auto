/**
 * SCRUM-417 UX5 (S7) -- the invariant: "Recorded. Next: ..." is shown only when
 * the read model shows the fact written by THAT action on THAT deal; an action
 * with no such fact gets an immediate outcome; the operator is never left
 * without one (timeout, unmount, another deal).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  RECORDED_REFLECT_TIMEOUT_MS,
  approvalReopenedReflected,
  approvedPurchaseReflected,
  creditStatusReflected,
  depositReleaseReflected,
  expectedPaymentReflected,
  financeDisbursementReflected,
  handoverReflected,
  legalInvoiceReflected,
  quotationReflected,
  reconciliationReflected,
  supplierDisbursementReflected,
  uploadReflected,
  useRecordedFeedback,
  verifyReflected,
  type RecordedModel,
} from "./recordedFeedback";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Doc = NonNullable<RecordedModel["documents"]>[number];
const doc = (ruleId: string, status = "MISSING", extra: Partial<Doc> = {}): Doc => ({
  _id: `id_${ruleId}`,
  ruleId,
  status,
  uploadedAt: null,
  fileUrl: null,
  ...extra,
});
const model = (documents: Doc[], extra: Partial<RecordedModel> = {}): RecordedModel => ({
  deal: { stages: [] },
  documents,
  ...extra,
});

describe("predicates: each names the fact its action wrote", () => {
  test("upload: another operator's change, or the rule list reordering, is not this upload", () => {
    const start = model([doc("A"), doc("B", "UPLOADED", { fileUrl: "b", uploadedAt: 1 }), { ...doc("C"), _id: null }]);
    const reflected = uploadReflected("A");
    // Another operator verifies B.
    expect(reflected(model([doc("A"), doc("B", "VERIFIED", { fileUrl: "b", uploadedAt: 1 }), { ...doc("C"), _id: null }]), start)).toBe(false);
    // C's row is materialized: the row-less rules move out of the tail.
    expect(reflected(model([doc("A"), doc("C"), doc("B", "UPLOADED", { fileUrl: "b", uploadedAt: 1 })]), start)).toBe(false);
    // The target rule's row now carries the file.
    expect(reflected(model([doc("A", "UPLOADED", { fileUrl: "a", uploadedAt: 5 }), doc("B"), doc("C")]), start)).toBe(true);
  });

  test("upload: a REPLACEMENT is reflected by a new uploadedAt, not by the old file already being there", () => {
    const start = model([doc("A", "UPLOADED", { fileUrl: "old", uploadedAt: 1 })]);
    expect(uploadReflected("A")(start, start)).toBe(false);
    expect(uploadReflected("A")(model([doc("A", "UPLOADED", { fileUrl: "new", uploadedAt: 2 })]), start)).toBe(true);
  });

  test("verify: only the target rule's own VERIFIED status", () => {
    expect(verifyReflected("A")(model([doc("A", "UPLOADED"), doc("B", "VERIFIED")]), null)).toBe(false);
    expect(verifyReflected("A")(model([doc("A", "VERIFIED")]), null)).toBe(true);
    expect(verifyReflected(undefined)(model([doc("A", "VERIFIED")]), null)).toBe(false);
  });

  test("credit, deposit release, disbursement, handover, payment, reconciliation", () => {
    const app = (application: NonNullable<RecordedModel["application"]>): RecordedModel => ({ deal: { stages: [] }, application });
    expect(creditStatusReflected("UNDER_REVIEW")(app({ status: "PENDING_DOCS" }), null)).toBe(false);
    expect(creditStatusReflected("UNDER_REVIEW")(app({ status: "UNDER_REVIEW" }), null)).toBe(true);

    const deposits = (releaseCount: number, id = "d1") => app({ deposits: [{ _id: id, releaseCount }] });
    expect(depositReleaseReflected("d1", 0)(deposits(0), null)).toBe(false);
    expect(depositReleaseReflected("d1", 0)(deposits(1, "d2"), null)).toBe(false);
    expect(depositReleaseReflected("d1", 0)(deposits(1), null)).toBe(true);

    expect(financeDisbursementReflected(app({}), null)).toBe(false);
    expect(financeDisbursementReflected(app({ disbursedAt: 9 }), null)).toBe(true);
    expect(supplierDisbursementReflected(app({}), null)).toBe(false);
    expect(supplierDisbursementReflected(app({ supplierDisbursementStatus: "CONFIRMED" }), null)).toBe(true);
    expect(reconciliationReflected(app({ needsFinancingReconciliation: true }), null)).toBe(false);
    expect(reconciliationReflected(app({ needsFinancingReconciliation: false }), null)).toBe(true);

    const deal = (state: string, expectedPaymentRegistered = false): RecordedModel => ({
      deal: { expectedPaymentRegistered, stages: [{ key: "HANDOVER", state }] },
    });
    expect(handoverReflected(deal("CURRENT"), null)).toBe(false);
    expect(handoverReflected(deal("COMPLETE"), null)).toBe(true);
    expect(expectedPaymentReflected(deal("CURRENT"), null)).toBe(false);
    expect(expectedPaymentReflected(deal("CURRENT", true), null)).toBe(true);
  });

  test("economics and legal invoice: the figure that was written, not just any figure", () => {
    const econ = (submittedQuotationMinor: number | null, approvedDealerPurchaseAmountMinor: number | null): RecordedModel => ({
      deal: { stages: [] },
      economics: { submittedQuotationMinor, approvedDealerPurchaseAmountMinor },
    });
    expect(quotationReflected(100)(econ(90, null), null)).toBe(false);
    expect(quotationReflected(100)(econ(100, null), null)).toBe(true);
    expect(approvedPurchaseReflected(80)(econ(100, 70), null)).toBe(false);
    expect(approvedPurchaseReflected(80)(econ(100, 80), null)).toBe(true);
    // Reopen: the amount was on screen, and is gone.
    expect(approvalReopenedReflected(econ(100, null), econ(100, 80))).toBe(true);
    expect(approvalReopenedReflected(econ(100, 80), econ(100, 80))).toBe(false);
    // ...and a caller who was never shown it cannot be told "reopened".
    expect(approvalReopenedReflected(econ(100, null), econ(100, null))).toBe(false);

    const costs = (legalInvoiceNumber: string, legalInvoiceAmountMinor: number): RecordedModel => ({
      deal: { stages: [] },
      costs: { legalInvoiceNumber, legalInvoiceAmountMinor },
    });
    expect(legalInvoiceReflected("INV-2", 500)(costs("INV-1", 500), null)).toBe(false);
    expect(legalInvoiceReflected("INV-2", 500)(costs("INV-2", 500), null)).toBe(true);
  });
});

describe("useRecordedFeedback", () => {
  const setup = (initial: RecordedModel | null) => {
    const onUnreflected = vi.fn();
    const hook = renderHook(
      ({ m, scope }: { m: RecordedModel | null; scope: string }) => useRecordedFeedback(m, onUnreflected, scope),
      { initialProps: { m: initial, scope: "deal-1" } }
    );
    return { ...hook, onUnreflected };
  };
  const start = () => model([doc("A", "UPLOADED", { fileUrl: "a", uploadedAt: 1 }), doc("B", "UPLOADED", { fileUrl: "b", uploadedAt: 1 })]);

  test("held until the TARGET's fact shows: an unrelated document change does not release it", async () => {
    const { result, rerender, onUnreflected } = setup(start());
    await act(async () => {
      await result.current.track(async () => "ok", "DocVerified", { reflectedWhen: verifyReflected("A"), isDocumentAction: true, documentRuleId: "A" });
    });
    expect(result.current.recorded).toBeNull();
    // Another operator verifies B: the deal moved, but not because of this action.
    rerender({ m: model([doc("A", "UPLOADED", { fileUrl: "a", uploadedAt: 1 }), doc("B", "VERIFIED", { fileUrl: "b", uploadedAt: 1 })]), scope: "deal-1" });
    expect(result.current.recorded).toBeNull();
    // The target row itself.
    rerender({ m: model([doc("A", "VERIFIED", { fileUrl: "a", uploadedAt: 1 }), doc("B", "VERIFIED", { fileUrl: "b", uploadedAt: 1 })]), scope: "deal-1" });
    expect(result.current.recorded).toEqual({ isDocumentAction: true, documentRuleId: "A" });
    expect(onUnreflected).not.toHaveBeenCalled();
  });

  test("a query that beat the promise still counts: reflected the moment the mutation resolves", async () => {
    const { result, rerender } = setup(model([doc("A", "UPLOADED")]));
    let resolve!: () => void;
    let tracked!: Promise<unknown>;
    await act(async () => {
      tracked = result.current.track(() => new Promise<void>((r) => (resolve = r)), "DocVerified", { reflectedWhen: verifyReflected("A") });
    });
    rerender({ m: model([doc("A", "VERIFIED")]), scope: "deal-1" });
    await act(async () => {
      resolve();
      await tracked;
    });
    expect(result.current.recorded).not.toBeNull();
  });

  test("a refused save shows no 'Recorded' and no toast", async () => {
    const { result, onUnreflected } = setup(start());
    await act(async () => {
      await expect(
        result.current.track(async () => {
          throw new Error("refused");
        }, "DocVerified", { reflectedWhen: verifyReflected("A") })
      ).rejects.toThrow("refused");
    });
    expect(result.current.recorded).toBeNull();
    expect(onUnreflected).not.toHaveBeenCalled();
  });

  test("an action with no observable fact gets its outcome at once -- no timer advance", async () => {
    vi.useFakeTimers();
    const { result, onUnreflected } = setup(start());
    await act(async () => {
      await result.current.track(async () => "ok", "ReceiptRecorded");
    });
    expect(onUnreflected).toHaveBeenCalledTimes(1);
    expect(onUnreflected).toHaveBeenCalledWith("ReceiptRecorded");
    expect(result.current.recorded).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(RECORDED_REFLECT_TIMEOUT_MS * 2);
    });
    expect(onUnreflected).toHaveBeenCalledTimes(1);
  });

  test("control: a committed change that never shows up falls back to the notice after the timeout", async () => {
    vi.useFakeTimers();
    const { result, onUnreflected } = setup(start());
    await act(async () => {
      await result.current.track(async () => "ok", "DocVerified", { reflectedWhen: verifyReflected("A") });
    });
    expect(onUnreflected).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(RECORDED_REFLECT_TIMEOUT_MS);
    });
    expect(onUnreflected).toHaveBeenCalledWith("DocVerified");
    expect(result.current.recorded).toBeNull();
  });

  test("control: a second action settles the first one's outcome instead of dropping it", async () => {
    const { result, onUnreflected } = setup(start());
    await act(async () => {
      await result.current.track(async () => "ok", "DocVerified", { reflectedWhen: verifyReflected("A") });
    });
    await act(async () => {
      await result.current.track(async () => "ok", "UploadSuccess", { reflectedWhen: uploadReflected("B") });
    });
    expect(onUnreflected).toHaveBeenCalledTimes(1);
    expect(onUnreflected).toHaveBeenCalledWith("DocVerified");
  });

  test("finalize case: the cockpit unmounting with an unconfirmed outcome still emits it", async () => {
    const { result, unmount, onUnreflected } = setup(start());
    await act(async () => {
      await result.current.track(async () => "ok", "DealFinalizedSuccess", { reflectedWhen: verifyReflected("A") });
    });
    expect(onUnreflected).not.toHaveBeenCalled();
    unmount();
    expect(onUnreflected).toHaveBeenCalledTimes(1);
    expect(onUnreflected).toHaveBeenCalledWith("DealFinalizedSuccess");
  });

  test("an unmount that already released its line emits nothing further", async () => {
    const { result, rerender, unmount, onUnreflected } = setup(model([doc("A", "UPLOADED")]));
    await act(async () => {
      await result.current.track(async () => "ok", "DocVerified", { reflectedWhen: verifyReflected("A") });
    });
    rerender({ m: model([doc("A", "VERIFIED")]), scope: "deal-1" });
    expect(result.current.recorded).not.toBeNull();
    unmount();
    expect(onUnreflected).not.toHaveBeenCalled();
  });

  test("control: another deal on the same mounted cockpit settles a held line and drops the shown one", async () => {
    const { result, rerender, onUnreflected } = setup(start());
    await act(async () => {
      await result.current.track(async () => "ok", "DocVerified", { reflectedWhen: verifyReflected("A") });
    });
    rerender({ m: model([doc("A", "VERIFIED")]), scope: "deal-2" });
    expect(onUnreflected).toHaveBeenCalledWith("DocVerified");
    expect(result.current.recorded).toBeNull();
  });

  test("a mutation that resolves after the deal changed is said at once, not held against the new deal", async () => {
    const { result, rerender, onUnreflected } = setup(start());
    let resolve!: () => void;
    let tracked!: Promise<unknown>;
    await act(async () => {
      tracked = result.current.track(() => new Promise<void>((r) => (resolve = r)), "DocVerified", { reflectedWhen: verifyReflected("A") });
    });
    rerender({ m: start(), scope: "deal-2" });
    await act(async () => {
      resolve();
      await tracked;
    });
    expect(onUnreflected).toHaveBeenCalledWith("DocVerified");
    expect(result.current.recorded).toBeNull();
  });
});
