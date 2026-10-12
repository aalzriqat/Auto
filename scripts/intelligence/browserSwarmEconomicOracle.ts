/**
 * SCRUM-826 — deterministic economic oracles for the DUPLICATE_SUBMIT and
 * MULTI_TAB_RACE browser attacks.
 *
 * These judge BACKEND authority only. The browser drives the attack; the
 * verdict comes from what the backend actually recorded: operational rows,
 * accounting events, the durable posting outbox and the journal lines.
 *
 * Three outcomes, never conflated:
 *   - passed: true             exactly one authorized economic effect
 *   - passed: false            a reproduced product breach (violations named)
 *   - BrowserSwarmOracleInconclusiveError
 *                              the evidence could not decide (truncated read,
 *                              unreadable journal, unvouched currency). The
 *                              executor turns this into HARNESS_ERROR, which
 *                              fails the run — it is never a pass.
 */

import { ConvexError } from "convex/values";
import { denominationOf } from "../../convex/utils/money";

export class BrowserSwarmOracleInconclusiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSwarmOracleInconclusiveError";
  }
}

export interface ExpenseRow {
  id: string;
  title: string;
  amount: number;
  status: string;
}

export interface AccountingEventRow {
  id: string;
  sourceId: string;
  eventType: string;
  status: string;
  idempotencyKey: string;
  journalEntryId?: string | null;
}

export interface OutboxRow {
  id: string;
  kind: string;
  status: string;
  idempotencyKey: string;
  payload?: { amountMinor?: unknown; currency?: unknown } | null;
}

export interface JournalLineRow {
  debitMinor: number;
  creditMinor: number;
  scale: number;
  /** The line's own denomination; its scale is vouched against it, never trusted. */
  currency: string;
}

export interface JournalRow {
  entryId: string;
  lines: readonly JournalLineRow[];
}

export interface ExpenseEffectSnapshot {
  title: string;
  expenses: readonly ExpenseRow[];
  events: readonly AccountingEventRow[];
  /** Outbox rows that are PENDING or FAILED (POSTED rows are already events). */
  openOutbox: readonly OutboxRow[];
  journals: readonly JournalRow[];
}

export interface ExpenseSingleEffectVerdict {
  passed: boolean;
  violations: string[];
  expenseId: string | null;
  postingMode: "POSTED" | "QUEUED" | null;
  ledgerAmountMinor: number | null;
}

export function expensePostedIdempotencyKey(expenseId: string): string {
  return "expense_posted_" + expenseId;
}

function toMinor(amount: number, scale: number): number {
  return Math.round(amount * 10 ** scale);
}

/**
 * Exactly one expense with this title, in the expected state, with exactly
 * one economic posting (posted journal XOR open queued post) whose amount
 * equals the authoritative expense amount, balanced, and not dead-lettered.
 */
