/**
 * S-16 guard: every entry point that names a Convex function must either have an
 * expected function type in compare's EXPECTED_FUNCTION_TYPE (so a Query called
 * through a mutation hook is a PROVEN break) or sit in the explicit, commented
 * exemption list below. A new DIRECT_CALLERS / ENTRY_TABLE member that is in
 * neither fails here instead of silently skipping the type check.
 *
 * The exempt names fail CLOSED rather than skip: see the "fail CLOSED" cases in
 * cliExit.test.ts, which prove each exits 9.
 */
import { describe, expect, it } from "vitest";
import { DIRECT_CALLERS } from "./clientPaths.mjs";
import { ENTRY_TABLE } from "./census.mjs";
import { EXPECTED_FUNCTION_TYPE } from "./compare.mjs";

const NOT_EXTRACTED =
  "not extracted by clientPaths; census records the call site UNACCOUNTED -> exit 9 (COVERAGE_INCOMPLETE). " +
  "Add to EXPECTED_FUNCTION_TYPE if extraction is ever added.";

/** Reviewed exemptions: name -> why no function type is asserted. */
const EXEMPT: Record<string, string> = {
  createMutation: NOT_EXTRACTED,
  onPaginatedUpdate_experimental: NOT_EXTRACTED,
  usePaginatedQuery_experimental: NOT_EXTRACTED,
  useQueriesHelper: NOT_EXTRACTED,
  useQuery_experimental: NOT_EXTRACTED,
};

const FUNCTION_REFERENCE_KINDS = new Set(["IMMEDIATE", "DEFERRED", "REQUEST_MAP"]);

const lastSegment = (key: string) => key.slice(key.lastIndexOf(".") + 1);

describe("EXPECTED_FUNCTION_TYPE coverage", () => {
  it("covers every DIRECT_CALLERS member", () => {
    const gaps = [...(DIRECT_CALLERS as Set<string>)].filter(
      (name) => !(name in EXPECTED_FUNCTION_TYPE) && !(name in EXEMPT),
    );
    expect(gaps).toEqual([]);
  });

  it("covers every function-reference ENTRY_TABLE hook and method", () => {
    const gaps = Object.entries(ENTRY_TABLE as Record<string, string>)
      .filter(([, kind]) => FUNCTION_REFERENCE_KINDS.has(kind))
      .map(([key]) => lastSegment(key))
      .filter((name) => !(name in EXPECTED_FUNCTION_TYPE) && !(name in EXEMPT));
    expect([...new Set(gaps)].sort()).toEqual([]);
  });

  it("keeps the exemption list honest: no exempt name is also typed", () => {
    expect(Object.keys(EXEMPT).filter((name) => name in EXPECTED_FUNCTION_TYPE)).toEqual([]);
  });
});
