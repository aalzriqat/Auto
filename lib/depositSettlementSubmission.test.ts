import { describe, expect, test } from "vitest";
import { decideDepositSubmission, type DepositLineEligibility } from "./depositSettlementSubmission";

const eligible = (label: string): DepositLineEligibility => ({
  canApply: true,
  required: true,
  reason: null,
  label,
});

const refusing = (label: string, reason: string): DepositLineEligibility => ({
  canApply: false,
  required: true,
  reason,
  label,
});

/**
 * Eligible, but the server does NOT insist on the treatment — the deposit fits
 * inside what the dealership billed this customer, so the long-standing default
 * handles it. This is the only shape for which declining is a real answer.
 */
const optional = (label: string): DepositLineEligibility => ({
  canApply: true,
  required: false,
  reason: null,
  label,
});

describe("whether a quote's deposit treatment may be sent", () => {
  test("a single confirmed line sends it", () => {
    const d = decideDepositSubmission({ a: eligible("Camry") }, { a: true });
    expect(d.sendTreatment).toBe(true);
    expect(d.canSubmit).toBe(true);
  });

  test("confirming ONE of two lines does not apply the treatment to the other", () => {
    // The defect this exists for. `completeFromQuote` forwards ONE treatment to
    // every vehicle on the quote, so "some line is confirmed" consumed the
    // second car's share against the supplier settlement, opened its claim
    // short by that amount, and reported success — for a car the operator had
    // deliberately left unticked, under an on-screen message saying the sale
    // could not be completed until its deposit was decided.
    const d = decideDepositSubmission(
      { a: eligible("Camry"), b: eligible("Corolla") },
      { a: true }
    );

    expect(d.sendTreatment).toBe(false);
    expect(d.partiallyConfirmed).toBe(true);
    // And it does not quietly complete WITHOUT the treatment either — an
    // unfinished decision is not a decision.
    expect(d.canSubmit).toBe(false);
  });

  test("confirming both lines sends it", () => {
    const d = decideDepositSubmission(
      { a: eligible("Camry"), b: eligible("Corolla") },
      { a: true, b: true }
    );
    expect(d.sendTreatment).toBe(true);
    expect(d.canSubmit).toBe(true);
  });

  test("a refusing line blocks the deal and names itself", () => {
    // Previously the submission was merely withheld, and the server's refusal
    // names no vehicle — so on a multi-car quote the operator was told a
    // deposit was too large without being told whose.
    const d = decideDepositSubmission(
      { a: eligible("Camry"), b: refusing("Corolla", "exceeds the dealership's margin") },
      { a: true, b: true }
    );

    expect(d.sendTreatment).toBe(false);
    expect(d.canSubmit).toBe(false);
    expect(d.blockingLine?.label).toBe("Corolla");
    expect(d.blockingLine?.reason).toMatch(/margin/);
  });

  test("no lines with an opinion means nothing to send and nothing to block", () => {
    // Owned stock, or a quote with no عربون: the sections render nothing, so
    // the deal submits exactly as it did before this control existed.
    const d = decideDepositSubmission({}, {});
    expect(d.sendTreatment).toBe(false);
    expect(d.canSubmit).toBe(true);
  });

  test("confirming nothing submits when no line REQUIRES the treatment", () => {
    // Declining is a valid answer here, and only here: the deposit fits the
    // customer's bill, so the server's long-standing default handles it.
    const d = decideDepositSubmission({ a: optional("Camry") }, {});
    expect(d.sendTreatment).toBe(false);
    expect(d.partiallyConfirmed).toBe(false);
    expect(d.unconfirmedRequiredLine).toBeNull();
    expect(d.canSubmit).toBe(true);
  });

  test("a REQUIRED line nobody confirmed blocks submission, and names itself", () => {
    // This fixture used to be the one above, asserting that declining was
    // fine — while carrying `required: true`, which is precisely the case the
    // server refuses. The test encoded the defect: no line refused, nothing
    // was confirmed so `partiallyConfirmed` stayed false, submission was
    // allowed, and `completeFromQuote` went out with no treatment to a server
    // that had already promised to reject it. The operator had been shown
    // "this treatment is required" and left free to ignore it.
    const d = decideDepositSubmission({ a: eligible("Camry") }, {});
    expect(d.canSubmit).toBe(false);
    expect(d.unconfirmedRequiredLine?.label).toBe("Camry");
    expect(d.blockingLine).toBeNull();
  });

  test("confirming the required line releases it", () => {
    const d = decideDepositSubmission({ a: eligible("Camry") }, { a: true });
    expect(d.unconfirmedRequiredLine).toBeNull();
    expect(d.canSubmit).toBe(true);
    expect(d.sendTreatment).toBe(true);
  });

  test("a required line is not blamed when another line refuses outright", () => {
    // `blockingLine` cannot be resolved on this screen; the required one can.
    // Reporting both would give the operator two instructions for one deal.
    const d = decideDepositSubmission(
      { a: eligible("Camry"), b: refusing("Sunny", "exceeds the margin") },
      {}
    );
    expect(d.canSubmit).toBe(false);
    expect(d.blockingLine?.label).toBe("Sunny");
  });
});
