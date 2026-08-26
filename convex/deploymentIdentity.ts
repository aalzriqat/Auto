import { query } from "./_generated/server";

/**
 * SCRUM-195 — who is answering, and may this deployment be raced?
 *
 * The commitment authority's concurrency behaviour cannot be proved by
 * `convex-test`: it serialises, so acquire-versus-acquire, release-versus-acquire
 * and reopen-versus-competing-acquire all pass there trivially and prove nothing
 * about the real runtime. Proving them needs genuinely simultaneous mutations
 * against a real backend — which immediately raises the question of WHICH
 * backend, because the same test pointed at production would be a live
 * double-booking experiment on somebody's inventory.
 *
 * So the deployment answers for itself, and the contention suite refuses to run
 * unless it says yes.
 *
 * ## Deliberately narrow
 *
 * A zero-argument read-only query returning three facts. No arguments to abuse,
 * no write surface, and nothing here is a secret: a deployment URL, a boolean,
 * and a commit SHA. There is no test-only seeding companion to this and there
 * must not be one — a write-capable backdoor shipped to production is a far
 * worse defect than the flakiness it would be added to avoid.
 *
 * ## Fail closed, deliberately
 *
 * `isDisposable` is false unless a deployment explicitly declares itself
 * disposable. Production does not set that variable, so it can never present as
 * safe to race — and a misconfigured preview reads as "not disposable" and
 * simply refuses to run the races, which is the failure direction you want.
 * Inferring it from the URL shape would invert that: a naming change or an
 * unfamiliar deployment kind would silently read as disposable.
 */
export const identity = query({
  args: {},
  handler: async () => {
    return {
      /** Which backend answered. Not a secret; it is in every client bundle. */
      deployment: process.env.CONVEX_CLOUD_URL ?? null,
      /**
       * True only where a deployment has been explicitly marked as throwaway.
       * Anything else — including production, and including a preview whose
       * variables did not take — is false.
       */
      isDisposable: process.env.AUTOFLOW_DISPOSABLE_DEPLOYMENT === "true",
      /**
       * The commit this backend was deployed FROM, set at deploy time.
       *
       * The point is that it comes from the server rather than from the
       * workflow's own checkout. A green run proves nothing about the candidate
       * unless the backend that answered agrees about which commit it is
       * running — otherwise a race could pass against a stale preview while the
       * report names the SHA that was merely checked out.
       *
       * Null when nothing set it, which the contention suite treats as missing
       * evidence rather than as a pass.
       */
      gitSha: process.env.DEPLOYMENT_GIT_SHA ?? null,
    };
  },
});
