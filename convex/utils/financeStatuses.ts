/**
 * SCRUM-208 — ONE definition of "this finance application still holds its cars".
 *
 * ⚠️ A NEUTRAL MODULE, NOT A COPY PINNED BY A TEST. A first version of
 * `commitmentSources.ts` declared its own list and claimed a test kept the two
 * aligned. That test did not exist — but even if it had, two independently
 * maintained lists ARE the distributed-inference defect SCRUM-195 was built to
 * remove. A test can only tell you they drifted; a shared constant means they
 * cannot.
 *
 * It lives here rather than in `commitments.ts` so the source module can import
 * it without a cycle.
 */

/**
 * Statuses in which an application can still progress toward finalization, and
 * therefore still holds every vehicle in its normalized set.
 *
 * ⚠️ REJECTED IS IN FLIGHT. `applications.ts` runs a repeatable
 * REJECTED ↔ PENDING_DOCS ↔ UNDER_REVIEW cycle, so a rejected application is
 * not necessarily finished — but it is not holding a car either, which is why
 * it is absent here while remaining a live business record.
 */
export const IN_FLIGHT_FINANCE_STATUSES: readonly string[] = [
  "DRAFT",
  "PENDING_DOCS",
  "UNDER_REVIEW",
  "APPROVED",
];
