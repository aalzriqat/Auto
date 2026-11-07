/** NON-PILOT-CERTIFYING: destructive test-data reset; no pilot workflow is certified here. */
import { describe, expect, test } from "vitest";
import type { GenericDatabaseWriter, GenericDataModel } from "convex/server";
import type { Value } from "convex/values";
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
        if (target === "_storage") throw new Error("Storage fixtures must be supplied explicitly");
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
  const id = await db.insert(table, { ...fields, ...overrides } as Record<string, Value>);
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
    const db = ctx.db as unknown as GenericDatabaseWriter<GenericDataModel>;
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(tables)) out[table] = await db.query(table).collect();
    return out;
  });
}

const reset = (t: Harness, orgId: Id<"organizations">, dryRun = false) =>
  t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId, dryRun, batchSize: 1 });

const five = ["vehicleCommitmentClaims", "commitmentRoots", "depositApplications",
  "financeCompanyForwards", "financeCompanyForwardSlices"];
const vehicleChildren = ["vehicleLandedCosts", "vehicleCostCorrections", "consignedSaleCorrections",
  "vehicleSupplierReceivables", "vehicleSupplierPayables", "vehiclePriceHistory", "vehicleOwnershipConversions",
  "vehicleReservations", "vehicleStatusRequests", "vehicleEdits", "test_drives", "workOrders", "vehicleValuations",
  "depositRequests", "depositVehicleHolds", "socialPosts", "profitApprovalRequests"];

