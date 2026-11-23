// @vitest-environment node
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { MASTER_KEY, pauseScheduler, seedDealership, switchOnAi } from "../test-utils/aiDraftsFixture";
import type { AiTest, Dealership } from "../test-utils/aiDraftsFixture";
import schema from "./schema";
import { requestDraftForStaff } from "./domains/ai";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

type Platform = "instagram" | "facebook";

const COMMENTS = 60;
const EVENT_TABLES: Record<Platform, "instagramEvents" | "facebookEvents"> = {
  instagram: "instagramEvents",
  facebook: "facebookEvents",
};

const ORIGINAL_MASTER = process.env.AI_KEY_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.AI_KEY_ENCRYPTION_KEY = MASTER_KEY;
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
  // Literal method names on purpose: test-utils/pilotConfigParity.ts treats a spyOn with a
  // non-literal method name as a possible pilot-door replacement.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  pauseScheduler();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (ORIGINAL_MASTER === undefined) delete process.env.AI_KEY_ENCRYPTION_KEY;
  else process.env.AI_KEY_ENCRYPTION_KEY = ORIGINAL_MASTER;
});

/** What a request read: documents handed out per table, and the order of tables and indexes touched. */
interface ReadLog {
  documents: Record<string, number>;
  touched: string[];
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Counts the documents a result carries: an array's length, one document, or nothing. */
function countResult(result: unknown, table: string, log: ReadLog): void {
  if (Array.isArray(result)) log.documents[table] = (log.documents[table] ?? 0) + result.length;
  else if (isObject(result) && "_id" in result) log.documents[table] = (log.documents[table] ?? 0) + 1;
}

/** A query builder that counts every document it hands out, however it is consumed. */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isObject(value) && Symbol.asyncIterator in value;
}

function countedQuery<Q extends AsyncIterable<unknown>>(query: Q, table: string, log: ReadLog): Q {
  return new Proxy(query, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return () => {
          const iterator = target[Symbol.asyncIterator]();
          return {
            async next() {
              const step = await iterator.next();
              if (!step.done) log.documents[table] = (log.documents[table] ?? 0) + 1;
              return step;
            },
          };
        };
      }
      const member: unknown = Reflect.get(target, prop);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        if (prop === "withIndex") log.touched.push(`${table}:${String(args[0])}`);
        const result: unknown = member.apply(target, args);
        if (result instanceof Promise) {
          return result.then((value: unknown) => {
            countResult(value, table, log);
            return value;
          });
        }
        return isAsyncIterable(result) ? countedQuery(result, table, log) : result;
      };
    },
  });
}

function countedDb<Db extends { query: (table: never) => object }>(db: Db, log: ReadLog): Db {
  return new Proxy(db, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop);
      if (prop !== "query" || typeof member !== "function") return member;
      return (table: string) => {
        log.touched.push(table);
        return countedQuery(member.call(target, table), table, log);
      };
    },
  });
}

async function seedThread(t: AiTest, d: Dealership, platform: Platform, shape: "no_dm" | "buried_dm"): Promise<void> {
  await t.run(async (ctx) => {
    for (const event of await ctx.db.query("instagramEvents").take(5)) await ctx.db.delete(event._id);
    const insertDm = async () => {
      if (platform === "instagram") {
        await ctx.db.insert("instagramEvents", {
          orgId: d.orgId, externalId: "ig_dm_old", kind: "dm", senderInstagramId: "ig_s", customerId: d.customerId, text: "Is it available?",
        });
      } else {
        await ctx.db.insert("facebookEvents", {
          orgId: d.orgId, externalId: "fb_dm_old", kind: "dm", senderFacebookId: "fb_s", customerId: d.customerId, text: "Is it available?",
        });
      }
    };
    if (shape === "buried_dm") await insertDm();
    for (let i = 0; i < COMMENTS; i += 1) {
      if (platform === "instagram") {
        await ctx.db.insert("instagramEvents", {
          orgId: d.orgId, externalId: `ig_c_${i}`, kind: "comment", senderInstagramId: "ig_s", customerId: d.customerId, text: `c${i}`,
        });
      } else {
        await ctx.db.insert("facebookEvents", {
          orgId: d.orgId, externalId: `fb_c_${i}`, kind: "comment", senderFacebookId: "fb_s", customerId: d.customerId, text: `c${i}`,
        });
      }
    }
  });
}

