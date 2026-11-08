// @vitest-environment node
/**
 * SCRUM-418 guardrail 2: nothing imports a door. A door is a top-level
 * convex/<name> module that registers a public function (found with
 * convexFunctions.mjs, custom builders included), so a top-level helper module
 * stays importable and a module becomes a door the moment it registers one.
 */
import { describe, expect, test } from "vitest";

import { doorModules, extractFacts, resolvePublicFunctions } from "./convexFunctions.mjs";
import { importViolations } from "./rules.mjs";
import { TIMEOUT, check, expectFailure, fixtureRepo, git, registerFixtureCleanup, remove, write } from "./testkit";

registerFixtureCleanup();

const RULE = "no-door-import";
const SERVER = 'import { query, internalQuery } from "./_generated/server";\n';
const DOOR = `${SERVER}export const list = query({ args: {}, returns: null, handler: async () => null });\n`;

function doorsOf(files: Record<string, string>): string[] {
  const facts = new Map(Object.entries(files).map(([p, text]) => [p, extractFacts(p, text)]));
  return [...doorModules(resolvePublicFunctions(facts), facts)].sort();
}

function found(from: string, spec: string, doors = ["convex/applications"]): string[] {
  return importViolations(from, `import { x } from "${spec}";\nexport const y = x;\n`, new Set(doors)).map(
    (v: { rule: string; to: string }) => `${v.rule} ${v.to}`,
  );
}

describe("which modules are doors", () => {
  test("a top-level module that registers a public function is a door", () => {
    expect(doorsOf({ "convex/applications.ts": DOOR })).toEqual(["convex/applications"]);
    expect(doorsOf({ "convex/applications.ts": `${SERVER}export default query({ handler: async () => null });\n` })).toEqual(["convex/applications"]);
  });

  test("a top-level helper, a schema and a module with only internal functions are not doors", () => {
    expect(
      doorsOf({
        "convex/helpers.ts": "export const toMinor = (n: number) => n * 100;\n",
        "convex/schema.ts": "export default {};\n",
        "convex/internalOnly.ts": `${SERVER}export const i = internalQuery({ handler: async () => null });\n`,
        "convex/unexported.ts": `${SERVER}const hidden = query({ handler: async () => null });\n`,
      }),
    ).toEqual([]);
  });

  test("a nested module is not a door even when it registers a public function", () => {
    expect(doorsOf({ "convex/accounting/refunds.ts": 'import { query } from "../_generated/server";\nexport const r = query({ handler: async () => null });\n' })).toEqual([]);
  });

  test("a module whose only public function comes from a custom builder defined elsewhere is a door", () => {
    expect(
      doorsOf({
        "convex/utils/builders.ts": 'import { query } from "../_generated/server";\nimport { customQuery } from "convex-helpers/server/customFunctions";\nexport const authed = customQuery(query, { args: {}, input: async () => ({ ctx: {}, args: {} }) });\n',
        "convex/orders.ts": 'import { authed } from "./utils/builders";\nexport const list = authed({ handler: async () => null });\n',
      }),
    ).toEqual(["convex/orders"]);
  });
});

describe("nothing imports a door", () => {
  test("negative control: every production root importing a door fails, however it is spelled", () => {
    const target = `${RULE} convex/applications`;
    expect(found("lib/deals.ts", "@/convex/applications")).toEqual([target]);
    expect(found("app/page.tsx", "../convex/applications")).toEqual([target]);
    expect(found("components/Deal.tsx", "@/convex/applications.ts")).toEqual([target]);
    expect(found("convex/accounting/refunds.ts", "../applications")).toEqual([target]);
    expect(found("convex/other.ts", "./applications")).toEqual([target]);
    expect(found("convex/domains/deals/commands/close.ts", "@/convex/./applications")).toEqual([target]);
    expect(found("convex/domains/deals/commands/close.ts", "@///convex/applications")).toEqual([target]);
  });

  test("negative control: re-export, dynamic import and require of a door fail too", () => {
    const source = 'export { list } from "@/convex/applications";\nconst lazy = () => import("@/convex/applications");\nconst c = require("@/convex/applications");\n';
    expect(importViolations("lib/x.ts", source, new Set(["convex/applications"])).map((v: { rule: string }) => v.rule)).toEqual([RULE]);
  });

  test("positive control: a helper module, the generated api and a package pass", () => {
    expect(found("lib/deals.ts", "@/convex/helpers")).toEqual([]);
    expect(found("lib/deals.ts", "@/convex/_generated/api")).toEqual([]);
    expect(found("lib/deals.ts", "convex/values")).toEqual([]);
    expect(found("lib/deals.ts", "@/convex/accounting/refunds")).toEqual([]);
  });

  test("a test file may import a door", () => {
    expect(found("lib/deals.test.ts", "@/convex/applications")).toEqual([]);
  });
});

