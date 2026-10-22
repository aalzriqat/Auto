/**
 * SCRUM-350 — pure judgements for the boundary attacks (TENANT_ESCAPE,
 * AUTHORIZATION_ABUSE, COMPLETENESS_BOUNDARY, LIFECYCLE_REVERSAL).
 *
 * Every judgement is decided from a backend refusal or from backend state read
 * through a permission-checked public query. A judgement can prove a breach, or
 * it can say it could not judge; it never passes on a missing, lapsed or
 * unclassified observation (`unjudged` is never empty-handed success).
 */
import { ConvexError } from "convex/values";
import { denominationOf } from "../../convex/utils/money";
import { isAuthenticationLapse } from "./browserSwarmEconomicOracle";

export interface Judgement {
  violations: string[];
  unjudged: string[];
}

const CLEAN: Judgement = { violations: [], unjudged: [] };

// ─── Probing a backend call ───────────────────────────────────────────────────

export type ProbeOutcome =
  | { kind: "ACCEPTED"; value: unknown }
  | { kind: "REFUSED"; message: string }
  | { kind: "LAPSED" }
  | { kind: "UNCLASSIFIED"; message: string };

/**
 * What the product's authorization guards actually say. `requireTenantAuth`
 * raises `Forbidden: Missing required permissions` / `Unauthorized: You are not
 * a member`, `requireOwner` raises `Forbidden: Only the organization owner`, and
 * the membership guards raise `You cannot ...`. A rate limit, a validation
 * failure or a not-found is NOT among them: a call refused for one of those
 * never reached the authorization guard, so it proves nothing about it.
 */
export const AUTHORIZATION_REFUSAL =
  /\b(?:forbidden|unauthori[sz]ed|only (?:the )?(?:organization )?owner|you cannot|not a member|missing required permissions)\b/i;

/**
 * A cross-tenant reference may also be refused as "not found in this organization". The
 * bare words "not found" are NOT accepted: "User not found in the database" and
 * "Membership role not found or corrupted" are a broken attacker account, not a refusal.
 */
export const TENANT_REFUSAL = new RegExp(
  `${AUTHORIZATION_REFUSAL.source}|not found in this organization|organization not found`,
  "i",
);

/** The refusals the expense mutations raise for a posted (ledger-bound) record. */
export const POSTED_HISTORY_REFUSAL = /posted expenses (?:are locked|cannot be deleted)/i;

/**
 * What `reverseExpense` answers a second request: it soft-deletes the expense
 * once it has reversed it, so the only legitimate refusal of a replay is that
 * the expense is gone. A rate limit, a validation failure or a missing
 * permission never reached the reversal and proves nothing about it.
 */
export const REPLAY_REFUSAL = /^Expense not found\.?$/;

