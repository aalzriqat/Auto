import { validateOpeningCommissions, materializeOpeningCommission } from "../utils/openingCommissionLiabilities";
import { openingPolicyForAccount, openingAccountAllowsFamily, isRemainingOpeningKind } from "../utils/openingAccountPolicy";
export { openingPolicyForAccount } from "../utils/openingAccountPolicy";
import { assertOrgEconomicallyActive } from "../utils/orgLifecycle";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ensureReceivableDocument } from "../subledger";
import { resolveSystemAccount } from "../chartOfAccounts";
import { SYSTEM_KEYS } from "../utils/defaultChart";
import { fromMinorUnits, toMinorUnits } from "../utils/money";
import { requireOwnedRow, requireTenantAuth } from "../utils/tenancy";
import { orgResetState } from "../utils/orgResetGeneration";
import { isSystemOwnerRole, PERMISSIONS } from "../utils/permissions";
import { validateOpeningPartners } from "./openingPartnerAllocations";
import { listOpeningStockEvidence } from "../utils/openingVehicleBasis";
import { hasVehicleAcquisitionAccountingExposure, hasVehicleLandedCostAccountingExposure } from "../vehicles";


const PREPAID_EXPENSE_KEYS = new Set<string>([
  SYSTEM_KEYS.RENT_EXPENSE, SYSTEM_KEYS.UTILITIES_EXPENSE, SYSTEM_KEYS.SALARIES_EXPENSE,
  SYSTEM_KEYS.MARKETING_EXPENSE, SYSTEM_KEYS.OFFICE_EXPENSE,
  SYSTEM_KEYS.PROFESSIONAL_FEES_EXPENSE, SYSTEM_KEYS.GENERAL_EXPENSE,
]);
function yearMonthIndex(value: string): number | null {
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(value)) return null;
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
}

type Allocation = NonNullable<Doc<"openingBalanceDrafts">["allocations"]>[number];
type Result = NonNullable<Doc<"openingBalanceDrafts">["allocationResults"]>[number];
const validatedPlan = Symbol("validated opening allocations");
export type OpeningAllocationPlan = {
  readonly [validatedPlan]: true;
  readonly orgId: Id<"organizations">;
  readonly currency: string;
  readonly asOfDate: number;
  readonly rows: readonly Allocation[];
};

