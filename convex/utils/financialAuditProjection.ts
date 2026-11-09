import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isSystemOwnerRole, PERMISSIONS } from "./permissions";
import { canReadVehicleCost } from "./vehicleCostVisibility";
import { mayReadFinanceEconomics } from "./financeApplicationProjection";
import { canManageOpeningPayroll, canReadOpeningPayroll, containsEmployeeAdvanceControl } from "./openingPayrollVisibility";
import { openingAllocationValidator } from "./openingAllocationValidators";
import { isUnwindActor } from "./dealUnwindGuard";

// Derive from the persisted union: schema additions must be classified here.
export type AuditActionType = Doc<"financialAuditLog">["actionType"];
type AuditReadPolicy = "FINANCE" | "COST" | "OPENING" | "OPENING_VOID" | "JOURNAL" | "MANUAL_DRAFT" |
  "COMMISSION" | "SALE_COMMISSION" | "POST_EVENT" | "MIGRATION" | "SALES" | "APPLICATION_FINANCE" | "EXPECTED_PAYMENT" | "UNWIND";

/** Source-reader policies, not mutation authority. See the SCRUM-936 census/ADR. */
export const AUDIT_READ_POLICY = {
  EDIT_OPENING_DRAFT: "OPENING",
  REQUEST_OPENING_VOID: "OPENING_VOID",
  APPROVE_OPENING_VOID: "OPENING_VOID",
  CREATE_PERIOD: "FINANCE",
  POST_EVENT: "POST_EVENT",
  POST_MANUAL_JOURNAL: "JOURNAL",
  CREATE_MANUAL_JOURNAL_DRAFT: "MANUAL_DRAFT",
  REJECT_MANUAL_JOURNAL: "MANUAL_DRAFT",
  REVERSE_EVENT: "COST",
  OPEN_PERIOD: "FINANCE",
  CLOSE_PERIOD: "COST",
  LOCK_PERIOD: "FINANCE",
  REOPEN_PERIOD: "FINANCE",
  INIT_CHART: "FINANCE",
  UPDATE_ACCOUNT: "FINANCE",
  MIGRATE_TRANSACTION: "MIGRATION",
  ALLOCATE_PAYMENT: "COST",
  SET_SUPPLIER_DISPUTE: "COST",
  REVERSE_ALLOCATION: "COST",
  IGNORE_BANK_STATEMENT_LINE: "FINANCE",
  CORRECT_PREPAID_SCHEDULE: "FINANCE",
  REQUEST_PREPAID_CORRECTION: "FINANCE",
  APPROVE_PREPAID_CORRECTION: "FINANCE",
  REJECT_PREPAID_CORRECTION: "FINANCE",
  RESOLVE_SYSTEM_ACCOUNT_ADOPTION: "FINANCE",
  REPAIR_MISSING_SYSTEM_ACCOUNTS: "FINANCE",
  ACKNOWLEDGE_CLOSE_WARNINGS: "COST",
  SET_COMMISSION_AMOUNT: "SALE_COMMISSION",
  ALLOCATE_DEPOSIT: "SALES",
  RESOLVE_DEPOSIT_ALLOCATION: "SALES",
  SET_SUPPLIER_SETTLEMENT_ROUTE: "SALES",
  CORRECT_EXPECTED_PAYMENT: "EXPECTED_PAYMENT",
  ATTEST_CHEQUE_FACE: "FINANCE",
  CONFIRM_SUPPLIER_DISBURSEMENT: "APPLICATION_FINANCE",
  AMEND_SUPPLIER_DISBURSEMENT_ADVICE: "APPLICATION_FINANCE",
  SETTLE_COMMITMENT_AUTHORITY: "SALES",
  RETURN_FINANCE_DISBURSEMENT_CHEQUE: "APPLICATION_FINANCE",
  ADD_DEAL_COMMISSION_LINE: "COMMISSION",
  REMOVE_DEAL_COMMISSION_LINE: "COMMISSION",
  DEAL_UNWIND_STARTED: "UNWIND",
  DEAL_UNWIND_FORWARD_RETURNED: "UNWIND",
  DEAL_UNWIND_REMITTANCE_REFUNDED: "UNWIND",
  DEAL_UNWIND_COMPLETED: "UNWIND",
  DEAL_UNWIND_ABANDONED: "UNWIND",
} satisfies Record<AuditActionType, AuditReadPolicy>;

type AuditRow = Doc<"financialAuditLog">;
type AuditReadRow = AuditRow & { detailsWithheld?: true; lineCount?: number };

type DraftPayrollReader = (draftId: Id<"openingBalanceDrafts">) => Promise<boolean>;

