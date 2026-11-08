// @vitest-environment node
/**
 * SCRUM-418 guardrail 2, the pure-policy rules. There is no mandated policy/
 * folder: "no React" applies to all of convex/domains/**, and "pure policy"
 * (no generated server module) applies to any path with a `policy` segment or a
 * file named `policy.ts`, `*policy.ts` or `*.policy.ts`, in any production root.
 * The "no door" half of pure policy is the global rule that nothing imports a door.
 */
import { describe, expect, test } from "vitest";

import { importViolations } from "./rules.mjs";
import { TIMEOUT, check, fixtureRepo, registerFixtureCleanup, write } from "./testkit";

registerFixtureCleanup();

function found(from: string, spec: string): string[] {
  return importViolations(from, `import { x } from "${spec}";\nexport const y = x;\n`).map(
    (v: { rule: string; to: string }) => `${v.rule} ${v.to}`,
  );
}

const SERVER = "policy-no-generated-server convex/_generated/server";

describe("no React anywhere under convex/domains", () => {
  test("negative control: React, react-dom and subpaths fail in any file of a domain", () => {
    expect(found("convex/domains/deals/commands/close.ts", "react")).toEqual(["domains-no-react react"]);
    expect(found("convex/domains/deals/index.ts", "react-dom/client")).toEqual(["domains-no-react react-dom/client"]);
    expect(found("convex/domains/deals/policy/view.ts", "react/jsx-runtime")).toEqual(["domains-no-react react/jsx-runtime"]);
    expect(found("convex/domains/deals/queries/list.ts", "../../../../node_modules/react")).toEqual(["domains-no-react react"]);
  });

  test("positive control: React outside convex/domains is not this rule, and a look-alike package passes", () => {
    expect(found("components/Deal.tsx", "react")).toEqual([]);
    expect(found("convex/accounting/refunds.ts", "react")).toEqual([]);
    expect(found("convex/domains/deals/commands/close.ts", "reactive-streams")).toEqual([]);
  });
});

describe("pure policy modules cannot import the generated server module", () => {
  test("negative control: a policy segment, policy.ts, *Policy.ts and *.policy.ts fail, in any production root", () => {
    expect(found("convex/domains/deals/policy/canClose.ts", "../../../_generated/server")).toEqual([SERVER]);
    expect(found("convex/accounting/policy/refunds.ts", "../../_generated/server")).toEqual([SERVER]);
    expect(found("lib/policy/rules.ts", "@/convex/_generated/server")).toEqual(["policy-no-generated-server convex/_generated/server"]);
    expect(found("convex/accounting/policy.ts", "./../_generated/server")).toEqual([SERVER]);
    expect(found("convex/utils/openingAccountPolicy.ts", "../_generated/server")).toEqual([SERVER]);
    expect(found("convex/accounting/refund.policy.ts", "../_generated/server")).toEqual([SERVER]);
  });

  test("positive control: a policy file may import other repo modules, and a non-policy file may import the server module", () => {
    expect(found("convex/accounting/policy/refunds.ts", "../../utils/money")).toEqual([]);
    expect(found("convex/accounting/refunds.ts", "../_generated/server")).toEqual([]);
    expect(found("convex/domains/deals/commands/close.ts", "../../../_generated/server")).toEqual([]);
    expect(found("convex/accounting/policyHelpers.ts", "../_generated/server")).toEqual([]);
  });

  test("a policy test file is out of scope", () => {
    expect(found("convex/accounting/policy/refunds.test.ts", "../../_generated/server")).toEqual([]);
  });

  test("negative control through the checker: a new policy file importing the server module fails and is not grandfathered", async () => {
    const root = fixtureRepo();
    write(root, "convex/accounting/refundPolicy.ts", 'import type { QueryCtx } from "../_generated/server";\nexport type C = QueryCtx;\n');
    const result = await check(root);
    expect(result.errors).toEqual([`IMPORT-NEW [policy-no-generated-server] convex/accounting/refundPolicy.ts -> convex/_generated/server`]);
  }, TIMEOUT);
});