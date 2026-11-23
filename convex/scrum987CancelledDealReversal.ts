import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
// Read-only builder: it cannot write, so it may come from the raw module.
import { internalQuery } from "./_generated/server";
// ⚠️ SCRUM-987 F8 — the WRAPPED builder, never the raw one: its ctx.db fires
// the aggregate triggers. `aggregateWiring.test.ts` fails the build otherwise.
import { internalMutation } from "./functions";
import { hookCustodyCashReversed } from "./accounting/workflowHooks";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { isSystemOwnerRole, PERMISSIONS, type Permission } from "./utils/permissions";
import { writeAuditLog } from "./utils/auditLog";
import { getOpenPeriodForDate } from "./utils/postingPeriod";
import { custodyEntryPostKey } from "./utils/custodySourceLedger";
import { assertFeeDocWithinBytes, assertFeeTextWithinCap, feeAfterPatch, MAX_FEE_VOID_REASON_CHARS } from "./utils/feeDocLimits";
import { assertMayPostCustody, assertMayUndoReconciliation } from "./utils/financeDealCosts/dealCostGuards";
import { assertNotCustodian, custodyEntriesFor } from "./utils/financeDealCosts/custodyRecords";
import { assertReversalAllowed, recomputeCustodyTotals } from "./utils/financeDealCosts/custodyLedger";
import { syncCustodyFeePosting, syncCustodyPayable } from "./utils/financeDealCosts/custodyPosting";
import { loadActiveFees } from "./utils/settlementDeductions";

/**
 * SCRUM-987 slice 1 — one-time correction of three CANCELLED production deals.
 *
 * Owner ruling 2026-11-23: D-000012, D-000015 and D-000016 were input errors
 * ("paid once, recorded twice"). Every financial effect of their execution fee
 * and custody issuance is removed through the SAME system paths the app uses —
 * no manual journal:
 *
 *   (a) the fee is voided  -> `syncCustodyFeePosting` reverses CUSTODY_FEE_PAID;
 *   (b) the custody ISSUED entry is reversed -> `hookCustodyCashReversed` +
 *       `syncCustodyPayable`, exactly as `recordCustodyMovementHandler` does.
 *
 * ORDER MATTERS (F2): the fee goes first. Reversing the issuance while the
 * fee is still live drives the custody position negative and posts a spurious
 * EMPLOYEE_REIMBURSEMENTS_PAYABLE reclassification that nothing unwinds.
 *
 * Guards deliberately NOT applied, for these ids only (they exist to stop the
 * product's own doors on a finalized / closed record, which is exactly the
 * state being corrected): requireTenantAuth (the actor is passed explicitly and
 * re-proven below), assertDealEconomicsOpen, the RT11 finalized-movement door,
 * custody `status !== OPEN`, assertCustodyOpen. The custody row stays
 * RECONCILED with its sign-off metadata untouched (F6).
 *
 * Fail-closed shape: `planCorrection` reads only and proves every target;
 * `applyCorrection` writes only after the plan holds for ALL targets, then
 * reads the ledger back and throws (rolling the whole transaction back) when
 * the books do not show the effect (F1: the reversal hooks RETURN a
 * "DEFERRED" outcome instead of throwing, so a return value is never evidence).
 * Convex mutations are atomic: a throw discards every write of the call.
 */

export const SCRUM987_REASON = "SCRUM-987 owner ruling 2026-11-23";
export const SCRUM987_ORG_ID = "pd7pw6zrrz9q9ke4sdv6xtw6tn8g8v5n";
/** The UTC month the correction must be dated into (the open November period). */
export const SCRUM987_EXPECTED_UTC_MONTH = "2026-11";

export interface CorrectionTarget {
  label: string;
  applicationId: string;
  feeId: string;
  custodyId: string;
  entryId: string;
  /** Fee amount == custody issued == ISSUED entry amount, in minor units. */
  amountMinor: number;
  /** Whether the deal was finalized then unwound (sale CANCELLED, finalizedSaleId kept). */
  finalized: boolean;
}

