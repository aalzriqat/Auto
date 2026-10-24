import type { FunctionReturnType } from "convex/server";
import type { QueryCtx } from "./_generated/server";
import { postedOpeningAllocationReadback } from "./accountingCutover";
import { expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import { collectOpeningCommissions } from "./utils/openingCommissionBasis";

/** Pass-through database telemetry: actual harness returns, not estimated/billed platform reads. */
function recordedDb<Db extends QueryCtx["db"]>(db: Db, totals: { gets: number; queries: number; documents: number; journalLines: number }) {
  function queryObject(target: object, table: string): object {
    return new Proxy(target, { get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, object, args);
        if (["collect", "take", "first", "unique"].includes(String(key))) {
          return Promise.resolve(result).then(rows => {
            const count = Array.isArray(rows) ? rows.length : rows ? 1 : 0;
            totals.documents += count;
            if (table === "journalLines") totals.journalLines += count;
            return rows;
          });
        }
        return result && typeof result === "object" ? queryObject(result, table) : result;
      };
    } });
  }
  return new Proxy(db, { get(target, key) {
    if (key === "get") return async (...args: Parameters<typeof db.get>) => {
      totals.gets += 1;
      const row = await Reflect.apply(db.get, db, args);
      if (row) totals.documents += 1;
      return row;
    };
    if (key === "query") return (table: Parameters<typeof db.query>[0]) => {
      totals.queries += 1;
      return queryObject(db.query(table), table);
    };
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

for (const count of [10, 100]) {
  test(`actual opening commission source reads at ${count} admitted account/employee rows`, async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s")); registerRateLimiter(t);
    const seed = await t.run(async ctx => {
      const orgId = await ctx.db.insert("organizations", { name: "QA TEST commission read shape", createdAt: Date.now() });
      const owner = await ctx.db.insert("users", { clerkId: `commission-budget-${count}`, email: "budget@example.test" });
      const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
      await ctx.db.insert("memberships", { orgId, userId: owner, roleId });
      await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
      await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
      return { orgId, roleId };
    });
    const owner = t.withIdentity({ subject: `commission-budget-${count}` });
    await owner.mutation(api.chartOfAccounts.initialize, { orgId: seed.orgId });
    const now = new Date();
    await owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId, startDate: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), endDate: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1, fiscalYear: now.getUTCFullYear(), periodNumber: now.getUTCMonth() + 1 });
    const [period] = await owner.query(api.accountingPeriods.list, { orgId: seed.orgId });
    await owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: period._id });
    const rows = await t.run(async ctx => {
      const allocations = [];
      const accounts = await ctx.db.query("chartOfAccounts").withIndex("by_org", q => q.eq("orgId", seed.orgId)).collect();
      const cash = accounts.find(row => row.systemKey === "CASH_ON_HAND");
      if (!cash) throw new Error("Missing synthetic cash control");
      for (let index = 0; index < count; index += 1) {
        const userId = await ctx.db.insert("users", { clerkId: `commission-budget-employee-${count}-${index}`, email: `budget-${index}@example.test` });
        await ctx.db.insert("memberships", { orgId: seed.orgId, userId, roleId: seed.roleId });
        const accountId = await ctx.db.insert("chartOfAccounts", { orgId: seed.orgId, code: `29${String(index).padStart(3,"0")}`, name: "Synthetic commission control", type: "LIABILITY", normalBalance: "CREDIT", isControlAccount: true, allowManualPosting: false, active: true, createdAt: Date.now(), updatedAt: Date.now() });
        allocations.push({ kind: "EMPLOYEE_COMMISSION" as const, rowKey: `budget-${index}`, accountId, userId, amountMinor: 1000 });
      }
      return { allocations, cashId: cash._id };
    });
    await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, { orgId: seed.orgId, expectedCurrency: "JOD", asOfDate: Date.now(),
      lines: [{ accountId: rows.cashId, debitMinor: count * 1000, creditMinor: 0 }, ...rows.allocations.map(row => ({ accountId: row.accountId, debitMinor: 0, creditMinor: 1000 }))], allocations: rows.allocations });
    const totals = { gets: 0, queries: 0, documents: 0, journalLines: 0 };
    await t.run(async ctx => {
      const current = await collectOpeningCommissions({ ...ctx, db: recordedDb(ctx.db, totals) }, seed.orgId, "JOD", new Set(rows.allocations.map(row => row.userId)), Date.now());
      expect(current.size).toBe(count);
      expect([...current.values()].reduce((sum, row) => sum + row.minor, 0)).toBe(count * 1000);
    });
    console.info("COMMISSION_READ_SHAPE", JSON.stringify({ count, ...totals, scope: "actual collectOpeningCommissions harness DB returns; no platform/byte/OCC claim" }));
    expect(totals.journalLines).toBe(count + 1);
    // The pinned native registration stores this same handler; convex-test also
    // extracts it when dispatching the normal FunctionReference query above.
    const handler:unknown=Reflect.get(postedOpeningAllocationReadback,"_handler");
    if(typeof handler !== "function")throw new Error("Registered public readback handler is unavailable");
    const invoke=handler as (ctx:QueryCtx,args:{orgId:typeof seed.orgId})=>Promise<FunctionReturnType<typeof api.accountingCutover.postedOpeningAllocationReadback>>;
    const readTotals={gets:0,queries:0,documents:0,journalLines:0};
    const observed=await owner.query(ctx=>invoke({...ctx,db:recordedDb(ctx.db,readTotals)},{orgId:seed.orgId}));
    const publicView=await owner.query(api.accountingCutover.postedOpeningAllocationReadback,{orgId:seed.orgId});
    expect(observed).toEqual(publicView);
    expect(observed?.rows).toHaveLength(count);
    expect(observed?.rows.every(row=>!row.restricted && row.recordAvailable)).toBe(true);
    expect(observed?.rows.reduce((sum,row)=>sum+(row.restricted?0:row.amountMinor),0)).toBe(count*1000);
    console.info("OPENING_READBACK_READ_SHAPE",JSON.stringify({count,...readTotals,scope:"authenticated registered public handler and normal API equality; actual harness DB returns; no platform/byte/OCC claim"}));
    expect(readTotals.journalLines).toBe(count+1);
  });
}
