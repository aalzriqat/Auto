import { describe, expect, test } from "vitest";
import type { GenericDatabaseWriter, GenericDataModel } from "convex/server";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");
type Harness = ReturnType<typeof convexTestWithComponents>;
type Validator = { kind: string; isOptional?: string; fields?: Record<string, Validator>;
  members?: Validator[]; element?: Validator; tableName?: string; value?: unknown };
const tables = schema.tables as unknown as Record<string, { validator: Validator }>;

/** Real schema-valid documents and required FK targets; optional links are explicit in each case. */
async function document(ctx: MutationCtx, orgId: Id<"organizations">, table: string,
  overrides: Record<string, unknown> = {}, cache = new Map<string, string>()): Promise<string> {
  const db = ctx.db as GenericDatabaseWriter<GenericDataModel>;
  cache.set("organizations", orgId);
  async function value(v: Validator, field: string): Promise<unknown> {
    if (v.isOptional === "optional") return undefined;
    switch (v.kind) {
      case "object": {
        const result: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(v.fields ?? {})) {
          const childValue = await value(child, key);
          if (childValue !== undefined) result[key] = childValue;
        }
        return result;
      }
      case "id": {
        const target = v.tableName;
        if (!target) throw new Error("Missing fixture table");
        if (target === "_storage") return ctx.storage.store(new Blob(["fixture"]));
        const existing = cache.get(target);
        if (existing) return existing;
        return document(ctx, orgId, target, {}, cache);
      }
      case "union": {
        const first = v.members?.[0];
        if (!first) throw new Error("Empty fixture union");
        return value(first, field);
      }
      case "literal": return v.value;
      case "array": return [];
      case "record": return {};
      case "string": return field === "currency" ? "JOD" : `fixture-${field}`;
      case "float64": return 1;
      case "boolean": return false;
      case "null": return null;
      case "any": return {};
      default: throw new Error(`Unhandled fixture validator ${v.kind}`);
    }
  }
  const def = tables[table];
  if (!def) throw new Error(`Unknown fixture table ${table}`);
  const fields = await value(def.validator, table) as Record<string, unknown>;
  const id = await db.insert(table, { ...fields, ...overrides });
  cache.set(table, id);
  return id;
}

async function fixture() {
  const t = convexTestWithComponents(schema, modules);
  const [a, b] = await t.run(async ctx => {
    const a = await ctx.db.insert("organizations", { name: "Reset A", createdAt: 1, suspended: true });
    const b = await ctx.db.insert("organizations", { name: "Keep B", createdAt: 1, suspended: true });
    await ctx.db.insert("customers", { orgId: a, firstName: "Keep", lastName: "A" });
    await ctx.db.insert("customers", { orgId: b, firstName: "Keep", lastName: "B" });
    return [a, b];
  });
  return { t, a, b };
}

async function snapshot(t: Harness) {
  return t.run(async ctx => {
    const db = ctx.db as GenericDatabaseWriter<GenericDataModel>;
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(tables)) out[table] = await db.query(table).collect();
    return out;
  });
}

const reset = (t: Harness, orgId: Id<"organizations">, dryRun = false) =>
  t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId, dryRun, batchSize: 1 });

const five = ["vehicleCommitmentClaims", "commitmentRoots", "depositApplications",
  "financeCompanyForwards", "financeCompanyForwardSlices"];
// Literal acceptance oracle, independent of the runtime's derived guard list.
const survivors = ["applicationDocuments", "bankStatementLines", "cashMovements", "claims",
  "collectionReminders", "dealerProductDeferrals", "dealUnwinds", "customerFinanceCompanyPayments",
  "employeeAdvanceRecoveries", "fixedAssetEvents", "manualJournalDrafts", "openingBalanceDrafts",
  "partnerEquityTransactions", "paymentIntents", "prepaidExpenseSchedules"];

describe("SCRUM-565 narrow reset", () => {
  test("clean fresh reset drains vehicles and the five tables; retries preserve kept rows and org B", async () => {
    const { t, a, b } = await fixture();
    await t.run(async ctx => {
      for (const org of [a, b]) {
        const cache = new Map<string, string>();
        for (const table of five) await document(ctx, org, table, {}, cache);
        await document(ctx, org, "vehicles", { status: "SOLD" });
      }
      await document(ctx, a, "vehicles", { status: "AVAILABLE" });
    });
    const before = await snapshot(t);
    const dry = await reset(t, a, true);
    expect(dry).toMatchObject({ preflight: { verdict: "PASS" } });
    expect(await snapshot(t)).toEqual(before);
    const first = await reset(t, a);
    expect(first.remaining).toBeGreaterThan(0);
    expect((await t.run(ctx => ctx.db.get(a)))?.financialResetGeneration).toBe(1);
    let remaining = first.remaining;
    for (let pass = 0; pass < 80 && remaining > 0; pass += 1) remaining = (await reset(t, a)).remaining;
    expect(remaining).toBe(0);
    const after = await snapshot(t);
    for (const table of [...five, "vehicles"]) {
      expect((after[table] as Array<{ orgId?: string }>).filter(r => r.orgId === a), table).toEqual([]);
    }
    expect(after.customers).toEqual(before.customers);
    for (const table of Object.keys(tables)) {
      const ownedByB = (rows: unknown[]) => (rows as Array<{ orgId?: string; _id: string }>).filter(r => r.orgId === b || r._id === b);
      expect(ownedByB(after[table]), table).toEqual(ownedByB(before[table]));
    }
    expect(await t.run(ctx => ctx.db.get(a))).toMatchObject({ financialResetGeneration: 1, financialResetCompletedGeneration: 1 });
  });

  test.each(survivors)("survivor %s refuses by table before any write", async table => {
    const { t, a, b } = await fixture();
    await t.run(async ctx => {
      await document(ctx, a, table);
      await document(ctx, b, "vehicles");
    });
    const before = await snapshot(t);
    const dry = await reset(t, a, true);
    expect(dry).toMatchObject({ preflight: { verdict: "REFUSED" } });
    await expect(reset(t, a)).rejects.toThrow(new RegExp(`${table}.*[1-9]`));
    expect(await snapshot(t)).toEqual(before);
  });

  test.each(["dealCommissionLines", "supplierCostRecoveries", "postDatedCheques", "unmatchedProviderFunds"])(
    "risky family %s refuses by table before any write", async table => {
      const { t, a } = await fixture();
      await t.run(ctx => document(ctx, a, table, { orgId: a }));
      const before = await snapshot(t);
      await expect(reset(t, a)).rejects.toThrow(new RegExp(`${table}.*[1-9]`));
      expect(await snapshot(t)).toEqual(before);
    });

  test("over-bound terminal cheques are UNAVAILABLE, not a partial PASS", async () => {
    const { t, a } = await fixture();
    await t.run(async ctx => {
      const cache = new Map<string, string>();
      for (let i = 0; i < 101; i += 1) await document(ctx, a, "postDatedCheques", { status: "RETURNED" }, cache);
    });
    const before = await snapshot(t);
    expect(await reset(t, a, true)).toMatchObject({ preflight: { verdict: "UNAVAILABLE" } });
    await expect(reset(t, a)).rejects.toThrow(/UNAVAILABLE.*postDatedCheques|postDatedCheques.*UNAVAILABLE/);
    expect(await snapshot(t)).toEqual(before);
  });
});