/** One request owns both caches, including in-flight reads during Promise.all. */
export function draftPayrollReader(ctx: QueryCtx, orgId: Id<"organizations">): DraftPayrollReader {
  const accounts = new Map<Id<"chartOfAccounts">, Promise<Doc<"chartOfAccounts"> | null>>();
  const readAccount = (id: Id<"chartOfAccounts">) => {
    let account = accounts.get(id);
    if (!account) {
      account = ctx.db.get(id);
      accounts.set(id, account);
    }
    return account;
  };
  const decisions = new Map<Id<"openingBalanceDrafts">, Promise<boolean>>();
  return draftId => {
    const cached = decisions.get(draftId);
    if (cached) return cached;
    const decision = (async () => {
      const draft = await ctx.db.get(draftId);
      // Missing/foreign evidence never grants access.
      if (!draft || draft.orgId !== orgId) return true;
      return containsEmployeeAdvanceControl(ctx, orgId, draft, readAccount);
    })();
    decisions.set(draftId, decision);
    return decision;
  };
}

async function mayReadOpeningAudit(ctx: QueryCtx, role: Doc<"roles">, row: AuditRow, needsPayroll: DraftPayrollReader): Promise<boolean> {
  if (!canReadVehicleCost(role)) return false;
  const voidAction = AUDIT_READ_POLICY[row.actionType] === "OPENING_VOID";
  if (voidAction ? canManageOpeningPayroll(role) : canReadOpeningPayroll(role)) return true;
  // The current draft may have had an employee removed since an older audit
  // snapshot was written. An untyped historical payload cannot prove its audience.
  if (row.actionType === "EDIT_OPENING_DRAFT" &&
      (!isOpeningAuditSummary(row.before) || !isOpeningAuditSummary(row.after))) return false;
  const draftId = ctx.db.normalizeId("openingBalanceDrafts", row.resourceId);
  return draftId !== null && !(await needsPayroll(draftId));
}

async function mayReadJournalAudit(ctx: QueryCtx, role: Doc<"roles">, row: AuditRow, needsPayroll: DraftPayrollReader): Promise<boolean> {
  if (!mayReadFinanceEconomics(role) || !canReadVehicleCost(role)) return false;
  if (canReadOpeningPayroll(role)) return true;
  const journalId = ctx.db.normalizeId("journalEntries", row.resourceId);
  const journal = journalId ? await ctx.db.get(journalId) : null;
  if (!journal || journal.orgId !== row.orgId) return false;
  if (journal.category !== "OPENING_BALANCE") return true;
  const draft = await ctx.db.query("openingBalanceDrafts")
    .withIndex("by_orgId_and_journalEntryId", q => q.eq("orgId", row.orgId).eq("journalEntryId", journal._id)).unique();
  return draft !== null && !(await needsPayroll(draft._id));
}

async function mayReadAuditDetails(ctx: QueryCtx, role: Doc<"roles">, row: AuditRow, needsPayroll: DraftPayrollReader): Promise<boolean> {
  if (isSystemOwnerRole(role)) return true;
  const policy = AUDIT_READ_POLICY[row.actionType];
  switch (policy) {
    case "OPENING": return mayReadOpeningAudit(ctx, role, row, needsPayroll);
    case "OPENING_VOID": return mayReadOpeningAudit(ctx, role, row, needsPayroll);
    case "JOURNAL": return mayReadJournalAudit(ctx, role, row, needsPayroll);
    case "MANUAL_DRAFT":
      if (row.resourceType === "openingBalanceDrafts") return mayReadOpeningAudit(ctx, role, row, needsPayroll);
      // listPendingManualJournals intentionally requires manage:finance alone.
      return row.resourceType === "manualJournalDrafts";
    case "POST_EVENT":
      return mayReadFinanceEconomics(role) &&
        (row.resourceType === "accountingCutoverSignOffs" || canReadVehicleCost(role));
    case "MIGRATION":
      // The other migration producer records batch counts, not sale economics.
      return mayReadFinanceEconomics(role) && (row.resourceId === row.resourceType || canReadVehicleCost(role));
    case "COST": return mayReadFinanceEconomics(role) && canReadVehicleCost(role);
    case "COMMISSION": return role.permissions.includes(PERMISSIONS.VIEW_COMMISSIONS);
    case "SALE_COMMISSION":
      // sales.get exposes commissionAmount under VIEW_SALES (PUBLIC_LEGACY);
      // dealCommissions.forSale exposes it under VIEW_COMMISSIONS.
      return role.permissions.includes(PERMISSIONS.VIEW_SALES) || role.permissions.includes(PERMISSIONS.VIEW_COMMISSIONS);
    case "SALES": return role.permissions.includes(PERMISSIONS.VIEW_SALES);
    case "APPLICATION_FINANCE":
    case "EXPECTED_PAYMENT":
    case "UNWIND":
      // applications.get and unwindStatus authenticate VIEW_SALES before
      // projecting the finance tier; the audit copy must retain both gates.
      return role.permissions.includes(PERMISSIONS.VIEW_SALES) && mayReadFinanceEconomics(role);
    case "FINANCE": return mayReadFinanceEconomics(role);
    default: return false;
  }
}

