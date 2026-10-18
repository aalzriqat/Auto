/**
 * SCRUM-350 LIFE-1 — pure STATE_TRANSITION judgement for the deposit-void
 * lifecycle.
 *
 * INVARIANT. Voiding a reservation deposit ("recorded in error") moves exactly
 * that deposit HELD → VOIDED and unwinds exactly its own effects: its receipt
 * in the ledger is reversed once, by a linked mirror, and the car it held is
 * released only if nothing else holds it. It must NOT erase an independently
 * surviving obligation: a second deposit on the same quote and car is customer
 * money still held, so after the void it keeps its row, its hold, its ledger
 * posting, and the car stays reserved.
 *
 * REVERSAL PATHS OF A HELD DEPOSIT (what this mission exercises vs. not):
 *   void (recorded in error)   HELD → VOIDED, receipt reversed    EXERCISED
 *   refund / forfeit           HELD → REFUNDED / FORFEITED        refused after a void (EXERCISED)
 *   apply to a sale, cancel    APPLIED ↔ HELD                     not exercised
 *   forwarded to financier     blocks void and refund             not exercised
 *
 * COUNTEREXAMPLE this scenario can fail on: a void that keys its unwind on the
 * quote, customer or car instead of the deposit — it reverses both receipts
 * (the survivor's ledger shows REVERSED), or frees the car (AVAILABLE) while
 * 300 of the customer's money is still held against it. A void that is merely
 * "idempotent on the voided row" passes every single-deposit check and fails
 * here. A single-deposit mission could not tell the two apart.
 *
 * A judgement proves a breach or says it could not judge; it never passes on a
 * missing or unreadable observation.
 */
import { denominationOf } from "../../convex/utils/money";
import {
  stable,
  type Judgement,
  type LedgerEvent,
  type LedgerLine,
  type LedgerSnapshot,
} from "./browserSwarmBoundaryOracle";

/** The canonical payment behind a deposit, as `subledger.getPaymentBalance` returns it. */
export interface PaymentView {
  id: string;
  status: string;
  amountMinor: number;
  unappliedMinor: number;
}

/** The deposit row as a permission-checked read returns it; `payment` is null when it could not be read. */
export interface DepositView {
  id: string;
  status: string;
  isDeleted: boolean;
  holdActive: boolean;
  amountMinor: number | null;
  releasedAmountMinor: number;
  payment: PaymentView | null;
}

/** Everything one observation reads: both deposits, both ledgers, the car. */
export interface DepositLifecycleState {
  voided: DepositView | null;
  survivor: DepositView | null;
  voidedLedger: LedgerSnapshot;
  survivorLedger: LedgerSnapshot;
  vehicleStatus: string | null;
}

export interface DepositVoidTransitionInput {
  /** Both deposits HELD, both receipts posted, the car reserved. */
  before: DepositLifecycleState;
  /** After the canonical void of the first deposit. */
  afterVoid: DepositLifecycleState;
  /** After the voided deposit was asked to void, refund and forfeit again. */
  afterAttempts: DepositLifecycleState;
  voidedAmountMajor: number;
  survivorAmountMajor: number;
  /** The organization's currency from its settings; null when unreadable. */
  expectedCurrency: string | null;
}

const RECEIVED = "DEPOSIT_RECEIVED";
const REVERSAL = "JOURNAL_REVERSAL";

const merge = (...parts: Judgement[]): Judgement => ({
  violations: [...new Set(parts.flatMap((part) => part.violations))],
  unjudged: [...new Set(parts.flatMap((part) => part.unjudged))],
});

