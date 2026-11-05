import type { Doc, Id } from "../_generated/dataModel";
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

  constructor(ctx: QueryCtx) {
    this.budget = new VerificationBudget(ctx, { accountIds: [], readLimit: 30_000, readBytesLimit: 14 * 1024 * 1024 });
  }

  private serial<T>(read: () => Promise<T>): Promise<T> {
    const result = this.tail.then(read);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private stream(source: AsyncIterable<object>): AsyncIterableIterator<object> {
    let iterator: AsyncIterator<object> | undefined;
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

  private query<T extends object & AsyncIterable<object>>(source: T): T {
    return new Proxy(source, {
      get: (target, key) => {
        if (key === Symbol.asyncIterator) return () => this.stream(source);
        if (key === "collect") return () => this.serial(() => this.budget.read(source));
        if (key === "take") return (count: number) => this.serial(() => this.budget.read(source, count));
        if (key === "first") return async () => (await this.serial(() => this.budget.read(source, 1)))[0] ?? null;
        if (key === "unique") return async () => {
          const docs = await this.serial(() => this.budget.read(source, 2));
          if (docs.length > 1) throw new Error("Opening verification expected a unique record");
          return docs[0] ?? null;
        };
        // No pagination or filters beneath this boundary: their hidden scans cannot
        // be charged one document at a time. Refuse instead of bypassing admission.
        if (["paginate", "filter", "count"].includes(String(key))) return () => { throw new ReadHeadroomExhausted(); };
        const member: unknown = Reflect.get(target, key);
        if (typeof member !== "function") return member;
        if (!["withIndex", "order", "fullTableScan"].includes(String(key))) return () => { throw new ReadHeadroomExhausted(); };
        return (...args: unknown[]) => {
          const next: unknown = Reflect.apply(member, target, args);
          if (!isDocumentStream(next)) throw new ReadHeadroomExhausted();
          return this.query(next);
        };
      },
    });
  }

  database(db: QueryCtx["db"]): QueryCtx["db"] {
    return new Proxy(db, {
      get: (target, key) => {
        const member: unknown = Reflect.get(target, key);
        if (key === "get" && typeof member === "function") return (...args: unknown[]) => this.serial(() =>
          this.budget.point(async () => {
            const doc: unknown = await Reflect.apply(member, target, args);
            if (doc === null || typeof doc === "object") return doc;
            throw new ReadHeadroomExhausted();
          }));
        if (key === "query" && typeof member === "function") return (...args: unknown[]) => {
          const source: unknown = Reflect.apply(member, target, args);
          if (!isDocumentStream(source)) throw new ReadHeadroomExhausted();
          return this.query(source);
        };
        if (key === "normalizeId" && typeof member === "function") return member.bind(target);
        // This context deliberately has no write or system-table escape hatch.
        throw new ReadHeadroomExhausted();
      },
    });
  }
}

function isDocumentStream(value: unknown): value is object & AsyncIterable<object> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function";
}

const scopes = new WeakMap<QueryCtx, OpeningVerificationScope>();

/** Optional only for existing consumers: a guarded reader reuses its complete
 * source inventory; legacy mutation and report paths retain their original I/O. */
export function openingVerificationSource(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<OpeningSourceIdentity> | undefined {
  return scopes.has(ctx) ? loadOpeningSourceIdentity(ctx, orgId) : undefined;
}

export function openingVerificationContext(ctx: QueryCtx): QueryCtx {
  if (scopes.has(ctx)) return ctx;
  const scope = new OpeningVerificationScope(ctx);
  const guarded = { ...ctx, db: scope.database(ctx.db) };
  scopes.set(guarded, scope);
  return guarded;
}

/** Only typed resource refusal becomes unavailable. Programming errors still reach
 * the existing server logger. No partial accumulator escapes this boundary. */
export async function verifyOpeningRead<T>(ctx: QueryCtx, read: (guarded: QueryCtx) => Promise<T>, unavailable: () => T): Promise<T> {
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
  ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">,
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

async function readOpeningSourceIdentity(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<OpeningSourceIdentity> {
  const limit = 100;
  const [headers, journals] = await Promise.all([
    ctx.db.query("openingBalanceDrafts").withIndex("by_org_status", q =>
      q.eq("orgId", orgId).eq("status", "POSTED")).take(limit + 1),
    ctx.db.query("journalEntries").withIndex("by_org_source", q =>
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