/** Production ids and amounts read 2026-11-23 (invariant packet, table §1). */
export const SCRUM987_TARGETS: ReadonlyArray<CorrectionTarget> = [
  {
    label: "D-000012",
    applicationId: "qs7en3pgh408khqsagjphgqhrx8jdxzf",
    feeId: "rh716g08tzs0kjq8xh1kcprvfs8jdgfp",
    custodyId: "r976ejw9pca01ckx442f48pk6s8jdynn",
    entryId: "rd73sbrcqf3qfecr4v6m0rxx3h8jce2s",
    amountMinor: 582_150,
    finalized: false,
  },
  {
    label: "D-000015",
    applicationId: "qs7dq0emdxtb7m65kbfgca41398jc811",
    feeId: "rh71aasc38t34x4g22gmpvxhws8jcyy5",
    custodyId: "r97cy2f8t6gqex3zn5hgm2kz1x8jdmct",
    entryId: "rd725v20e792s89e4n0b5vah3n8jd1ph",
    amountMinor: 870_000,
    finalized: false,
  },
  {
    label: "D-000016",
    applicationId: "qs70da2paqr67nvawywa4tnxfn8jcnds",
    feeId: "rh7evqeycaesbde744d9tep0n18jdezs",
    custodyId: "r97f74vwqhfd2v7kspzep6pmvn8jc536",
    entryId: "rd7eqpry1j41gw6ch7z3tn4k9s8jckf7",
    amountMinor: 870_000,
    finalized: true,
  },
];

type TargetState = "ORIGINAL" | "APPLIED" | "INVALID";

interface TargetInspection {
  label: string;
  state: TargetState;
  /** Why the ORIGINAL state does not hold (and, for INVALID, why APPLIED does not either). */
  problems: string[];
  appliedProblems: string[];
  ids?: {
    applicationId: Id<"financeApplications">;
    feeId: Id<"financeDealFees">;
    custodyId: Id<"financeDealCustody">;
    entryId: Id<"financeDealCustodyEntries">;
  };
}

export type CorrectionPlan =
  | { kind: "ALREADY_APPLIED"; targets: TargetInspection[] }
  | {
      kind: "READY";
      periodId: Id<"accountingPeriods">;
      now: number;
      actor: { userId: Id<"users">; roleName: string };
      targets: TargetInspection[];
    };

type Ctx = QueryCtx | MutationCtx;

const refuse = (message: string, detail?: unknown): never => {
  throw new ConvexError(detail === undefined ? message : { message, detail: JSON.parse(JSON.stringify(detail)) });
};

// ─── Ledger readers ──────────────────────────────────────────────────────────

/** Debit/credit lines of one journal, keyed by the account's system key; sorted and stringified for comparison. */
async function journalShape(
  ctx: Ctx,
  orgId: Id<"organizations">,
  journalEntryId: Id<"journalEntries"> | undefined
): Promise<string[] | null> {
  if (journalEntryId === undefined) return null;
  const entry = await ctx.db.get(journalEntryId);
  if (entry === null || entry.orgId !== orgId) return null;
  const lines = await ctx.db
    .query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalEntryId))
    .take(50);
  const shape: string[] = [];
  for (const line of lines) {
    const account = await ctx.db.get(line.accountId);
    if (account === null || account.orgId !== orgId) return null;
    shape.push(`${account.systemKey ?? "NO_SYSTEM_KEY"}|D${line.debitMinor}|C${line.creditMinor}`);
  }
  return shape.sort();
}

const forwardFeeShape = (amountMinor: number): string[] =>
  [
    `${SYSTEM_KEYS.FINANCE_COMPANY_COMMISSION_EXPENSE}|D${amountMinor}|C0`,
    `${SYSTEM_KEYS.DEAL_CUSTODY_CLEARING}|D0|C${amountMinor}`,
  ].sort();
