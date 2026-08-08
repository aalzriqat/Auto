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

  test("confirming nothing on an eligible quote still submits, without the treatment", () => {
    // Declining is a valid answer. The server then applies its long-standing
    // default, and refuses if the deposit does not fit — which is the state the
    // control exists to give a way out of, not one it may force.
    const d = decideDepositSubmission({ a: eligible("Camry") }, {});
    expect(d.sendTreatment).toBe(false);
    expect(d.partiallyConfirmed).toBe(false);
    expect(d.canSubmit).toBe(true);
  });
});
