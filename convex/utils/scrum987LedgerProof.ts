// SCRUM-987 slice 1 — ledger readers and the actor proof used by the correction. Split from
// scrum987CancelledDealReversal.ts (file-size guardrail); read-only, no logic changed.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SYSTEM_KEYS } from "./defaultChart";
import { PERMISSIONS, type Permission } from "./permissions";
import { AppErrorCode } from "./errors";
import type { CorrectionTarget } from "./scrum987Targets";
import { requireActorPermission, requireOrgMember } from "./tenancy";
import { assertMayPostCustody, assertMayUndoReconciliation } from "./financeDealCosts/dealCostGuards";
interface TargetIds {
  applicationId: Id<"financeApplications">;
  feeId: Id<"financeDealFees">;
  custodyId: Id<"financeDealCustody">;
  entryId: Id<"financeDealCustodyEntries">;
}

interface InspectionBase {
  label: string;
  /** The allow-listed target itself, so apply reads it from the plan instead of a parallel array. */
  target: CorrectionTarget;
  /** Why the ORIGINAL state does not hold (and, for INVALID, why APPLIED does not either). */
  problems: string[];
  appliedProblems: string[];
}

/** ORIGINAL and APPLIED are only ever reported with the resolved ids; INVALID may lack them (a malformed id). */
export type TargetInspection =
  | (InspectionBase & { state: "ORIGINAL"; ids: TargetIds })
  | (InspectionBase & { state: "APPLIED"; ids: TargetIds })
  | (InspectionBase & { state: "INVALID"; ids?: TargetIds });
export type OriginalInspection = Extract<TargetInspection, { state: "ORIGINAL" }>;
export type AppliedInspection = Extract<TargetInspection, { state: "APPLIED" }>;export type Ctx = QueryCtx | MutationCtx;

export const refuse = (message: string, detail?: unknown): never => {
  throw new ConvexError(detail === undefined ? message : { message, detail: JSON.parse(JSON.stringify(detail)) });
};

// ─── Ledger readers ──────────────────────────────────────────────────────────

/** Debit/credit lines of one journal, keyed by the account's system key; sorted and stringified for comparison. */
export async function journalShape(
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

export const forwardFeeShape = (amountMinor: number): string[] =>
  [
    `${SYSTEM_KEYS.FINANCE_COMPANY_COMMISSION_EXPENSE}|D${amountMinor}|C0`,
    `${SYSTEM_KEYS.DEAL_CUSTODY_CLEARING}|D0|C${amountMinor}`,
  ].sort();
export const forwardIssueShape = (amountMinor: number): string[] =>
  [
    `${SYSTEM_KEYS.DEAL_CUSTODY_CLEARING}|D${amountMinor}|C0`,
    `${SYSTEM_KEYS.CASH_ON_HAND}|D0|C${amountMinor}`,
  ].sort();
/** The mirror of a forward shape: every debit becomes the credit of the same account. */
const mirror =(shape: string[]): string[] =>
  shape
    .map((line) => {
      const [key, d, c] = line.split("|");
      return `${key}|D${c.slice(1)}|C${d.slice(1)}`;
    })
    .sort();

export async function eventsFor(
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

export async function pendingFor(
  ctx: Ctx,
  orgId: Id<"organizations">,
  sourceType: string,
  sourceId: string
): Promise<Array<Doc<"pendingAccountingEvents">>> {
  const rows = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId))
    .take(21);
  if (rows.length > 20) refuse(`Source ${sourceType}/${sourceId} carries more than 20 pending accounting events; the correction will not decide on a prefix.`);
  return rows;
}

/** One original event, REVERSED by exactly one POSTED mirrored JOURNAL_REVERSAL. Returns the problems found. */
export async function reversedProblems(
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

export async function requireActor(ctx: Ctx, org: Doc<"organizations">, actorId: Id<"users">) {
  const orgId = org._id;
  const user = await ctx.db.get(actorId);
  if (user === null) return refuse("SCRUM-987: the actor does not exist.");
  // requireTenantAuth refuses a disabled account (utils/tenancy.ts); the same here.
  if (user.disabled) return refuse("SCRUM-987: the actor's account is disabled.");
  if (org.suspended) return refuse("SCRUM-987: the organization is suspended.");
  // Membership and offboarding come from the shared tenancy guard (a missing or offboarding
  // member raises the same refusal there, which is no weaker than the two separate refusals).
  const membership = await requireOrgMember(
    ctx, orgId, actorId, AppErrorCode.FORBIDDEN, "SCRUM-987: the actor is not a member of this organization."
  );
  // A membership carrying an impersonation grant is a super admin's temporary session
  // (utils/tenancy.ts); such a session must never be the named actor of a ledger correction.
  if (membership.impersonationGrantId !== undefined) {
    return refuse("SCRUM-987: an impersonation membership cannot be the actor of a ledger correction.");
  }
  const role = await ctx.db.get(membership.roleId);
  if (role === null) return refuse("SCRUM-987: the actor's role is missing.");
  // roles.ts treats a soft-deleted role as gone, and a role must belong to this org.
  if (role.isDeleted || role.orgId !== orgId) return refuse("SCRUM-987: the actor's role is deleted or belongs to another organization.");
  // The permissions the bypassed handlers require; the shared guard applies the owner bypass.
  const must: Permission[] = [PERMISSIONS.CREATE_FINANCE_APPLICATION, PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT];
  for (const permission of must) {
    await requireActorPermission(ctx, orgId, actorId, permission, `SCRUM-987: the actor lacks ${permission}.`);
  }
  assertMayUndoReconciliation({ role }, "Removing a reconciled cost (SCRUM-987)");
  assertMayPostCustody({ role }, "Removing a cost charged to an employee's custody (SCRUM-987)");
  return { user, role };
}
