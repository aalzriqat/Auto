/**
 * SCRUM-350 LIFE-1 — the pure judgement of voiding a cost the dealership paid directly.
 *
 * LIFE-1: a new way to SPEND creates a reversal obligation on every path that un-happens it.
 * A dealership-paid handover cost is recorded, reconciled and paid directly (DR the cost's
 * expense, CR the bank). Voiding the cost must take exactly that payment back: the original
 * posting untouched, ONE linked mirror reversal, the cost line gone, a repeated void a no-op,
 * and another directly paid cost on the same deal left exactly as it was.
 *
 * The verdict is the LEDGER read through permission-checked queries, judged against figures
 * computed from the scenario (never from the product): an expense debited and a bank credited
 * by the paid amount, mirrored by the reversal. A premise that was not established is
 * unjudged, never clean.
 */
import { judgeUnchanged, type Judgement, type LedgerEvent, type LedgerLine, type LedgerSnapshot } from "./browserSwarmBoundaryOracle";
import { currencyDecimals, toMinor } from "./browserSwarmConsignmentOracle";

/** The accounts a directly paid ownership-transfer cost moves, by bank transfer. */
export const FEE_VOID_EXPENSE_KEY = "OWNERSHIP_TRANSFER_EXPENSE";
export const FEE_VOID_BANK_KEY = "BANK_ACCOUNT";
export const DIRECT_PAYMENT_EVENT = "HANDOVER_COST_PAID_DIRECT";

export interface FeeVoidFigures {
  /** The cost that is voided (major units). */
  voidedMajor: number;
  /** The cost that stays paid beside it (major units). */
  survivingMajor: number;
}

export const FEE_VOID_FIGURES: Readonly<FeeVoidFigures> = { voidedMajor: 50, survivingMajor: 20 };

export type FeeVoidAmounts = { ok: true; voidedMinor: number; survivingMinor: number } | { ok: false; reason: string };

/**
 * The two figures as minor units of `currency`, or why they cannot be used: each must be a whole, positive
 * amount of that currency and the two must differ, or the void could not be told from its sibling.
 */
export function feeVoidAmounts(figures: Readonly<FeeVoidFigures>, currency: string): FeeVoidAmounts {
  const voidedMinor = toMinor(figures.voidedMajor, currency);
  const survivingMinor = toMinor(figures.survivingMajor, currency);
  if (voidedMinor === null || survivingMinor === null || voidedMinor <= 0 || survivingMinor <= 0 || voidedMinor === survivingMinor) {
    return { ok: false, reason: `the figures ${figures.voidedMajor} and ${figures.survivingMajor} are not two distinct whole positive amounts in ${currency}` };
  }
  return { ok: true, voidedMinor, survivingMinor };
}

/** What `listDealCosts` says about one live cost line. */
export interface FeeLineView {
  id: string;
  actualAmountMinor: number | null;
  /** The live direct payment's version and amount; null when the line carries none. */
  paymentVersion: number | null;
  paymentAmountMinor: number | null;
}

/** One cost's ledger at the three moments of the mission. */
export interface FeeLedgerStages {
  paid: LedgerSnapshot;
  afterVoid: LedgerSnapshot;
  afterRepeat: LedgerSnapshot;
}

export interface FeeVoidObservation {
  /** The organization's currency from its settings; null when that read was not possible. */
  currency: string | null;
  figures: FeeVoidFigures;
  voidedFeeId: string;
  survivingFeeId: string;
  /** Chart account id to system key. */
  keyOf: ReadonlyMap<string, string>;
  voided: FeeLedgerStages;
  surviving: FeeLedgerStages;
  /** The deal's live cost lines before the void, after it, and after the repeated void. */
  lines: { beforeVoid: readonly FeeLineView[]; afterVoid: readonly FeeLineView[]; afterRepeat: readonly FeeLineView[] };
  /** Whether the product accepted the repeated void; false when it refused. */
  repeatAccepted: boolean;
}

const sortedLines = (lines: readonly LedgerLine[]): string[] =>
  lines.map((line) => `${line.accountId ?? ""}|${line.debitMinor}|${line.creditMinor}|${line.scale}|${line.currency}`).sort((a, b) => a.localeCompare(b));