export function evaluateExpenseSingleEffect(
  snapshot: ExpenseEffectSnapshot,
  expected: { amount: number; status: "PAID" | "PENDING" },
): ExpenseSingleEffectVerdict {
  const violations: string[] = [];
  const matches = snapshot.expenses.filter((row) => row.title === snapshot.title);
  const verdict = (
    expenseId: string | null,
    postingMode: ExpenseSingleEffectVerdict["postingMode"],
    ledgerAmountMinor: number | null,
  ): ExpenseSingleEffectVerdict => ({
    passed: violations.length === 0,
    violations,
    expenseId,
    postingMode,
    ledgerAmountMinor,
  });

  if (matches.length !== 1) {
    violations.push(
      `expected exactly 1 expense record for this intent; backend holds ${matches.length} expense records`,
    );
    return verdict(null, null, null);
  }
  const expense = matches[0];
  if (expense.amount !== expected.amount) {
    violations.push(
      `authoritative expense amount ${expense.amount} does not equal the intended ${expected.amount}`,
    );
  }
  if (expense.status !== expected.status) {
    violations.push(
      `authoritative expense status ${expense.status} does not equal the intended ${expected.status}`,
    );
  }

  const key = expensePostedIdempotencyKey(expense.id);
  const events = snapshot.events.filter(
    (row) => row.sourceId === expense.id && row.eventType === "EXPENSE_POSTED",
  );
  const postedEvents = events.filter((row) => row.status === "POSTED");
  const open = snapshot.openOutbox.filter(
    (row) => row.kind === "POST" && row.idempotencyKey === key,
  );

  if (expense.status !== "PAID") {
    if (postedEvents.length + open.length > 0) {
      violations.push(
        `an unpaid expense carries ${postedEvents.length + open.length} economic postings`,
      );
    }
    return verdict(expense.id, null, null);
  }

  for (const row of open) {
    if (row.status === "FAILED") {
      violations.push(
        `the expense posting ${row.id} is dead-lettered (FAILED) instead of posted or retrying`,
      );
    }
  }
  const effectCount = postedEvents.length + open.length;
  if (effectCount !== 1) {
    violations.push(
      `expected exactly 1 economic posting for the expense; found ${effectCount} economic postings (${postedEvents.length} posted, ${open.length} queued)`,
    );
    return verdict(expense.id, null, null);
  }

  if (postedEvents.length === 1) {
    const event = postedEvents[0];
    const journal = snapshot.journals.find(
      (entry) => entry.entryId === event.journalEntryId,
    );
    if (!event.journalEntryId || !journal) {
      throw new BrowserSwarmOracleInconclusiveError(
        `posted event ${event.id} has no readable journal; the ledger effect cannot be judged`,
      );
    }
    if (journal.lines.length === 0) {
      throw new BrowserSwarmOracleInconclusiveError(
        `journal ${journal.entryId} has no lines; the ledger effect cannot be judged`,
      );
    }
    const currencies = new Set(journal.lines.map((line) => line.currency));
    if (currencies.size !== 1) {
      throw new BrowserSwarmOracleInconclusiveError(
        `journal ${journal.entryId} mixes currencies (${[...currencies].join(", ")})`,
      );
    }
    const currency = journal.lines[0].currency;
    // The journal's own scale only agrees with itself. The expected minor
    // amount comes from the backend's canonical denomination rule for the
    // line's currency; an unvouched code is inconclusive, a line written at a
    // different scale is a misposted ledger amount (SCRUM-826 F1).
    const scale = denominationOf(currency)?.scale;
    if (scale === undefined) {
      throw new BrowserSwarmOracleInconclusiveError(
        `journal ${journal.entryId} carries currency ${currency} with no vouched minor-unit scale`,
      );
    }
    const misScaled = journal.lines.filter((line) => line.scale !== scale);
    if (misScaled.length > 0) {
      violations.push(
        `journal ${journal.entryId} records ${misScaled.length} line(s) at scale ${misScaled[0].scale} for ${currency}, whose canonical scale is ${scale}`,
      );
      return verdict(expense.id, "POSTED", null);
    }
    const debit = journal.lines.reduce((sum, line) => sum + line.debitMinor, 0);
    const credit = journal.lines.reduce((sum, line) => sum + line.creditMinor, 0);
    if (debit !== credit) {
      violations.push(
        `journal ${journal.entryId} is unbalanced: debits ${debit} vs credits ${credit}`,
      );
    }
    const expectedMinor = toMinor(expense.amount, scale);
    if (debit !== expectedMinor) {
      violations.push(
        `ledger amount ${debit} does not equal the authoritative expense amount ${expectedMinor}`,
      );
    }
    return verdict(expense.id, "POSTED", debit);
  }

  const queued = open[0];
  const currency = queued.payload?.currency;
  const amountMinor = queued.payload?.amountMinor;
  // The backend's own canonical denomination rule: an unrecognised or
  // non-canonical code makes the oracle inconclusive, never a guessed scale.
  const scale =
    typeof currency === "string" ? denominationOf(currency)?.scale : undefined;
  if (scale === undefined) {
    throw new BrowserSwarmOracleInconclusiveError(
      `queued posting ${queued.id} carries currency ${String(currency)} with no vouched minor-unit scale`,
    );
  }
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor)) {
    throw new BrowserSwarmOracleInconclusiveError(
      `queued posting ${queued.id} carries no integer amountMinor`,
    );
  }
  const expectedMinor = toMinor(expense.amount, scale);
  if (amountMinor !== expectedMinor) {
    violations.push(
      `queued ledger amount ${amountMinor} does not equal the authoritative expense amount ${expectedMinor}`,
    );
  }
  return verdict(expense.id, "QUEUED", amountMinor);
}

