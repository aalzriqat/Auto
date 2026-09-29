/**
 * SCRUM-417 UX5 (S7) -- the invariant: "Recorded. Next: ..." is shown only when
 * the read model shows the fact written by THAT action on THAT deal; an action
 * with no such fact gets an immediate outcome; the operator is never left
 * without one (timeout, unmount, another deal).
 */
import { useLayoutEffect } from "react";
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
    const reflected = uploadReflected("A", () => "file_a");
    // Another operator verifies B.
    expect(reflected(model([doc("A"), doc("B", "VERIFIED", { fileUrl: "b", uploadedAt: 1 }), { ...doc("C"), _id: null }]), start)).toBe(false);
    // C's row is materialized: the row-less rules move out of the tail.
    expect(reflected(model([doc("A"), doc("C"), doc("B", "UPLOADED", { fileUrl: "b", uploadedAt: 1 })]), start)).toBe(false);
    // The target rule's row now carries the file.
    expect(reflected(model([doc("A", "UPLOADED", { fileUrl: "a", fileId: "file_a", uploadedAt: 5 }), doc("B"), doc("C")]), start)).toBe(true);
  });

  test("upload: a REPLACEMENT is reflected by the new stored file, not by the old file already being there", () => {
    const start = model([doc("A", "UPLOADED", { fileUrl: "old", fileId: "file_old", uploadedAt: 1 })]);
    const reflected = uploadReflected("A", () => "file_new");
    expect(reflected(start, start)).toBe(false);
    // Same timestamp, new file: still this upload (an uploadedAt comparison would miss it).
    expect(reflected(model([doc("A", "UPLOADED", { fileUrl: "new", fileId: "file_new", uploadedAt: 1 })]), start)).toBe(true);
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
    const withSource = (m: RecordedModel, extra: NonNullable<RecordedModel["economics"]>): RecordedModel => ({
      ...m,
      economics: { ...m.economics, ...extra },
    });
    const econ = (submittedQuotationMinor: number | null, approvedDealerPurchaseAmountMinor: number | null): RecordedModel => ({
      deal: { stages: [] },
      economics: { submittedQuotationMinor, approvedDealerPurchaseAmountMinor },
    });
    expect(quotationReflected(100, "MANUAL_ENTRY")(econ(90, null), null)).toBe(false);
    expect(quotationReflected(100, "MANUAL_ENTRY")(withSource(econ(100, null), { submittedQuotationSource: "MANUAL_ENTRY" }), null)).toBe(true);
    expect(approvedPurchaseReflected(80, "MANUAL")(econ(100, 70), null)).toBe(false);
    expect(approvedPurchaseReflected(80, "MANUAL")(withSource(econ(100, 80), { approvedPurchaseBasis: "MANUAL" }), null)).toBe(true);
    // Reopen: the amount was on screen, and is gone.
    expect(approvalReopenedReflected(econ(100, null), econ(100, 80))).toBe(true);
    expect(approvalReopenedReflected(econ(100, 80), econ(100, 80))).toBe(false);
    // ...and a caller who was never shown it cannot be told "reopened".
    expect(approvalReopenedReflected(econ(100, null), econ(100, null))).toBe(false);

    const costs = (legalInvoiceNumber: string, legalInvoiceAmountMinor: number): RecordedModel => ({
      deal: { stages: [] },
      costs: { legalInvoiceNumber, legalInvoiceAmountMinor, legalInvoiceDate: 1, legalInvoiceIssuedTo: "CUSTOMER" },
    });
    const submitted = { number: "INV-2", amountMinor: 500, date: 1, issuedTo: "CUSTOMER" };
    expect(legalInvoiceReflected(submitted)(costs("INV-1", 500), null)).toBe(false);
    expect(legalInvoiceReflected(submitted)(costs("INV-2", 500), null)).toBe(true);
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
      await result.current.track(async () => "ok", "UploadSuccess", { reflectedWhen: uploadReflected("B", () => "file_b") });
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

describe("R2 batch fix -- a predicate proves ITS action, not a matching value", () => {
  const costs = (number: string, amountMinor: number, date: number, issuedTo: string): RecordedModel => ({
    deal: { stages: [] },
    costs: {
      legalInvoiceNumber: number,
      legalInvoiceAmountMinor: amountMinor,
      legalInvoiceDate: date,
      legalInvoiceIssuedTo: issuedTo,
    },
  });
  const econ = (economics: NonNullable<RecordedModel["economics"]>): RecordedModel => ({
    deal: { stages: [] },
    economics,
  });

  test("invoice: a date-only edit is reflected by the NEW date; the old row is not enough", () => {
    const start = costs("INV-1", 500, 1, "CUSTOMER");
    const reflected = legalInvoiceReflected({ number: "INV-1", amountMinor: 500, date: 2, issuedTo: "CUSTOMER" });
    expect(reflected(start, start)).toBe(false);
    expect(reflected(costs("INV-1", 500, 2, "CUSTOMER"), start)).toBe(true);
  });

  test("invoice: a recipient-only edit is reflected by the new recipient, not the old row", () => {
    const start = costs("INV-1", 500, 1, "CUSTOMER");
    const reflected = legalInvoiceReflected({ number: "INV-1", amountMinor: 500, date: 1, issuedTo: "FINANCE_COMPANY" });
    expect(reflected(start, start)).toBe(false);
    expect(reflected(costs("INV-1", 500, 1, "FINANCE_COMPANY"), start)).toBe(true);
  });

  test("invoice: a submission the read model already shows cannot be proved -- it is not held", () => {
    const start = costs("INV-1", 500, 1, "CUSTOMER");
    const same = legalInvoiceReflected({ number: "INV-1", amountMinor: 500, date: 1, issuedTo: "CUSTOMER" });
    expect(same.provableFrom?.(start)).toBe(false);
    expect(same.provableFrom?.(costs("INV-1", 500, 2, "CUSTOMER"))).toBe(true);
    expect(same.provableFrom?.(null)).toBe(true);
  });

  test("quotation: the same amount from another source is a different fact", () => {
    const start = econ({ submittedQuotationMinor: 100, submittedQuotationSource: "MANUAL_ENTRY" });
    const reflected = quotationReflected(100, "CALCULATED_WITH_OVERRIDE");
    expect(reflected(start, start)).toBe(false);
    expect(
      reflected(econ({ submittedQuotationMinor: 100, submittedQuotationSource: "CALCULATED_WITH_OVERRIDE" }), start)
    ).toBe(true);
    // Same amount AND source as what is already shown: nothing distinguishes the write.
    expect(quotationReflected(100, "MANUAL_ENTRY").provableFrom?.(start)).toBe(false);
  });

  test("approval: the same amount on another basis is a different fact", () => {
    const start = econ({ approvedDealerPurchaseAmountMinor: 80, approvedPurchaseBasis: "APPRAISAL" });
    const reflected = approvedPurchaseReflected(80, "MANUAL");
    expect(reflected(start, start)).toBe(false);
    expect(reflected(econ({ approvedDealerPurchaseAmountMinor: 80, approvedPurchaseBasis: "MANUAL" }), start)).toBe(true);
    expect(approvedPurchaseReflected(80, "APPRAISAL").provableFrom?.(start)).toBe(false);
  });

  test("upload: a competing same-rule upload (another file) is not this upload; the stored file identity is", () => {
    let stored: string | undefined;
    const reflected = uploadReflected("A", () => stored);
    const start = model([doc("A", "UPLOADED", { fileUrl: "old", fileId: "file_old", uploadedAt: 1 })]);
    stored = "file_mine";
    // A colleague's replacement landed first, in the same millisecond ours would carry.
    expect(reflected(model([doc("A", "UPLOADED", { fileUrl: "theirs", fileId: "file_theirs", uploadedAt: 1 })]), start)).toBe(false);
    expect(reflected(model([doc("A", "UPLOADED", { fileUrl: "mine", fileId: "file_mine", uploadedAt: 1 })]), start)).toBe(true);
    // Before the file id is known nothing can be proved.
    stored = undefined;
    expect(reflected(model([doc("A", "UPLOADED", { fileUrl: "mine", fileId: "file_mine", uploadedAt: 1 })]), start)).toBe(false);
  });
});

describe("R2 batch fix -- a held outcome settles exactly once", () => {
  const setup = (initial: RecordedModel | null) => {
    const onUnreflected = vi.fn();
    const hook = renderHook(
      ({ m, scope }: { m: RecordedModel | null; scope: string }) => useRecordedFeedback(m, onUnreflected, scope),
      { initialProps: { m: initial, scope: "deal-1" } }
    );
    return { ...hook, onUnreflected };
  };
  const held = () => model([doc("A", "UPLOADED")]);

  test("track resolving and the cockpit unmounting in one batch still says the outcome once", async () => {
    const { result, unmount, onUnreflected } = setup(held());
    await act(async () => {
      await result.current.track(async () => "ok", "DocVerified", { reflectedWhen: verifyReflected("A") });
      unmount();
    });
    expect(onUnreflected).toHaveBeenCalledTimes(1);
    expect(onUnreflected).toHaveBeenCalledWith("DocVerified");
  });

  test("the timeout firing and the cockpit unmounting in one batch does not say it twice", async () => {
    vi.useFakeTimers();
    const { result, unmount, onUnreflected } = setup(held());
    await act(async () => {
      await result.current.track(async () => "ok", "DocVerified", { reflectedWhen: verifyReflected("A") });
    });
    await act(async () => {
      vi.advanceTimersByTime(RECORDED_REFLECT_TIMEOUT_MS);
      unmount();
    });
    expect(onUnreflected).toHaveBeenCalledTimes(1);
  });

  test("an action the read model already shows is said at once, not held", async () => {
    const values = { number: "N", amountMinor: 1, date: 1, issuedTo: "CUSTOMER" };
    const { result, onUnreflected } = setup({
      deal: { stages: [] },
      costs: { legalInvoiceNumber: "N", legalInvoiceAmountMinor: 1, legalInvoiceDate: 1, legalInvoiceIssuedTo: "CUSTOMER" },
    });
    await act(async () => {
      await result.current.track(async () => "ok", "LegalInvoiceRecorded", { reflectedWhen: legalInvoiceReflected(values) });
    });
    expect(onUnreflected).toHaveBeenCalledTimes(1);
    expect(onUnreflected).toHaveBeenCalledWith("LegalInvoiceRecorded");
    expect(result.current.recorded).toBeNull();
  });
});

describe("Sol R3-1 -- a released line is retracted when the read model stops showing its fact", () => {
  const setup = (initial: RecordedModel | null) => {
    const onUnreflected = vi.fn();
    const hook = renderHook(
      ({ m, scope }: { m: RecordedModel | null; scope: string }) => useRecordedFeedback(m, onUnreflected, scope),
      { initialProps: { m: initial, scope: "deal-1" } }
    );
    return { ...hook, onUnreflected };
  };
  const econ = (minor: number, source: string, extra: Partial<RecordedModel> = {}): RecordedModel => ({
    deal: { stages: [] },
    economics: { submittedQuotationMinor: minor, submittedQuotationSource: source },
    ...extra,
  });

  test("quotation released, then another operator changes the amount: the line is gone, with no toast", async () => {
    const { result, rerender, onUnreflected } = setup(econ(90, "MANUAL_ENTRY"));
    await act(async () => {
      await result.current.track(async () => "ok", "QuotationRecorded", {
        reflectedWhen: quotationReflected(100, "MANUAL_ENTRY"),
      });
    });
    rerender({ m: econ(100, "MANUAL_ENTRY"), scope: "deal-1" });
    expect(result.current.recorded).not.toBeNull();
    rerender({ m: econ(120, "MANUAL_ENTRY"), scope: "deal-1" });
    expect(result.current.recorded).toBeNull();
    expect(onUnreflected).not.toHaveBeenCalled();
  });

  test("retraction is permanent: the value coming back does not resurrect the line", async () => {
    const { result, rerender } = setup(econ(90, "MANUAL_ENTRY"));
    await act(async () => {
      await result.current.track(async () => "ok", "QuotationRecorded", {
        reflectedWhen: quotationReflected(100, "MANUAL_ENTRY"),
      });
    });
    rerender({ m: econ(100, "MANUAL_ENTRY"), scope: "deal-1" });
    rerender({ m: econ(120, "MANUAL_ENTRY"), scope: "deal-1" });
    rerender({ m: econ(100, "MANUAL_ENTRY"), scope: "deal-1" });
    expect(result.current.recorded).toBeNull();
  });

  test("upload released, then the same row becomes VERIFIED with the same file: the line stays", async () => {
    const start = model([doc("A", "MISSING")]);
    const { result, rerender, onUnreflected } = setup(start);
    await act(async () => {
      await result.current.track(async () => "ok", "UploadSuccess", {
        reflectedWhen: uploadReflected("A", () => "file_a"),
        isDocumentAction: true,
        documentRuleId: "A",
      });
    });
    rerender({ m: model([doc("A", "UPLOADED", { fileId: "file_a", uploadedAt: 5 })]), scope: "deal-1" });
    expect(result.current.recorded).not.toBeNull();
    rerender({ m: model([doc("A", "VERIFIED", { fileId: "file_a", uploadedAt: 5 })]), scope: "deal-1" });
    expect(result.current.recorded).toEqual({ isDocumentAction: true, documentRuleId: "A" });
    expect(onUnreflected).not.toHaveBeenCalled();
  });

  test("an unrelated field changing on the same deal keeps the line", async () => {
    const { result, rerender } = setup(econ(90, "MANUAL_ENTRY"));
    await act(async () => {
      await result.current.track(async () => "ok", "QuotationRecorded", {
        reflectedWhen: quotationReflected(100, "MANUAL_ENTRY"),
      });
    });
    rerender({ m: econ(100, "MANUAL_ENTRY"), scope: "deal-1" });
    rerender({ m: econ(100, "MANUAL_ENTRY", { application: { status: "UNDER_REVIEW" } }), scope: "deal-1" });
    expect(result.current.recorded).not.toBeNull();
  });
});

describe("Opus L1 -- the released line retires its owed outcome at commit, before any timer can run", () => {
  test("a timer firing in the commit that shows the line does not add a toast", async () => {
    vi.useFakeTimers();
    const onUnreflected = vi.fn();
    // The probe's layout effect runs right after the hook's own, in the same commit
    // and before any passive effect: exactly the window a 10s timer could land in.
    const { result, rerender } = renderHook(
      ({ m }: { m: RecordedModel | null }) => {
        const feedback = useRecordedFeedback(m, onUnreflected, "deal-1");
        useLayoutEffect(() => {
          if (feedback.recorded !== null) vi.advanceTimersByTime(RECORDED_REFLECT_TIMEOUT_MS);
        }, [feedback.recorded]);
        return feedback;
      },
      { initialProps: { m: model([doc("A", "UPLOADED")]) as RecordedModel | null } }
    );
    await act(async () => {
      await result.current.track(async () => "ok", "DocVerified", { reflectedWhen: verifyReflected("A") });
    });
    rerender({ m: model([doc("A", "VERIFIED")]) });
    expect(result.current.recorded).not.toBeNull();
    expect(onUnreflected).not.toHaveBeenCalled();
  });
});
