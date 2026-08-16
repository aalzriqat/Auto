import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember, VIEWER_PERMISSIONS } from "../test-utils/seedOrg";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { deferredThreadTriggers, prepareDeferredThreadMutation } from "./aggregates";
import type { Id } from "./_generated/dataModel";

/**
 * The boundary around the deferred conversation writer.
 *
 * ## Why this file exists instead of a build-time guard
 *
 * `socialBulkMutation` suppresses the per-write conversation recompute so bulk
 * loops are not O(N²), and something has to guarantee the recompute still
 * happens. That used to be the handler's job, policed by a source-scanning test
 * that failed OPEN seven times — the last time unfixably, because a static
 * check can prove the settlement calls EXIST beneath a mutation and can never
 * prove they EXECUTE.
 *
 * So the builder owns it now: the triggers record which threads a write
 * touched, and the customization's `onSuccess` recomputes them. That moved the
 * question from "did the author remember?" to "is the mechanism reachable and
 * mandatory?" — which is what this file answers, at runtime, on real writes.
 *
 * The behavioural proof that finalisation actually runs lives in
 * `socialInboxConversations.test.ts` (emptying `onSuccess` turns eight of its
 * cases red). These are the two boundary properties that suite cannot see.
 */
describe("deferred thread writer boundary", () => {
  async function seed(t: ReturnType<typeof convexTestWithComponents>) {
    const { orgId } = await seedOrgWithMember(t, {
      clerkId: "deferred_boundary",
      permissions: VIEWER_PERMISSIONS,
    });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Bound", lastName: "Ary" })
    );
    return { orgId, customerId };
  }

  test("wrapping the deferred writer without a tracker refuses the write", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId } = await seed(t);

    // The misuse: taking the deferred writer directly instead of through
    // `prepareDeferredThreadMutation`. TypeScript rejects this — the triggers
    // are typed `Triggers<DataModel, DeferredThreadCtx>`, so `wrapDB` demands
    // the tracker — and the cast is here precisely to get past that and prove
    // the RUNTIME also refuses. A compile error alone would be a guarantee only
    // for code that is compiled with these types.
    await expect(
      t.runUnwrapped(async (ctx) => {
        const wrapped = (deferredThreadTriggers.wrapDB as unknown as (c: unknown) => {
          db: { insert: (table: string, doc: unknown) => Promise<unknown> };
        })(ctx);
        await wrapped.db.insert("instagramEvents", {
          orgId,
          externalId: "boundary_no_tracker",
          kind: "dm",
          senderInstagramId: "ig_boundary",
          customerId,
          text: "should not commit",
        });
      })
    ).rejects.toThrow(/without a thread tracker/);

    // ⚠️ The refusal is only worth having if it takes the write with it. The
    // old behaviour returned quietly on a missing tracker, which committed the
    // event and left `socialConversations` describing a state that no longer
    // existed — silent staleness being the exact defect the whole mechanism
    // exists to prevent. Triggers run inside the mutation's transaction, so the
    // throw rolls the insert back.
    const events = await t.run((ctx) => ctx.db.query("instagramEvents").collect());
    expect(events).toHaveLength(0);
  });

  test("the tracker is not reachable from a handler's context", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

    // `customFnBuilder` merges everything returned under `ctx` into the
    // handler's context. Returning the whole wrapped ctx therefore handed
    // `deferredThreads` to the handler, which could `.clear()` it and leave
    // finalisation synchronising an empty map — the obligation defeated from
    // inside the very builder that owns it.
    //
    // The factory now returns the wrapped `db` and nothing else, keeping the
    // tracker captured in its closure. Asserted on the factory's own surface
    // because that is what determines the handler's context.
    const surface = await t.run(async (ctx) => {
      const prepared = prepareDeferredThreadMutation(ctx as never);
      return Object.keys(prepared).sort();
    });

    expect(surface).toEqual(["db", "finalize"]);
    expect(surface).not.toContain("deferredThreads");
  });

  test("the factory's writer records threads and finalize recomputes them", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId } = await seed(t);

    // The positive case, so the two refusals above cannot pass by the mechanism
    // being broken outright. One event in, one materialised conversation out —
    // and only after `finalize`, which is the deferral this builder exists for.
    const beforeFinalize = await t.runUnwrapped(async (ctx) => {
      const { db, finalize } = prepareDeferredThreadMutation(ctx as never);
      await db.insert("instagramEvents", {
        orgId,
        externalId: "boundary_ok",
        kind: "dm",
        senderInstagramId: "ig_boundary",
        customerId: customerId as Id<"customers">,
        text: "hello",
      });
      const midRun = await ctx.db.query("socialConversations").collect();
      await finalize();
      return midRun.length;
    });

    expect(beforeFinalize).toBe(0);

    const conversations = await t.run((ctx) => ctx.db.query("socialConversations").collect());
    expect(conversations).toHaveLength(1);
    expect(conversations[0].eventCount).toBe(1);
  });
});
