/**
 * SCRUM-994: the Seat 2 (model, effort) pairing on the regular evidence path.
 * Sol models at low or medium, gpt-6-luna only at high. Kept out of
 * skillEnforcement.test.ts, which may only shrink (SOURCE-LINES-MAX).
 */
import { describe, expect, test } from "vitest";
import { evaluate } from "./prSkillEvidence.mjs";
import { fill } from "./skillEvidenceFixtures";

const money = ["convex/sales.ts", "convex/sales.test.ts"];
const problems = async (model: string, effort: string) =>
  (await evaluate({ body: fill({ "Seat 2 model": model, "Seat 2 effort": effort }), files: money, isPrCommit: async () => true })).problems;

describe("Seat 2 model and effort pairing", () => {
  test.each([
    ["gpt-6-sol", "low"], ["gpt-6-sol", "medium"], ["gpt-6.1-sol", "medium"], ["gpt-6.1-sol (Codex)", "low (Codex)"],
    ["gpt-6-luna", "high"], ["gpt-6-luna", "high (Codex)"], ["gpt-6-luna (Codex)", "HIGH"], ["GPT-6-LUNA", "High"],
  ])("accepts %s at %s", async (model, effort) => {
    expect(await problems(model, effort)).toEqual([]);
  });

  test.each([
    ["gpt-6-luna", "medium"], ["gpt-6-luna", "low"], ["gpt-6-luna", "xhigh"], ["gpt-6-luna", "max"], ["gpt-6-luna", "high-ish"],
    ["gpt-6-sol", "high"], ["gpt-6.1-sol", "high"], ["gpt-6-sol", "xhigh"], ["gpt-6-sol", "ultra"], ["gpt-6-sol", "highest"],
    ["gpt-6-lunar", "high"], ["gpt-5", "high"],
  ])("refuses %s at %s", async (model, effort) => {
    expect((await problems(model, effort)).length).toBeGreaterThan(0);
  });

  test("a Luna-at-medium refusal states the real rule", async () => {
    const text = (await problems("gpt-6-luna", "medium")).join("\n");
    expect(text).toContain("gpt-6-sol or gpt-6.1-sol at low or medium effort, or gpt-6-luna at high effort");
  });

  test("a Sol-at-high refusal states the real rule", async () => {
    const text = (await problems("gpt-6.1-sol", "high")).join("\n");
    expect(text).toContain("gpt-6-sol or gpt-6.1-sol at low or medium effort, or gpt-6-luna at high effort");
  });

  test("an unknown model keeps its model message", async () => {
    expect((await problems("gpt-5", "medium")).join("\n")).toContain('"Seat 2 model" must be gpt-6-sol, gpt-6.1-sol or gpt-6-luna');
  });
});