describe("SCRUM-565 narrow reset", () => {
  test("clean fresh reset drains vehicles and the five tables; retries preserve kept rows and org B", async () => {
    const { t, a, b } = await fixture();
    await t.run(async ctx => {
      for (const org of [a, b]) {
        const cache = new Map<string, string>();
        for (const table of [...five, ...vehicleChildren]) await document(ctx, org, table, {}, cache);
        await document(ctx, org, "financeCompanyForwardSlices", {}, cache);
        await document(ctx, org, "vehicleCommitmentClaims", {}, cache);
        await document(ctx, org, "vehicles", { status: "SOLD", soldBySaleId: cache.get("sales") });
        for (const table of ["leads", "bankAccounts", "suppliers", "memberships", "roles", "orgSettings",
          "subscriptions", "branches", "orgValuationCompanies"]) await document(ctx, org, table, {}, cache);
      }
      await document(ctx, a, "vehicles", { status: "AVAILABLE" });
    });
    const before = await snapshot(t);
    const dry = await reset(t, a, true);
    expect(dry).toMatchObject({ preflight: { verdict: "PASS" } });
    expect(await snapshot(t)).toEqual(before);
    const first = await reset(t, a);
    expect(first.remaining).toBeGreaterThan(0);
    const partial = await snapshot(t);
    for (const table of ["financeCompanyForwardSlices", "financeCompanyForwards", "vehicleCommitmentClaims", "commitmentRoots"]) {
      expect((partial[table] as Array<{ orgId: string }>).some(row => row.orgId === a), table).toBe(true);
    }
    expect((await t.run(ctx => ctx.db.get(a)))?.financialResetGeneration).toBe(1);
    let remaining = first.remaining;
    for (let pass = 0; pass < 80 && remaining > 0; pass += 1) remaining = (await reset(t, a)).remaining;
    expect(remaining).toBe(0);
    const after = await snapshot(t);
    for (const table of [...five, ...vehicleChildren, "vehicles"]) {
      expect((after[table] as Array<{ orgId?: string }>).filter(r => r.orgId === a), table).toEqual([]);
    }
    for (const table of ["customers", "users", "leads", "bankAccounts", "financeCompanies", "suppliers",
      "memberships", "roles", "orgSettings", "subscriptions", "branches", "orgValuationCompanies"]) {
      expect(after[table], table).toEqual(before[table]);
    }
    expect((after.journalEntries as Array<{ orgId: string }>).filter(row => row.orgId === a)).toEqual([]);
    for (const table of Object.keys(tables)) {
      const ownedByB = (rows: unknown[]) => (rows as Array<{ orgId?: string; _id: string }>).filter(r => r.orgId === b || r._id === b);
      expect(ownedByB(after[table]), table).toEqual(ownedByB(before[table]));
    }
    expect(await t.run(ctx => ctx.db.get(a))).toMatchObject({ financialResetGeneration: 1, financialResetCompletedGeneration: 1 });
  });

  async function refusesSurvivor(table: string) {
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
  }
  // Literal registrations bind each scenario to the strict SCRUM-761 library.
  test("survivor applicationDocuments refuses by table before any write", () => refusesSurvivor("applicationDocuments"));
  test("survivor bankStatementLines refuses by table before any write", () => refusesSurvivor("bankStatementLines"));
  test("survivor cashMovements refuses by table before any write", () => refusesSurvivor("cashMovements"));
  test("survivor claims refuses by table before any write", () => refusesSurvivor("claims"));
  test("survivor collectionReminders refuses by table before any write", () => refusesSurvivor("collectionReminders"));
  test("survivor dealerProductDeferrals refuses by table before any write", () => refusesSurvivor("dealerProductDeferrals"));
  test("survivor dealUnwinds refuses by table before any write", () => refusesSurvivor("dealUnwinds"));
  test("survivor customerFinanceCompanyPayments refuses by table before any write", () => refusesSurvivor("customerFinanceCompanyPayments"));
  test("survivor employeeAdvanceRecoveries refuses by table before any write", () => refusesSurvivor("employeeAdvanceRecoveries"));
  test("survivor fixedAssetEvents refuses by table before any write", () => refusesSurvivor("fixedAssetEvents"));
  test("survivor manualJournalDrafts refuses by table before any write", () => refusesSurvivor("manualJournalDrafts"));
  test("survivor openingBalanceDrafts refuses by table before any write", () => refusesSurvivor("openingBalanceDrafts"));
  test("survivor partnerEquityTransactions refuses by table before any write", () => refusesSurvivor("partnerEquityTransactions"));
  test("survivor paymentIntents refuses by table before any write", () => refusesSurvivor("paymentIntents"));
  test("survivor prepaidExpenseSchedules refuses by table before any write", () => refusesSurvivor("prepaidExpenseSchedules"));
  test("survivor marketplaceWhatsAppFlows refuses by table before any write", () => refusesSurvivor("marketplaceWhatsAppFlows"));

  async function refusesRiskyFamily(table: string) {
      const { t, a } = await fixture();
      await t.run(ctx => document(ctx, a, table, { orgId: a }));
      const before = await snapshot(t);
      await expect(reset(t, a)).rejects.toThrow(new RegExp(`${table}.*[1-9]`));
      expect(await snapshot(t)).toEqual(before);
  }
  test("owner ruling 2026-11-07 wipes owed deal commission lines, books start from zero", () => wipesOwedCommissions("dealCommissionLines"));
  test("risky family supplierCostRecoveries refuses by table before any write", () => refusesRiskyFamily("supplierCostRecoveries"));
  test("risky family postDatedCheques refuses by table before any write", () => refusesRiskyFamily("postDatedCheques"));
  test("risky family unmatchedProviderFunds refuses by table before any write", () => refusesRiskyFamily("unmatchedProviderFunds"));

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

  test("kept vehicle references clear with their projections, other content and org B stay identical", async () => {
    const { t, a, b } = await fixture();
    const linked = ["leads", "tasks", "instagramEvents", "facebookEvents", "socialConversations",
      "marketplaceRequestMatches", "marketplaceResponses"];
    await t.run(async ctx => {
      for (const org of [a, b]) {
        const cache = new Map<string, string>();
        const vehicleId = await document(ctx, org, "vehicles", {}, cache);
        const customerId = await document(ctx, org, "customers", {}, cache);
        for (const table of linked) {
          const link = table === "socialConversations" ? { vehicleIds: [vehicleId], vehicleCount: 1 }
            : table === "marketplaceRequestMatches" ? { matchedVehicleId: vehicleId, matchTier: "INVENTORY" }
              : { vehicleId };
          await document(ctx, org, table, { ...link, ...(["instagramEvents", "facebookEvents"].includes(table) ? { customerId } : {}) }, cache);
        }
        await document(ctx, org, "orgCustomFieldValues", { entityType: "vehicle", entityId: vehicleId });
        await document(ctx, org, "orgCustomFieldValues", { entityType: "customer", entityId: "historical-customer" });
      }
    });
    const before = await snapshot(t);
    const result = await reset(t, a);
    expect(result.remaining).toBe(0);
    const after = await snapshot(t);
    for (const table of linked) {
      const rows = after[table] as Array<Record<string, unknown>>;
      for (const row of rows.filter(r => r.orgId === a)) {
        if (table === "socialConversations") expect(row).toMatchObject({ vehicleIds: [], vehicleCount: 0 });
        else expect(row[table === "marketplaceRequestMatches" ? "matchedVehicleId" : "vehicleId"]).toBeUndefined();
      }
      expect(rows.filter(r => r.orgId === b)).toEqual((before[table] as Array<Record<string, unknown>>).filter(r => r.orgId === b));
    }
    const fields = after.orgCustomFieldValues as Array<Record<string, unknown>>;
    expect(fields.filter(r => r.orgId === a).map(r => r.entityType)).toEqual(["customer"]);
    expect(fields.filter(r => r.orgId === b)).toEqual((before.orgCustomFieldValues as Array<Record<string, unknown>>).filter(r => r.orgId === b));
  });

  test("more than 20 vehicle-linked events are UNAVAILABLE before triggers or deletion", async () => {
    const { t, a } = await fixture();
    await t.run(async ctx => {
      const cache = new Map<string, string>();
      const vehicleId = await document(ctx, a, "vehicles", {}, cache);
      const customerId = await document(ctx, a, "customers", {}, cache);
      for (let i = 0; i < 21; i += 1) await document(ctx, a, "instagramEvents",
        { externalId: `event-${i}`, customerId, vehicleId }, cache);
    });
    const before = await snapshot(t);
    expect(await reset(t, a, true)).toMatchObject({ preflight: { verdict: "UNAVAILABLE" } });
    await expect(reset(t, a)).rejects.toThrow(/instagramEvents count 21/);
    expect(await snapshot(t)).toEqual(before);
  });

  test("owner ruling 2026-11-07 bounds only vehicle writes: large kept tables reset through batches without changing unrelated rows or org B", async () => {
    const { t, a, b } = await fixture();
    const kept = ["leads", "tasks", "instagramEvents", "facebookEvents", "socialConversations",
      "marketplaceRequestMatches", "marketplaceResponses", "orgCustomFieldValues"];
    const unrelatedIds = new Set<string>();
    await t.run(async ctx => {
      for (const org of [a, b]) {
        const cache = new Map<string, string>();
        const vehicleId = await document(ctx, org, "vehicles", {}, cache);
        await document(ctx, org, "vehicles");
        const customerId = await document(ctx, org, "customers", {}, cache);
        for (const table of kept) {
          for (let i = 0; i < 26; i += 1) {
            const extra: Record<string, unknown> = {};
            if (table === "leads") extra.notes = "unrelated".repeat(350);
            if (table === "instagramEvents" || table === "facebookEvents") {
              extra.text = "unrelated".repeat(350);
              extra.externalId = `unrelated-${i}`;
              extra.customerId = customerId;
            }
            if (table === "socialConversations") {
              extra.conversationKey = `unrelated-${i}`;
              extra.latestText = "unrelated".repeat(350);
              extra.vehicleCount = 0;
            }
            if (table === "orgCustomFieldValues") extra.entityType = "customer";
            unrelatedIds.add(await document(ctx, org, table, extra, cache));
          }
          const link: Record<string, unknown> = { vehicleId };
          if (table === "instagramEvents" || table === "facebookEvents") link.customerId = customerId;
          if (table === "socialConversations") {
            delete link.vehicleId;
            Object.assign(link, { vehicleIds: [vehicleId], vehicleCount: 1, conversationKey: "linked" });
          }
          if (table === "marketplaceRequestMatches") {
            delete link.vehicleId;
            Object.assign(link, { matchedVehicleId: vehicleId, matchTier: "INVENTORY" });
          }
          if (table === "orgCustomFieldValues") {
            delete link.vehicleId;
            Object.assign(link, { entityType: "vehicle", entityId: vehicleId });
          }
          await document(ctx, org, table, link, cache);
        }
      }
    });
    const before = await snapshot(t);
    expect(JSON.stringify(kept.map(table => before[table])).length).toBeGreaterThan(256_000);
    expect(await reset(t, a, true)).toMatchObject({ preflight: { verdict: "PASS" } });
    expect(await snapshot(t)).toEqual(before);
    const first = await reset(t, a);
    expect(first).toMatchObject({ preflight: { verdict: "PASS" }, resetGeneration: 1, resetCompleted: false });
    expect(first.remaining).toBeGreaterThan(0);
    let remaining = first.remaining;
    for (let batch = 0; batch < 10 && remaining > 0; batch += 1) remaining = (await reset(t, a)).remaining;
    expect(remaining).toBe(0);
    const after = await snapshot(t);
    for (const table of kept) {
      const rows = after[table] as Array<Record<string, unknown>>;
      expect(rows.filter(row => unrelatedIds.has(String(row._id))), table)
        .toEqual((before[table] as Array<Record<string, unknown>>).filter(row => unrelatedIds.has(String(row._id))));
      for (const row of rows.filter(row => row.orgId === a)) {
        expect(row.vehicleId, table).toBeUndefined();
        expect(row.matchedVehicleId, table).toBeUndefined();
        if (table === "socialConversations") expect(row).toMatchObject({ vehicleIds: [], vehicleCount: 0 });
        if (table === "orgCustomFieldValues") expect(row.entityType).toBe("customer");
      }
    }
    expect((after.vehicles as Array<{ orgId: string }>).filter(row => row.orgId === a)).toEqual([]);
    for (const table of Object.keys(tables)) {
      const foreign = (rows: unknown[]) => (rows as Array<{ orgId?: string; _id: string }>).filter(row => row.orgId === b || row._id === b);
      expect(foreign(after[table]), table).toEqual(foreign(before[table]));
    }
    expect(await t.run(ctx => ctx.db.get(a))).toMatchObject({ financialResetGeneration: 1, financialResetCompletedGeneration: 1 });
  });

  test("kept scan past 1000 rows is UNAVAILABLE even with no vehicle references", async () => {
    const { t, a } = await fixture();
    await t.run(async ctx => {
      const cache = new Map<string, string>();
      for (let i = 0; i < 1001; i += 1) await document(ctx, a, "leads", {}, cache);
    });
    const before = await snapshot(t);
    expect(await reset(t, a, true)).toMatchObject({ preflight: { verdict: "UNAVAILABLE" } });
    await expect(reset(t, a)).rejects.toThrow(/UNAVAILABLE.*leads/);
    expect(await snapshot(t)).toEqual(before);
  });

  test("a continuation with 21 vehicle custom fields refuses without partial reference cleanup", async () => {
    const { t, a, b } = await fixture();
    await t.run(async ctx => {
      const cache = new Map<string, string>();
      const vehicleId = await document(ctx, a, "vehicles", {}, cache);
      await document(ctx, a, "leads", { vehicleId }, cache);
      for (let i = 0; i < 21; i += 1) await document(ctx, a, "orgCustomFieldValues",
        { entityType: "vehicle", entityId: vehicleId }, cache);
      await document(ctx, b, "vehicles");
      await ctx.db.patch(a, { financialResetGeneration: 1 });
    });
    const before = await snapshot(t);
    expect(await reset(t, a, true)).toMatchObject({ preflight: { verdict: "UNAVAILABLE" } });
    await expect(reset(t, a)).rejects.toThrow(/UNAVAILABLE.*orgCustomFieldValues/);
    expect(await snapshot(t)).toEqual(before);
  });

  async function refusesLiveCheque(status: "HELD" | "DEPOSITED") {
    const { t, a } = await fixture();
    const id = await t.run(ctx => document(ctx, a, "postDatedCheques", { status }));
    const before = await snapshot(t);
    await expect(reset(t, a)).rejects.toThrow(/postDatedCheques count 1/);
    expect(await snapshot(t)).toEqual(before);
    await t.run(async ctx => {
      const chequeId = ctx.db.normalizeId("postDatedCheques", id);
      if (!chequeId) throw new Error("Missing cheque fixture");
      await ctx.db.patch(chequeId, { status: "RETURNED" });
    });
    expect((await reset(t, a)).remaining).toBe(0);
  }
  test("cheque HELD refuses; terminal cheques are resettable", () => refusesLiveCheque("HELD"));
  test("cheque DEPOSITED refuses; terminal cheques are resettable", () => refusesLiveCheque("DEPOSITED"));

  test("wide retained evidence is UNAVAILABLE even below the row bound", async () => {
    const { t, a } = await fixture();
    await t.run(async ctx => {
      const cache = new Map<string, string>();
      for (let i = 0; i < 2; i += 1) await document(ctx, a, "leads", { notes: "x".repeat(300_000) }, cache);
    });
    const before = await snapshot(t);
    expect(await reset(t, a, true)).toMatchObject({ preflight: { verdict: "UNAVAILABLE" } });
    await expect(reset(t, a)).rejects.toThrow(/UNAVAILABLE.*leads count/);
    expect(await snapshot(t)).toEqual(before);
  });

  test("new vehicle metadata is deleted while shared media remains available to org B", async () => {
    const { t, a, b } = await fixture();
    const blob = await t.run(ctx => ctx.storage.store(new Blob(["shared-photo"])));
    await t.run(async ctx => {
      await document(ctx, a, "vehicles", { imageIds: [blob] });
      await document(ctx, b, "vehicles", { imageIds: [blob] });
    });
    const before = await snapshot(t);
    expect((await reset(t, a)).remaining).toBe(0);
    const after = await snapshot(t);
    expect((after.vehicles as Array<{ orgId: string }>).filter(row => row.orgId === a)).toEqual([]);
    expect((after.vehicles as Array<{ orgId: string }>).filter(row => row.orgId === b))
      .toEqual((before.vehicles as Array<{ orgId: string }>).filter(row => row.orgId === b));
    expect(await t.run(ctx => ctx.storage.getUrl(blob))).not.toBeNull();
  });

  async function wipesOwedCommissions(table: "dealCommissionLines" | "sales" | "openingCommissionLiabilities") {
    const { t, a, b } = await fixture();
    const owed = {
      dealCommissionLines: { amountMinor: 2 },
      sales: { status: "COMPLETED", commissionAmount: 2 },
      // A timestamp alone does not settle a partially paid opening liability.
      openingCommissionLiabilities: { amountMinor: 2, paidMinor: 1, paidAt: 1 },
    };
    const settled = {
      dealCommissionLines: { amountMinor: 2, paidAt: 1 },
      sales: { status: "COMPLETED", commissionAmount: 2, commissionPaidAt: 1 },
      openingCommissionLiabilities: { amountMinor: 2, paidMinor: 2 },
    };
    const link = {
      dealCommissionLines: "commissionLineIds", sales: "commissionSaleIds",
      openingCommissionLiabilities: "openingCommissionLiabilityIds",
    };
    await t.run(async ctx => {
      for (const org of [a, b]) {
        const cache = new Map<string, string>();
        const ids: string[] = [];
        for (let i = 0; i < 2; i += 1) ids.push(await document(ctx, org, table, owed[table], cache));
        await document(ctx, org, table, settled[table], cache);
        // Historical liabilities can outlive their draft. A live draft independently refuses reset.
        if (table === "openingCommissionLiabilities") {
          const draftId = ctx.db.normalizeId("openingBalanceDrafts", cache.get("openingBalanceDrafts") ?? "");
          if (!draftId) throw new Error("Missing historical draft fixture");
          await ctx.db.delete(draftId);
        }
        await document(ctx, org, "payrollItems", { commissionSaleIds: [] }, cache);
        await document(ctx, org, "payrollItems", { commissionSaleIds: [], [link[table]]: ids }, cache);
      }
    });
    const before = await snapshot(t);
    const counts = { dealCommissionLines: 0, sales: 0, openingCommissionLiabilities: 0, [table]: 2 };
    expect(await reset(t, a, true)).toMatchObject({
      preflight: { verdict: "PASS", owedCommissionCounts: counts, refusals: [] },
    });
    expect(await snapshot(t)).toEqual(before);

    let result = await reset(t, a);
    expect(result.remaining).toBeGreaterThan(0);
    const partial = await snapshot(t);
    const ownedByA = (rows: unknown[]) => (rows as Array<{ orgId?: string }>).filter(row => row.orgId === a);
    // The second payslip still names the owed rows, so all parents must survive this committed batch.
    expect(ownedByA(partial.payrollItems)).toHaveLength(1);
    expect(ownedByA(partial[table])).toEqual(ownedByA(before[table]));
    for (let pass = 0; pass < 80 && result.remaining > 0; pass += 1) result = await reset(t, a);
    expect(result).toMatchObject({ remaining: 0, resetCompleted: true, resetGeneration: 1 });
    const after = await snapshot(t);
    for (const deleted of [table, "payrollItems", "payrollRuns", "journalEntries", "journalLines"]) {
      expect(ownedByA(after[deleted]), deleted).toEqual([]);
    }
    for (const name of Object.keys(tables)) {
      const ownedByB = (rows: unknown[]) => (rows as Array<{ orgId?: string; _id: string }>).filter(row => row.orgId === b || row._id === b);
      expect(ownedByB(after[name]), name).toEqual(ownedByB(before[name]));
    }
    expect(after.customers).toEqual(before.customers);
    expect(after.users).toEqual(before.users);
    expect(await reset(t, a, true)).toMatchObject({
      preflight: { verdict: "PASS", owedCommissionCounts: { dealCommissionLines: 0, sales: 0, openingCommissionLiabilities: 0 } },
    });
  }

  test("owner ruling 2026-11-07 wipes unpaid sale commissions, books start from zero", () => wipesOwedCommissions("sales"));

  test("dry run excludes a soft-deleted completed sale from owed commissions", async () => {
    const { t, a } = await fixture();
    await t.run(async ctx => {
      await document(ctx, a, "sales", { status: "COMPLETED", commissionAmount: 2, isDeleted: true });
    });
    expect(await reset(t, a, true)).toMatchObject({
      preflight: { verdict: "PASS", owedCommissionCounts: { sales: 0 } },
    });
  });

  test("owner ruling 2026-11-07 wipes historical unpaid opening commissions with missing draft and paid timestamp", () => wipesOwedCommissions("openingCommissionLiabilities"));

  test("owner ruling 2026-11-07 keeps over-bound commission evidence UNAVAILABLE with no invented count", async () => {
    for (const table of ["dealCommissionLines", "sales", "openingCommissionLiabilities"]) {
      const { t, a } = await fixture();
      await t.run(async ctx => {
        const cache = new Map<string, string>();
        for (let i = 0; i < 101; i += 1) await document(ctx, a, table, {}, cache);
      });
      const before = await snapshot(t);
      expect(await reset(t, a, true)).toMatchObject({
        preflight: { verdict: "UNAVAILABLE", owedCommissionCounts: { [table]: null } },
      });
      await expect(reset(t, a)).rejects.toThrow(new RegExp(`${table} count 101`));
      expect(await snapshot(t)).toEqual(before);
    }
  });
});
