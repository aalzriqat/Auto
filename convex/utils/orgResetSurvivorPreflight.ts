import type { DatabaseReader, MutationCtx } from "../_generated/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { KNOWN_SURVIVING_REFERENCES } from "./orgResetReferences";
import { convexToJson } from "convex/values";

export const RESET_FAMILY_READ_BOUND = 100;
// Event patches recompute their threads. Bounding the whole org also bounds that fanout.
export const RESET_KEPT_READ_BOUND = 20;
export const RESET_EVIDENCE_BYTES = 256_000;

export const RESET_KEPT_REFERENCE_INDEX = {
  leads: "by_org", tasks: "by_org", instagramEvents: "by_org", facebookEvents: "by_org",
  socialConversations: "by_org_generation_key", marketplaceRequestMatches: "by_org",
  marketplaceResponses: "by_org", orgCustomFieldValues: "by_org",
} as const;
type KeptTable = keyof typeof RESET_KEPT_REFERENCE_INDEX;

/** Exact retained fields repaired by clearResetVehicleReferences, checked against the schema. */
export const RESET_VEHICLE_REFERENCE_CLEARS = [
  "leads.vehicleId->vehicles", "tasks.vehicleId->vehicles",
  "instagramEvents.vehicleId->vehicles", "facebookEvents.vehicleId->vehicles",
  "socialConversations.vehicleIds[]->vehicles",
  "marketplaceRequestMatches.matchedVehicleId->vehicles", "marketplaceResponses.vehicleId->vehicles",
] as const;

export interface SurvivorPreflight {
  verdict: "PASS" | "REFUSED" | "UNAVAILABLE" | "CONTINUATION";
  /** Exact within the bound; an overflow is a lower bound, never an inventory total. */
  counts: Record<string, number>;
  refusals: Array<{ table: string; count: number; reason: "SURVIVOR" | "RISKY_STATE" | "OVER_BOUND" | "READ_FAILED" }>;
}

/** Each entry must be a real orgId-leading index; schema coverage enforces this. */
export const RESET_SURVIVOR_INDEX = {
  applicationDocuments: "by_org", bankStatementLines: "by_org_bankAccount", cashMovements: "by_org",
  claims: "by_org", collectionReminders: "by_org", dealerProductDeferrals: "by_org",
  dealUnwinds: "by_org_application_status", customerFinanceCompanyPayments: "by_org_application",
  employeeAdvanceRecoveries: "by_org", fixedAssetEvents: "by_org", manualJournalDrafts: "by_org_status",
  openingBalanceDrafts: "by_org", partnerEquityTransactions: "by_org", paymentIntents: "by_org_status",
  prepaidExpenseSchedules: "by_org", marketplaceWhatsAppFlows: "by_org",
} as const satisfies Partial<Record<TableNames, string>>;
type SurvivorTable = keyof typeof RESET_SURVIVOR_INDEX;
type FamilyTable = "postDatedCheques" | "supplierCostRecoveries" | "dealCommissionLines" |
  "openingCommissionLiabilities" | "sales" | "unmatchedProviderFunds" | "cashDrawerSessions";
type ReadableTable = SurvivorTable | FamilyTable | KeptTable;

export function survivingReferenceTables(resetTables: readonly string[]): SurvivorTable[] {
  const deleted = new Set(resetTables);
  return [...new Set(Object.keys(KNOWN_SURVIVING_REFERENCES).map(key => key.split(".")[0]))]
    .filter(table => !deleted.has(table)).sort().map(table => {
      if (!Object.hasOwn(RESET_SURVIVOR_INDEX, table)) throw new Error(`Unmeasured survivor table ${table}`);
      return table as SurvivorTable;
    });
}

async function rows<Table extends ReadableTable>(db: DatabaseReader, table: Table, index: string,
  orgId: Id<"organizations">, bound: number, budget: { bytes: number }): Promise<Doc<Table>[]> {
  // Dynamic table/index pairs are checked against the real schema in the reference-coverage test.
  const found: Doc<Table>[] = [];
  const query = db.query(table as "vehicles").withIndex(index as "by_org", q => q.eq("orgId", orgId));
  for await (const row of query) {
    budget.bytes += new TextEncoder().encode(JSON.stringify(convexToJson(row))).byteLength;
    if (budget.bytes > RESET_EVIDENCE_BYTES) throw new Error("Reset evidence byte bound exceeded");
    found.push(row as unknown as Doc<Table>);
    if (found.length >= bound) break;
  }
  return found;
}

