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
  org: Pick<Doc<"organizations">, "financialResetGeneration" | "financialResetCompletedGeneration"> | null
): { generation: number; inProgress: boolean } {
  const generation = org?.financialResetGeneration ?? 0;
  const completed = org?.financialResetCompletedGeneration ?? 0;
  return { generation, inProgress: generation !== completed };
}