export type TabOutcome =
  | { outcome: "SUCCESS"; message?: string }
  | { outcome: "REFUSED"; message: string }
  | { outcome: "UNKNOWN"; message?: string };

/**
 * Observer-assigned sequence numbers for one tab's save: when its mutation
 * frame was forwarded to the backend and when the backend's response came
 * back. A shared monotonic counter across both tabs' sockets.
 */
export interface RaceOrderingRow {
  tab: string;
  sentSeq: number | null;
  responseSeq: number | null;
}

export interface ConcurrentEditRaceInput {
  /**
   * Evidence that the race was actually run: both saves were in flight before
   * either was answered. Without it a fully serialized edit sequence produces
   * the same outcomes as a race and would PASS vacuously (SCRUM-826 F2).
   */
  ordering: readonly RaceOrderingRow[];
  tabs: readonly ({ tab: string; intendedAmount: number } & TabOutcome)[];
  authoritative: { amount: number; status: string };
  /** The losing tab submitting its stale form again after the race. */
  staleRetry: TabOutcome;
}

export interface ConcurrentEditRaceVerdict {
  passed: boolean;
  violations: string[];
  winner: string | null;
  winningAmount: number | null;
}

/**
 * The only lawful refusal of the losing tab: the backend's posting lock. Any
 * other refusal (rate limit, auth, network) means the race was not actually
 * exercised, which is inconclusive — never a pass.
 */
const POSTING_LOCK_REFUSAL = /Posted expenses are locked/;

/**
 * CONC-1 / ECON-2: two tabs edited the same pending expense into PAID with
 * different amounts and saved concurrently. Exactly one may win; the backend
 * must hold exactly the winner's value; the loser and its stale retry must be
 * refused by the posting lock rather than silently overwrite posted money.
 */
export function evaluateConcurrentEditRace(
  input: ConcurrentEditRaceInput,
): ConcurrentEditRaceVerdict {
  for (const tab of input.tabs) {
    if (tab.outcome === "UNKNOWN") {
      throw new BrowserSwarmOracleInconclusiveError(
        `tab ${tab.tab} produced no observable outcome; the race cannot be judged`,
      );
    }
    if (tab.outcome === "REFUSED" && !POSTING_LOCK_REFUSAL.test(tab.message)) {
      throw new BrowserSwarmOracleInconclusiveError(
        `tab ${tab.tab} was refused for a reason other than the posting lock (${tab.message}); the race was not exercised`,
      );
    }
  }
  const sentSeqs: number[] = [];
  const responseSeqs: number[] = [];
  for (const tab of input.tabs) {
    const order = input.ordering.find((row) => row.tab === tab.tab);
    if (
      !order ||
      typeof order.sentSeq !== "number" ||
      typeof order.responseSeq !== "number"
    ) {
      throw new BrowserSwarmOracleInconclusiveError(
        `tab ${tab.tab} has no recorded send/response order; overlap cannot be proven`,
      );
    }
    sentSeqs.push(order.sentSeq);
    responseSeqs.push(order.responseSeq);
  }
  if (Math.max(...sentSeqs) > Math.min(...responseSeqs)) {
    throw new BrowserSwarmOracleInconclusiveError(
      "the concurrent saves did not overlap: one tab was answered before the other tab's save was sent, so this was a sequential edit, not a race",
    );
  }
  if (input.staleRetry.outcome === "UNKNOWN") {
    throw new BrowserSwarmOracleInconclusiveError(
      "the stale retry produced no observable outcome",
    );
  }
  if (
    input.staleRetry.outcome === "REFUSED" &&
    !POSTING_LOCK_REFUSAL.test(input.staleRetry.message)
  ) {
    throw new BrowserSwarmOracleInconclusiveError(
      `the stale retry was refused for a reason other than the posting lock (${input.staleRetry.message})`,
    );
  }

  const violations: string[] = [];
  const winners = input.tabs.filter((tab) => tab.outcome === "SUCCESS");
  if (winners.length !== 1) {
    violations.push(
      `expected exactly one tab to win the concurrent save; ${winners.length} tabs reported success`,
    );
  }
  const winner = winners.length === 1 ? winners[0] : null;
  if (winner && winner.intendedAmount !== input.authoritative.amount) {
    violations.push(
      `tab ${winner.tab} was told it saved ${winner.intendedAmount} but the backend holds ${input.authoritative.amount}`,
    );
  }
  if (winner && input.authoritative.status !== "PAID") {
    violations.push(
      `tab ${winner.tab} was told it saved a payment but the backend status is ${input.authoritative.status}`,
    );
  }
  if (input.staleRetry.outcome === "SUCCESS") {
    violations.push(
      "the losing tab's stale retry was accepted after the expense had been posted",
    );
  }
  return {
    passed: violations.length === 0,
    violations,
    winner: winner?.tab ?? null,
    winningAmount: winner?.intendedAmount ?? null,
  };
}