function validDate(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

/** Read-only validation, repeated on approval. A private capability binds the
 * materializer to this plan instead of trusting a caller's "validated" flag. */
export async function prepareOpeningAllocations(ctx: QueryCtx | MutationCtx, args: {
  orgId: Id<"organizations">; currency: string; asOfDate: number; actorId: Id<"users">;
  lines: readonly { accountId: Id<"chartOfAccounts">; debitMinor: number; creditMinor: number }[];
  allocations?: Allocation[];
}): Promise<OpeningAllocationPlan> {
  await assertOrgEconomicallyActive(ctx, args.orgId);
  if (orgResetState(await ctx.db.get(args.orgId)).inProgress) {
    throw new ConvexError("An organization with a financial reset in progress cannot post an opening balance.");
  }
  if (!validDate(args.asOfDate)) throw new ConvexError("The opening date is invalid.");
  const rows = args.allocations ?? [];
  if(rows.some(row=>isRemainingOpeningKind(row.kind)) && args.lines.length>200)throw new ConvexError("This opening exceeds the reviewed control-line limit. Ask finance to review it before posting.");
  const hasReceivableControl = rows.some((row) => row.kind === "CUSTOMER_RECEIVABLE") || (await Promise.all(args.lines.map(async (line) => {
    const account = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", line.accountId, "Opening account not found in this organization.");
    return account.systemKey === SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS;
  }))).some(Boolean);
  const collectionAccountId = hasReceivableControl
    ? await resolveSystemAccount(ctx, args.orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS) : undefined;
  const hasAdvanceControl = rows.some((row) => row.kind === "EMPLOYEE_ADVANCE") || (await Promise.all(args.lines.map(async (line) => {
    const account = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", line.accountId, "Opening account not found in this organization.");
    return account.systemKey === SYSTEM_KEYS.EMPLOYEE_ADVANCES;
  }))).some(Boolean);
  // Creating payroll-recoverable debt requires the same authority as ordinary
  // advances. This validator runs again for the authenticated approver.
  if (hasAdvanceControl) await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
  if(rows.some(row=>row.kind === "EMPLOYEE_COMMISSION") || (await Promise.all(args.lines.map(async line=>(await requireOwnedRow(ctx,args.orgId,"chartOfAccounts",line.accountId)).systemKey === SYSTEM_KEYS.COMMISSION_PAYABLE))).some(Boolean)) await requireTenantAuth(ctx,args.orgId,[PERMISSIONS.MANAGE_PAYROLL]);
  const advanceAccountId = hasAdvanceControl
    ? await resolveSystemAccount(ctx, args.orgId, SYSTEM_KEYS.EMPLOYEE_ADVANCES) : undefined;
  const hasPrepaidControl = rows.some((row) => row.kind === "PREPAID_EXPENSE") || (await Promise.all(args.lines.map(async (line) => {
    const account = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", line.accountId, "Opening account not found in this organization.");
    return account.systemKey === SYSTEM_KEYS.PREPAID_EXPENSES;
  }))).some(Boolean);
  const prepaidAccountId = hasPrepaidControl
    ? await resolveSystemAccount(ctx, args.orgId, SYSTEM_KEYS.PREPAID_EXPENSES) : undefined;
  const hasInventoryControl = rows.some((row) => row.kind === "VEHICLE_INVENTORY") ||
    (await Promise.all(args.lines.map(async (line) => {
      const account = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", line.accountId);
      return account.systemKey === SYSTEM_KEYS.VEHICLE_INVENTORY;
    }))).some(Boolean);
  const inventoryAccountId = hasInventoryControl
    ? await resolveSystemAccount(ctx, args.orgId, SYSTEM_KEYS.VEHICLE_INVENTORY) : undefined;
  const openingStockEvidence = hasInventoryControl ? await listOpeningStockEvidence(ctx, args.orgId) : [];
  const evidencedVehicleIds = new Set(openingStockEvidence.map((item) => String(item.vehicleId)));
  const existingCars = await ctx.db.query("vehicles")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(101);
  if (existingCars.length > 100) {
    throw new ConvexError("Existing vehicle stock exceeds the reviewed opening allocation limit.");
  }
  const costedOwnedCars = existingCars.filter((vehicle) => !vehicle.isDeleted && vehicle.status !== "SOLD" &&
    vehicle.sourceType !== "SOURCED" && (vehicle.purchasePrice ?? 0) > 0);
  if (costedOwnedCars.some((vehicle) => !evidencedVehicleIds.has(String(vehicle._id)))) {
    throw new ConvexError("Every existing owned stock car needs a tracked opening import before posting the cutover.");
  }
  if (rows.length > 100) throw new ConvexError("An opening can contain at most 100 allocations.");
  const identities = new Set<string>();
  let allocatedMinor = 0;
  let allocatedAdvanceMinor = 0;
  let allocatedPrepaidMinor = 0;
  let allocatedInventoryMinor = 0;
  const allocatedVehicleIds = new Set<string>();
  for (const row of rows) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.rowKey)) throw new ConvexError("The opening allocation row key is invalid.");
    if (identities.has(row.rowKey)) throw new ConvexError("Opening allocation row keys must be unique.");
    identities.add(row.rowKey);
    if (!Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0 ||
        toMinorUnits(fromMinorUnits(row.amountMinor, args.currency), args.currency) !== row.amountMinor) {
      throw new ConvexError("Opening allocation amounts must be positive whole minor-unit values.");
    }
    const account = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", row.accountId, "Opening account not found in this organization.");
    if (!args.lines.some((line) => line.accountId === row.accountId)) throw new ConvexError("An allocation must name an account in the opening journal.");
    if (isRemainingOpeningKind(row.kind)) {
      if (!await openingAccountAllowsFamily(ctx, args.orgId, account, args.currency, row.kind, "purpose" in row ? row.purpose : undefined)) {
        throw new ConvexError("The declared opening family does not match its active control account.");
      }
      if ("title" in row && (!row.title.trim() || row.title.length > 200)) throw new ConvexError("The opening title is invalid.");
      if ("counterpartyName" in row && (!row.counterpartyName.trim() || row.counterpartyName.length > 200)) throw new ConvexError("The opening counterparty name is invalid.");
      continue;
    }
    if (row.kind === "PARTNER_CAPITAL") continue;
    if (row.kind === "VEHICLE_INVENTORY") {
      allocatedInventoryMinor += row.amountMinor;
      if (!Number.isSafeInteger(allocatedInventoryMinor) || !account.active ||
          account.systemKey !== SYSTEM_KEYS.VEHICLE_INVENTORY || row.accountId !== inventoryAccountId ||
          allocatedVehicleIds.has(String(row.vehicleId)) || !evidencedVehicleIds.has(String(row.vehicleId))) {
        throw new ConvexError("Opening inventory needs one proven owned vehicle per allocation.");
      }
      allocatedVehicleIds.add(String(row.vehicleId));
      const vehicle = await requireOwnedRow(ctx, args.orgId, "vehicles", row.vehicleId,
        "Opening inventory vehicle not found in this organization.");
      const proof = openingStockEvidence.find((item) => item.vehicleId === row.vehicleId);
      if (!proof || proof.command.resetGeneration !== orgResetState(await ctx.db.get(args.orgId)).generation ||
          vehicle.openingStockImportId === undefined || vehicle.openingStockRowId === undefined ||
          proof.command.idempotencyKey !== `${vehicle.openingStockImportId}:${vehicle.openingStockRowId}` ||
          proof.vin !== vehicle.vin || proof.currency !== args.currency || proof.costMinor !== row.amountMinor ||
          vehicle.isDeleted || vehicle.status === "SOLD" || vehicle.sourceType !== "STOCK" ||
          !vehicle.vin || vehicle.openingBalanceDraftId || vehicle.landedCostTotal && vehicle.landedCostTotal !== 0 ||
          vehicle.purchasePrice === undefined ||
          toMinorUnits(vehicle.purchasePrice, args.currency) !== row.amountMinor ||
          await hasVehicleAcquisitionAccountingExposure(ctx, args.orgId, row.vehicleId) ||
          await hasVehicleLandedCostAccountingExposure(ctx, args.orgId, row.vehicleId)) {
        throw new ConvexError("Opening inventory vehicle cost, ownership or posting proof conflicts with the opening.");
      }
      const events = await ctx.db.query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", args.orgId).eq("sourceType", "vehicles").eq("sourceId", String(row.vehicleId))).collect();
      const landedCosts = await ctx.db.query("vehicleLandedCosts")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", row.vehicleId)).first();
      if (events.some((event) => event.eventType === "VEHICLE_INVENTORY_OPENING_BALANCE") ||
          (landedCosts?.items ?? []).some((item) => item.amount !== 0)) {
        throw new ConvexError("Opening inventory has a conflicting vehicle posting or landed cost.");
      }
      continue;
    }
    if (row.kind === "PREPAID_EXPENSE") {
      allocatedPrepaidMinor += row.amountMinor;
      if (!Number.isSafeInteger(allocatedPrepaidMinor)) throw new ConvexError("The opening allocation total is too large.");
      if (!account.active || account.systemKey !== SYSTEM_KEYS.PREPAID_EXPENSES || row.accountId !== prepaidAccountId) {
        throw new ConvexError("Opening prepaid assets must use the native prepaid control account.");
      }
      const start = yearMonthIndex(row.startYearMonth);
      const openingMonth = yearMonthIndex(new Date(args.asOfDate).toISOString().slice(0, 7));
      if (!row.title.trim() || row.title.length > 200 || row.attestedUnexpiredBenefit !== true ||
          start === null || openingMonth === null || start < openingMonth ||
          !Number.isSafeInteger(row.termMonths) || row.termMonths < 1 ||
          !Number.isSafeInteger(start + row.termMonths - 1) || start + row.termMonths - 1 > 9999 * 12 + 11 ||
          !PREPAID_EXPENSE_KEYS.has(row.expenseSystemKey)) {
        throw new ConvexError("An opening prepaid needs an attested unexpired benefit, valid remaining term and supported expense account.");
      }
      const expenseAccount = (await ctx.db.query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", args.orgId).eq("systemKey", row.expenseSystemKey)).collect())
        .find((candidate) => candidate.active);
      if (!expenseAccount || expenseAccount.currencyRestriction && expenseAccount.currencyRestriction !== args.currency) {
        throw new ConvexError("The opening prepaid expense account is unavailable in this currency.");
      }
      continue;
    }
    if (row.kind === "EMPLOYEE_ADVANCE") {
      allocatedAdvanceMinor += row.amountMinor;
      if (!Number.isSafeInteger(allocatedAdvanceMinor)) throw new ConvexError("The opening allocation total is too large.");
      if (!account.active || account.systemKey !== SYSTEM_KEYS.EMPLOYEE_ADVANCES || row.accountId !== advanceAccountId) {
        throw new ConvexError("Opening advances must use the account used by native payroll.");
      }
      if (row.note !== undefined && row.note.length > 500) throw new ConvexError("The opening advance note is too long.");
      const membership = await ctx.db.query("memberships").withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", row.userId)).unique();
      if (!membership || !(await ctx.db.get(row.userId))) throw new ConvexError("Opening employee is not a member of this organization.");
      if (membership.offboardingStatus) throw new ConvexError("Opening employee is unavailable.");
      if (row.userId === args.actorId) {
        const role = await ctx.db.get(membership.roleId);
        if (!role || role.orgId !== args.orgId || role.isDeleted || !isSystemOwnerRole(role)) {
          throw new ConvexError("An independent actor must prepare or approve your opening advance.");
        }
      }
      continue;
    }
    if (row.kind !== "CUSTOMER_RECEIVABLE") throw new ConvexError("Unsupported opening allocation.");
    allocatedMinor += row.amountMinor;
    if (!Number.isSafeInteger(allocatedMinor)) throw new ConvexError("The opening allocation total is too large.");
    if (!row.title.trim() || row.title.length > 200) throw new ConvexError("An opening allocation needs a title of at most 200 characters.");
    if (!validDate(row.dueDate)) throw new ConvexError("The opening allocation due date is invalid.");
    const customer = await requireOwnedRow(ctx, args.orgId, "customers", row.customerId, "Opening customer not found in this organization.");
    if (customer.isDeleted) throw new ConvexError("Opening customer is unavailable.");
    if (!account.active || account.systemKey !== SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS) {
      throw new ConvexError("Customer openings must use the active customer receivable control account.");
    }
    if (row.accountId !== collectionAccountId) {
      throw new ConvexError("Opening receivables must use the account used by native collections.");
    }
  }

  let receivableMinor = 0;
  let advanceMinor = 0;
  let prepaidMinor = 0;
  let inventoryMinor = 0;
  for (const line of args.lines) {
    const account = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", line.accountId, "Opening account not found in this organization.");
    const explicitlyAllocatedCapital = rows.some((row) => row.kind === "PARTNER_CAPITAL" && row.accountId === line.accountId);
    const policy = openingPolicyForAccount(account, explicitlyAllocatedCapital);
    if (!account.active) throw new ConvexError("An opening account is inactive.");
    if (account.currencyRestriction !== undefined && account.currencyRestriction !== args.currency) {
      throw new ConvexError("An opening account uses a different currency.");
    }
    if (!policy || policy === "UNSUPPORTED") {
      throw new ConvexError("This opening account requires an allocation type that is not supported yet. Nothing has been posted.");
    }
    if (policy === "DECLARED_LIABILITY" || isRemainingOpeningKind(policy)) {
      const familyRows = rows.filter(row => row.accountId === line.accountId && isRemainingOpeningKind(row.kind));
      if (familyRows.length === 0 || new Set(familyRows.map(row => row.kind)).size !== 1) throw new ConvexError("Every opening control needs one explicitly declared allocation family.");
      const total = familyRows.reduce((sum,row) => sum + row.amountMinor, 0);
      const asset = familyRows[0].kind === "SUPPLIER_RECOVERABLE";
      if (!Number.isSafeInteger(total) || (asset ? line.creditMinor !== 0 || line.debitMinor !== total : line.debitMinor !== 0 || line.creditMinor !== total)) throw new ConvexError("Opening allocations must exactly match their declared control balance.");
      if (familyRows[0].kind === "UNALLOCATED_LIABILITY" && new Set(familyRows.map(row => "purpose" in row ? row.purpose : undefined)).size !== 1) throw new ConvexError("Unidentified opening pools need separate declared controls.");
    }
    if (policy === "CUSTOMER_RECEIVABLE") {
      if (line.accountId !== collectionAccountId) {
        throw new ConvexError("Opening receivables must use the account used by native collections.");
      }
      if (line.creditMinor !== 0) throw new ConvexError("Customer opening receivables require a debit balance.");
      receivableMinor += line.debitMinor;
      if (!Number.isSafeInteger(receivableMinor)) throw new ConvexError("The opening receivable total is too large.");
    }
    if (policy === "EMPLOYEE_ADVANCE") {
      if (line.accountId !== advanceAccountId) throw new ConvexError("Opening advances must use the account used by native payroll.");
      if (line.creditMinor !== 0) throw new ConvexError("Opening advances require a debit balance.");
      advanceMinor += line.debitMinor;
      if (!Number.isSafeInteger(advanceMinor)) throw new ConvexError("The opening advance total is too large.");
    }
    if (policy === "PREPAID_EXPENSE") {
      if (line.accountId !== prepaidAccountId || line.creditMinor !== 0) {
        throw new ConvexError("Opening prepaids require a debit on the native prepaid asset account.");
      }
      prepaidMinor += line.debitMinor;
      if (!Number.isSafeInteger(prepaidMinor)) throw new ConvexError("The opening prepaid total is too large.");
    }
    if (policy === "VEHICLE_INVENTORY") {
      if (line.accountId !== inventoryAccountId || line.creditMinor !== 0) {
        throw new ConvexError("Opening inventory requires a debit on the native vehicle inventory account.");
      }
      inventoryMinor += line.debitMinor;
      if (!Number.isSafeInteger(inventoryMinor)) throw new ConvexError("The opening inventory total is too large.");
    }
  }
  if (allocatedMinor !== receivableMinor) throw new ConvexError("Customer opening allocations must match the receivable control balance.");
  if (allocatedAdvanceMinor !== advanceMinor) throw new ConvexError("Employee opening allocations must match the advance control balance.");
  if (allocatedPrepaidMinor !== prepaidMinor) throw new ConvexError("Prepaid opening allocations must match the prepaid asset control balance.");
  if (allocatedInventoryMinor !== inventoryMinor || allocatedVehicleIds.size !== evidencedVehicleIds.size ||
      costedOwnedCars.length !== evidencedVehicleIds.size) {
    throw new ConvexError("Every imported opening car must match the vehicle inventory control balance exactly.");
  }
  await validateOpeningCommissions(ctx, {orgId:args.orgId,currency:args.currency,lines:args.lines,allocations:rows});
  if (rows.some(row => row.kind === "SUPPLIER_RECOVERABLE") && await ctx.db.query("supplierCostRecoveries").withIndex("by_org", q => q.eq("orgId",args.orgId)).first()) throw new ConvexError("Existing supplier recoveries require finance review before opening.");
  if (rows.some(row => row.kind === "SUPPLIER_PAYABLE" || row.kind === "OTHER_PAYABLE") && await ctx.db.query("vehicleSupplierPayables").withIndex("by_org", q => q.eq("orgId",args.orgId)).first()) throw new ConvexError("Existing payables require finance review before opening.");
  await validateOpeningPartners(ctx, args.orgId, args.lines, rows);
  if (hasPrepaidControl && await ctx.db.query("prepaidExpenseSchedules").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).first()) {
    throw new ConvexError("Existing prepaid schedules require a finance review before an opening can be posted.");
  }
  if (await ctx.db.query("employeeAdvances").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).first()) {
    throw new ConvexError("Existing advance records require a finance review before an opening can be posted.");
  }
  const [legacy, canonical] = await Promise.all([
    ctx.db.query("receivables").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).first(),
    ctx.db.query("receivableDocuments").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).first(),
  ]);
  if (legacy || canonical) throw new ConvexError("Existing receivable records require a finance review before an opening can be posted.");
  return { [validatedPlan]: true, orgId: args.orgId, currency: args.currency, asOfDate: args.asOfDate,
    rows: rows.map((row) => row.kind === "CUSTOMER_RECEIVABLE" || row.kind === "PREPAID_EXPENSE" ? ({ ...row, title: row.title.trim() })
      : row.kind === "EMPLOYEE_ADVANCE" ? ({ ...row, note: row.note?.trim() }) : ({ ...row })) };
}