const forwardIssueShape = (amountMinor: number): string[] =>
  [
    `${SYSTEM_KEYS.DEAL_CUSTODY_CLEARING}|D${amountMinor}|C0`,
    `${SYSTEM_KEYS.CASH_ON_HAND}|D0|C${amountMinor}`,
  ].sort();
/** The mirror of a forward shape: every debit becomes the credit of the same account. */
const mirror = (shape: string[]): string[] =>
  shape
    .map((line) => {
      const [key, d, c] = line.split("|");
      return `${key}|D${c.slice(1)}|C${d.slice(1)}`;
    })
    .sort();

async function eventsFor(
  ctx: Ctx,
  orgId: Id<"organizations">,
  sourceType: string,
  sourceId: string
): Promise<Array<Doc<"accountingEvents">>> {
  const rows = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId))
    .take(21);
  if (rows.length > 20) refuse(`Source ${sourceType}/${sourceId} carries more than 20 accounting events; the correction will not decide on a prefix.`);
  return rows;
}

async function pendingFor(
  ctx: Ctx,
  orgId: Id<"organizations">,
  sourceType: string,
  sourceId: string
): Promise<Array<Doc<"pendingAccountingEvents">>> {
  return await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId))
    .take(21);
}

/** One original event, REVERSED by exactly one POSTED mirrored JOURNAL_REVERSAL. Returns the problems found. */
async function reversedProblems(
  ctx: Ctx,
  orgId: Id<"organizations">,
  family: Array<Doc<"accountingEvents">>,
  eventType: "CUSTODY_FEE_PAID" | "CUSTODY_CASH_ISSUED",
  forward: string[],
  what: string,
  expectedPeriodId: Id<"accountingPeriods"> | undefined
): Promise<string[]> {
  const problems: string[] = [];
  const originals = family.filter((e) => e.eventType === eventType);
  const reversals = family.filter((e) => e.eventType === "JOURNAL_REVERSAL");
  if (family.length !== 2 || originals.length !== 1 || reversals.length !== 1) {
    return [`${what}: expected exactly one ${eventType} and one JOURNAL_REVERSAL, found ${family.map((e) => `${e.eventType}/${e.status}`).join(", ") || "none"}`];
  }
  const [original] = originals;
  const [reversal] = reversals;
  if (original.status !== "REVERSED") problems.push(`${what}: original event is ${original.status}, not REVERSED`);
  if (original.reversedByEventId !== reversal._id) problems.push(`${what}: original is not linked to the reversal`);
  if (reversal.status !== "POSTED" || reversal.reversalOfEventId !== original._id) {
    problems.push(`${what}: reversal is ${reversal.status} / reverses ${String(reversal.reversalOfEventId)}, not a POSTED reversal of the original`);
  }
  const originalShape = await journalShape(ctx, orgId, original.journalEntryId);
  if (JSON.stringify(originalShape) !== JSON.stringify(forward)) problems.push(`${what}: original journal is ${JSON.stringify(originalShape)}, expected ${JSON.stringify(forward)}`);
  const reversalShape = await journalShape(ctx, orgId, reversal.journalEntryId);
  if (JSON.stringify(reversalShape) !== JSON.stringify(mirror(forward))) problems.push(`${what}: reversal journal is ${JSON.stringify(reversalShape)}, not the mirror`);
  if (reversal.journalEntryId !== undefined) {
    const journal = await ctx.db.get(reversal.journalEntryId);
    if (journal === null || journal.status !== "POSTED") problems.push(`${what}: reversal journal is not POSTED`);
    else if (expectedPeriodId !== undefined && journal.periodId !== expectedPeriodId) problems.push(`${what}: reversal journal is in another period than the open one`);
  }
  return problems;
}

// ─── Actor ───────────────────────────────────────────────────────────────────