export interface CommandIdentityVerdict {
  passed: boolean;
  violations: string[];
  key: string | null;
}

/**
 * ECON-2: every transmitted attempt of ONE user intent must carry ONE client
 * command identity. Per-attempt minting is the defect that lets a retry
 * become a second economic effect.
 */
export function evaluateCommandIdentityLifetime(
  keys: readonly (string | undefined | null)[],
): CommandIdentityVerdict {
  if (keys.length === 0) {
    throw new BrowserSwarmOracleInconclusiveError(
      "no transmitted attempt of the intent was observed; identity lifetime cannot be judged",
    );
  }
  const violations: string[] = [];
  const missing = keys.filter((key) => typeof key !== "string" || key.length === 0).length;
  if (missing > 0) {
    violations.push(`${missing} attempt(s) were transmitted without a command identity`);
  }
  const distinct = [
    ...new Set(keys.filter((key): key is string => typeof key === "string" && key.length > 0)),
  ];
  if (distinct.length > 1) {
    violations.push(
      `one intent was transmitted under ${distinct.length} distinct command identities`,
    );
  }
  return {
    passed: violations.length === 0,
    violations,
    key: distinct.length === 1 ? distinct[0] : null,
  };
}

/** One backend reply to a transmitted attempt of an intent. */
export interface IntentReplyRow {
  requestId: number;
  success: boolean;
  /** True only for the reply the harness withheld to simulate a lost response. */
  withheld: boolean;
  errorText?: string;
}

export interface IntentRepliesVerdict {
  violations: string[];
  /** Client-visible refusals of an attempt of this intent. */
  refused: number;
  /**
   * Replies refused because the session had lapsed (SCRUM-826 P2). Not judged
   * as product refusals; the caller must treat any as an inconclusive run.
   */
  authenticationLapses: number;
}

export const FINGERPRINT_CONFLICT_TEXT = /Idempotency key reused with different request content/;

/**
 * ECON-2 (SCRUM-826 O1): every transmitted attempt of ONE user intent must be
 * accepted as that intent — the first commits, every retry replays it. A
 * client-visible refusal of any attempt is a breach: the user was told the
 * save failed (and a fingerprint refusal means the client recomputed a
 * fingerprinted input from a volatile value). The reply the harness itself
 * withheld never reached the client and is not judged.
 */
export function evaluateIntentReplies(
  title: string,
  replies: readonly IntentReplyRow[],
): IntentRepliesVerdict {
  const violations: string[] = [];
  let authenticationLapses = 0;
  for (const reply of replies) {
    if (reply.withheld || reply.success) continue;
    const text = reply.errorText ?? "";
    if (AUTHENTICATION_LAPSE_TEXT.test(text)) {
      authenticationLapses += 1;
      continue;
    }
    violations.push(
      FINGERPRINT_CONFLICT_TEXT.test(text)
        ? `${title}: attempt ${reply.requestId} was refused with a fingerprint conflict on a same-intent retry: ${text}`
        : `${title}: attempt ${reply.requestId} was refused: ${text || "(no error text)"}`,
    );
  }
  return { violations, refused: violations.length, authenticationLapses };
}

