/**
 * Phase 7 — Financial audit log + segregation of duties enforcement
 *
 * Every sensitive financial mutation writes an immutable audit log entry.
 * Segregation of duties (SoD) rules are checked before high-risk operations.
 * The audit log itself is append-only: no update or delete mutations are exposed.
 */
import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { isSystemOwnerRole, PERMISSIONS } from "./utils/permissions";
import { canReadVehicleCost } from "./utils/vehicleCostVisibility";
import { mayReadFinanceEconomics } from "./utils/financeApplicationProjection";
import { canManageOpeningPayroll, canReadOpeningPayroll, containsEmployeeAdvanceControl } from "./utils/openingPayrollVisibility";
import { openingAllocationValidator } from "./utils/openingAllocationValidators";
import { mayReadUnwindActorEvidence } from "./utils/dealUnwindGuard";
import { assertManualJournalsEnabled } from "./utils/manualJournalContainment";
import { scaleForCurrency } from "./utils/money";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";
import { SYSTEM_KEYS } from "./utils/defaultChart";

// Derive from the persisted union: schema additions must be classified here.
type AuditActionType = Doc<"financialAuditLog">["actionType"];
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
function draftPayrollReader(ctx: QueryCtx, orgId: Id<"organizations">): DraftPayrollReader {
  let controls: Promise<ReadonlySet<Id<"chartOfAccounts">>> | undefined;
  const decisions = new Map<Id<"openingBalanceDrafts">, Promise<boolean>>();
  return draftId => {
    const cached = decisions.get(draftId);
    if (cached) return cached;
    const decision = (async () => {
      const draft = await ctx.db.get(draftId);
      // Missing/foreign evidence never grants access.
      if (!draft || draft.orgId !== orgId) return true;
      controls ??= Promise.all([SYSTEM_KEYS.EMPLOYEE_ADVANCES, SYSTEM_KEYS.COMMISSION_PAYABLE].map(systemKey =>
        ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", q => q.eq("orgId", orgId).eq("systemKey", systemKey)).unique()
      )).then(accounts => new Set(accounts.flatMap(account => account ? [account._id] : [])));
      return containsEmployeeAdvanceControl(ctx, orgId, draft, await controls);
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
  const kinds = openingAllocationValidator.members.map(member => member.fields.kind.value);
  if (Array.isArray(source.allocationKinds) && source.allocationKinds.every((kind: unknown) => kinds.some(allowed => allowed === kind))) {
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

async function projectAuditRow(ctx: QueryCtx, role: Doc<"roles">, row: AuditRow, needsPayroll: DraftPayrollReader): Promise<AuditReadRow> {
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
  if (AUDIT_READ_POLICY[row.actionType] === "UNWIND" && role.permissions.includes(PERMISSIONS.VIEW_SALES) && mayReadUnwindActorEvidence(role)) {
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

// ─── Internal: write audit entry ─────────────────────────────────────────────

export async function auditLog(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    actorId: Id<"users">;
    actionType: AuditActionType;
    resourceType: string;
    resourceId: string;
    description: string;
    before?: unknown;
    after?: unknown;
    idempotencyKey?: string;
  }
): Promise<void> {
  await ctx.db.insert("financialAuditLog", {
    ...entry,
    occurredAt: Date.now(),
  });
}

// ─── Segregation of duties guard ─────────────────────────────────────────────

export async function checkSegregationOfDuties(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    actorId: Id<"users">;
    priorActorId: Id<"users"> | undefined;
    operationLabel: string;
  }
): Promise<void> {
  if (!args.priorActorId) return;
  if (args.actorId === args.priorActorId) {
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    const allowBypass = (settings as unknown as { allowSoDBypasses?: boolean })?.allowSoDBypasses ?? false;
    if (!allowBypass) {
      throw new ConvexError(
        `Segregation of duties violation: the same person cannot both initiate and approve ${args.operationLabel}.`
      );
    }
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const listAuditLog = query({
  args: {
    orgId: v.id("organizations"),
    actorId: v.optional(v.id("users")),
    actionType: v.optional(v.string()),
    fromDate: v.optional(v.number()),
    toDate: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const requestedLimit = args.limit ?? 50;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new ConvexError("limit must be a positive integer.");
    }
    const limit = Math.min(requestedLimit, 200);
    const actionType = args.actionType as AuditActionType | undefined;

    // When date bounds are specified with the time index we can push the lower
    // bound into the index scan; for actor/action branches we over-fetch and
    // slice to avoid dropping valid matches before the in-memory date filter.
    const fetchLimit = args.fromDate || args.toDate ? limit * 5 : limit;

    let entries;
    if (args.actorId) {
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_actor", (q) => q.eq("orgId", args.orgId).eq("actorId", args.actorId!))
        .order("desc")
        .take(fetchLimit);
    } else if (actionType) {
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_action", (q) =>
          q.eq("orgId", args.orgId).eq("actionType", actionType)
        )
        .order("desc")
        .take(fetchLimit);
    } else if (args.fromDate) {
      // Use time index so fromDate is pushed into the scan, not post-filtered.
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_time", (q) =>
          q.eq("orgId", args.orgId).gte("occurredAt", args.fromDate!)
        )
        .order("desc")
        .take(fetchLimit);
    } else {
      entries = await ctx.db
        .query("financialAuditLog")
        .withIndex("by_org_time", (q) => q.eq("orgId", args.orgId))
        .order("desc")
        .take(fetchLimit);
    }

    // Apply remaining date bounds in memory (after the index scan).
    if (args.fromDate || args.toDate) {
      entries = entries.filter((e) => {
        if (args.fromDate && e.occurredAt < args.fromDate) return false;
        if (args.toDate && e.occurredAt > args.toDate) return false;
        return true;
      });
    }

    const needsPayroll = draftPayrollReader(ctx, args.orgId);
    return Promise.all(entries.slice(0, limit).map(entry => projectAuditRow(ctx, role, entry, needsPayroll)));
  },
});

// ─── Manual journal — true two-person approval (phase 10) ───────────────────

const manualJournalLineValidator = v.object({
  accountId: v.id("chartOfAccounts"),
  debitMinor: v.number(),
  creditMinor: v.number(),
  description: v.optional(v.string()),
});

export type ManualJournalLine = {
  accountId: Id<"chartOfAccounts">;
  debitMinor: number;
  creditMinor: number;
  description?: string;
};

// Per-line validation (safe integers, non-negative, exactly one side non-zero)
// plus the overall balance check. Shared by draft creation and approval, since
// approval must not trust that nothing changed since the draft was created.
export function validateManualJournalLines(lines: ManualJournalLine[]): number {
  for (const [idx, line] of lines.entries()) {
    const n = idx + 1;
    if (!Number.isSafeInteger(line.debitMinor) || !Number.isSafeInteger(line.creditMinor)) {
      throw new ConvexError(`Line ${n}: amounts must be integer minor-unit values.`);
    }
    if (line.debitMinor < 0 || line.creditMinor < 0) {
      throw new ConvexError(`Line ${n}: amounts cannot be negative.`);
    }
    if (line.debitMinor > 0 && line.creditMinor > 0) {
      throw new ConvexError(`Line ${n}: a single line cannot have both debit and credit amounts.`);
    }
    if (line.debitMinor === 0 && line.creditMinor === 0) {
      throw new ConvexError(`Line ${n}: must have a non-zero debit or credit amount.`);
    }
  }

  const totalDebits = lines.reduce((s, l) => s + l.debitMinor, 0);
  const totalCredits = lines.reduce((s, l) => s + l.creditMinor, 0);
  if (totalDebits !== totalCredits) {
    throw new ConvexError(`Manual journal is unbalanced: debits=${totalDebits} credits=${totalCredits}.`);
  }
  if (totalDebits === 0) {
    throw new ConvexError("Manual journal must have at least one non-zero line.");
  }
  return totalDebits;
}

// Validates every account exists, belongs to the org, and allows manual
// posting, and resolves the single currency + minor-unit scale for the
// journal. Re-run at approval time in case an account changed between draft
// creation and approval.
async function resolveManualJournalCurrency(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  lines: ManualJournalLine[]
): Promise<{ currency: string; scale: number }> {
  let journalCurrency: string | null = null;
  for (const line of lines) {
    const account = await ctx.db.get(line.accountId);
    if (!account || account.orgId !== orgId) {
      throw new ConvexError(`Account ${line.accountId} not found in this org.`);
    }
    if (!account.active) {
      throw new ConvexError(`Account "${account.name}" is inactive and cannot be posted to. Reactivate it first or use a different account.`);
    }
    // Manual journal lines have no physical bank field. Even if an older
    // chart configuration permits manual posting, they cannot safely debit or
    // credit the BANK_ACCOUNT control without inventing an attribution.
    if (account.systemKey === SYSTEM_KEYS.BANK_ACCOUNT) {
      throw new ConvexError("This manual journal cannot use the bank control account because it cannot capture a physical bank. Nothing was posted.");
    }
    if (!account.allowManualPosting) {
      throw new ConvexError(`Account "${account.name}" does not allow manual posting.`);
    }
    const lineCurrency = account.currencyRestriction ?? null;
    if (journalCurrency === null) {
      journalCurrency = lineCurrency;
    } else if (lineCurrency !== null && lineCurrency !== journalCurrency) {
      throw new ConvexError("All manual journal lines must use the same currency.");
    }
  }

  let effectiveCurrency = journalCurrency;
  if (!effectiveCurrency) {
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();
    effectiveCurrency = settings?.currency ?? "JOD";
  }
  return { currency: effectiveCurrency, scale: scaleForCurrency(effectiveCurrency) };
}

function manualJournalFingerprint(
  memo: string,
  lines: ManualJournalLine[],
  accountingDate: number | undefined
): string {
  // SCRUM-50: the accounting date is part of what makes a journal that journal.
  // Two drafts with identical memo and lines but different dates are DIFFERENT
  // journals, so leaving the date out would let a retried key silently return
  // the first draft and discard the second date — the same silent substitution
  // this ticket exists to remove, just relocated to the idempotency guard.
  return JSON.stringify({
    memo,
    accountingDate,
    lines: lines.map((l) => ({ a: l.accountId, d: l.debitMinor, c: l.creditMinor })),
  });
}

export const createManualJournal = mutation({
  args: {
    orgId: v.id("organizations"),
    memo: v.string(),
    lines: v.array(manualJournalLineValidator),
    idempotencyKey: v.string(),
    // SCRUM-50 / c16529 — OPTIONAL AT THE TRANSPORT BOUNDARY, MANDATORY IN THE
    // HANDLER.
    //
    // ⚠️ WHAT THIS DOES *NOT* BUY, stated first because an earlier version of
    // this comment claimed it and was wrong. Optional does NOT make the two
    // deploys compatible. Once this backend is live, a call from the current
    // client — which sends no `accountingDate` at all — fails either way: a
    // required validator would reject it with an ArgumentValidationError, and
    // this optional one lets it reach the handler, which refuses it below.
    // Both outcomes are a 100% failure of manual-journal creation. The only
    // thing optional buys on that path is a readable business message instead
    // of a raw validator error. It is a better error, not availability.
    //
    // What actually prevents the skew is that Stage A ships NO client change:
    // `main` auto-deploys the frontend while the Convex backend deploy is
    // separately owner-gated, so merging this alone leaves the live client and
    // the live backend exactly as they were.
    //
    // The residual hazard is therefore OPERATIONAL, not structural, and it is
    // recorded against SCRUM-201 rather than papered over here:
    //
    //     backend activation WITHOUT the Stage-B client
    //       = manual-journal creation fully unavailable until Stage B ships.
    //
    // The rule itself is not weakened. The handler refuses a missing date
    // before any write, so no dateless draft can be created through the
    // backend whatever the caller sends — and softening that to restore
    // availability would reinstate the exact defect this ticket removes.
    accountingDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    // SCRUM-795: off for the pilot. After authentication, before any read or write.
    assertManualJournalsEnabled();

    // FAIL CLOSED, BEFORE ANY WRITE.
    //
    // The accounting date is an assertion the preparer makes about which period
    // the economic event belongs to. It is never inferred, never defaulted and
    // never taken from the clock — that inference IS the defect this ticket
    // removes, so re-introducing it here as a convenience would undo the fix at
    // its own front door.
    if (args.accountingDate === undefined) {
      throw new ConvexError(
        "A manual journal must state the accounting date the entry belongs to. Supply the date explicitly and submit it again."
      );
    }

    // Refused here rather than at approval: a draft carrying an unusable date
    // could never be approved, and a draft that can only ever be rejected is a
    // dead end handed to the reviewer instead of to the person who can fix it.
    //
    // `Number.isFinite` alone is NOT enough, and both review seats found this
    // independently. JavaScript's Date domain stops at +/-8.64e15 ms, so
    // 8640000000000001 is a perfectly finite safe integer whose `toISOString()`
    // throws RangeError. Accepting one would persist a draft that can never be
    // approved and that counts against EVERY period-close checklist until
    // somebody rejects it.
    if (
      !Number.isFinite(args.accountingDate) ||
      Number.isNaN(new Date(args.accountingDate).getTime())
    ) {
      throw new ConvexError("The manual journal's accounting date is not a valid date.");
    }
    const accountingDate = args.accountingDate;

    validateManualJournalLines(args.lines);
    await resolveManualJournalCurrency(ctx, args.orgId, args.lines);

    const fingerprint = manualJournalFingerprint(args.memo, args.lines, accountingDate);
    const existing = await ctx.db
      .query("manualJournalDrafts")
      .withIndex("by_org_idempotency", (q) =>
        q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey)
      )
      .first();
    if (existing) {
      const priorFingerprint = manualJournalFingerprint(
        existing.memo,
        existing.lines,
        existing.accountingDate
      );
      if (priorFingerprint !== fingerprint) {
        throw new ConvexError("Idempotency key reused with different journal content.");
      }
      return { alreadyCreated: true, draftId: existing._id };
    }

    const now = Date.now();
    const draftId = await ctx.db.insert("manualJournalDrafts", {
      orgId: args.orgId,
      status: "PENDING_APPROVAL",
      memo: args.memo,
      lines: args.lines,
      accountingDate,
      idempotencyKey: args.idempotencyKey,
      createdBy: user._id,
      createdAt: now,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "CREATE_MANUAL_JOURNAL_DRAFT",
      resourceType: "manualJournalDrafts",
      resourceId: draftId.toString(),
      description: `Manual journal draft submitted for approval: ${args.memo}`,
      after: { lines: args.lines.length },
      idempotencyKey: args.idempotencyKey,
    });

    return { alreadyCreated: false, draftId };
  },
});

export const approveManualJournal = mutation({
  args: {
    orgId: v.id("organizations"),
    draftId: v.id("manualJournalDrafts"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    // SCRUM-795: off for the pilot. After authentication, before any read or write.
    assertManualJournalsEnabled();

    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.orgId !== args.orgId) {
      throw new ConvexError("Manual journal draft not found.");
    }
    if (draft.status !== "PENDING_APPROVAL") {
      throw new ConvexError("This manual journal has already been resolved.");
    }
    // Segregation of duties: the approver must be a different, finance-authorized
    // person from whoever created the draft. Deliberately hardcoded rather than
    // routed through checkSegregationOfDuties/orgSettings.allowSoDBypasses — a
    // manual journal is an arbitrary, unrestricted GL posting (the highest-risk
    // financial control point), and this is the exact check Phase 10 exists to
    // make unbypassable, unlike lower-risk SoD checks elsewhere that orgs may
    // opt out of.
    if (draft.createdBy === user._id) {
      throw new ConvexError("Manual journal reviewer cannot be the same as the poster.");
    }

    const totalDebits = validateManualJournalLines(draft.lines);
    const { currency: effectiveCurrency, scale: journalScale } =
      await resolveManualJournalCurrency(ctx, args.orgId, draft.lines);

    // `now` is approval-time AUDIT metadata only — postedAt, decidedAt,
    // createdAt. It is deliberately NOT the accounting date (SCRUM-50). Both
    // facts are real and they are not the same fact: one says when the money
    // moved, the other says when a human signed off.
    const now = Date.now();

    // A draft written before SCRUM-50 carries no declared date, and there is no
    // honest way to supply one here. `Date.now()` is the precise defect this
    // closes, and the draft's creation timestamp would invent an accounting
    // assertion the preparer never made. Refuse, and let the operator resubmit
    // with a date they actually chose.
    const accountingDate = draft.accountingDate;
    if (accountingDate === undefined) {
      throw new ConvexError(
        "This manual journal draft carries no accounting date, so it cannot be posted. It was prepared before the accounting date became explicit. Reject it and resubmit the journal with the date the entry belongs to."
      );
    }
    // Defence in depth, and NOT redundant with the guard in
    // createManualJournal: that one only protects drafts that came through
    // createManualJournal. A row written directly — a migration, an admin tool,
    // a future caller — would otherwise reach the formatting below and throw an
    // uncaught RangeError instead of a refusal an operator can act on.
    if (Number.isNaN(new Date(accountingDate).getTime())) {
      throw new ConvexError(
        "This manual journal draft carries an unusable accounting date, so it cannot be posted. Reject it and resubmit the journal with a valid date."
      );
    }
    const declaredDay = new Date(accountingDate).toISOString().slice(0, 10);

    // The period containing the DECLARED date, not today's; inline to avoid a
    // circular import with accountingPeriods.ts.
    const period = await ctx.db
      .query("accountingPeriods")
      .withIndex("by_org_startDate", (q) => q.eq("orgId", args.orgId))
      .filter((q) =>
        q.and(
          q.lte(q.field("startDate"), accountingDate),
          q.gte(q.field("endDate"), accountingDate)
        )
      )
      .first();
    if (!period) {
      throw new ConvexError(
        `No accounting period covers ${declaredDay}. Open the period for that date, or resubmit the journal with a date the books cover.`
      );
    }
    if (period.status === "CLOSED" || period.status === "LOCKED") {
      throw new ConvexError(
        `The accounting period covering ${declaredDay} is ${period.status}. Manual journal posting not allowed.`
      );
    }
    if (period.status === "FUTURE") {
      throw new ConvexError(`The accounting period covering ${declaredDay} has not been opened yet.`);
    }

    const journalId = await ctx.db.insert("journalEntries", {
      orgId: args.orgId,
      periodId: period._id,
      journalNumber: "MJ-pending",
      accountingDate,
      sourceType: "manual",
      sourceId: draft.createdBy.toString(),
      category: "MANUAL",
      memo: draft.memo,
      status: "POSTED",
      postedBy: user._id,
      postedAt: now,
      createdAt: now,
    });
    // Derive journal number from the inserted record ID — guaranteed unique
    const journalNumber = `MJ-${journalId.toString().replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase()}`;
    await ctx.db.patch(journalId, { journalNumber });

    for (let i = 0; i < draft.lines.length; i++) {
      const line = draft.lines[i];
      await ctx.db.insert("journalLines", {
        orgId: args.orgId,
        journalEntryId: journalId,
        lineNumber: i + 1,
        accountId: line.accountId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        currency: effectiveCurrency,
        scale: journalScale,
        // journalLines carries its OWN accountingDate, so dating only the entry
        // above would leave every line contradicting the entry it belongs to.
        accountingDate,
        description: line.description,
      });
      // GL Phase 18: a direct journalLines insert (not routed through
      // postAccountingEvent), so the running snapshot needs its own update
      // here too — same as postingEngine.ts, reversals.ts, and
      // accountingCutover.ts's approveOpeningBalance.
      await incrementAccountSnapshot(ctx, {
        orgId: args.orgId,
        accountId: line.accountId,
        currency: effectiveCurrency,
        periodId: period._id,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
      });
    }

    await ctx.db.patch(draft._id, {
      status: "POSTED",
      reviewedBy: user._id,
      decidedAt: now,
      journalEntryId: journalId,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "POST_MANUAL_JOURNAL",
      resourceType: "journalEntries",
      resourceId: journalId.toString(),
      description: `Manual journal posted: ${draft.memo}`,
      after: { lines: draft.lines.length, totalDebits, createdBy: draft.createdBy, draftId: draft._id },
    });

    return { resourceId: journalId.toString(), journalId };
  },
});

export const rejectManualJournal = mutation({
  args: {
    orgId: v.id("organizations"),
    draftId: v.id("manualJournalDrafts"),
    rejectionReason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (!args.rejectionReason.trim()) {
      throw new ConvexError("A rejection reason is required.");
    }

    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.orgId !== args.orgId) {
      throw new ConvexError("Manual journal draft not found.");
    }
    if (draft.status !== "PENDING_APPROVAL") {
      throw new ConvexError("This manual journal has already been resolved.");
    }
    // See the matching check in approveManualJournal for why this is hardcoded
    // rather than routed through checkSegregationOfDuties/allowSoDBypasses.
    if (draft.createdBy === user._id) {
      throw new ConvexError("Manual journal reviewer cannot be the same as the poster.");
    }

    const now = Date.now();
    await ctx.db.patch(draft._id, {
      status: "REJECTED",
      reviewedBy: user._id,
      decidedAt: now,
      rejectionReason: args.rejectionReason,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "REJECT_MANUAL_JOURNAL",
      resourceType: "manualJournalDrafts",
      resourceId: draft._id.toString(),
      description: `Manual journal rejected: ${draft.memo} — ${args.rejectionReason}`,
      after: { createdBy: draft.createdBy, rejectionReason: args.rejectionReason },
    });
  },
});

export const listPendingManualJournals = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const drafts = await ctx.db
      .query("manualJournalDrafts")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING_APPROVAL"))
      .order("desc")
      .collect();

    return Promise.all(
      drafts.map(async (draft) => {
        const creator = await ctx.db.get(draft.createdBy);
        return {
          ...draft,
          creatorName: creator?.name || creator?.email || "Unknown",
        };
      })
    );
  },
});