/** The lines of an event's journal as `key|debit|credit`, or null when a line sits on an account the chart cannot name. */
function keyedLines(lines: readonly LedgerLine[], keyOf: ReadonlyMap<string, string>): string[] | null {
  const keyed: string[] = [];
  for (const line of lines) {
    const key = line.accountId === null ? undefined : keyOf.get(line.accountId);
    if (key === undefined) return null;
    keyed.push(`${key}|${line.debitMinor}|${line.creditMinor}`);
  }
  return keyed.sort((a, b) => a.localeCompare(b));
}

const directPayments = (snapshot: LedgerSnapshot): LedgerEvent[] =>
  snapshot.events.filter((event) => event.eventType === DIRECT_PAYMENT_EVENT);

/**
 * The paid stage must hold exactly one POSTED direct payment of `amountMinor`: DR the expense, CR the
 * bank, one currency at its scale. Returns the event, or the reason the premise was not established.
 */
function judgePaid(
  label: string,
  snapshot: LedgerSnapshot,
  amountMinor: number,
  currency: string,
  keyOf: ReadonlyMap<string, string>,
): { event: LedgerEvent | null; lines: readonly LedgerLine[]; judgement: Judgement } {
  const unjudged = (reason: string) => ({ event: null, lines: [], judgement: { violations: [], unjudged: [`${label}: ${reason}`] } });
  const payments = directPayments(snapshot);
  if (payments.length !== 1) {
    return unjudged(
      payments.length === 0
        ? "the direct payment never reached the ledger, so there was no posted payment to take back"
        : `the line produced ${payments.length} direct payment events before any void`,
    );
  }
  const [event] = payments as [LedgerEvent];
  const lines = event.journalEntryId ? snapshot.journals[event.journalEntryId] : undefined;
  if (event.status !== "POSTED" || !lines) return unjudged("the direct payment had no posted, readable journal before the void");
  const keyed = keyedLines(lines, keyOf);
  if (keyed === null) return unjudged("the direct payment posted to an account the chart cannot name");
  const decimals = currencyDecimals(currency);
  const violations: string[] = [];
  if (!lines.every((line) => line.currency === currency && line.scale === decimals)) {
    violations.push(`${label}: the direct payment is not posted in ${currency} at that currency's scale`);
  }
  const expected = [`${FEE_VOID_EXPENSE_KEY}|${amountMinor}|0`, `${FEE_VOID_BANK_KEY}|0|${amountMinor}`].sort((a, b) => a.localeCompare(b));
  if (keyed.join(",") !== expected.join(",")) {
    violations.push(
      `${label}: the direct payment moved [${keyed.join(", ")}] but a ${amountMinor} bank-transfer payment debits ${FEE_VOID_EXPENSE_KEY} and credits ${FEE_VOID_BANK_KEY} by exactly that`,
    );
  }
  return { event, lines, judgement: { violations, unjudged: [] } };
}

/** After the void: the original untouched, one linked POSTED mirror reversal, nothing else. `originalLines` are the paid journal judgePaid read. */
function judgeReversal(label: string, original: LedgerEvent, originalLines: readonly LedgerLine[], after: LedgerSnapshot): Judgement {
  const violations: string[] = [];
  const unjudged: string[] = [];
  const current = after.events.find((event) => event.id === original.id);
  if (!current) return { violations: [`${label}: the original direct payment ${original.id} is gone from the ledger`], unjudged };
  if (current.eventType !== original.eventType || current.journalEntryId !== original.journalEntryId) {
    violations.push(`${label}: the original direct payment ${original.id} was rewritten`);
  }
  const currentLines = original.journalEntryId ? after.journals[original.journalEntryId] : undefined;
  if (!currentLines) {
    unjudged.push(`${label}: the original journal was not readable after the void`);
  } else if (sortedLines(originalLines).join(",") !== sortedLines(currentLines).join(",")) {
    violations.push(`${label}: the posted journal lines were rewritten instead of reversed`);
  }
  const payments = directPayments(after);
  if (payments.length !== 1) {
    violations.push(`${label}: the void left ${payments.length} direct payment events, expected the original alone (no re-post)`);
  }
  const reversals = after.events.filter((event) => event.eventType === "JOURNAL_REVERSAL");
  if (reversals.length !== 1) {
    violations.push(`${label}: the ledger holds ${reversals.length} reversal events for one direct payment, expected exactly one`);
    return { violations, unjudged };
  }
  const [reversal] = reversals as [LedgerEvent];
  if (reversal.reversalOfEventId !== original.id) {
    violations.push(`${label}: the reversal is not linked to the direct payment it takes back`);
  }
  if (current.status !== "REVERSED" || current.reversedByEventId !== reversal.id) {
    violations.push(`${label}: the original direct payment is not linked to its reversal`);
  }
  if (reversal.status !== "POSTED") violations.push(`${label}: the reversal event is ${reversal.status}, not POSTED`);
  const reversalLines = reversal.journalEntryId ? after.journals[reversal.journalEntryId] : undefined;
  if (!reversalLines) {
    unjudged.push(`${label}: the reversal journal was not readable`);
  } else {
    const mirror = originalLines.map((line) => ({ ...line, debitMinor: line.creditMinor, creditMinor: line.debitMinor }));
    if (sortedLines(reversalLines).join(",") !== sortedLines(mirror).join(",")) {
      violations.push(`${label}: the reversal journal does not mirror the posted journal`);
    }
  }
  return { violations, unjudged };
}