describe("the door rule through the whole checker", () => {
  const TARGET = { "convex/applications.ts": DOOR, "convex/helpers.ts": "export const toMinor = (n: number) => n * 100;\n" };

  test("negative control: a new import of a door from components fails and is not grandfathered", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "components/Deal.ts", 'import { list } from "@/convex/applications";\nexport const d = list;\n');
    const result = await check(root);
    expect(result.errors).toEqual([`IMPORT-NEW [${RULE}] components/Deal.ts -> convex/applications`]);
  }, TIMEOUT);

  test("negative control: a door importing another door fails", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "convex/second.ts", `${SERVER}import { list } from "./applications";\nexport const s = query({ args: {}, returns: null, handler: async () => list });\n`);
    const result = await check(root);
    expectFailure(result.errors, /^IMPORT-NEW \[no-door-import\] convex\/second\.ts -> convex\/applications/);
  }, TIMEOUT);

  test("negative control: turning an imported helper into a door makes its existing importers violate", async () => {
    const root = fixtureRepo({ ...TARGET, "components/money.ts": 'import { toMinor } from "@/convex/helpers";\nexport const m = toMinor(1);\n' });
    write(root, "convex/helpers.ts", `${SERVER}export const toMinor = query({ args: {}, returns: null, handler: async () => null });\n`);
    const result = await check(root);
    expect(result.errors).toEqual([`IMPORT-NEW [${RULE}] components/money.ts -> convex/helpers`]);
  }, TIMEOUT);

  test("positive control: importing a top-level helper passes", async () => {
    const root = fixtureRepo(TARGET);
    write(root, "components/money.ts", 'import { toMinor } from "@/convex/helpers";\nexport const m = toMinor(1);\n');
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);

  test("an edge that is on the target is grandfathered, and must be removed from the list once it is gone", async () => {
    const root = fixtureRepo({ ...TARGET, "components/Deal.ts": 'import { list } from "@/convex/applications";\nexport const d = list;\n' });
    write(
      root,
      "quality/guardrails/baseline.json",
      `${JSON.stringify({ schemaVersion: 1, sourceCommit: "0".repeat(40), sizeCeilings: {}, importGrandfather: [{ rule: RULE, from: "components/Deal.ts", to: "convex/applications" }] }, null, 2)}\n`,
    );
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "target with a grandfathered door import");
    expect((await check(root)).errors).toEqual([]);
    remove(root, "components/Deal.ts");
    expectFailure((await check(root)).errors, /^STALE-GRANDFATHER \[no-door-import\] components\/Deal\.ts -> convex\/applications/);
  }, TIMEOUT);

  test("a door in a convex module outside the counted scope still counts as a door", async () => {
    const root = fixtureRepo({ "convex/migrateOld.ts": `${SERVER}export const run = query({ handler: async () => null });\n` });
    write(root, "components/Deal.ts", 'import { run } from "@/convex/migrateOld";\nexport const d = run;\n');
    const result = await check(root);
    expect(result.errors).toEqual([`IMPORT-NEW [${RULE}] components/Deal.ts -> convex/migrateOld`]);
  }, TIMEOUT);
});