export type ServerReplayFailure = "BACKEND_REFUSED" | "UNIDENTIFIED";

/**
 * SCRUM-826 O2/R1: a server-side replay that fails is a product verdict only
 * when the backend itself refused it. ConvexHttpClient raises ConvexError
 * exclusively for an application refusal returned by the deployment; a
 * transport, HTTP or unidentified failure stays inconclusive (never a pass,
 * never a fabricated breach).
 */
export function classifyServerReplayFailure(error: unknown): ServerReplayFailure {
  if (!(error instanceof ConvexError)) return "UNIDENTIFIED";
  // SCRUM-826 P2: the harness's own session lapsing is not a product verdict.
  return isAuthenticationLapse(error) ? "UNIDENTIFIED" : "BACKEND_REFUSED";
}

/**
 * SCRUM-826 P2: requireTenantAuth throws ConvexError({code:"UNAUTHENTICATED"})
 * when the caller's session token is missing or expired. During an attack the
 * same principal has just acted successfully, so this means the harness lost
 * its session — inconclusive, never a product refusal and never a pass. An
 * authorization refusal (UNAUTHORIZED/FORBIDDEN) of that same principal stays
 * a product verdict.
 */
export function isAuthenticationLapse(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === "UNAUTHENTICATED"
  );
}

/** The serialized errorData of a socket MutationResponse for a lapsed session. */
export const AUTHENTICATION_LAPSE_TEXT = /"code":"UNAUTHENTICATED"/;

export type IntentExercise = "EXERCISED" | "PRODUCT_REFUSED" | "NOT_EXERCISED";

/**
 * SCRUM-826 O2: separates a product refusal from a harness that never
 * exercised the attack. An intent the client confirmed, or that the backend
 * holds more than once, was exercised. An unconfirmed intent with a
 * client-visible refusal is a PRODUCT verdict (the backend said no), never a
 * harness error. Only an unconfirmed, unrefused intent is NOT_EXERCISED.
 */
export function classifyIntentExercise(input: {
  uiConfirmed: boolean;
  backendRecords: number;
  refusedReplies: number;
}): IntentExercise {
  if (input.uiConfirmed || input.backendRecords > 1) return "EXERCISED";
  if (input.refusedReplies > 0) return "PRODUCT_REFUSED";
  return "NOT_EXERCISED";
}

export type LedgerDecision =
  | { kind: "BREACH"; violations: string[]; unjudged: string[] }
  | { kind: "INCONCLUSIVE"; reason: string; unjudged: string[] }
  | { kind: "PASS" };

/**
 * SCRUM-826 S1/C-2 (redesign after the convergence circuit breaker): the one
 * place a multi-phase attack's verdict is decided, independent of the order
 * in which proof and unjudgeable conditions were observed.
 *
 *   any proof                → BREACH (with every unjudged reason attached)
 *   no proof, any unjudged   → INCONCLUSIVE (never a pass)
 *   neither                  → PASS
 *
 * Proof is recorded the moment it is observed and is never retracted; a
 * later lapse, stall or harness failure can only add unjudged reasons.
 */
export class VerdictLedger {
  private readonly proofs = new Set<string>();
  private readonly reasons = new Set<string>();

  prove(...violations: readonly string[]): void {
    for (const violation of violations) this.proofs.add(violation);
  }

  unjudgeable(reason: string): void {
    this.reasons.add(reason);
  }

  get proven(): string[] {
    return [...this.proofs];
  }

  get unjudged(): string[] {
    return [...this.reasons];
  }

  decide(): LedgerDecision {
    const unjudged = this.unjudged;
    if (this.proofs.size > 0) return { kind: "BREACH", violations: this.proven, unjudged };
    if (unjudged.length > 0) return { kind: "INCONCLUSIVE", reason: unjudged.join("; "), unjudged };
    return { kind: "PASS" };
  }
}