const isMinorUnits = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** A receipt must be a real double entry of exactly the seeded amount, in the organization's currency. */
function judgeReceiptPosting(
  label: string,
  lines: readonly LedgerLine[],
  seededMajor: number,
  expectedCurrency: string | null,
): Judgement {
  if (expectedCurrency === null) {
    return { violations: [], unjudged: [`${label}: the organization's currency was not readable independently`] };
  }
  const denomination = denominationOf(expectedCurrency);
  if (denomination === null) {
    return { violations: [], unjudged: [`${label}: ${expectedCurrency} is not a currency the product supports`] };
  }
  if (lines.length < 2) {
    return { violations: [], unjudged: [`${label}: the receipt had no readable balanced journal`] };
  }
  if (!lines.every((line) => isMinorUnits(line.debitMinor) && isMinorUnits(line.creditMinor) && Number.isInteger(line.scale))) {
    return { violations: [], unjudged: [`${label}: the journal has an amount that is not whole non-negative minor units`] };
  }
  if (new Set(lines.map((line) => line.currency)).size > 1 || new Set(lines.map((line) => line.scale)).size > 1) {
    return { violations: [`${label}: the journal mixes currencies or scales within one posting`], unjudged: [] };
  }
  const first = lines[0]!;
  if (first.currency !== expectedCurrency) {
    return { violations: [`${label}: posted in ${first.currency} but the organization's currency is ${expectedCurrency}`], unjudged: [] };
  }
  if (first.scale !== denomination.scale) {
    return { violations: [`${label}: stored at scale ${first.scale} but ${expectedCurrency} uses scale ${denomination.scale}`], unjudged: [] };
  }
  const debit = lines.reduce((sum, line) => sum + line.debitMinor, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditMinor, 0);
  if (debit !== credit) return { violations: [`${label}: not balanced, debits ${debit} and credits ${credit}`], unjudged: [] };
  const expected = Math.round(seededMajor * 10 ** denomination.scale);
  if (debit !== expected) {
    return { violations: [`${label}: the receipt moves ${debit} minor units but ${expected} were deposited`], unjudged: [] };
  }
  return { violations: [], unjudged: [] };
}

const linesOf = (snapshot: LedgerSnapshot, event: LedgerEvent): readonly LedgerLine[] | undefined =>
  event.journalEntryId ? snapshot.journals[event.journalEntryId] : undefined;

/** The only receipt event a ledger may hold for a deposit, when it holds exactly one. */
function soleReceipt(snapshot: LedgerSnapshot): LedgerEvent | null {
  const receipts = snapshot.events.filter((event) => event.eventType === RECEIVED);
  return receipts.length === 1 ? receipts[0]! : null;
}

const mirrorKeys = (lines: readonly LedgerLine[], swapped: boolean): string[] =>
  lines
    .map((line) =>
      [line.accountId ?? "", swapped ? line.creditMinor : line.debitMinor, swapped ? line.debitMinor : line.creditMinor, line.scale, line.currency].join("|"),
    )
    .sort((left, right) => left.localeCompare(right));

/** The voided deposit's receipt: kept, marked REVERSED, and answered by exactly one linked mirror. */
function judgeVoidedLedger(stage: string, snapshot: LedgerSnapshot, original: LedgerEvent, originalLines: readonly LedgerLine[]): Judgement {
  const violations: string[] = [];
  const unjudged: string[] = [];
  const current = snapshot.events.find((event) => event.id === original.id);
  if (!current) return { violations: [`${stage}: the voided deposit's receipt event ${original.id} is gone from the ledger`], unjudged };
  if (current.eventType !== original.eventType || current.journalEntryId !== original.journalEntryId) {
    violations.push(`${stage}: the voided deposit's receipt event was rewritten`);
  }
  const currentLines = linesOf(snapshot, current);
  if (!currentLines) unjudged.push(`${stage}: the receipt journal was not readable`);
  else if (stable(currentLines) !== stable(originalLines)) violations.push(`${stage}: the receipt journal was rewritten instead of reversed`);

  // Nothing but the receipt and its one linked reversal may exist: a refund or a forfeit
  // event on a voided deposit is money leaving a receipt that was just erased.
  const unexpected = snapshot.events.filter((event) => event.eventType !== RECEIVED && event.eventType !== REVERSAL);
  if (unexpected.length > 0) {
    violations.push(
      `${stage}: the voided deposit's ledger also holds ${unexpected.length} unexpected event${unexpected.length === 1 ? "" : "s"} (${[...new Set(unexpected.map((event) => event.eventType))].join(", ")}); only the receipt and its one linked reversal may exist`,
    );
  }
  const receipts = snapshot.events.filter((event) => event.eventType === RECEIVED);
  if (receipts.length > 1) violations.push(`${stage}: the deposit was received ${receipts.length} times in the ledger`);
  const reversals = snapshot.events.filter((event) => event.eventType === REVERSAL);
  if (reversals.length === 0) return { violations: [...violations, `${stage}: the voided deposit's receipt has no reversal event`], unjudged };
  if (reversals.length > 1) violations.push(`${stage}: the voided deposit's receipt has ${reversals.length} reversal events`);
  const linked = reversals.filter((event) => event.reversalOfEventId === original.id);
  if (reversals.length > linked.length) violations.push(`${stage}: a reversal event is not linked to the voided deposit's receipt`);
  const reversal = linked[0];
  if (!reversal) return { violations: [...violations, `${stage}: no reversal event is linked to the voided deposit's receipt`], unjudged };
  if (current.status !== "REVERSED" || current.reversedByEventId !== reversal.id) {
    violations.push(`${stage}: the receipt is not marked REVERSED by its reversal`);
  }
  if (reversal.status !== "POSTED") violations.push(`${stage}: the reversal event is ${reversal.status}, not POSTED`);
  const reversalLines = linesOf(snapshot, reversal);
  if (!reversalLines) unjudged.push(`${stage}: the reversal journal was not readable`);
  else if (stable(mirrorKeys(reversalLines, false)) !== stable(mirrorKeys(originalLines, true))) {
    violations.push(`${stage}: the reversal journal does not mirror the receipt`);
  }
  return { violations, unjudged };
}