async function requireActor(ctx: Ctx, orgId: Id<"organizations">, actorId: Id<"users">) {
  const user = await ctx.db.get(actorId);
  if (user === null) return refuse("SCRUM-987: the actor does not exist.");
  const org = await ctx.db.get(orgId);
  if (org === null) return refuse("SCRUM-987: the organization does not exist.");
  if (org.suspended) return refuse("SCRUM-987: the organization is suspended.");
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", actorId))
    .unique();
  if (membership === null) return refuse("SCRUM-987: the actor is not a member of this organization.");
  if (membership.offboardingStatus) return refuse("SCRUM-987: the actor's membership is no longer active.");
  const role = await ctx.db.get(membership.roleId);
  if (role === null) return refuse("SCRUM-987: the actor's role is missing.");
  // The permissions the bypassed handlers require, judged on the loaded role.
  const must: Permission[] = [PERMISSIONS.CREATE_FINANCE_APPLICATION, PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT];
  if (!isSystemOwnerRole(role)) {
    const missing = must.filter((p) => !role.permissions.includes(p));
    if (missing.length > 0) return refuse(`SCRUM-987: the actor lacks ${missing.join(", ")}.`);
  }
  assertMayUndoReconciliation({ role }, "Removing a reconciled cost (SCRUM-987)");
  assertMayPostCustody({ role }, "Removing a cost charged to an employee's custody (SCRUM-987)");
  return { user, role };
}

// ─── Per-target proof ────────────────────────────────────────────────────────

