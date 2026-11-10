/** Shared release cursor traversal. Imported with explicit extensions for Node type stripping. */
import type { Refusal, RegistryStep } from "./releaseGuard.ts";

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type CursorPage = { isDone: boolean; continueCursor: string | null };
export type WalkLimits = { now: () => number; startedAt: number; timeoutMs: number; maxPages: number; refuseAtDeadline?: true };

/**
 * Walks one cursor-paged internal function to its end, handing each validated page to `onPage`. Every rollout phase that
 * pages by cursor goes through this one loop. `deployed` is the refusal subject ("Production is DEPLOYED, but ..."), so
 * the wording stays per phase while the deadline, page cap and cursor rules stay in one place.
 * Stops with a refusal on the deadline (checked before AND after every call, so a call that returns
 * past the budget is never accepted), the page cap, a failed call, an unrecognised page, or a
 * cursor that stopped advancing. The cursor lives only in the call arguments and is never logged.
 */
export function walkCursorPages<T extends CursorPage>(
  limits: WalkLimits,
  deployed: string,
  runPage: (cursor: string | null) => RegistryStep,
  parse: (value: unknown) => T | null,
  onPage: (page: T) => void,
): { ok: true } | Refusal {
  let cursor: string | null = null;
  const seen = new Set<string>();
  // Existing repairs accept equality; P7's original contract refuses at equality.
  const pastDeadline = () => {
    const elapsed = limits.now() - limits.startedAt;
    return elapsed > limits.timeoutMs || (limits.refuseAtDeadline === true && elapsed === limits.timeoutMs);
  };
  const deadlineRefusal: Refusal = {
    ok: false,
    reason: `${deployed} reached the rollout deadline. A re-run resumes it.`,
  };
  for (let pageNumber = 0; pageNumber < limits.maxPages; pageNumber += 1) {
    if (pastDeadline()) return deadlineRefusal;
    const result = runPage(cursor);
    // Checked again AFTER the call: a call that returns past the budget must not be accepted as
    // complete, or the run would go on to later phases having overrun the deadline (fail closed).
    if (pastDeadline()) return deadlineRefusal;
    if (!result.ok) {
      return { ok: false, reason: `${deployed} call failed. See backend logs; a re-run resumes it.` };
    }
    const page = parse(result.value);
    if (!page) return { ok: false, reason: `${deployed} returned an unrecognised result.` };
    onPage(page);
    if (page.isDone) return { ok: true };
    if (typeof page.continueCursor !== "string" || page.continueCursor === "" || seen.has(page.continueCursor)) {
      return { ok: false, reason: `${deployed} cursor stopped advancing; refusing to page forever.` };
    }
    seen.add(page.continueCursor);
    cursor = page.continueCursor;
  }
  return { ok: false, reason: `${deployed} reached its page cap. A re-run resumes it.` };
}

export function parseCursorPage(value: unknown): CursorPage | null {
  if (typeof value !== "object" || value === null) return null;
  const { isDone, continueCursor } = value as { isDone?: unknown; continueCursor?: unknown };
  if (typeof isDone !== "boolean") return null;
  if (continueCursor !== null && typeof continueCursor !== "string") return null;
  return { isDone, continueCursor };
}