async function readsOf(
  t: AiTest,
  d: Dealership,
  platform: Platform,
  customerId: Id<"customers"> = d.customerId
): Promise<{ log: ReadLog; outcome: { draftId: Id<"aiDrafts">; created: boolean } | { code: string } }> {
  const log: ReadLog = { documents: {}, touched: [] };
  const outcome = await t
    .withIdentity({ subject: d.subject })
    .run(async (ctx) => {
      const counted: MutationCtx = { ...ctx, db: countedDb(ctx.db, log) };
      try {
        return await requestDraftForStaff(counted, { orgId: d.orgId, customerId, platform });
      } catch (error) {
        const data: unknown = error instanceof ConvexError ? error.data : null;
        const code: unknown = isObject(data) ? Reflect.get(data, "code") : null;
        return { code: typeof code === "string" ? code : "UNKNOWN" };
      }
    });
  return { log, outcome };
}

describe.each(["instagram", "facebook"] as const)("S2-02 bounded reads on %s", (platform) => {
  const table = EVENT_TABLES[platform];

  test("a disabled switch is refused before the customer's thread is read", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    registerRateLimiter(t);
    const d = await seedDealership(t);
    await switchOnAi(t, d, { org: false });
    await seedThread(t, d, platform, "no_dm");
    const { log, outcome } = await readsOf(t, d, platform);
    expect(outcome).toEqual({ code: "AI_DRAFT_NOT_ENABLED" });
    expect(log.documents[table] ?? 0).toBe(0);
    expect(log.touched).not.toContain(table);
  });

  test("a comment-only customer is refused after reading one indexed row at most", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    registerRateLimiter(t);
    const d = await seedDealership(t);
    await switchOnAi(t, d);
    await seedThread(t, d, platform, "no_dm");
    const { log, outcome } = await readsOf(t, d, platform);
    expect(outcome).toEqual({ code: "AI_DRAFT_NO_CONVERSATION" });
    expect(log.touched).toContain(`${table}:by_org_customer_kind`);
    expect(log.documents[table] ?? 0).toBeLessThanOrEqual(1);
  });

  test("a direct message under many newer comments is found with one indexed row read", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    registerRateLimiter(t);
    const d = await seedDealership(t);
    await switchOnAi(t, d);
    await seedThread(t, d, platform, "buried_dm");
    const { log, outcome } = await readsOf(t, d, platform);
    expect(outcome).toMatchObject({ created: true });
    expect(log.documents[table] ?? 0).toBeLessThanOrEqual(1);
  });

  test("a second press on a fresh pending draft returns it, reads no thread and uses no rate-limit token", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    registerRateLimiter(t);
    const d = await seedDealership(t);
    await switchOnAi(t, d);
    await seedThread(t, d, platform, "buried_dm");
    const first = await readsOf(t, d, platform);
    expect(first.outcome).toMatchObject({ created: true });
    for (let press = 0; press < 8; press += 1) {
      const again = await readsOf(t, d, platform);
      expect(again.outcome).toMatchObject({ created: false });
      expect(again.log.documents[table] ?? 0).toBe(0);
    }
    // Eight repeat presses would have exhausted the per-user limit of 5 a minute.
    const other = await t.run((ctx) => ctx.db.insert("customers", { orgId: d.orgId, firstName: "B", lastName: "C" }));
    await t.run(async (ctx) => {
      if (platform === "instagram") {
        await ctx.db.insert("instagramEvents", {
          orgId: d.orgId, externalId: "ig_dm_b", kind: "dm", senderInstagramId: "ig_b", customerId: other, text: "hi",
        });
      } else {
        await ctx.db.insert("facebookEvents", {
          orgId: d.orgId, externalId: "fb_dm_b", kind: "dm", senderFacebookId: "fb_b", customerId: other, text: "hi",
        });
      }
    });
    const next = await readsOf(t, d, platform, other);
    expect(next.outcome).toMatchObject({ created: true });
  });
});
