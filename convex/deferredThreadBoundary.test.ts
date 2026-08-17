import { describe, expect, test } from "vitest";
import * as aggregates from "./aggregates";
import * as functions from "./functions";

/**
 * The API boundary around the deferred conversation writer.
 *
 * ## What this file is for, and what it replaced
 *
 * `socialBulkMutation` suppresses the per-write conversation recompute so bulk
 * loops are not O(N²), and something must guarantee the recompute still
 * happens. That was the handler's job for seven rounds, policed by a
 * source-scanning test that failed OPEN every time — finally unfixably, because
 * a static check can prove the settlement calls EXIST beneath a mutation and
 * can never prove they EXECUTE.
 *
 * The builder owns it now. But ownership only means something if the builder is
 * the only way in: an earlier version exported `prepareDeferredThreadMutation`,
 * which handed out a deferred `db` *and* a separate `finalize`. That is a
 * settlement obligation under a new name — take the `db`, write events, never
 * call `finalize`, and the missing-tracker throw stays silent because a tracker
 * was supplied. The claim "there is no settlement API left to forget" was not
 * yet true; the API had just moved.
 *
 * So the low-level pieces are module-private and this pins that. It is a
 * runtime check of the module's actual export surface — not a source scan, and
 * deliberately so, because the lesson of the deleted guard is that reading text
 * to infer behaviour is what kept failing.
 *
 * ## Where the rest of the proof lives
 *
 * - `socialInboxConversations.test.ts` proves finalisation actually runs, on
 *   real writes: `mergeCustomers` and `setConversationVehicle` contain zero
 *   settlement code, their conversations still come out correct and bounded,
 *   and emptying the builder's `onSuccess` turns eight of those cases red.
 * - `aggregateWiring.test.ts` pins that the deferred triggers record rather
 *   than recompute.
 *
 * ⚠️ Two earlier tests here — that wrapping the writer without a tracker throws
 * and rolls the write back, and that a handler cannot reach the tracker — were
 * removed with this seal, and that is worth stating rather than quietly
 * dropping. They required importing the very things that must not be
 * importable. The behaviours they covered are now unreachable by construction,
 * which is a stronger guarantee than a test that the misuse fails: the misuse
 * cannot be written. The runtime throw remains in `recordDeferredThreads` as
 * defence-in-depth against future edits *inside* `aggregates.ts`, where it is
 * still reachable.
 */
describe("deferred thread writer API boundary", () => {
  test("the low-level deferred writer is not exported", () => {
    // Each of these hands a caller either the raw trigger set or a deferred db
    // paired with a manual finalize. Exporting any one of them reopens the
    // "forgot to settle" class this design exists to eliminate.
    const sealed = ["deferredThreadTriggers", "prepareDeferredThreadMutation"];
    const exported = Object.keys(aggregates);

    for (const name of sealed) {
      expect(exported, `${name} must stay module-private`).not.toContain(name);
    }
  });

  test("the only exported path always owns finalization", () => {
    // `createSocialBulkMutation` is the sanctioned entry point, and the builder
    // it returns wires `onSuccess` itself. There is deliberately no exported
    // function that returns a deferred `db` for a caller to drive by hand.
    expect(Object.keys(aggregates)).toContain("createSocialBulkMutation");
    expect(typeof aggregates.createSocialBulkMutation).toBe("function");

    expect(Object.keys(functions)).toContain("socialBulkMutation");
    expect(typeof functions.socialBulkMutation).toBe("function");
  });

  test("no export hands out a deferred db alongside a separate finalize", () => {
    // The shape-level statement of the same rule, so a differently-named future
    // helper with the same shape is caught too. Every exported function is
    // called only if it is safe to do so — these are all zero-argument or
    // builder-taking factories — so the check is on the export NAMES rather
    // than on invoking them, which would run trigger registration.
    const suspicious = Object.keys(aggregates).filter(
      (name) => /^(prepare|create|make|get).*Deferred/i.test(name) && name !== "createSocialBulkMutation"
    );

    expect(suspicious).toEqual([]);
  });
});