export async function resetSurvivorPreflight(db: DatabaseReader, orgId: Id<"organizations">,
  resetTables: readonly string[]): Promise<SurvivorPreflight> {
  const result: SurvivorPreflight = { verdict: "PASS", counts: {}, refusals: [] };
  const budget = { bytes: 0 };
  let currentTable = "organizations";
  try {
    for (const table of survivingReferenceTables(resetTables)) {
      currentTable = table;
      const index = RESET_SURVIVOR_INDEX[table];
      if (!index) throw new Error("Unmeasured survivor table");
      const found = await rows(db, table, index, orgId, RESET_FAMILY_READ_BOUND + 1, budget);
      result.counts[table] = found.length;
      if (found.length > 0) result.refusals.push({ table, count: found.length,
        reason: found.length > RESET_FAMILY_READ_BOUND ? "OVER_BOUND" : "SURVIVOR" });
    }
    // These families are reset-scoped or do not carry a typed reset reference.
    const familyIndexes = {
      postDatedCheques: "by_org", supplierCostRecoveries: "by_org", dealCommissionLines: "by_org_sale",
      openingCommissionLiabilities: "by_org", sales: "by_org", unmatchedProviderFunds: "by_org_review",
      cashDrawerSessions: "by_org",
    } as const;
    for (const [name, index] of Object.entries(familyIndexes)) {
      const table = name as keyof typeof familyIndexes;
      currentTable = table;
      const found = await rows(db, table, index, orgId, RESET_FAMILY_READ_BOUND + 1, budget);
      result.counts[table] = found.length;
      if (found.length > RESET_FAMILY_READ_BOUND) {
        result.refusals.push({ table, count: found.length, reason: "OVER_BOUND" });
        continue;
      }
      const risky = found.filter(row => {
        if (table === "unmatchedProviderFunds" || table === "cashDrawerSessions") return true;
        if (table === "postDatedCheques") return "status" in row && (row.status === "HELD" || row.status === "DEPOSITED");
        if (table === "supplierCostRecoveries") return "status" in row && (row.status === "OPEN" || row.status === "PARTIALLY_RECOVERED");
        if (table === "dealCommissionLines") return "amountMinor" in row && (row.amountMinor ?? 0) > 0 && !("paidAt" in row) && !("removedAt" in row);
        if (table === "sales") return "commissionAmount" in row && row.status === "COMPLETED" && (row.commissionAmount ?? 0) > 0 && !("commissionPaidAt" in row);
        return "paidMinor" in row && row.amountMinor > row.paidMinor;
      });
      if (risky.length > 0) result.refusals.push({ table, count: risky.length, reason: "RISKY_STATE" });
    }
    for (const [name, index] of Object.entries(RESET_KEPT_REFERENCE_INDEX)) {
      const table = name as KeptTable;
      currentTable = table;
      const found = await rows(db, table, index, orgId, RESET_KEPT_READ_BOUND + 1, budget);
      result.counts[table] = found.length;
      if (found.length > RESET_KEPT_READ_BOUND) result.refusals.push({ table, count: found.length, reason: "OVER_BOUND" });
    }
  } catch (error) {
    console.error("Financial reset preflight evidence unavailable", error);
    result.refusals.push({ table: currentTable, count: 0, reason: "READ_FAILED" });
  }
  result.verdict = result.refusals.some(r => r.reason === "OVER_BOUND" || r.reason === "READ_FAILED")
    ? "UNAVAILABLE" : result.refusals.length > 0 ? "REFUSED" : "PASS";
  return result;
}

/** Bounded before writes, including social-trigger fanout. Runs before any vehicle can be deleted. */
export async function clearResetVehicleReferences(ctx: MutationCtx, orgId: Id<"organizations">): Promise<void> {
  const groups: Array<{ table: KeptTable; docs: Doc<KeptTable>[] }> = [];
  const budget = { bytes: 0 };
  for (const [name, index] of Object.entries(RESET_KEPT_REFERENCE_INDEX)) {
    const table = name as KeptTable;
    const docs = await rows(ctx.db, table, index, orgId, RESET_KEPT_READ_BOUND + 1, budget);
    if (docs.length > RESET_KEPT_READ_BOUND) throw new Error(`UNAVAILABLE ${table} count ${docs.length}`);
    groups.push({ table, docs });
  }
  // Clear events first: their normal triggers rebuild conversation projections.
  groups.sort((a, b) => Number(a.table === "socialConversations") - Number(b.table === "socialConversations"));
  for (const { table, docs } of groups) {
    for (const row of docs) await clearVehicleReference(ctx, table, row);
  }
}

async function clearVehicleReference(ctx: MutationCtx, table: KeptTable, row: Doc<KeptTable>): Promise<void> {
  switch (table) {
    case "orgCustomFieldValues": {
      if (!("entityType" in row) || row.entityType !== "vehicle") return;
      const id = ctx.db.normalizeId("orgCustomFieldValues", row._id);
      if (!id) throw new Error("Invalid custom-field cleanup reference");
      await ctx.db.delete("orgCustomFieldValues", id);
      return;
    }
    case "socialConversations":
      if ("vehicleIds" in row && row.vehicleIds.length > 0) await ctx.db.patch(row._id, { vehicleIds: [], vehicleCount: 0 });
      return;
    case "marketplaceRequestMatches":
      if ("matchedVehicleId" in row && row.matchedVehicleId) await ctx.db.patch(row._id, {
        matchedVehicleId: undefined, matchTier: "ELIGIBLE", estimatedMonthlyPayment: undefined,
        estimatedTotalContractValue: undefined, matchScore: undefined, matchReasons: undefined, calculationSnapshot: undefined,
      });
      return;
    case "marketplaceResponses":
      if ("vehicleId" in row && row.vehicleId) await ctx.db.patch(row._id, { vehicleId: undefined,
        kind: "NOT_AVAILABLE", offerPriceJod: undefined, financeOffer: undefined });
      return;
    default:
      if ("vehicleId" in row && row.vehicleId) await ctx.db.patch(row._id, { vehicleId: undefined });
  }
}
