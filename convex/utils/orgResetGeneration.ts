import type { Doc } from "../_generated/dataModel";

/**
 * SCRUM-565 D-19 — the single switch for the no-new-start barrier.
 *
 * While true, a destructive `resetOrgFinancialData` is refused unless the
 * organization is ALREADY mid-reset (a continuation). The same constant is
 * attested by `orgResetPreflight:countOrgsWithResetInProgress`, so the release
 * workflow reads from the live backend the value the guard actually enforces.
 */
export const FRESH_RESET_STARTS_BLOCKED = true as const;

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
 * SCRUM-565 D-19 — the one barrier predicate. True when a call must be refused
 * because it would START a destructive reset: the switch is on, the call is
 * destructive (`!dryRun`), and the org has no row or no reset in progress.
 * Continuations and every dry run are never refused.
 */
export function isFreshResetStartRefused(org: OrgResetFields | null, dryRun: boolean): boolean {
  return FRESH_RESET_STARTS_BLOCKED && !dryRun && (org === null || !orgResetState(org).inProgress);
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