function auditObject(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

/** Preserve #792's amount-free summary contract without trusting arbitrary keys. */
function openingAuditSummary(raw: unknown): Record<string, unknown> | undefined {
  const source = auditObject(raw);
  if (!source) return undefined;
  const summary: Record<string, unknown> = {};
  for (const key of ["version", "lineCount", "allocationCount", "asOfDate"] as const) {
    const count = source[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) summary[key] = count;
  }
  if (Array.isArray(source.lines)) summary.lineCount = source.lines.length;
  if (Array.isArray(source.allocations)) summary.allocationCount = source.allocations.length;
  const kinds: readonly unknown[] = openingAllocationValidator.members.map(member => member.fields.kind.value);
  if (Array.isArray(source.allocationKinds) && source.allocationKinds.every((kind: unknown) => kinds.includes(kind))) {
    summary.allocationKinds = source.allocationKinds;
  }
  if (source.currency === null || (typeof source.currency === "string" && /^[A-Z]{3}$/.test(source.currency))) summary.currency = source.currency;
  if (typeof source.memoChanged === "boolean") summary.memoChanged = source.memoChanged;
  return Object.keys(summary).length ? summary : undefined;
}

function isOpeningAuditSummary(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  const source = auditObject(raw);
  if (!source) return false;
  const summary = openingAuditSummary(raw) ?? {};
  return Object.keys(source).every(key => Object.hasOwn(summary, key));
}

function unwindActorAuditAmounts(raw: unknown): Record<string, unknown> | undefined {
  const source = auditObject(raw);
  if (!source) return undefined;
  const amounts: Record<string, unknown> = {};
  for (const key of ["remittanceMinor", "disbursedAmountMinor"] as const) {
    const amount = source[key];
    if (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0) amounts[key] = amount;
  }
  if (source.remittanceMethod === "CASH" || source.remittanceMethod === "BANK_TRANSFER") amounts.remittanceMethod = source.remittanceMethod;
  return Object.keys(amounts).length ? amounts : undefined;
}

/** Method/date belong to the application reader; cheque evidence to collections. */
function expectedPaymentAuditSummary(ctx: QueryCtx, role: Doc<"roles">, raw: unknown): Record<string, unknown> | undefined {
  const source = auditObject(raw);
  if (!source) return undefined;
  const summary: Record<string, unknown> = {};
  if (role.permissions.includes(PERMISSIONS.VIEW_SALES)) {
    const method = source.expectedPaymentMethod;
    if (method === null || method === "CASH" || method === "BANK_TRANSFER" || method === "CHEQUE") summary.expectedPaymentMethod = method;
    const date = source.expectedPaymentDate;
    if (date === null || (typeof date === "number" && Number.isFinite(date))) summary.expectedPaymentDate = date;
  }
  if (mayReadFinanceEconomics(role) && Array.isArray(source.chequeIds) && source.chequeIds.every((id: unknown) =>
    typeof id === "string" && ctx.db.normalizeId("postDatedCheques", id) !== null)) summary.chequeIds = source.chequeIds;
  return Object.keys(summary).length ? summary : undefined;
}

export async function projectAuditRow(ctx: QueryCtx, role: Doc<"roles">, row: AuditRow, needsPayroll: DraftPayrollReader): Promise<AuditReadRow> {
  if (await mayReadAuditDetails(ctx, role, row, needsPayroll)) return row;
  // Explicit allowlist: never spread a restricted row, even when the schema grows.
  const projected: AuditReadRow = {
    _id: row._id, _creationTime: row._creationTime, orgId: row.orgId,
    actorId: row.actorId, actionType: row.actionType, resourceType: row.resourceType,
    resourceId: "WITHHELD", occurredAt: row.occurredAt,
    description: "Financial audit details withheld.", detailsWithheld: true,
  };
  const after = auditObject(row.after);
  const lineCount = Array.isArray(after?.lines) ? after.lines.length : after?.lineCount ?? after?.lines;
  if (typeof lineCount === "number" && Number.isSafeInteger(lineCount) && lineCount >= 0) projected.lineCount = lineCount;
  if (row.actionType === "EDIT_OPENING_DRAFT") {
    projected.before = openingAuditSummary(row.before);
    projected.after = openingAuditSummary(row.after);
  }
  if (AUDIT_READ_POLICY[row.actionType] === "UNWIND" && role.permissions.includes(PERMISSIONS.VIEW_SALES) && isUnwindActor(role)) {
    projected.before = unwindActorAuditAmounts(row.before);
    projected.after = unwindActorAuditAmounts(row.after);
  }
  if (AUDIT_READ_POLICY[row.actionType] === "EXPECTED_PAYMENT") {
    projected.before = expectedPaymentAuditSummary(ctx, role, row.before);
    projected.after = expectedPaymentAuditSummary(ctx, role, row.after);
    if (mayReadFinanceEconomics(role)) projected.description = row.description;
  }
  return projected;
}