async function inspectTarget(
  ctx: Ctx,
  orgId: Id<"organizations">,
  actorId: Id<"users">,
  target: CorrectionTarget,
  expectedPeriodId: Id<"accountingPeriods"> | undefined
): Promise<TargetInspection> {
  const fail = (problems: string[]): TargetInspection => ({ label: target.label, state: "INVALID", problems, appliedProblems: [] });
  const applicationId = ctx.db.normalizeId("financeApplications", target.applicationId);
  const feeId = ctx.db.normalizeId("financeDealFees", target.feeId);
  const custodyId = ctx.db.normalizeId("financeDealCustody", target.custodyId);
  const entryId = ctx.db.normalizeId("financeDealCustodyEntries", target.entryId);
  if (!applicationId || !feeId || !custodyId || !entryId) {
    return fail(["an allow-listed id is not a well-formed id of its table (typo?)"]);
  }
  const [app, fee, custody, entry] = await Promise.all([
    ctx.db.get(applicationId), ctx.db.get(feeId), ctx.db.get(custodyId), ctx.db.get(entryId),
  ]);
  if (!app || app.orgId !== orgId) return fail(["the application is missing or belongs to another organization"]);
  if (!fee || fee.orgId !== orgId) return fail(["the fee is missing or belongs to another organization"]);
  if (!custody || custody.orgId !== orgId) return fail(["the custody record is missing or belongs to another organization"]);
  if (!entry || entry.orgId !== orgId) return fail(["the custody entry is missing or belongs to another organization"]);

  const amount = target.amountMinor;
  const [entries, liveFees, feeEvents, entryEvents, custodyEvents, feePending, entryPending, custodyPending] = await Promise.all([
    custodyEntriesFor(ctx, custodyId, "proving the SCRUM-987 correction"),
    loadActiveFees(ctx, applicationId),
    eventsFor(ctx, orgId, "financeDealFees", feeId),
    eventsFor(ctx, orgId, "financeDealCustodyEntries", entryId),
    eventsFor(ctx, orgId, "financeDealCustody", custodyId),
    pendingFor(ctx, orgId, "financeDealFees", feeId),
    pendingFor(ctx, orgId, "financeDealCustodyEntries", entryId),
    pendingFor(ctx, orgId, "financeDealCustody", custodyId),
  ]);

  // Facts true BEFORE and AFTER the correction.
  const common: string[] = [];
  if (app.status !== "CANCELLED") common.push(`application status is ${app.status}, not CANCELLED`);
  if (fee.applicationId !== applicationId) common.push("fee is on another deal");
  if (custody.applicationId !== applicationId) common.push("custody is on another deal");
  if (entry.custodyId !== custodyId) common.push("entry is on another custody record");
  if (fee.custodyId !== custodyId) common.push("fee.custodyId is not the custody record");
  if (fee.actualAmountMinor !== amount) common.push(`fee actual is ${String(fee.actualAmountMinor)}, expected ${amount}`);
  if (fee.deductedFromSettlement) common.push("fee is deducted from settlement");
  if (fee.directPayment !== undefined) common.push("fee carries a direct payment");
  if (entry.kind !== "ISSUED" || entry.amountMinor !== amount) common.push(`entry is ${entry.kind} ${entry.amountMinor}, expected ISSUED ${amount}`);
  if (custody.ledgerPosting !== "CANONICAL") common.push("custody is not CANONICAL");
  if (custody.status !== "RECONCILED") common.push(`custody status is ${custody.status}, not RECONCILED`);
  if (custody.returnedMinor !== 0 || custody.reimbursedMinor !== 0) common.push("custody has returned/reimbursed money");
  if ((custody.payableTargetMinor ?? 0) !== 0 || (custody.payableReclassIssued ?? []).length > 0) common.push("custody carries a payable reclassification");
  if (custody.writeOffPosted !== undefined) common.push("custody carries a write-off");
  try {
    assertNotCustodian(custody, actorId, "The SCRUM-987 correction");
  } catch {
    common.push("the actor is the custodian of this record");
  }
  if (target.finalized) {
    if (app.finalizedSaleId === undefined) common.push("deal was expected to be finalized");
    else {
      const sale = await ctx.db.get(app.finalizedSaleId);
      if (!sale || sale.orgId !== orgId || sale.status !== "CANCELLED") common.push("the finalized sale is not CANCELLED");
    }
    const active = await ctx.db
      .query("dealUnwinds")
      .withIndex("by_org_application_status", (q) => q.eq("orgId", orgId).eq("applicationId", applicationId).eq("status", "ACTIVE"))
      .take(1);
    if (active.length > 0) common.push("an ACTIVE unwind exists for this deal");
  } else if (app.finalizedSaleId !== undefined) common.push("deal was not expected to be finalized");
  // The non-terminal outbox rows would post or reverse behind our back.
  for (const row of [...feePending, ...entryPending, ...custodyPending]) {
    if (row.status !== "POSTED") common.push(`outbox row ${row._id} (${row.kind}) is ${row.status}`);
  }
  if (custodyEvents.length > 0) common.push(`custody record carries accounting events (${custodyEvents.map((e) => e.eventType).join(", ")})`);

  // ORIGINAL: nothing done yet.
  const original = [...common];
  if (fee.voidedAt !== undefined) original.push("fee is already voided");
  const posted = fee.custodyPosted;
  if (posted === undefined || posted.custodyId !== custodyId || posted.amountMinor !== amount || !Number.isSafeInteger(posted.version)) {
    original.push("fee.custodyPosted does not match the custody/amount");
  }
  if (custody.issuedMinor !== amount) original.push(`custody issued is ${custody.issuedMinor}, expected ${amount}`);
  if (entries.length !== 1 || entries[0]._id !== entryId) original.push(`custody log has ${entries.length} entries, expected exactly the ISSUED entry`);
  const liveOnCustody = liveFees.filter((f) => f.custodyId === custodyId || f.custodyPosted?.custodyId === custodyId);
  if (liveOnCustody.length !== 1 || liveOnCustody[0]._id !== feeId) original.push("custody does not have exactly one live fee (this one)");
  if (posted !== undefined) {
    const originalFee = feeEvents.filter((e) => e.eventType === "CUSTODY_FEE_PAID");
    if (feeEvents.length !== 1 || originalFee.length !== 1 || originalFee[0].status !== "POSTED" || originalFee[0].eventVersion !== posted.version) {
      original.push(`fee source events are ${feeEvents.map((e) => `${e.eventType}/v${e.eventVersion}/${e.status}`).join(", ") || "none"}, expected one POSTED CUSTODY_FEE_PAID v${posted.version}`);
    } else {
      const shape = await journalShape(ctx, orgId, originalFee[0].journalEntryId);
      if (JSON.stringify(shape) !== JSON.stringify(forwardFeeShape(amount))) original.push(`fee journal is ${JSON.stringify(shape)}`);
    }
  }
  if (entryEvents.length !== 1 || entryEvents[0].eventType !== "CUSTODY_CASH_ISSUED" || entryEvents[0].status !== "POSTED") {
    original.push(`entry source events are ${entryEvents.map((e) => `${e.eventType}/${e.status}`).join(", ") || "none"}, expected one POSTED CUSTODY_CASH_ISSUED`);
  } else {
    const shape = await journalShape(ctx, orgId, entryEvents[0].journalEntryId);
    if (JSON.stringify(shape) !== JSON.stringify(forwardIssueShape(amount))) original.push(`issue journal is ${JSON.stringify(shape)}`);
  }

  const ids = { applicationId, feeId, custodyId, entryId };
  if (original.length === 0) return { label: target.label, state: "ORIGINAL", problems: [], appliedProblems: [], ids };

  // APPLIED: everything done, proven on the rows AND the ledger.
  const applied = [...common];
  if (fee.voidedAt === undefined) applied.push("fee is not voided");
  if (!(fee.voidReason ?? "").includes(SCRUM987_REASON)) applied.push("fee void reason does not carry the ruling");
  if (fee.custodyPosted !== undefined) applied.push("fee still carries custodyPosted");
  if (custody.issuedMinor !== 0) applied.push(`custody issued is ${custody.issuedMinor}, expected 0 net`);
  const reversals = entries.filter((e) => e.kind === "REVERSAL");
  if (entries.length !== 2 || reversals.length !== 1 || reversals[0].reversesEntryId !== entryId || reversals[0].amountMinor !== amount ||
      !(reversals[0].note ?? "").includes(SCRUM987_REASON)) {
    applied.push("custody log is not exactly [ISSUED, its REVERSAL carrying the ruling]");
  }
  applied.push(...(await reversedProblems(ctx, orgId, feeEvents, "CUSTODY_FEE_PAID", forwardFeeShape(amount), "fee posting", expectedPeriodId)));
  applied.push(...(await reversedProblems(ctx, orgId, entryEvents, "CUSTODY_CASH_ISSUED", forwardIssueShape(amount), "custody issuance", expectedPeriodId)));
  if (applied.length === 0) return { label: target.label, state: "APPLIED", problems: [], appliedProblems: [], ids };
  return { label: target.label, state: "INVALID", problems: original, appliedProblems: applied, ids };
}

