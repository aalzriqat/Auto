/**
 * SCRUM-565 D-19 — the shared barrier predicate and the begin-reset transition.
 * Pure functions: no database, no harness.
 */
import { describe, expect, test } from "vitest";
import {
  beginResetGenerationPatch,
  isFreshResetStartRefused,
  orgResetState,
} from "./orgResetGeneration";

const idle = { financialResetGeneration: 3, financialResetCompletedGeneration: 3 };
const inProgress = { financialResetGeneration: 4, financialResetCompletedGeneration: 3 };

describe("isFreshResetStartRefused", () => {
  test("destructive call with no organization row is refused", () => {
    expect(isFreshResetStartRefused(null, false)).toBe(true);
  });

  test("destructive call on an org with no reset in progress is refused", () => {
    expect(isFreshResetStartRefused(idle, false)).toBe(true);
    expect(isFreshResetStartRefused({}, false)).toBe(true);
  });

  test("destructive call on an org already mid-reset (a continuation) is allowed", () => {
    expect(isFreshResetStartRefused(inProgress, false)).toBe(false);
  });

  test("a dry run is never refused, whatever the org state", () => {
    expect(isFreshResetStartRefused(null, true)).toBe(false);
    expect(isFreshResetStartRefused(idle, true)).toBe(false);
    expect(isFreshResetStartRefused(inProgress, true)).toBe(false);
  });
});

describe("beginResetGenerationPatch", () => {
  test("moves {generation N, completed N} to generation N+1 and puts the org in progress", () => {
    const patch = beginResetGenerationPatch(idle);
    expect(patch).toEqual({ financialResetGeneration: 4 });
    const after = { ...idle, ...patch };
    expect(orgResetState(after)).toEqual({ generation: 4, inProgress: true });
  });

  test("an org with neither field starts at generation 1", () => {
    expect(beginResetGenerationPatch({})).toEqual({ financialResetGeneration: 1 });
  });
});