/**
 * LIFE-1 STATE_TRANSITION: the void moved the voided deposit HELD → VOIDED and
 * unwound only its own receipt; the surviving deposit, its receipt and the car's
 * hold are untouched; and asking again — void, refund, forfeit — changes nothing.
 */
export function evaluateDepositVoidTransition(input: DepositVoidTransitionInput): Judgement {
  const { before, afterVoid, afterAttempts, voidedAmountMajor, survivorAmountMajor, expectedCurrency } = input;

  // Preconditions: without two held, posted deposits on a reserved car the
  // scenario never put a surviving obligation beside the voided one.
  const unjudged: string[] = [];
  const voidedReceipt = soleReceipt(before.voidedLedger);
  const survivorReceipt = soleReceipt(before.survivorLedger);
  if (!before.voided || !before.survivor) unjudged.push("a seeded deposit could not be read back before the void");
  else {
    for (const [name, deposit] of [["voided", before.voided], ["surviving", before.survivor]] as const) {
      if (deposit.status !== "HELD" || deposit.isDeleted || !deposit.holdActive) {
        unjudged.push(`the ${name} deposit was not an active HELD deposit before the void (status ${deposit.status})`);
      }
    }
  }
  if (!voidedReceipt || voidedReceipt.status !== "POSTED") unjudged.push("the deposit to be voided has no single POSTED receipt event before the void");
  if (!survivorReceipt || survivorReceipt.status !== "POSTED") unjudged.push("the surviving deposit has no single POSTED receipt event before the void");
  if (before.vehicleStatus !== "RESERVED") {
    unjudged.push(`the car was ${before.vehicleStatus ?? "unreadable"}, not RESERVED, before the void, so its release could not be judged`);
  }
  if (unjudged.length > 0) return { violations: [], unjudged };
  const originalLines = linesOf(before.voidedLedger, voidedReceipt!);
  const survivorLines = linesOf(before.survivorLedger, survivorReceipt!);
  if (!originalLines || !survivorLines) return { violations: [], unjudged: ["a receipt journal was not readable before the void"] };

  const posting = merge(
    judgeReceiptPosting("voided deposit's receipt", originalLines, voidedAmountMajor, expectedCurrency),
    judgeReceiptPosting("surviving deposit's receipt", survivorLines, survivorAmountMajor, expectedCurrency),
  );
  if (posting.unjudged.length > 0) return posting;

  const violations = new Set<string>(posting.violations);
  const notes = new Set<string>();
  const fold = (verdict: Judgement): void => {
    verdict.violations.forEach((entry) => violations.add(entry));
    verdict.unjudged.forEach((entry) => notes.add(entry));
  };

  // The canonical payments behind both deposits, read through the subledger. A payment that
  // could not be read is unjudged: the pass would otherwise say more than was measured.
  const scale = denominationOf(expectedCurrency!)!.scale;
  for (const [name, deposit, major] of [
    ["voided", before.voided!, voidedAmountMajor],
    ["surviving", before.survivor!, survivorAmountMajor],
  ] as const) {
    if (!deposit.payment) {
      notes.add(`the ${name} deposit's canonical payment could not be read before the void`);
    } else if (deposit.payment.status !== "SETTLED") {
      notes.add(`the ${name} deposit's canonical payment was ${deposit.payment.status}, not SETTLED, before the void`);
    } else if (deposit.payment.amountMinor !== Math.round(major * 10 ** scale)) {
      violations.add(`the ${name} deposit's canonical payment holds ${deposit.payment.amountMinor} minor units but ${Math.round(major * 10 ** scale)} were deposited`);
    }
  }

  // The transition itself.
  if (!afterVoid.voided) notes.add("the voided deposit could not be read back after the void");
  else {
    if (afterVoid.voided.status !== "VOIDED") {
      violations.add(`after the void, the voided deposit is ${afterVoid.voided.status}, not VOIDED`);
    } else if (afterVoid.voided.holdActive) {
      violations.add("after the void, the voided deposit still holds its car");
    }
    if (!afterVoid.voided.payment) notes.add("the voided deposit's canonical payment could not be read after the void");
    else if (afterVoid.voided.payment.status !== "VOIDED") {
      violations.add(`after the void, the voided deposit's canonical payment is ${afterVoid.voided.payment.status}, not VOIDED`);
    }
  }
  fold(judgeVoidedLedger("after void", afterVoid.voidedLedger, voidedReceipt!, originalLines));

  // The independently surviving obligation. A field that is unreadable on either side is
  // reported as unjudged and left out of the comparison, never read as a change.
  const survivorPair = maskUnread(before, afterVoid, notes, "after the void", violations);
  if (!afterVoid.survivor) notes.add("the surviving deposit could not be read back after the void");
  else if (stable(survivorPair.survivor.right) !== stable(survivorPair.survivor.left)) {
    violations.add(`the void changed the surviving deposit from ${stable(survivorPair.survivor.left)} to ${stable(survivorPair.survivor.right)}`);
  }
  if (stable(afterVoid.survivorLedger) !== stable(before.survivorLedger)) {
    violations.add("the void changed the surviving deposit's ledger postings (its receipt was reversed or rewritten)");
  }
  if (afterVoid.vehicleStatus === null) {
    notes.add("the car's status could not be read after the void, so its release could not be judged");
  } else if (afterVoid.vehicleStatus !== "RESERVED") {
    violations.add(`the void released the car (${afterVoid.vehicleStatus}) while the surviving deposit still holds it`);
  }

  // Asking again, in every other way the deposit could leave: nothing moves.
  const repeat = maskUnread(afterVoid, afterAttempts, notes, "after the repeated attempts", violations);
  fold(judgeVoidedLedger("after repeated attempts", afterAttempts.voidedLedger, voidedReceipt!, originalLines));
  if (stable(repeat.state) !== stable(repeat.reference)) {
    violations.add("a repeated void, refund or forfeit of the voided deposit changed deposit, ledger or car state");
  }
  if (afterAttempts.voided && afterAttempts.voided.releasedAmountMinor !== 0) {
    violations.add("the voided deposit paid out money after the void");
  }
  return { violations: [...violations], unjudged: [...notes] };
}