// ─── Planner (reads only) ────────────────────────────────────────────────────

export async function planCorrection(
  ctx: Ctx,
  args: {
    orgId: string;
    actorId: Id<"users">;
    targets: ReadonlyArray<CorrectionTarget>;
    now: number;
    expectedUtcMonth: string;
  }
): Promise<CorrectionPlan> {
  const orgId = ctx.db.normalizeId("organizations", args.orgId);
  if (orgId === null) return refuse("SCRUM-987: the allow-listed organization id is not a well-formed organization id.");
  const org = await ctx.db.get(orgId);
  if (org === null) return refuse("SCRUM-987: the allow-listed organization does not exist in this deployment.");
  const { role } = await requireActor(ctx, orgId, args.actorId);

  const targets: TargetInspection[] = [];
  for (const target of args.targets) targets.push(await inspectTarget(ctx, orgId, args.actorId, target, undefined));

  const invalid = targets.filter((t) => t.state === "INVALID");
  const original = targets.filter((t) => t.state === "ORIGINAL");
  const applied = targets.filter((t) => t.state === "APPLIED");
  if (invalid.length > 0 || (original.length > 0 && applied.length > 0)) {
    return refuse("SCRUM-987: the targets are not all in the expected original state, or the correction is partially applied. Nothing was changed.", targets);
  }
  if (original.length === 0) return { kind: "ALREADY_APPLIED", targets };

  if (new Date(args.now).toISOString().slice(0, 7) !== args.expectedUtcMonth) {
    return refuse(`SCRUM-987: today is not in ${args.expectedUtcMonth}; the correction is dated into that open period only. Nothing was changed.`);
  }
  const period = await getOpenPeriodForDate(ctx, orgId, args.now);
  if (period === null) return refuse("SCRUM-987: no OPEN accounting period covers today. A reversal would be deferred, not posted. Nothing was changed.");
  return { kind: "READY", periodId: period._id, now: args.now, actor: { userId: args.actorId, roleName: role.name }, targets };
}

