import type { Doc, Id, DataModel, TableNames } from "../_generated/dataModel";
import type { GenericTableInfo, DocumentByInfo, QueryInitializer, Query, OrderedQuery, IndexNames, IndexRangeBuilder, NamedIndex, IndexRange } from "convex/server";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { ReadHeadroomExhausted, VerificationBudget } from "../accounting/accountSnapshots";

/** An explicit read-only context boundary, following Convex's custom-context pattern.
 * Every terminal database read beneath it uses VerificationBudget, including helpers
 * added later. Legacy callers keep their original context and database methods.
 * The queue makes admission atomic with respect to sibling Promise.all readers.
 */
class OpeningVerificationScope {
  readonly sources = new Map<Id<"organizations">, Promise<OpeningSourceIdentity>>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly budget: VerificationBudget;

  constructor(ctx: Pick<QueryCtx, "meta">) {
    this.budget = new VerificationBudget(ctx, { accountIds: [], readLimit: 30_000, readBytesLimit: 14 * 1024 * 1024 });
  }

  serial<T>(read: () => Promise<T>): Promise<T> {
    const result = this.tail.then(read);
    this.tail = result.catch(() => undefined);
    return result;
  }

  stream<T extends object>(source: AsyncIterable<T>): AsyncIterableIterator<T> {
    let iterator: AsyncIterator<T> | undefined;
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => {
        return this.serial(async () => {
          if (!(await this.budget.hasHeadroom())) throw new ReadHeadroomExhausted();
          iterator ??= source[Symbol.asyncIterator]();
          const next = await iterator.next();
          if (!next.done && !this.budget.chargeLine(next.value)) throw new ReadHeadroomExhausted();
          return next;
        });
      },
      async return() { return iterator?.return ? iterator.return() : { done: true, value: undefined }; },
    };
  }

  read<T extends object>(source: AsyncIterable<T>, count?: number): Promise<T[]> {
    return this.serial(() => this.budget.read(source, count));
  }

  point<T extends object>(read: () => Promise<T | null>): Promise<T | null> {
    return this.serial(() => this.budget.point(read));
  }
}

/** Only the read operations used by opening verification are available. Native
 * query stages retain Convex's index and ordering types; terminals share admission. */
class OpeningOrderedQuery<T extends GenericTableInfo> implements AsyncIterable<DocumentByInfo<T>> {
  constructor(protected readonly source: OrderedQuery<T>, protected readonly scope?: OpeningVerificationScope) {}

  collect(): Promise<DocumentByInfo<T>[]> { return this.scope ? this.scope.read(this.source) : this.source.collect(); }
  take(count: number): Promise<DocumentByInfo<T>[]> { return this.scope ? this.scope.read(this.source, count) : this.source.take(count); }
  async first(): Promise<DocumentByInfo<T> | null> { return this.scope ? (await this.take(1))[0] ?? null : this.source.first(); }
  async unique(): Promise<DocumentByInfo<T> | null> {
    if (!this.scope) return this.source.unique();
    const docs = await this.take(2);
    if (docs.length > 1) throw new Error("Opening verification expected a unique record");
    return docs[0] ?? null;
  }
  [Symbol.asyncIterator](): AsyncIterator<DocumentByInfo<T>> { return this.scope ? this.scope.stream(this.source) : this.source[Symbol.asyncIterator](); }
}

class OpeningQuery<T extends GenericTableInfo> extends OpeningOrderedQuery<T> {
  constructor(private readonly querySource: Query<T>, scope?: OpeningVerificationScope) { super(querySource, scope); }
  order(order: "asc" | "desc"): OpeningOrderedQuery<T> {
    return new OpeningOrderedQuery(this.querySource.order(order), this.scope);
  }
}

class OpeningQueryInitializer<T extends GenericTableInfo> extends OpeningQuery<T> {
  constructor(private readonly initializer: QueryInitializer<T>, scope?: OpeningVerificationScope) { super(initializer, scope); }
  withIndex<I extends IndexNames<T>>(name: I, range?: (q: IndexRangeBuilder<DocumentByInfo<T>, NamedIndex<T, I>>) => IndexRange): OpeningQuery<T> {
    return new OpeningQuery(this.initializer.withIndex(name, range), this.scope);
  }
}

// Registry master tables have no role in the opening read census. Keeping this
// explicit also prevents a generic table accessor from hiding registry access.
type OpeningTable = Exclude<TableNames, "suppliers" | "supplierAliases" | "supplierRegistryState">;
class OpeningDatabaseReader {
  constructor(private readonly db: QueryCtx["db"], private readonly scope?: OpeningVerificationScope) {}