type Side = { left: DepositView | null; right: DepositView | null };

/**
 * Pairs two observations with every unreadable field removed from BOTH, so a read that failed on
 * one side is unjudged instead of a difference. Returns the masked states and the survivor pair.
 *
 * A deposit is null only when it is absent from a successful `listByVehicle` read (a failed read
 * throws), so when `vanished` is given, a deposit present in the reference and absent from the
 * state is a proven disappearance and is recorded there as a violation; it is never masked into a
 * pass. Any other one-sided absence, and any one-sided unreadable car, is recorded as unjudged.
 */
function maskUnread(
  reference: DepositLifecycleState,
  state: DepositLifecycleState,
  notes: Set<string>,
  stage: string,
  vanished?: Set<string>,
): { reference: DepositLifecycleState; state: DepositLifecycleState; survivor: Side } {
  const pair = (name: string, a: DepositView | null, b: DepositView | null): [DepositView | null, DepositView | null] => {
    if (!a || !b) {
      if (a && !b && vanished) vanished.add(`the ${name} deposit disappeared ${stage}`);
      else if (a !== b) notes.add(`the ${name} deposit could not be compared ${stage}`);
      return [null, null];
    }
    if (a.payment && b.payment) return [a, b];
    notes.add(`the ${name} deposit's canonical payment could not be read ${stage}`);
    return [{ ...a, payment: null }, { ...b, payment: null }];
  };
  const [voidedA, voidedB] = pair("voided", reference.voided, state.voided);
  const [survivorA, survivorB] = pair("surviving", reference.survivor, state.survivor);
  const carUnread = reference.vehicleStatus === null || state.vehicleStatus === null;
  if (carUnread) notes.add(`the car's status could not be compared ${stage}, so its release could not be judged`);
  const masked = (source: DepositLifecycleState, voided: DepositView | null, survivor: DepositView | null): DepositLifecycleState => ({
    ...source,
    voided,
    survivor,
    vehicleStatus: carUnread ? null : source.vehicleStatus,
  });
  return {
    reference: masked(reference, voidedA, survivorA),
    state: masked(state, voidedB, survivorB),
    survivor: { left: survivorA, right: survivorB },
  };
}
