/**
 * SCRUM-302 — the single lifecycle decision for economic writes.
 *
 * `requireTenantAuth` refuses a suspended organization, but it is an
 * AUTHENTICATED-door guard: `internalMutation`, cron and webhook entry points do
 * not pass through it and nothing substituted an org-state check at that trust
 * boundary. So an organization that is suspended — including one whose
 * destructive purge has already drained its financial tables — still received
 * money postings through doors that never looked at its lifecycle.
 *
 * WHERE THIS IS ENFORCED, and why it is not enforced at the entry points.
 *
 * Gating the four entry points known to be defective today would fix four
 * defects and leave the CLASS open: the next internal economic writer is
 * ungated by default and nothing says so. So the decision lives at the
 * ECONOMIC CHOKEPOINTS instead — every ledger-core row in the repository is
 * written behind `postAccountingEvent`, `reverseAccountingEvent`, the
 * `subledger.ts` creators, or the accounting outbox. A caller that has not been
 * written yet inherits the refusal for free.
 *
 * `scripts/ledgerCoreWriteGuard.test.ts` is the ratchet that keeps that claim
 * true: it fails CI if a ledger-core insert appears outside the enumerated set.
 *
 * TWO LIFECYCLE CLASSES, and the difference decides a disposition, not just a
 * message:
 *
 *   PERMANENT — `destructivePurgeStartedAt` is set. Destructive deletion has
 *   begun and, per SCRUM-297, that is irreversible for the organization: the
 *   legal transitions are resume the purge or complete it. No new economic
 *   footprint may ever be created, so queued work must DEAD-LETTER rather than
 *   wait for a reactivation that must never come.
 *
 *   TEMPORARY — the organization is merely `suspended`. Ordinary suspension is
 *   fail-closed for launch, but it can legitimately end, so queued work is HELD
 *   rather than failed.
 *
 * Collapsing these two into one boolean is what makes a queue dangerous: held
 * forever (never posted, never resolvable, blocking period close) if a
 * permanent refusal is treated as temporary, and money detonating across the
 * boundary on reactivation if a temporary one is treated as postable.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type OrgLifecycleBlockCode = "ORG_NOT_FOUND" | "ORG_PURGE_HISTORY" | "ORG_SUSPENDED";

export interface OrgLifecycleBlock {
  code: OrgLifecycleBlockCode;
  /**
   * True when the refusal can never be lifted for this organization, so a
   * queued item must be dead-lettered rather than retried. False when the
   * organization may legitimately return to service.
   */
  permanent: boolean;
  /** One wording, shared by every refusal site, so the two cannot drift. */
  message: string;
}

/**
 * The lifecycle decision for ONE organization, as data rather than as a throw,
 * so each call site can choose the disposition its own failure semantics
 * require — a webhook acknowledges, a cron skips, the engine throws.
 *
 * Returns `null` when the organization may receive economic effect.
 *
 * ORDER IS LOAD-BEARING: purge history is checked before suspension. A purge
 * leaves the org suspended too, and reporting that one as the merely-temporary
 * class is precisely the misclassification that would let a queue wait for a
 * reactivation SCRUM-297 forbids.
 */
export async function orgEconomicLifecycleBlock(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">
): Promise<OrgLifecycleBlock | null> {
  const org = await ctx.db.get(orgId);

  // A missing organization is a permanent refusal, not an unknown. Reading
  // "absent" as "fine" is the fail-open reading, and the row cannot come back.
  if (!org) {
    return {
      code: "ORG_NOT_FOUND",
      permanent: true,
      message: `Organization ${orgId} does not exist; refusing to create economic state for it.`,
    };
  }

  if (org.destructivePurgeStartedAt != null) {
    return {
      code: "ORG_PURGE_HISTORY",
      permanent: true,
      message:
        "This organization has begun irreversible destructive deletion. No new economic, accounting or payment record may be created for it.",
    };
  }

  if (org.suspended) {
    return {
      code: "ORG_SUSPENDED",
      permanent: false,
      message:
        "This organization is suspended. Economic processing is refused until it is returned to service.",
    };
  }

  return null;
}

/**
 * Fail-closed assertion for the economic chokepoints themselves.
 *
 * Throws `ConvexError` so an internal caller that has NOT been taught about
 * lifecycle still cannot write money for a blocked organization. Call sites
 * with their own failure semantics — anything reached from a cron batch, or a
 * provider webhook — must call `orgEconomicLifecycleBlock` and handle the
 * refusal explicitly rather than let this propagate: an uncaught throw inside a
 * cross-org cron batch aborts the run for every OTHER tenant too.
 */
export async function assertOrgEconomicallyActive(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">
): Promise<void> {
  const block = await orgEconomicLifecycleBlock(ctx, orgId);
  if (block) {
    throw new ConvexError({ code: block.code, message: block.message });
  }
}