// ─── Executor ────────────────────────────────────────────────────────────────

export interface CorrectionResult {
  alreadyApplied: boolean;
  targets: Array<{ label: string; feeId: string; entryId: string; reversalEntryId?: string; amountMinor: number }>;
}

/** Whole-document equality as the database stores it — key order is irrelevant. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner
  );
}

export async function applyCorrection(
  ctx: MutationCtx,
  args: {
    orgId: string;
    actorId: Id<"users">;
    targets: ReadonlyArray<CorrectionTarget>;
    reason: string;
    now: number;
    expectedUtcMonth: string;
  }
): Promise<CorrectionResult> {
  const plan = await planCorrection(ctx, args);
  if (plan.kind === "ALREADY_APPLIED") {
    return { alreadyApplied: true, targets: [] };
  }
  const orgId = ctx.db.normalizeId("organizations", args.orgId)!;
  const actor = (await ctx.db.get(args.actorId))!;
  const reason = args.reason.trim();
  assertFeeTextWithinCap(reason, MAX_FEE_VOID_REASON_CHARS, "The reason", "removing this cost");

  const results: CorrectionResult["targets"] = [];
  const before = new Map<string, { app: string; custodySignoff: string; fee: Doc<"financeDealFees"> }>();
  for (const inspected of plan.targets) {
    const ids = inspected.ids!;
    const [app, custody, fee] = await Promise.all([ctx.db.get(ids.applicationId), ctx.db.get(ids.custodyId), ctx.db.get(ids.feeId)]);
    before.set(inspected.label, {
      app: stable(app),
      custodySignoff: stable({
        status: custody!.status, reconciledAt: custody!.reconciledAt, reconciledBy: custody!.reconciledBy,
        reconciliationNotes: custody!.reconciliationNotes,
      }),
      fee: fee!,
    });
  }

  for (let i = 0; i < plan.targets.length; i += 1) {
    const inspected = plan.targets[i];
    const target = args.targets[i];
    const ids = inspected.ids!;
    const fee = before.get(inspected.label)!.fee;

    // (a) The fee void FIRST (F2) — same writes and same posting call as
    // voidDealFeeHandler, WITHOUT recomputeAfterSettlementInputChange (F4):
    // the deal's economics are frozen and nothing about them changes.
    const voidPatch = { voidedAt: args.now, voidedBy: args.actorId, voidReason: reason, updatedAt: args.now };
    assertFeeDocWithinBytes(feeAfterPatch(fee, voidPatch), "removing this cost");
    await ctx.db.patch(ids.feeId, voidPatch);
    await syncCustodyFeePosting(ctx, ids.feeId, args.actorId, `Handover cost removed: ${reason}`);

    // (b) The issuance reversal — the REVERSAL branch of
    // recordCustodyMovementHandler, minus the guards listed in the header.
    await assertReversalAllowed(ctx, orgId, ids.custodyId, ids.entryId, target.amountMinor);
    const reversalEntryId = await ctx.db.insert("financeDealCustodyEntries", {
      orgId,
      custodyId: ids.custodyId,
      kind: "REVERSAL",
      reversesEntryId: ids.entryId,
      amountMinor: target.amountMinor,
      note: reason,
      occurredAt: args.now,
      recordedBy: args.actorId,
      recordedAt: args.now,
    });
    await recomputeCustodyTotals(ctx, ids.custodyId);
    await hookCustodyCashReversed(ctx, {
      orgId,
      entryId: ids.entryId,
      kind: "ISSUED",
      reversalEntryId,
      reason,
      actorId: args.actorId,
      reversalDate: args.now,
    });
    await syncCustodyPayable(ctx, ids.custodyId, args.actorId, args.now, [
      { must: "OFF_BOOKS", idempotencyKey: custodyEntryPostKey(ids.entryId) },
    ]);
    await writeAuditLog(ctx, actor, {
      action: "SCRUM-987_CANCELLED_DEAL_REVERSAL",
      targetTable: "financeApplications",
      targetId: ids.applicationId,
      orgId,
      before: { feeId: ids.feeId, custodyId: ids.custodyId, entryId: ids.entryId, amountMinor: target.amountMinor },
      after: { reversalEntryId, reason },
    });
    results.push({
      label: inspected.label, feeId: ids.feeId, entryId: ids.entryId, reversalEntryId, amountMinor: target.amountMinor,
    });
  }

  // F1 — read the ledger back. Any mismatch throws and the whole call rolls back.
  for (let i = 0; i < args.targets.length; i += 1) {
    const target = args.targets[i];
    const after = await inspectTarget(ctx, orgId, args.actorId, target, plan.periodId);
    if (after.state !== "APPLIED") {
      return refuse(`SCRUM-987: read-back failed for ${target.label}; the books do not show the reversal. Rolled back.`, after);
    }
    const ids = after.ids!;
    const snapshot = before.get(target.label)!;
    const [app, custody] = await Promise.all([ctx.db.get(ids.applicationId), ctx.db.get(ids.custodyId)]);
    if (stable(app) !== snapshot.app) return refuse(`SCRUM-987: the application document of ${target.label} changed (economics must not). Rolled back.`);
    const signoff = stable({
      status: custody!.status, reconciledAt: custody!.reconciledAt, reconciledBy: custody!.reconciledBy,
      reconciliationNotes: custody!.reconciliationNotes,
    });
    if (signoff !== snapshot.custodySignoff) return refuse(`SCRUM-987: the custody sign-off of ${target.label} changed. Rolled back.`);
  }
  return { alreadyApplied: false, targets: results };
}

// ─── Thin internal doors ─────────────────────────────────────────────────────

/** Read-only: proves every target and reports what `applyScrum987` would do. Cannot write. */
export const planScrum987 = internalQuery({
  args: { actorId: v.id("users") },
  returns: v.any(),
  handler: async (ctx, { actorId }) => {
    const plan = await planCorrection(ctx, {
      orgId: SCRUM987_ORG_ID, actorId, targets: SCRUM987_TARGETS, now: Date.now(), expectedUtcMonth: SCRUM987_EXPECTED_UTC_MONTH,
    });
    return JSON.parse(JSON.stringify(plan)) as unknown;
  },
});

/**
 * `rehearse` performs EVERY write and read-back, then throws a ConvexError
 * carrying the result so the transaction rolls back (F10). `apply` commits.
 */
export const applyScrum987 = internalMutation({
  args: {
    actorId: v.id("users"),
    confirm: v.literal("SCRUM-987"),
    mode: v.union(v.literal("rehearse"), v.literal("apply")),
  },
  returns: v.any(),
  handler: async (ctx, { actorId, mode }) => {
    const result = await applyCorrection(ctx, {
      orgId: SCRUM987_ORG_ID, actorId, targets: SCRUM987_TARGETS, reason: SCRUM987_REASON,
      now: Date.now(), expectedUtcMonth: SCRUM987_EXPECTED_UTC_MONTH,
    });
    if (mode === "rehearse") {
      throw new ConvexError({ code: "SCRUM987_REHEARSAL_ROLLED_BACK", result: JSON.parse(JSON.stringify(result)) });
    }
    return result;
  },
});
