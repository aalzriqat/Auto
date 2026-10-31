/**
 * The checker stands in for Convex's argument validation (https://docs.convex.dev/functions/validation), which
 * rejects any field the validator does not declare. A name inherited from Object.prototype is not declared.
 */
import { describe, expect, test } from "vitest";
import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { registeredArgsProblems } from "./registeredArgs";

const registered = mutationGeneric({
  args: { orgId: v.string(), note: v.optional(v.string()), nested: v.optional(v.object({ amount: v.number() })) },
  handler: async () => null,
});

describe("registeredArgsProblems", () => {
  test("accepts a payload that matches the validator", () => {
    expect(registeredArgsProblems(registered, { orgId: "o1", note: "n", nested: { amount: 1 } })).toEqual([]);
  });

  test("refuses a field named after an inherited Object.prototype member", () => {
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const problems = registeredArgsProblems(registered, { orgId: "o1", [inherited]: "x" });
      expect(problems, inherited).toEqual([expect.stringMatching(new RegExp(`extra field \`${inherited}\``))]);
    }
  });

  test("refuses an inherited-name field inside a nested object", () => {
    const problems = registeredArgsProblems(registered, { orgId: "o1", nested: { amount: 1, constructor: 7 } });
    expect(problems).toEqual([expect.stringMatching(/extra field `constructor`/)]);
  });

  test("still refuses a missing required field and an ordinary unknown field", () => {
    expect(registeredArgsProblems(registered, {})).toEqual([expect.stringMatching(/missing the required field `orgId`/)]);
    expect(registeredArgsProblems(registered, { orgId: "o1", other: 1 })).toEqual([expect.stringMatching(/extra field `other`/)]);
  });

  test("returns null for something that is not a registered function", () => {
    expect(registeredArgsProblems(undefined, {})).toBeNull();
    expect(registeredArgsProblems({}, {})).toBeNull();
  });
});