const lineOf = (lines: readonly FeeLineView[], id: string): FeeLineView | undefined => lines.find((line) => line.id === id);

/** The line is live, carries `amountMinor` as its recorded cost, and shows a first-version direct payment of exactly that. */
const isPaidLine = (line: FeeLineView | undefined, amountMinor: number): boolean =>
  line !== undefined && line.actualAmountMinor === amountMinor && line.paymentVersion === 1 && line.paymentAmountMinor === amountMinor;

export function evaluateDirectFeeVoid(observation: FeeVoidObservation): Judgement {
  const { currency, figures, voidedFeeId, survivingFeeId, keyOf, voided, surviving, lines } = observation;
  if (currency === null) {
    return { violations: [], unjudged: ["the organization's currency was not readable, so no amount could be judged"] };
  }
  const amounts = feeVoidAmounts(figures, currency);
  if (!amounts.ok) return { violations: [], unjudged: [amounts.reason] };
  const { voidedMinor, survivingMinor } = amounts;

  const violations: string[] = [];
  const unjudged: string[] = [];
  const fold = (verdict: Judgement) => {
    violations.push(...verdict.violations);
    unjudged.push(...verdict.unjudged);
  };

  // The premise: both costs were really paid directly before the void, on the ledger and on the screen's read.
  const paidVoided = judgePaid("the voided cost", voided.paid, voidedMinor, currency, keyOf);
  const paidSurviving = judgePaid("the surviving cost", surviving.paid, survivingMinor, currency, keyOf);
  fold(paidVoided.judgement);
  fold(paidSurviving.judgement);
  if (
    !isPaidLine(lineOf(lines.beforeVoid, voidedFeeId), voidedMinor) ||
    !isPaidLine(lineOf(lines.beforeVoid, survivingFeeId), survivingMinor)
  ) {
    unjudged.push("the deal's cost lines did not show both costs as recorded and directly paid at the scenario's amounts before the void");
  }
  if (paidVoided.event === null || paidSurviving.event === null || unjudged.length > 0) return { violations, unjudged };

  // The transition: the voided cost's payment is taken back by one linked mirror reversal.
  fold(judgeReversal("the voided cost", paidVoided.event, paidVoided.lines, voided.afterVoid));
  if (lineOf(lines.afterVoid, voidedFeeId) !== undefined) {
    violations.push("the voided cost is still a live line on the deal after the void");
  }

  // Unrelated obligations: the surviving cost's payment, ledger and line are exactly as they were.
  fold(judgeUnchanged("the surviving cost's ledger across the void", surviving.paid, surviving.afterVoid));
  const survivor = lineOf(lines.afterVoid, survivingFeeId);
  if (!isPaidLine(survivor, survivingMinor)) {
    violations.push("the surviving cost lost its recorded amount, its direct payment or its line when the other cost was voided");
  }

  // Idempotency: a repeated void changes nothing, in the ledger or on the deal.
  fold(judgeUnchanged("the voided cost's ledger across the repeated void", voided.afterVoid, voided.afterRepeat));
  fold(judgeUnchanged("the surviving cost's ledger across the repeated void", surviving.afterVoid, surviving.afterRepeat));
  fold(judgeUnchanged("the deal's live cost lines across the repeated void", lines.afterVoid, lines.afterRepeat));
  if (!observation.repeatAccepted) {
    unjudged.push("the product refused the repeated void, so its answer to a retry is not the idempotent one the contract describes");
  }
  return { violations, unjudged };
}
