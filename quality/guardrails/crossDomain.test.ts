// @vitest-environment node
/**
 * SCRUM-418 section 3, guardrail 2 (A1): nothing outside convex/domains/<x>/
 * imports convex/domains/<x>/** except its index.ts, whoever the importer is
 * (another domain, a door, convex/accounting, lib, app, any production root),
 * and components/** may not import convex/domains/** at all. convex/domains/
 * does not exist yet, so nothing is grandfathered.
 */
import { describe, expect, test } from "vitest";

import { importViolations } from "./rules.mjs";
import {
  TIMEOUT,
  baseBaseline,
  check,
  expectFailure,
  fixtureRepo,
  registerFixtureCleanup,
  write,
  writeBaselineDoc,
} from "./testkit";

registerFixtureCleanup();

const CROSS = "domains-cross-domain-index-only";
const NO_DOMAINS = "components-no-domains";

function found(from: string, spec: string): string[] {
  return importViolations(from, `import { x } from "${spec}";\nexport const y = x;\n`).map(
    (v: { rule: string; to: string }) => `${v.rule} ${v.to}`,
  );
}

const FROM = "convex/domains/deals/commands/close.ts";

describe("cross-domain imports go through the domain index (A1)", () => {
  test("negative control: a deep import into another domain fails, however it is spelled", () => {
    const target = `${CROSS} convex/domains/inventory/commands/reserve`;
    expect(found(FROM, "@/convex/domains/inventory/commands/reserve")).toEqual([target]);
    expect(found(FROM, "../../inventory/commands/reserve")).toEqual([target]);
    expect(found(FROM, "@/convex/domains/./inventory/commands/reserve")).toEqual([target]);
    expect(found(FROM, "@//convex/domains/inventory/commands/reserve")).toEqual([target]);
    expect(found(FROM, "@/convex/domains/deals/../inventory/commands/reserve")).toEqual([target]);
    expect(found(FROM, "@/convex/domains/inventory/policy")).toEqual([`${CROSS} convex/domains/inventory/policy`]);
  });

  test("negative control: a sub-directory index is not the domain index", () => {
    expect(found(FROM, "@/convex/domains/inventory/commands/index")).toEqual([
      `${CROSS} convex/domains/inventory/commands`,
    ]);
  });

  test("negative control: re-export, dynamic import and require are judged like a static import", () => {
    const source = [
      'export { a } from "@/convex/domains/inventory/internal/a";',
      'const lazy = () => import("@/convex/domains/inventory/internal/b");',
      'const c = require("@/convex/domains/inventory/internal/c");',
      'import type { D } from "@/convex/domains/inventory/internal/d";',
    ].join("\n");
    const rules = importViolations(FROM, source).map((v: { rule: string; to: string }) => v.to).sort();
    expect(rules).toEqual([
      "convex/domains/inventory/internal/a",
      "convex/domains/inventory/internal/b",
      "convex/domains/inventory/internal/c",
      "convex/domains/inventory/internal/d",
    ]);
  });

  test("positive control: the domain index passes, spelled with or without /index", () => {
    expect(found(FROM, "@/convex/domains/inventory")).toEqual([]);
    expect(found(FROM, "@/convex/domains/inventory/index")).toEqual([]);
    expect(found(FROM, "../../inventory")).toEqual([]);
    expect(found(FROM, "../../inventory/index.ts")).toEqual([]);
  });

  test("positive control: the same domain may import its own internals; shared utils and packages pass", () => {
    expect(found(FROM, "../policy/canClose")).toEqual([]);
    expect(found(FROM, "@/convex/domains/deals/policy/canClose")).toEqual([]);
    expect(found(FROM, "@/convex/utils/money")).toEqual([]);
    expect(found(FROM, "convex/values")).toEqual([]);
  });

  test("a test file under convex/domains is out of scope", () => {
    expect(found("convex/domains/deals/commands/close.test.ts", "@/convex/domains/inventory/commands/reserve")).toEqual([]);
  });
});

describe("components do not import convex/domains directly", () => {
  test("negative control: any import from convex/domains/** fails, index included", () => {
    expect(found("components/Deal.tsx", "@/convex/domains/deals")).toEqual([`${NO_DOMAINS} convex/domains/deals`]);
    expect(found("components/Deal.tsx", "../convex/domains/deals/commands/close")).toEqual([
      `${NO_DOMAINS} convex/domains/deals/commands/close`,
    ]);
  });

  test("positive control: components may import other Convex modules and the generated api", () => {
    expect(found("components/Deal.tsx", "@/convex/_generated/api")).toEqual([]);
    expect(found("components/Deal.tsx", "@/lib/format")).toEqual([]);
  });
});

