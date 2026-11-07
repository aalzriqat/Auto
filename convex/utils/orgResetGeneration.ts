import type { Doc } from "../_generated/dataModel";

/**
 * SCRUM-565 c24729 replaces D-19 with survivor admission. This attests ONLY
 * the blanket barrier, not the conditional survivor guard. The release script
 * must refuse false until a separately authorized synchronization protocol exists.
 */
export const FRESH_RESET_STARTS_BLOCKED = false as const;

/** The org fields the reset protocol reads. */
type OrgResetFields = Pick<
  Doc<"organizations">,
  "financialResetGeneration" | "financialResetCompletedGeneration"
>;

/**
 * SCRUM-563 — the one definition of an organization's financial-reset state,
 * and the one place the protocol is explained.
 *
 * PROTOCOL. `resetOrgFinancialData` bumps `financialResetGeneration` once,
 * before its first delete, and stamps `financialResetCompletedGeneration` when a
 * run ends with nothing remaining. Both absent means generation 0 with no reset
 * in progress. `inProgress` is `generation !== completed`.
 *
 * Two consumers: `runWithIdempotency` / `findCommandUnit` refuse to replay a
 * command stamped with an older generation (`commandIdempotency` survives the
 * reset while the rows its stored result names do not), and `adminOrgs`
 * refuses to reactivate an org while a reset is in progress.
 *
 * A COUNTER, NOT A TIMESTAMP. A timestamp compare is defeated by an equal or
 * frozen clock (a command recorded in the same millisecond as the reset); a
 * counter that only ever increments cannot be.
 *
 * Pure on purpose: callers already hold the org row, and this adds no read.
 */
export function orgResetState(
  org: OrgResetFields | null
): { generation: number; inProgress: boolean } {
  const generation = org?.financialResetGeneration ?? 0;
  const completed = org?.financialResetCompletedGeneration ?? 0;
  return { generation, inProgress: generation !== completed };
}

/**
 * Fresh destructive starts require a present org and a complete PASS verdict.
 * Defaulting to false prevents a caller that omits evidence from admitting a reset.
 * Continuations and dry runs retain their prior semantics.
 */
export function isFreshResetStartRefused(org: OrgResetFields | null, dryRun: boolean, preflightPassed = false): boolean {
  return !dryRun && (org === null || (!orgResetState(org).inProgress &&
    (FRESH_RESET_STARTS_BLOCKED || !preflightPassed)));
}

/**
 * The patch that moves an org into "reset in progress": the generation moves to
 * `generation + 1` and the completed stamp is left alone (SCRUM-563 protocol).
 * Used by `resetOrgFinancialData` and by the test fixtures that seed a reset.
 */
export function beginResetGenerationPatch(org: OrgResetFields | null): {
  financialResetGeneration: number;
} {
  return { financialResetGeneration: orgResetState(org).generation + 1 };
}
