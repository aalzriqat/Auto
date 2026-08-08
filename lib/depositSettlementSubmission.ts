/**
 * Whether a quote's deposit-settlement treatment may be sent, and what stops it.
 *
 * Extracted from the sales wizard so it can be tested at all. The wizard has no
 * test file, and this is the rule that decides whether a financial treatment is
 * applied to every car on a deal — the two defects it has already carried were
 * both invisible to the component tests around it.
 *
 * ## Why "every", not "any"
 *
 * `completeFromQuote` takes ONE `depositResolution` and
 * `completeSalesForLineItems` forwards it to every vehicle on the quote. So a
 * rule of "some line is confirmed" applied the treatment to lines the operator
 * had deliberately left unticked: their share was consumed against the supplier
 * settlement, the supplier claim opened short by that amount, and the screen
 * reported success. The control is quote-wide on the wire, so it is quote-wide
 * here — all or nothing, and a partial selection blocks submission instead of
 * silently resolving itself in the operator's absence.
 */

export interface DepositLineEligibility {
  canApply: boolean;
  required: boolean;
  reason: string | null;
  label: string;
}

export interface DepositSubmissionDecision {
  /** Send `APPLY_TO_TRANSACTION_SETTLEMENT` with the completion. */
  sendTreatment: boolean;
  /** The first line refusing the treatment, if any — for naming it on screen. */
  blockingLine: DepositLineEligibility | null;
  /** Confirmed on some lines but not all: incoherent, so submission is blocked. */
  partiallyConfirmed: boolean;
  /**
   * The first line that REQUIRES the treatment and has not been confirmed.
   *
   * Distinct from `blockingLine`: that one cannot be confirmed at all, this one
   * has not been. The operator resolves it by ticking the box, so the screen
   * has to name it rather than just refusing.
   */
  unconfirmedRequiredLine: DepositLineEligibility | null;
  /** Whether the deal may be submitted at all. */
  canSubmit: boolean;
}

export function decideDepositSubmission(
  eligibility: Record<string, DepositLineEligibility>,
  confirmed: Record<string, boolean>
): DepositSubmissionDecision {
  const lines = Object.entries(eligibility);
  const blockingLine = lines.map(([, line]) => line).find((line) => !line.canApply) ?? null;

  const confirmedCount = lines.filter(([id]) => confirmed[id] === true).length;
  const everyConfirmed = lines.length > 0 && confirmedCount === lines.length;
  const partiallyConfirmed = confirmedCount > 0 && confirmedCount < lines.length;

  // A line the server REQUIRES a treatment for, which nobody has confirmed.
  //
  // `required` was carried on every line and then never read here, so nothing
  // was confirmed, `partiallyConfirmed` stayed false (it needs a count above
  // zero), no line refused, and submission was allowed. The wizard then called
  // `completeFromQuote` with no `depositResolution` at all and the server
  // refused the sale — after the operator had been shown "this treatment is
  // required" and left free to ignore it. The screen said go, the server said
  // no, and the field that knew better was sitting unused in this function.
  const unconfirmedRequiredLine =
    lines
      .filter(([id, line]) => line.required && line.canApply && confirmed[id] !== true)
      .map(([, line]) => line)[0] ?? null;

  return {
    sendTreatment: everyConfirmed && blockingLine === null,
    blockingLine,
    partiallyConfirmed,
    unconfirmedRequiredLine,
    // A blocking line cannot be resolved from this screen, a partial selection
    // is an unfinished decision, and an unconfirmed required line is a refusal
    // the server has already promised. None should reach it, where the message
    // names no vehicle.
    canSubmit:
      blockingLine === null && !partiallyConfirmed && unconfirmedRequiredLine === null,
  };
}