describe("every importer outside a domain goes through the domain index", () => {
  const RULE = "domains-index-only";

  test("negative control: any production root importing a domain's internals fails", () => {
    const deep = "@/convex/domains/deals/commands/close";
    const target = `${RULE} convex/domains/deals/commands/close`;
    expect(found("convex/applications.ts", deep)).toEqual([target]);
    expect(found("convex/accounting/refunds.ts", deep)).toEqual([target]);
    expect(found("convex/utils/money.ts", "./../domains/deals/commands/close")).toEqual([target]);
    expect(found("lib/deals/close.ts", deep)).toEqual([target]);
    expect(found("app/page.tsx", deep)).toEqual([target]);
    expect(found("hooks/useDeal.ts", deep)).toEqual([target]);
    expect(found("packages/shared/src/deal.ts", deep)).toEqual([target]);
    expect(found("convex/applications.ts", "@/convex/domains/deals/policy")).toEqual([`${RULE} convex/domains/deals/policy`]);
  });

  test("negative control: a sub-directory index is not the domain index, from outside as well", () => {
    expect(found("convex/accounting/refunds.ts", "@/convex/domains/deals/commands/index")).toEqual([
      `${RULE} convex/domains/deals/commands`,
    ]);
  });

  test("positive control: the domain index passes from any importer, spelled with or without /index", () => {
    expect(found("convex/accounting/refunds.ts", "@/convex/domains/deals")).toEqual([]);
    expect(found("convex/applications.ts", "@/convex/domains/deals/index")).toEqual([]);
    expect(found("lib/deals/close.ts", "../../convex/domains/deals/index.ts")).toEqual([]);
  });

  test("positive control: a domain still imports its own internals, and a test file is out of scope", () => {
    expect(found("convex/domains/deals/commands/close.ts", "../policy/canClose")).toEqual([]);
    expect(found("convex/accounting/refunds.test.ts", "@/convex/domains/deals/commands/close")).toEqual([]);
  });

  test("the component rule is unchanged: components may not import a domain at all", () => {
    expect(found("components/Deal.tsx", "@/convex/domains/deals/commands/close")).toEqual([
      `${NO_DOMAINS} convex/domains/deals/commands/close`,
    ]);
  });

  test("negative control through the checker: convex/accounting importing a domain's internals fails and is not grandfathered", async () => {
    const root = fixtureRepo({
      "convex/domains/deals/index.ts": "export const close = 1;\n",
      "convex/domains/deals/commands/close.ts": "export const c = 1;\n",
    });
    write(root, "convex/accounting/refunds.ts", 'import { c } from "@/convex/domains/deals/commands/close";\nexport const r = c;\n');
    const result = await check(root);
    expect(result.errors).toEqual([`IMPORT-NEW [${RULE}] convex/accounting/refunds.ts -> convex/domains/deals/commands/close`]);
  }, TIMEOUT);

  test("positive control through the checker: convex/accounting importing the domain index passes", async () => {
    const root = fixtureRepo({
      "convex/domains/deals/index.ts": "export const close = 1;\n",
      "convex/domains/deals/commands/close.ts": "export const c = 1;\n",
    });
    write(root, "convex/accounting/refunds.ts", 'import { close } from "@/convex/domains/deals";\nexport const r = close;\n');
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);
});
describe("cross-domain rules through the whole checker", () => {
  test("negative control: a new cross-domain deep import fails the check and nothing grandfathers it", async () => {
    const root = fixtureRepo({
      "convex/domains/inventory/index.ts": "export const reserve = 1;\n",
      "convex/domains/inventory/commands/reserve.ts": "export const r = 1;\n",
    });
    write(root, FROM, 'import { r } from "@/convex/domains/inventory/commands/reserve";\nexport const c = r;\n');
    const result = await check(root);
    expect(result.errors).toEqual([`IMPORT-NEW [${CROSS}] ${FROM} -> convex/domains/inventory/commands/reserve`]);
  }, TIMEOUT);

  test("negative control: a PR cannot add the violation to its own grandfather list", async () => {
    const root = fixtureRepo({
      "convex/domains/inventory/index.ts": "export const reserve = 1;\n",
      "convex/domains/inventory/commands/reserve.ts": "export const r = 1;\n",
    });
    write(root, FROM, 'import { r } from "@/convex/domains/inventory/commands/reserve";\nexport const c = r;\n');
    writeBaselineDoc(root, {
      ...baseBaseline(),
      importGrandfather: [{ rule: CROSS, from: FROM, to: "convex/domains/inventory/commands/reserve" }],
    });
    const result = await check(root);
    expectFailure(result.errors, /^IMPORT-NEW \[domains-cross-domain-index-only\]/);
    expectFailure(result.errors, /^RATCHET new grandfathered import domains-cross-domain-index-only\|/);
  }, TIMEOUT);

  test("negative control: a new components -> convex/domains import fails", async () => {
    const root = fixtureRepo({ "convex/domains/deals/index.ts": "export const close = 1;\n" });
    write(root, "components/Deal.tsx", 'import { close } from "@/convex/domains/deals";\nexport const d = close;\n');
    const result = await check(root);
    expect(result.errors).toEqual([`IMPORT-NEW [${NO_DOMAINS}] components/Deal.tsx -> convex/domains/deals`]);
  }, TIMEOUT);

  test("positive control: importing another domain through its index passes", async () => {
    const root = fixtureRepo({
      "convex/domains/inventory/index.ts": "export const reserve = 1;\n",
      "convex/domains/inventory/commands/reserve.ts": "export const r = 1;\n",
    });
    write(root, FROM, 'import { reserve } from "@/convex/domains/inventory";\nexport const c = reserve;\n');
    const result = await check(root);
    expect(result.errors).toEqual([]);
  }, TIMEOUT);
});
