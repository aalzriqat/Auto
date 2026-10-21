import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertStillPending, pickSeededDraft } from "../playwright/legacyDraftScope";

const row = (orgId: string, over: Partial<{ _id: string; memo: string }> = {}) => ({
  _id: "d1",
  memo: "m",
  createdBy: "u1",
  orgId,
  ...over,
});

describe("approve-door draft org scope (SCRUM-795)", () => {
  it("accepts a memo match in the seeded org", () => {
    expect(pickSeededDraft([row("orgA")], "m", "orgA")?._id).toBe("d1");
  });
  it("returns undefined when no memo matches (fixture-missing path stays with the caller)", () => {
    expect(pickSeededDraft([row("orgA", { memo: "x" })], "m", "orgA")).toBeUndefined();
  });
  it("RED: memo match in another org throws on the first read", () => {
    expect(() => pickSeededDraft([row("orgB")], "m", "orgA")).toThrow(/not the seeded org/);
  });
  it("accepts a read-back in the seeded org", () => {
    expect(() => assertStillPending([row("orgA")], "d1", "orgA")).not.toThrow();
  });
  it("RED: read-back row in another org throws", () => {
    expect(() => assertStillPending([row("orgB")], "d1", "orgA")).toThrow(/not the seeded org/);
  });
  it("RED: read-back without the draft throws", () => {
    expect(() => assertStillPending([], "d1", "orgA")).toThrow(/no longer pending/);
  });

  it("the spec routes BOTH pending reads through the org-scope helpers", () => {
    const src = readFileSync(path.join(process.cwd(), "playwright/tests/accounting.spec.ts"), "utf8");
    expect(src).toContain("pickSeededDraft(pending, LEGACY_MEMO, orgId)");
    expect(src).toContain("assertStillPending(after, seeded._id, orgId)");
    expect(src).not.toMatch(/\.find\(\(d\) => d\.memo === LEGACY_MEMO\)/);
    expect(src).not.toMatch(/after\.some\(/);
  });
});
