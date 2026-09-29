/**
 * SCRUM-417 UX2 (S1) -- SCAFFOLD, committed with the failing tests so they fail
 * on assertions rather than on an unresolved import. Replaced in the fix commit.
 */
export function orderStagesForDisplay<T extends Readonly<{ key: string }>>(
  stages: ReadonlyArray<T>
): T[] {
  return [...stages];
}
