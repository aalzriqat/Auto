import type { DatabaseReader, MutationCtx } from "../_generated/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { KNOWN_SURVIVING_REFERENCES } from "./orgResetReferences";
import { convexToJson } from "convex/values";
import { isCommissionOwed } from "./commission";
import { inTurn } from "./transactionReadHeadroom";

export const RESET_FAMILY_READ_BOUND = 100;
// Owner 2026-11-07: bound trigger-producing writes, not unrelated retained history.
export const RESET_KEPT_READ_BOUND = 20;
export const RESET_EVIDENCE_BYTES = 256_000;
// Eight independent budgets. A fresh destructive call scans twice: at most
// 2 * 8 * 1001 = 16,016 documents and 2 * 8 * 512 KiB = 8 MiB serialized data.
// This leaves 15,984 documents / 8 MiB for the 500-row RESET_TOTAL_DELETE_BATCH,
// overflow probes, survivor/family evidence and triggers. It is direct-scan
// headroom, not a total transaction guarantee: social triggers reread customer
// history, and large deletion rows can exhaust it. Platform limits abort the
// mutation atomically. See the reset ADR and docs.convex.dev/production/state/limits.
export const RESET_KEPT_SCAN_BOUND = 1_000;
export const RESET_KEPT_SCAN_BYTES = 512 * 1024;

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
  /** Exact owed rows to wipe; null when a complete bounded count was not measured. */
  owedCommissionCounts: Record<"dealCommissionLines" | "sales" | "openingCommissionLiabilities", number | null>;
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

function owedCommissionCount(table: FamilyTable, found: Doc<FamilyTable>[]): number | null {
  switch (table) {
    case "dealCommissionLines":
      return found.filter(row => "amountMinor" in row && (row.amountMinor ?? 0) > 0 && !("paidAt" in row) && !("removedAt" in row)).length;
    case "sales":
      return found.filter(row => "commissionAmount" in row && isCommissionOwed(row)).length;
    case "openingCommissionLiabilities":
      return found.filter(row => "paidMinor" in row && row.amountMinor > row.paidMinor).length;
    default: return null;
  }
}

function isRiskyFamilyRow(table: FamilyTable, row: Doc<FamilyTable>): boolean {
  switch (table) {
    case "unmatchedProviderFunds":
    case "cashDrawerSessions": return true;
    case "postDatedCheques": return "status" in row && (row.status === "HELD" || row.status === "DEPOSITED");
    case "supplierCostRecoveries": return "status" in row && (row.status === "OPEN" || row.status === "PARTIALLY_RECOVERED");
    // Owner 2026-11-07: owed commissions are wiped with the test books, not a refusal.
    default: return false;
  }
}

async function measureFamilies(db: DatabaseReader, orgId: Id<"organizations">,
  result: SurvivorPreflight, evidence: { bytes: number; table: string }): Promise<void> {
  const familyIndexes = {
    postDatedCheques: "by_org", supplierCostRecoveries: "by_org", dealCommissionLines: "by_org_sale",
    openingCommissionLiabilities: "by_org", sales: "by_org", unmatchedProviderFunds: "by_org_review",
    cashDrawerSessions: "by_org",
  } as const;
  await inTurn(Object.entries(familyIndexes), async ([name, index]) => {
    const table = name as keyof typeof familyIndexes;
    evidence.table = table;
    const found = await rows(db, table, index, orgId, RESET_FAMILY_READ_BOUND + 1, evidence);
    result.counts[table] = found.length;
    if (found.length > RESET_FAMILY_READ_BOUND) {
      result.refusals.push({ table, count: found.length, reason: "OVER_BOUND" });
      return;
    }
    if (table === "dealCommissionLines" || table === "sales" || table === "openingCommissionLiabilities") {
      result.owedCommissionCounts[table] = owedCommissionCount(table, found);
    }
    const risky = found.filter(row => isRiskyFamilyRow(table, row));
    if (risky.length > 0) result.refusals.push({ table, count: risky.length, reason: "RISKY_STATE" });
  });
}

export function survivingReferenceTables(resetTables: readonly string[]): SurvivorTable[] {
  const deleted = new Set(resetTables);
  return [...new Set(Object.keys(KNOWN_SURVIVING_REFERENCES).map(key => key.split(".")[0]))]
    .filter(table => !deleted.has(table))
    // Read order controls shared-budget attribution; retain the original UTF-16 ordering.
    .sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }).map(table => {
      if (!Object.hasOwn(RESET_SURVIVOR_INDEX, table)) throw new Error(`Unmeasured survivor table ${table}`);
      return table as SurvivorTable;
    });
}

async function rows<Table extends ReadableTable>(db: DatabaseReader, table: Table, index: string,
  orgId: Id<"organizations">, bound: number, budget: { bytes: number; limit?: number }): Promise<Doc<Table>[]> {
  // Dynamic table/index pairs are checked against the real schema in the reference-coverage test.
  const found: Doc<Table>[] = [];
  const query = db.query(table as "vehicles").withIndex(index as "by_org", q => q.eq("orgId", orgId));
  for await (const row of query) {
    budget.bytes += new TextEncoder().encode(JSON.stringify(convexToJson(row))).byteLength;
    if (budget.bytes > (budget.limit ?? RESET_EVIDENCE_BYTES)) throw new Error("Reset evidence byte bound exceeded");
    found.push(row as unknown as Doc<Table>);
    if (found.length >= bound) break;
  }
  return found;
}