/** Called only by the shared opening poster in its original transaction. No
 * ordinary origination hook, cash movement or income event belongs here. */
export async function materializeOpeningAllocations(ctx: MutationCtx, plan: OpeningAllocationPlan,
  draftId: Id<"openingBalanceDrafts">, actorId: Id<"users">): Promise<Result[]> {
  if (plan[validatedPlan] !== true) throw new ConvexError("The opening allocations have not been validated.");
  const results: Result[] = [];
  const partnerTotals = new Map<Id<"partnerEquity">, number>();
  for (const row of plan.rows) {
    if (row.kind !== "PARTNER_CAPITAL") continue;
    const amount = (partnerTotals.get(row.partnerId) ?? 0) + row.amountMinor;
    if (!Number.isSafeInteger(amount)) throw new ConvexError("The opening partner total is too large.");
    partnerTotals.set(row.partnerId, amount);
  }
  for (const [partnerId, openingBalanceMinor] of partnerTotals) {
    await ctx.db.patch(partnerId, { openingBalanceMinor, openingBalanceDraftId: draftId });
  }
  for (let index = 0; index < plan.rows.length; index++) {
    const row = plan.rows[index];
    const now = Date.now();
    if (row.kind === "EMPLOYEE_COMMISSION") {
      const openingCommissionLiabilityId = await materializeOpeningCommission(ctx,{orgId:plan.orgId,currency:plan.currency,draftId,row,now});
      results.push({kind:row.kind,rowKey:row.rowKey,openingCommissionLiabilityId}); continue;
    }
    if (row.kind === "UNALLOCATED_LIABILITY") {
      results.push({kind:row.kind,rowKey:row.rowKey,purpose:row.purpose}); continue;
    }
    if (row.kind === "SUPPLIER_RECOVERABLE") {
      const recoveryId = await ctx.db.insert("supplierCostRecoveries",{origin:"OPENING",orgId:plan.orgId,openingBalanceDraftId:draftId,openingRowKey:row.rowKey,title:row.title.trim(),purpose:row.purpose,sourcedFromName:row.counterpartyName.trim(),amountDueMinor:row.amountMinor,amountRecoveredMinor:0,currency:plan.currency,receiptSeq:0,status:"OPEN",createdBy:actorId,createdAt:now,updatedAt:now});
      results.push({kind:row.kind,rowKey:row.rowKey,recoveryId}); continue;
    }
    if (row.kind === "SUPPLIER_PAYABLE" || row.kind === "OTHER_PAYABLE") {
      const payableId = await ctx.db.insert("vehicleSupplierPayables",{origin:"OPENING",orgId:plan.orgId,openingBalanceDraftId:draftId,openingRowKey:row.rowKey,openingKind:row.kind,title:row.title.trim(),sourcedFromName:row.counterpartyName.trim(),amountDue:fromMinorUnits(row.amountMinor,plan.currency),amountPaid:0,currency:plan.currency,paymentSeq:0,status:"PENDING",createdBy:actorId,createdAt:now,updatedAt:now});
      results.push({kind:row.kind,rowKey:row.rowKey,payableId}); continue;
    }
    if (row.kind === "PARTNER_CAPITAL") {
      results.push({ kind: row.kind, rowKey: row.rowKey, partnerId: row.partnerId });
      continue;
    }
    if (row.kind === "VEHICLE_INVENTORY") {
      await ctx.db.patch(row.vehicleId, { openingBalanceDraftId: draftId });
      results.push({ kind: row.kind, rowKey: row.rowKey, vehicleId: row.vehicleId });
      continue;
    }
    if (row.kind === "EMPLOYEE_ADVANCE") {
      const advanceId = await ctx.db.insert("employeeAdvances", { orgId: plan.orgId, userId: row.userId,
        amountMinor: row.amountMinor, recoveredMinor: 0, currency: plan.currency, date: plan.asOfDate,
        status: "OUTSTANDING", note: row.note, openingBalanceDraftId: draftId,
        createdBy: actorId, createdAt: now, updatedAt: now });
      results.push({ kind: row.kind, rowKey: row.rowKey, advanceId });
      continue;
    }
    if (row.kind === "PREPAID_EXPENSE") {
      const scheduleId = await ctx.db.insert("prepaidExpenseSchedules", {
        kind: "OPENING", orgId: plan.orgId, openingBalanceDraftId: draftId,
        openingRowKey: row.rowKey, title: row.title, attestedUnexpiredBenefit: true,
        openingBalanceDate: plan.asOfDate, currency: plan.currency, totalMinor: row.amountMinor,
        termMonths: row.termMonths, expenseSystemKey: row.expenseSystemKey,
        startYearMonth: row.startYearMonth, recognizedMinor: 0, monthsRecognized: 0,
        status: "ACTIVE", createdAt: now,
      });
      results.push({ kind: row.kind, rowKey: row.rowKey, scheduleId });
      continue;
    }
    const amount = fromMinorUnits(row.amountMinor, plan.currency);
    const receivableId = await ctx.db.insert("receivables", {
      orgId: plan.orgId, customerId: row.customerId, sourceType: "OTHER", title: row.title,
      originalAmount: amount, outstandingAmount: amount, dueDate: row.dueDate,
      status: row.dueDate < now ? "OVERDUE" : "OPEN", openingBalanceDraftId: draftId,
      createdBy: actorId, createdAt: now, updatedAt: now,
    });
    const canonicalReceivableDocumentId = await ensureReceivableDocument(ctx, {
      orgId: plan.orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId: row.customerId,
      sourceType: "legacy_receivable", sourceId: receivableId, originalAmountMinor: row.amountMinor,
      currency: plan.currency, issueDate: plan.asOfDate, dueDate: row.dueDate, actorId,
      documentNumber: `OB-${new Date(plan.asOfDate).getUTCFullYear()}-${String(index + 1).padStart(4, "0")}`,
    });
    await ctx.db.patch(receivableId, { canonicalReceivableDocumentId });
    results.push({ kind: row.kind, rowKey: row.rowKey, receivableId, canonicalReceivableDocumentId });
  }
  return results;
}
