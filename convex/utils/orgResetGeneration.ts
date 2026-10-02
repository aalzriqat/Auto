import type { Doc } from "../_generated/dataModel";

/**
 * SCRUM-563 — the one definition of an organization's financial-reset state.
 *
 * `resetOrgFinancialData` bumps `financialResetGeneration` once, before its
 * first delete, and stamps `financialResetCompletedGeneration` when a run ends
 * with nothing remaining. Both absent means generation 0, no reset in progress.
 *
 * `inProgress` is `generation !== completed`, so a reset that was started and
 * has not finished reads true, and a finished one reads false.
 *
 * Pure on purpose: callers already hold the org row, and this adds no read.
 */
export function orgResetState(
  org: Pick<Doc<"organizations">, "financialResetGeneration" | "financialResetCompletedGeneration"> | null
): { generation: number; completed: number; inProgress: boolean } {
  const generation = org?.financialResetGeneration ?? 0;
  const completed = org?.financialResetCompletedGeneration ?? 0;
  return { generation, completed, inProgress: generation !== completed };
}