export function describeError(error: unknown): string {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string") return data;
    if (typeof data === "object" && data !== null) {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    return "ConvexError";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one backend call and classifies how it ended. Only a ConvexError whose
 * text matches `refusal` is a refusal; a lapsed harness session, a transport
 * failure and any other error stay distinct so the judge can refuse to decide.
 * An aborted mission rethrows: it stops touching the preview.
 */
export async function probe(
  run: () => Promise<unknown>,
  refusal: RegExp,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  try {
    return { kind: "ACCEPTED", value: await run() };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (isAuthenticationLapse(error)) return { kind: "LAPSED" };
    const message = describeError(error);
    if (error instanceof ConvexError && refusal.test(message)) return { kind: "REFUSED", message };
    return { kind: "UNCLASSIFIED", message };
  }
}

function unclassified(label: string, outcome: ProbeOutcome): Judgement {
  return {
    violations: [],
    unjudged: [
      outcome.kind === "LAPSED"
        ? `${label}: the harness session lapsed, so the call proves nothing`
        : `${label}: failed for a reason that is not an authorization refusal${
            outcome.kind === "UNCLASSIFIED" ? ` (${outcome.message})` : ""
          }`,
    ],
  };
}

/** A call the caller must NOT be allowed to make. Acceptance is the breach. */
export function judgeRefusedAttempt(label: string, outcome: ProbeOutcome): Judgement {
  switch (outcome.kind) {
    case "ACCEPTED":
      return { violations: [`${label} was accepted`], unjudged: [] };
    case "REFUSED":
      return CLEAN;
    default:
      return unclassified(label, outcome);
  }
}

function containsAny(value: unknown, needles: readonly string[]): boolean {
  const text = JSON.stringify(value) ?? "";
  return needles.some((needle) => text.includes(needle));
}

/**
 * A read of another organization's data. A refusal and an empty answer both
 * isolate; a response carrying any planted canary is the leak.
 */
export function judgeTenantRead(
  label: string,
  outcome: ProbeOutcome,
  canaries: readonly string[],
): Judgement {
  switch (outcome.kind) {
    case "ACCEPTED":
      if (canaries.length === 0) {
        return { violations: [], unjudged: [`${label}: no canary was planted, so a leak could not be recognised`] };
      }
      return containsAny(outcome.value, canaries)
        ? { violations: [`${label} returned data that belongs to the other organization`], unjudged: [] }
        : CLEAN;
    case "REFUSED":
      return CLEAN;
    default:
      return unclassified(label, outcome);
  }
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** A state a refused attempt must not have moved. An unread state is unjudged. */
export function judgeUnchanged(label: string, before: unknown, after: unknown): Judgement {
  if (before === undefined || after === undefined) {
    return { violations: [], unjudged: [`${label}: the state was not read on both sides of the attempt`] };
  }
  const left = stable(before);
  const right = stable(after);
  return left === right
    ? CLEAN
    : { violations: [`${label} changed from ${left} to ${right}`], unjudged: [] };
}

// ─── List completeness ────────────────────────────────────────────────────────

export interface ListCompletenessInput {
  /** The synthetic rows the attack planted, all sharing the search nonce. */
  seededIds: readonly string[];
  /** Every id of the whole list, in the backend's paging order, from a complete walk. */
  authorityOrder: readonly string[];
  /** Rows the page loads before a user asks for more. */
  firstPageSize: number;
  /** The row ids the page shows once the search has settled. */
  uiIds: readonly string[];
  /** The page did not claim the list is complete: it is still loading or still offering more rows. */
  partialDisclosed: boolean;
}

/**
 * PERF-1: a search on a paginated list must not infer completeness from the
 * first page. The attack plants more matching rows than one page holds; a page
 * that claims to be done (no "Load more") while omitting any of them is the
 * silent truncation. A page that says it is still partial disclosed that, so it is
 * unjudged rather than a breach.
 */
export function evaluateListCompleteness(input: ListCompletenessInput): Judgement {
  const { seededIds, authorityOrder, firstPageSize, uiIds, partialDisclosed } = input;
  if (seededIds.length === 0) {
    return { violations: [], unjudged: ["no rows were seeded, so completeness could not be tested"] };
  }
  const position = new Map(authorityOrder.map((id, index) => [id, index] as const));
  const unread = seededIds.filter((id) => !position.has(id));
  if (unread.length > 0) {
    return {
      violations: [],
      unjudged: [`the authority read did not return ${unread.length} of ${seededIds.length} seeded rows`],
    };
  }
  const beyondFirstPage = seededIds.filter((id) => (position.get(id) ?? 0) >= firstPageSize);
  if (beyondFirstPage.length === 0) {
    return {
      violations: [],
      unjudged: ["no seeded row lies beyond the first page, so the page boundary was not exercised"],
    };
  }
  const shown = new Set(uiIds);
  const omitted = seededIds.filter((id) => !shown.has(id));
  if (omitted.length === 0) return CLEAN;
  if (partialDisclosed) {
    return {
      violations: [],
      unjudged: [
        `the page showed ${seededIds.length - omitted.length} of ${seededIds.length} matching rows but did not claim the list was complete, so the shortfall is disclosed`,
      ],
    };
  }
  return {
    violations: [
      `the page claimed a complete result but omitted ${omitted.length} of ${seededIds.length} matching rows (first-page-only inference)`,
    ],
    unjudged: [],
  };
}

// ─── Reversal reconciliation ──────────────────────────────────────────────────

export interface LedgerEvent {
  id: string;
  eventType: string;
  status: string;
  reversalOfEventId: string | null;
  reversedByEventId: string | null;
  journalEntryId: string | null;
}

export interface LedgerLine {
  accountId: string | null;
  debitMinor: number;
  creditMinor: number;
  scale: number;
  currency: string;
}

export interface LedgerSnapshot {
  events: readonly LedgerEvent[];
  /** Journal lines by journal entry id; an entry that could not be read is absent. */
  journals: Readonly<Record<string, readonly LedgerLine[]>>;
}

const lineKey = (line: LedgerLine, swapped: boolean): string =>
  [
    line.accountId ?? "",
    swapped ? line.creditMinor : line.debitMinor,
    swapped ? line.debitMinor : line.creditMinor,
    line.scale,
    line.currency,
  ].join("|");

const sortedKeys = (lines: readonly LedgerLine[], swapped: boolean): string[] =>
  lines.map((line) => lineKey(line, swapped)).sort((left, right) => left.localeCompare(right));

function inspectLedger(
  stage: string,
  snapshot: LedgerSnapshot,
  original: LedgerEvent,
  originalLines: readonly LedgerLine[],
): Judgement {
  const violations: string[] = [];
  const unjudged: string[] = [];

  const current = snapshot.events.find((event) => event.id === original.id);
  if (!current) {
    violations.push(`${stage}: the original posted event ${original.id} is gone from the ledger`);
    return { violations, unjudged };
  }
  if (current.eventType !== original.eventType || current.journalEntryId !== original.journalEntryId) {
    violations.push(`${stage}: the original posted event ${original.id} was rewritten`);
  }

  const currentLines = original.journalEntryId ? snapshot.journals[original.journalEntryId] : undefined;
  if (!currentLines) {
    unjudged.push(`${stage}: journal ${original.journalEntryId} was not readable`);
  } else if (stable(currentLines) !== stable(originalLines)) {
    violations.push(`${stage}: the posted journal lines were rewritten instead of reversed`);
  }

  // The snapshot is scoped to this one expense, so ANY reversal or further
  // posting in it is a footprint of the attack, whatever it claims to reverse.
  const additionalPostings = snapshot.events.filter(
    (event) => event.eventType === "EXPENSE_POSTED" && event.id !== original.id,
  );
  if (additionalPostings.length > 0) {
    violations.push(`${stage}: the expense was posted again (${additionalPostings.length} additional posting events)`);
  }
  const allReversals = snapshot.events.filter((event) => event.eventType === "JOURNAL_REVERSAL");
  if (allReversals.length === 0) {
    violations.push(`${stage}: the ledger holds no reversal event for the posted event`);
    return { violations, unjudged };
  }
  if (allReversals.length > 1) {
    violations.push(`${stage}: the ledger holds ${allReversals.length} reversal events for one posted event`);
  }
  const reversals = allReversals.filter((event) => event.reversalOfEventId === original.id);
  const stray = allReversals.length - reversals.length;
  if (stray > 0) {
    violations.push(`${stage}: ${stray} reversal event${stray === 1 ? " is" : "s are"} not linked to the posted event`);
  }
  if (reversals.length === 0) {
    violations.push(`${stage}: the ledger holds no reversal event linked to the posted event`);
    return { violations, unjudged };
  }
  const reversal = reversals[0]!;
  if (current.status !== "REVERSED" || current.reversedByEventId !== reversal.id) {
    violations.push(`${stage}: the original event ${original.id} is not linked to its reversal`);
  }
  if (reversal.status !== "POSTED") {
    violations.push(`${stage}: the reversal event ${reversal.id} is ${reversal.status}, not POSTED`);
  }
  const reversalLines = reversal.journalEntryId ? snapshot.journals[reversal.journalEntryId] : undefined;
  if (!reversalLines) {
    unjudged.push(`${stage}: journal ${reversal.journalEntryId} was not readable`);
  } else if (stable(sortedKeys(reversalLines, false)) !== stable(sortedKeys(originalLines, true))) {
    violations.push(`${stage}: the reversal journal does not mirror the posted journal`);
  }
  return { violations, unjudged };
}

const isMinorUnits = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The expense's original posting must be a real double entry of the seeded
 * amount: finite whole amounts, one currency at that currency's scale, debits
 * equal to credits, and the seeded effect. Without this an unbalanced or zero
 * posting and its exact mirror would reconcile.
 */
function judgePosting(lines: readonly LedgerLine[], seededAmount: number, expectedCurrency: string | null): Judgement {
  // The denomination comes from the organization, never from the journal being judged.
  if (expectedCurrency === null) {
    return {
      violations: [],
      unjudged: ["the organization's currency was not readable independently, so the posting's denomination could not be judged"],
    };
  }
  const denomination = denominationOf(expectedCurrency);
  if (denomination === null) {
    return { violations: [], unjudged: [`the organization's currency ${expectedCurrency} is not one the product supports`] };
  }
  if (lines.length < 2) {
    return { violations: [], unjudged: ["the expense's posted event had no readable balanced journal before the reversal"] };
  }
  if (!lines.every((line) => isMinorUnits(line.debitMinor) && isMinorUnits(line.creditMinor) && Number.isInteger(line.scale))) {
    return {
      violations: [],
      unjudged: ["the posted journal has an amount that is not a whole non-negative number of minor units"],
    };
  }
  const currencies = new Set(lines.map((line) => line.currency));
  const scales = new Set(lines.map((line) => line.scale));
  if (currencies.size > 1 || scales.size > 1) {
    return { violations: ["the posted journal mixes currencies or scales within one posting"], unjudged: [] };
  }
  const first = lines[0]!;
  if (first.currency !== expectedCurrency) {
    return {
      violations: [`the expense was posted in ${first.currency} but the organization's currency is ${expectedCurrency}`],
      unjudged: [],
    };
  }
  if (denomination.scale !== first.scale) {
    return {
      violations: [`the posted journal is stored at scale ${first.scale} but ${expectedCurrency} uses scale ${denomination.scale}`],
      unjudged: [],
    };
  }
  const debit = lines.reduce((sum, line) => sum + line.debitMinor, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditMinor, 0);
  if (debit !== credit) {
    return { violations: [`the posted journal is not balanced: debits ${debit}, credits ${credit}`], unjudged: [] };
  }
  if (debit === 0) return { violations: ["the posted journal is a zero posting"], unjudged: [] };
  const expected = Math.round(seededAmount * 10 ** denomination.scale);
  if (debit !== expected) {
    return {
      violations: [`the posted journal moves ${debit} minor units but the seeded expense is ${expected}`],
      unjudged: [],
    };
  }
  return CLEAN;
}

/**
 * ACC-2: posted history is immutable and a correction is the canonical, linked,
 * mirrored reversal, exactly once. `posted` is the ledger after the expense was
 * posted, `reversed` after the canonical reversal, `replayed` after the
 * reversal was asked for again. The posted snapshot must itself be a real
 * ledger posting, or the attack never exercised a posted record.
 */
export function evaluateReversalReconciliation(input: {
  posted: LedgerSnapshot;
  reversed: LedgerSnapshot;
  replayed: LedgerSnapshot;
  /** The synthetic expense's amount in major units; the posting must carry exactly this. */
  seededAmount: number;
  /** The organization's currency from its settings; null when that read was not possible. */
  expectedCurrency: string | null;
}): Judgement {
  const { posted, reversed, replayed, seededAmount, expectedCurrency } = input;
  const postedEvents = posted.events.filter((event) => event.eventType === "EXPENSE_POSTED");
  if (postedEvents.length !== 1) {
    return {
      violations: [],
      unjudged: [
        postedEvents.length === 0
          ? "the expense was never posted to the ledger, so there was no posted history to protect"
          : `the expense produced ${postedEvents.length} posted events before any reversal`,
      ],
    };
  }
  const original = postedEvents[0]!;
  const originalLines = original.journalEntryId ? posted.journals[original.journalEntryId] : undefined;
  if (original.status !== "POSTED" || !originalLines) {
    return {
      violations: [],
      unjudged: ["the expense's posted event had no readable balanced journal before the reversal"],
    };
  }
  const posting = judgePosting(originalLines, seededAmount, expectedCurrency);
  if (posting.unjudged.length > 0) return posting;

  const stages: [string, LedgerSnapshot][] = [["after reversal", reversed]];
  if (stable(replayed) !== stable(reversed)) stages.push(["after replay", replayed]);
  const violations = new Set<string>(posting.violations);
  const unjudged = new Set<string>();
  for (const [stage, snapshot] of stages) {
    const verdict = inspectLedger(stage, snapshot, original, originalLines);
    verdict.violations.forEach((entry) => violations.add(entry));
    verdict.unjudged.forEach((entry) => unjudged.add(entry));
  }
  return { violations: [...violations], unjudged: [...unjudged] };
}
