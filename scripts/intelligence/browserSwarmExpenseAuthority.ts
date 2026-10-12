/**
 * SCRUM-826 — bounded, exhaustive backend authority reads for one expense
 * intent. Every read is either provably complete or the whole snapshot is
 * inconclusive: a truncated page can hide a duplicate, so it can never count
 * toward a pass.
 */
import {
  BrowserSwarmOracleInconclusiveError,
  expensePostedIdempotencyKey,
  type AccountingEventRow,
  type ExpenseEffectSnapshot,
  type ExpenseRow,
  type JournalRow,
  type OutboxRow,
} from "./browserSwarmEconomicOracle";

export const EXPENSE_AUTHORITY_PAGE_SIZE = 100;
/** The server-side cap of listAccountingEvents / accountingOutbox.listPending. */
export const EXPENSE_AUTHORITY_ROW_LIMIT = 200;
/** Expense pages read before the list is declared non-terminating. */
export const EXPENSE_AUTHORITY_MAX_PAGES = 50;

export interface ExpenseAuthorityRefs {
  listExpenses: unknown;
  listAccountingEvents: unknown;
  listPendingOutbox: unknown;
  getJournalEntry: unknown;
}

export interface ExpenseAuthorityClient {
  // Typed loosely on purpose: the swarm passes the generated function
  // references to a ConvexHttpClient; the unit tests pass string tokens.
  query(ref: never, args: never): Promise<unknown>;
}

type LooseClient = { query(ref: unknown, args: Record<string, unknown>): Promise<unknown> };

function inconclusive(message: string): never {
  throw new BrowserSwarmOracleInconclusiveError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) inconclusive(`${label} returned a non-array response`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") inconclusive(`${label} carried a non-string field`);
  return value;
}

async function readAllExpenses(
  client: LooseClient,
  refs: ExpenseAuthorityRefs,
  orgId: string,
  title: string,
): Promise<ExpenseRow[]> {
  const rows: ExpenseRow[] = [];
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < EXPENSE_AUTHORITY_MAX_PAGES; pageIndex += 1) {
    const result = await client.query(refs.listExpenses, {
      orgId,
      paginationOpts: { numItems: EXPENSE_AUTHORITY_PAGE_SIZE, cursor },
    });
    if (!isRecord(result) || typeof result.isDone !== "boolean") {
      inconclusive("expenses.list returned a malformed page");
    }
    for (const raw of asArray(result.page, "expenses.list page")) {
      if (!isRecord(raw)) inconclusive("expenses.list returned a malformed row");
      if (raw.title !== title) continue;
      if (typeof raw.amount !== "number") inconclusive("expense row has no numeric amount");
      rows.push({
        id: asString(raw._id, "expense row id"),
        title,
        amount: raw.amount,
        status: asString(raw.status, "expense row status"),
      });
    }
    if (result.isDone) return rows;
    cursor = asString(result.continueCursor, "expenses.list continueCursor");
  }
  return inconclusive(
    `expenses.list did not terminate within ${EXPENSE_AUTHORITY_MAX_PAGES} pages`,
  );
}

async function readEvents(
  client: LooseClient,
  refs: ExpenseAuthorityRefs,
  orgId: string,
  expenseId: string,
): Promise<AccountingEventRow[]> {
  const raw = asArray(
    await client.query(refs.listAccountingEvents, {
      orgId,
      sourceType: "expenses",
      sourceId: expenseId,
      limit: EXPENSE_AUTHORITY_ROW_LIMIT,
    }),
    "listAccountingEvents",
  );
  if (raw.length >= EXPENSE_AUTHORITY_ROW_LIMIT) {
    inconclusive(`accounting events for expense ${expenseId} may be truncated`);
  }
  return raw.map((row) => {
    if (!isRecord(row)) inconclusive("listAccountingEvents returned a malformed row");
    return {
      id: asString(row._id, "event id"),
      sourceId: expenseId,
      eventType: asString(row.eventType, "event type"),
      status: asString(row.status, "event status"),
      idempotencyKey: asString(row.idempotencyKey, "event idempotencyKey"),
      journalEntryId:
        typeof row.journalEntryId === "string" ? row.journalEntryId : null,
    };
  });
}

