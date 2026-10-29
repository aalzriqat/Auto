/**
 * SCRUM-85 (B1): one org-currency resolver, in a LEAF module.
 *
 * `getOrgCurrency` used to live in accounting/workflowHooks (a hub that imports most of the
 * accounting engine) while accountingReports.ts kept a private copy and financialAudit.ts and
 * vatReport.ts re-implemented or reached through the hub. This pins:
 *  - the resolver lives in convex/utils/orgCurrency.ts, which value-imports only ./money (so it
 *    cannot be part of an import cycle: money only imports ./errors), and type-imports _generated;
 *  - workflowHooks re-exports that same function (identity), so existing callers are unchanged;
 *  - the three former copies use it;
 *  - the resolver returns the stored currency and refuses, with the typed code, when none exists.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConvexError } from "convex/values";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { getOrgCurrency as hubGetOrgCurrency } from "./accounting/workflowHooks";
import { getOrgCurrency } from "./utils/orgCurrency";

const MODULE_GLOB = import.meta.glob("./**/*.ts");
const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** Module specifiers of runtime (non type-only) imports and re-exports. */
function valueImports(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?\sfrom\s+["']([^"']+)["']/gm)) {
    if (match[1] === undefined) found.push(match[2]);
  }
  for (const match of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.push(match[1]);
  return found;
}

describe("SCRUM-85 B1: the org-currency resolver is a leaf module", () => {
  test("convex/utils/orgCurrency.ts value-imports only ./money", () => {
    expect(valueImports(source("./utils/orgCurrency.ts"))).toEqual(["./money"]);
  });

  test("workflowHooks re-exports the same function", () => {
    expect(hubGetOrgCurrency).toBe(getOrgCurrency);
  });

  test.each([
    ["accountingReports.ts", "./accountingReports.ts"],
    ["financialAudit.ts", "./financialAudit.ts"],
    ["vatReport.ts", "./vatReport.ts"],
  ])("%s reads the currency through the leaf, not a private copy or the hub", (_name, file) => {
    const text = source(file);
    expect(valueImports(text)).toContain("./utils/orgCurrency");
    expect(text).not.toContain("getOrgCurrencyForReports");
    expect(valueImports(text)).not.toContain("./accounting/workflowHooks");
  });
});

describe("SCRUM-85 B1: getOrgCurrency behaviour", () => {
  test("returns the stored currency", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB);
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Dealer", createdAt: Date.now() }));
    await t.run(async (ctx) => {
      const row = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
      if (row === null) throw new Error("harness did not seed a stored currency");
      await ctx.db.patch(row._id, { currency: "EUR" });
    });
    expect(await t.run((ctx) => getOrgCurrency(ctx, orgId))).toBe("EUR");
  });

  test("refuses with CURRENCY_NOT_CONFIGURED when the org stored none", async () => {
    const t = convexTestWithComponents(schema, MODULE_GLOB, { storedOrgCurrency: false });
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Dealer", createdAt: Date.now() }));
    const error = await t.run((ctx) => getOrgCurrency(ctx, orgId)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code?: string }>).data).toMatchObject({ code: "CURRENCY_NOT_CONFIGURED" });
  });
});