  get<T extends OpeningTable>(id: Id<T>): Promise<Doc<T> | null> {
    return this.scope ? this.scope.point(() => this.db.get(id)) : this.db.get(id);
  }
  query<T extends OpeningTable>(table: T): OpeningQueryInitializer<DataModel[T]> {
    return new OpeningQueryInitializer(this.db.query(table), this.scope);
  }
  normalizeId<T extends OpeningTable>(table: T, id: string): Id<T> | null {
    return this.db.normalizeId(table, id);
  }
}

type OpeningVerificationCtx = Omit<QueryCtx, "db"> & { reader: OpeningDatabaseReader };
export type OpeningReadCtx = QueryCtx | OpeningVerificationCtx;

/** Legacy contexts use native terminals; guarded contexts reuse their admitted reader. */
export function openingDatabase(ctx: OpeningReadCtx | Pick<QueryCtx, "db">): OpeningDatabaseReader {
  return "reader" in ctx ? ctx.reader : new OpeningDatabaseReader(ctx.db);
}

const scopes = new WeakMap<OpeningReadCtx, OpeningVerificationScope>();

/** Optional only for existing consumers: a guarded reader reuses its complete
 * source inventory; legacy mutation and report paths retain their original I/O. */
export function openingVerificationSource(ctx: OpeningReadCtx | MutationCtx, orgId: Id<"organizations">): Promise<OpeningSourceIdentity> | undefined {
  return scopes.has(ctx) ? loadOpeningSourceIdentity(ctx, orgId) : undefined;
}

export function openingVerificationContext(ctx: OpeningReadCtx): OpeningVerificationCtx {
  if ("reader" in ctx) return ctx;
  const scope = new OpeningVerificationScope(ctx);
  const { db, ...context } = ctx;
  const guarded = { ...context, reader: new OpeningDatabaseReader(db, scope) };
  scopes.set(guarded, scope);
  return guarded;
}

/** Only typed resource refusal becomes unavailable. Programming errors still reach
 * the existing server logger. No partial accumulator escapes this boundary. */
export async function verifyOpeningRead<T>(ctx: OpeningReadCtx, read: (guarded: OpeningVerificationCtx) => Promise<T>, unavailable: () => T): Promise<T> {
  try {
    return await read(openingVerificationContext(ctx));
  } catch (error) {
    if (error instanceof ReadHeadroomExhausted) return unavailable();
    throw error;
  }
}

type OpeningHeader = Doc<"openingBalanceDrafts">;
type OpeningJournal = Doc<"journalEntries">;
export type OpeningSourceIdentity = {
  headers: OpeningHeader[];
} & (
  | { status: "AVAILABLE"; parent: OpeningHeader; journal: OpeningJournal }
  | { status: "ABSENT" | "UNAVAILABLE"; parent: null; journal: null }
);

/** Retained history proves references, never current authority. Enumerate one
 * beyond each bound so an incomplete inventory cannot prove ordinary origin. */
export async function loadOpeningSourceIdentity(
  ctx: OpeningReadCtx | MutationCtx, orgId: Id<"organizations">,
): Promise<OpeningSourceIdentity> {
  const scope = scopes.get(ctx);
  if (!scope) return readOpeningSourceIdentity(ctx, orgId);
  let source = scope.sources.get(orgId);
  if (!source) {
    source = readOpeningSourceIdentity(ctx, orgId);
    scope.sources.set(orgId, source);
  }
  return source;
}

async function readOpeningSourceIdentity(ctx: OpeningReadCtx | MutationCtx, orgId: Id<"organizations">): Promise<OpeningSourceIdentity> {
  const limit = 100;
  const [headers, journals] = await Promise.all([
    openingDatabase(ctx).query("openingBalanceDrafts").withIndex("by_org_status", q =>
      q.eq("orgId", orgId).eq("status", "POSTED")).take(limit + 1),
    openingDatabase(ctx).query("journalEntries").withIndex("by_org_source", q =>
      q.eq("orgId", orgId).eq("sourceType", "cutover").eq("sourceId", String(orgId))).take(limit + 1),
  ]);
  const unavailable = (): OpeningSourceIdentity => ({ headers, status: "UNAVAILABLE", parent: null, journal: null });
  if (headers.length > limit || journals.length > limit || headers.some(header =>
    header.orgId !== orgId || (header.allocations?.length ?? 0) > limit ||
    (header.allocationResults?.length ?? 0) > limit)) return unavailable();
  const live = journals.filter(journal => journal.category === "OPENING_BALANCE" && journal.status === "POSTED");
  if (live.length === 0) return { headers, status: "ABSENT", parent: null, journal: null };
  if (live.length !== 1) return unavailable();
  const journal = live[0];
  const owners = headers.filter(header => header.journalEntryId === journal._id);
  if (owners.length !== 1 || owners[0].asOfDate !== journal.accountingDate ||
    owners[0].currency !== undefined && owners[0].currency !== journal.currency) return unavailable();
  return { headers, status: "AVAILABLE", parent: owners[0], journal };
}