async function readOpenOutbox(
  client: LooseClient,
  refs: ExpenseAuthorityRefs,
  orgId: string,
  keys: ReadonlySet<string>,
): Promise<OutboxRow[]> {
  const rows: OutboxRow[] = [];
  for (const status of ["PENDING", "FAILED"] as const) {
    const raw = asArray(
      await client.query(refs.listPendingOutbox, {
        orgId,
        status,
        limit: EXPENSE_AUTHORITY_ROW_LIMIT,
      }),
      "accountingOutbox.listPending",
    );
    if (raw.length >= EXPENSE_AUTHORITY_ROW_LIMIT) {
      inconclusive(`the ${status} outbox may be truncated; a duplicate could be hidden`);
    }
    for (const row of raw) {
      if (!isRecord(row)) inconclusive("listPending returned a malformed row");
      const key = asString(row.idempotencyKey, "outbox idempotencyKey");
      if (!keys.has(key)) continue;
      const kind = asString(row.kind, "outbox kind");
      if (kind !== "POST") continue;
      rows.push({
        id: asString(row._id, "outbox id"),
        kind,
        status: asString(row.status, "outbox status"),
        idempotencyKey: key,
        payload: isRecord(row.payload)
          ? { amountMinor: row.payload.amountMinor, currency: row.payload.currency }
          : null,
      });
    }
  }
  return rows;
}

async function readJournal(
  client: LooseClient,
  refs: ExpenseAuthorityRefs,
  orgId: string,
  journalEntryId: string,
): Promise<JournalRow | null> {
  const result = await client.query(refs.getJournalEntry, { orgId, journalEntryId });
  if (result === null) return null;
  if (!isRecord(result)) inconclusive("getJournalEntry returned a malformed response");
  const lines = asArray(result.lines, "journal lines").map((line) => {
    if (
      !isRecord(line) ||
      typeof line.debitMinor !== "number" ||
      typeof line.creditMinor !== "number" ||
      typeof line.scale !== "number" ||
      typeof line.currency !== "string"
    ) {
      inconclusive(`journal ${journalEntryId} has a malformed line`);
    }
    return {
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      scale: line.scale,
      currency: line.currency,
    };
  });
  return { entryId: journalEntryId, lines };
}

/** One complete authority snapshot of every row an expense intent can leave. */
export async function readExpenseEffectSnapshot(
  client: ExpenseAuthorityClient | LooseClient,
  { orgId, title, refs }: { orgId: string; title: string; refs: ExpenseAuthorityRefs },
): Promise<ExpenseEffectSnapshot> {
  const loose = client as LooseClient;
  const expenses = await readAllExpenses(loose, refs, orgId, title);
  const events: AccountingEventRow[] = [];
  for (const expense of expenses) {
    events.push(...(await readEvents(loose, refs, orgId, expense.id)));
  }
  const openOutbox = await readOpenOutbox(
    loose,
    refs,
    orgId,
    new Set(expenses.map((expense) => expensePostedIdempotencyKey(expense.id))),
  );
  const journals: JournalRow[] = [];
  for (const event of events) {
    if (event.status !== "POSTED" || !event.journalEntryId) continue;
    const journal = await readJournal(loose, refs, orgId, event.journalEntryId);
    if (journal) journals.push(journal);
  }
  return { title, expenses, events, openOutbox, journals };
}

/**
 * The posting outbox drains asynchronously, so a single pass can straddle a
 * PENDING -> POSTED transition and see the same effect twice (or not at all).
 * Only two consecutive identical snapshots are accepted as the authority; a
 * state that never settles is inconclusive, never a pass or a breach.
 */
export async function readSettledExpenseEffectSnapshot(
  client: ExpenseAuthorityClient | LooseClient,
  input: { orgId: string; title: string; refs: ExpenseAuthorityRefs },
  { attempts = 6, settleMs = 1_500 }: { attempts?: number; settleMs?: number } = {},
): Promise<ExpenseEffectSnapshot> {
  let previous = await readExpenseEffectSnapshot(client, input);
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const current = await readExpenseEffectSnapshot(client, input);
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  return inconclusive(
    `the backend state for "${input.title}" did not settle across ${attempts} reads`,
  );
}