/** This predicate is shared by admission and cleanup, including vehicle custom fields. */
function keptReferenceNeedsWrite(table: KeptTable, row: Doc<KeptTable>): boolean {
  switch (table) {
    case "orgCustomFieldValues": return "entityType" in row && row.entityType === "vehicle";
    case "socialConversations": return "vehicleIds" in row && row.vehicleIds.length > 0;
    case "marketplaceRequestMatches": return "matchedVehicleId" in row && !!row.matchedVehicleId;
    default: return "vehicleId" in row && !!row.vehicleId;
  }
}

async function keptReferences(db: DatabaseReader, table: KeptTable, orgId: Id<"organizations">) {
  const found = await rows(db, table, RESET_KEPT_REFERENCE_INDEX[table], orgId,
    RESET_KEPT_SCAN_BOUND + 1, { bytes: 0, limit: RESET_KEPT_SCAN_BYTES });
  const docs = found.filter(row => keptReferenceNeedsWrite(table, row));
  let overflowCount = 0;
  if (found.length > RESET_KEPT_SCAN_BOUND) overflowCount = found.length;
  else if (docs.length > RESET_KEPT_READ_BOUND) overflowCount = docs.length;
  return { docs, scanned: found.length, overflowCount };
}

export async function resetSurvivorPreflight(db: DatabaseReader, orgId: Id<"organizations">,
  resetTables: readonly string[]): Promise<SurvivorPreflight> {
  const result: SurvivorPreflight = { verdict: "PASS", counts: {}, refusals: [],
    owedCommissionCounts: { dealCommissionLines: null, sales: null, openingCommissionLiabilities: null } };
  const evidence = { bytes: 0, table: "organizations" };
  try {
    await inTurn(survivingReferenceTables(resetTables), async table => {
      evidence.table = table;
      const index = RESET_SURVIVOR_INDEX[table];
      const found = await rows(db, table, index, orgId, RESET_FAMILY_READ_BOUND + 1, evidence);
      result.counts[table] = found.length;
      if (found.length > 0) result.refusals.push({ table, count: found.length,
        reason: found.length > RESET_FAMILY_READ_BOUND ? "OVER_BOUND" : "SURVIVOR" });
    });
    await measureFamilies(db, orgId, result, evidence);
    await inTurn(Object.keys(RESET_KEPT_REFERENCE_INDEX), async name => {
      const table = name as KeptTable;
      evidence.table = table;
      const found = await keptReferences(db, table, orgId);
      result.counts[table] = found.scanned;
      if (found.overflowCount > 0) result.refusals.push({ table, count: found.overflowCount, reason: "OVER_BOUND" });
    });
  } catch (error) {
    console.error("Financial reset preflight evidence unavailable", error);
    result.refusals.push({ table: evidence.table, count: 0, reason: "READ_FAILED" });
  }
  if (result.refusals.length > 0) result.verdict = "REFUSED";
  if (result.refusals.some(r => r.reason === "OVER_BOUND" || r.reason === "READ_FAILED")) result.verdict = "UNAVAILABLE";
  return result;
}

/** Bounded before writes, including social-trigger fanout. Runs before any vehicle can be deleted. */
export async function clearResetVehicleReferences(ctx: MutationCtx, orgId: Id<"organizations">): Promise<void> {
  const groups: Array<{ table: KeptTable; docs: Doc<KeptTable>[] }> = [];
  await inTurn(Object.keys(RESET_KEPT_REFERENCE_INDEX), async name => {
    const table = name as KeptTable;
    const found = await keptReferences(ctx.db, table, orgId).catch(error => {
      console.error("Financial reset kept-reference evidence unavailable", error);
      throw new Error(`UNAVAILABLE ${table} evidence could not be completed`);
    });
    if (found.overflowCount > 0) throw new Error(`UNAVAILABLE ${table} count ${found.overflowCount}`);
    groups.push({ table, docs: found.docs });
  });
  // Clear events first: their normal triggers rebuild conversation projections.
  groups.sort((a, b) => Number(a.table === "socialConversations") - Number(b.table === "socialConversations"));
  await inTurn(groups, ({ table, docs }) => inTurn(docs, row => clearVehicleReference(ctx, table, row)));
}

async function clearVehicleReference(ctx: MutationCtx, table: KeptTable, row: Doc<KeptTable>): Promise<void> {
  if (!keptReferenceNeedsWrite(table, row)) return;
  switch (table) {
    case "orgCustomFieldValues":
      return clearVehicleCustomField(ctx, row);
    case "socialConversations":
      await ctx.db.patch(row._id, { vehicleIds: [], vehicleCount: 0 });
      return;
    case "marketplaceRequestMatches":
      await ctx.db.patch(row._id, {
        matchedVehicleId: undefined, matchTier: "ELIGIBLE", estimatedMonthlyPayment: undefined,
        estimatedTotalContractValue: undefined, matchScore: undefined, matchReasons: undefined, calculationSnapshot: undefined,
      });
      return;
    case "marketplaceResponses":
      await ctx.db.patch(row._id, { vehicleId: undefined,
        kind: "NOT_AVAILABLE", offerPriceJod: undefined, financeOffer: undefined });
      return;
    default:
      await ctx.db.patch(row._id, { vehicleId: undefined });
  }
}

async function clearVehicleCustomField(ctx: MutationCtx, row: Doc<KeptTable>): Promise<void> {
  const id = ctx.db.normalizeId("orgCustomFieldValues", row._id);
  if (!id) throw new Error("Invalid custom-field cleanup reference");
  await ctx.db.delete("orgCustomFieldValues", id);
}
