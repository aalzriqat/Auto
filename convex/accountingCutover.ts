import { openingRecoveryBasis, openingPayableBasis } from "./utils/openingSupplierBasis";
import { resolveOpeningCommissionBasis } from "./utils/openingCommissionBasis";
import { resolveOpeningSettlementBasis, createOpeningSettlementReader } from "./utils/openingSettlementBasis";
import { isRemainingOpeningKind, openingAccountAllowsFamily, type RemainingOpeningKind, type OpeningPolicy } from "./utils/openingAccountPolicy";
/**
 * GL Phase 17 — legacy money migration + accountant sign-off.
 *
 * Three distinct capabilities:
 *  - draftOpeningBalance / approveOpeningBalance / rejectOpeningBalanceDraft:
 *    a one-time, direct-lines journal entry seeding an org's starting GL
 *    position (mirrors financialAudit.ts's manual-journal posting mechanics
 *    — arbitrary caller-specified lines, not a fixed payload-driven posting
 *    rule), gated by the same two-person segregation of duties as a manual
 *    journal: the approver must be a different MANAGE_FINANCE user from
 *    whoever drafted it, and it can still only ever post once.
 *  - signOffCutover / listSignOffs: an accountant's point-in-time attestation
 *    that the legacy-to-GL cutover has been reviewed, carrying a snapshot of
 *    the numbers reviewed (not a live computation, so the sign-off stays
 *    meaningful after later activity changes current totals). Requires zero
 *    unmigrated legacy transactions, a balanced trial balance in every
 *    currency, and a signer distinct from whoever approved the opening
 *    balance — a sign-off can't paper over an incomplete migration or be
 *    self-certified by the same person who seeded the starting position.
 *  - compareLegacyToGL: a parallel-reporting query so a human can verify
 *    nothing was lost or double-counted for a given period.
 */
import { v, ConvexError } from "convex/values";
import { query, QueryCtx, MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { AppErrorCode, throwAppError } from "./utils/errors";
import { isSystemOwnerRole, PERMISSIONS } from "./utils/permissions";
import { getOpenPeriodForDate } from "./accountingPeriods";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { validateManualJournalLines, auditLog, type ManualJournalLine } from "./financialAudit";
import { toMinorUnits, denominationOf } from "./utils/money";
import { Doc, Id } from "./_generated/dataModel";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { materializeOpeningAllocations, openingPolicyForAccount, prepareOpeningAllocations } from "./accounting/openingAllocations";
import type { OpeningAllocationPlan } from "./accounting/openingAllocations";
import { isOpeningPartnerAccount } from "./accounting/openingPartnerAllocations";
import { resolveSystemAccount } from "./chartOfAccounts";
import { openingAllocationValidator } from "./utils/openingAllocationValidators";
import { resolvePrepaidScheduleSource } from "./utils/openingPrepaidBasis";
import { assertOpeningVehicleBasis, listOpeningStockEvidence } from "./utils/openingVehicleBasis";
import { orgResetState } from "./utils/orgResetGeneration";

/**
 * SCRUM-54: an opening line on the BANK_ACCOUNT control account must name the
 * physical bank it seeds — `getBookBalance` withholds any balance that has a
 * control line without one. The identity is supplied by the user, never
 * defaulted or inferred from amount/date, and no other account may carry one.
 *
 * The bank must be a live (not deleted, active) bank of this organization in
 * the currency the opening is denominated in. Callers invoke this before their
 * first write, and the shared poster repeats it as the chokepoint so a bank
 * removed between draft and approval, or a draft saved before this field
 * existed, cannot post an unattributed bank line.
 */
async function assertOpeningBankIdentities(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  lines: ReadonlyArray<{ accountId: Id<"chartOfAccounts">; bankAccountId?: Id<"bankAccounts"> }>,
  currency: string
): Promise<void> {
  for (const line of lines) {
    const account = await requireOwnedRow(ctx, orgId, "chartOfAccounts", line.accountId, "Opening account not found in this organization.");
    if (account.systemKey !== SYSTEM_KEYS.BANK_ACCOUNT) {
      if (line.bankAccountId) {
        throw new ConvexError("Only a bank account line can name a bank account.");
      }
      continue;
    }
    if (!line.bankAccountId) {
      throw new ConvexError("Select a bank account for every bank opening-balance line.");
    }
    const bank = await requireOwnedRow(ctx, orgId, "bankAccounts", line.bankAccountId, "The selected bank account was not found in this organization.");
    if (bank.isDeleted) {
      throw new ConvexError("The selected bank account was not found in this organization.");
    }
    if (!bank.isActive) {
      throw new ConvexError("The selected bank account is inactive.");
    }
    if (bank.currency !== currency) {
      throw new ConvexError(
        `The selected bank account is denominated in ${bank.currency}, but this opening balance is in ${currency}.`
      );
    }
  }
}

/**
 * One refusal, worded for the two things that are actually different to the
 * person reading it: nothing was ever recorded, versus something was recorded
 * that AutoFlow will not price.
 *
 * Both are dead ends only if rejection is unavailable, and it is not —
 * `rejectOpeningBalanceDraft` stays open on every path, so the org re-submits
 * in a supported currency rather than being stuck.
 */
/**
 * Binds already-converted minor units to the denomination they were converted
 * under, and refuses if the organization has moved on since.
 *
 * The client turns typed decimals into integers using the currency it can see
 * at that moment (`OpeningBalanceCard` calls `toMinorUnits(amount, currency)`).
 * The server then labels those integers with whatever the org denomination is
 * when the mutation runs. Between those two moments the currency can change —
 * and neither `denominationOf` nor any other validity check can notice, because
 * both codes are perfectly valid on their own. The integers are simply computed
 * under one scale and stamped with another: 1,000.000 JOD converted at scale 3
 * is 1,000,000 minor units, and posted as USD at scale 2 that reads 10,000.00.
 *
 * So the check is an EQUALITY against what the caller actually converted under,
 * not a validity test. Callers pass the exact canonical code they used.
 *
 * No normalization, deliberately: `"jod"` and `"JD"` fail the equality against
 * the canonical `"JOD"` rather than being uppercased or aliased into it. A
 * guard that rescues a value the rest of the system would reject is how the
 * previous round's defect worked.
 *
 * Every caller must invoke this BEFORE its first write. A refusal that lands
 * after the draft insert is still correct about the money — the mutation rolls
 * back — but `postOpeningBalanceDirect` would have created a PENDING_APPROVAL
 * row on the refusal path in any world where the two stopped sharing a
 * transaction, and `hasOpeningBalanceCommitment` reads such a row as a
 * commitment that blocks the org from opening its books at all.
 */
async function assertDenominationUnchanged(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  expectedCurrency: string
): Promise<void> {
  const current = await getOrgCurrency(ctx, orgId);
  const vouched = denominationOf(current);
  if (vouched === null) {
    throw new ConvexError(unvouchableDenominationMessage(current));
  }
  if (expectedCurrency !== vouched.code) {
    throw new ConvexError(
      `These amounts were entered in ${expectedCurrency}, but this organization's currency is now ${vouched.code}. The figures were converted using ${expectedCurrency}'s decimal places, so posting them as ${vouched.code} would misstate every one of them. Nothing has been saved — reopen the form and enter the opening balance again.`
    );
  }
}

function unvouchableDenominationMessage(recorded: string | undefined): string {
  if (recorded === undefined) {
    return "This opening balance was drafted before its currency was recorded, so the amounts cannot be safely posted. Reject it and submit it again.";
  }
  return `This opening balance is denominated "${recorded}", which is not a currency AutoFlow can price — the minor-unit scale would have to be guessed, and a wrong guess misstates the organization's entire starting position by a factor of ten. Reject it and submit it again in a supported currency.`;
}

/**
 * A deliberately minimal, sign-off-scoped total — not a substitute for
 * accountingReports.trialBalance (which is per-currency and drives the real
 * trial balance report). Convex query/mutation handlers aren't plain
 * callable functions, so this is a small self-contained sum rather than
 * cross-calling that query's handler.
 *
 * Bucketed by currency rather than a single mixed total: an org's currency
 * can change over time (GL Phase 14), leaving historical journal lines in
 * more than one currency, and summing minor units across currencies would
 * produce a number with no meaning (e.g. JOD fils + USD cents).
 */
async function sumAllPostedJournalLinesByCurrency(
  ctx: QueryCtx,
  orgId: Id<"organizations">
): Promise<Array<{ currency: string; totalDebitsMinor: number; totalCreditsMinor: number; isBalanced: boolean }>> {
  // Include REVERSED entries too — same reasoning as accountingReports.ts's
  // getPostedLines: a reversed entry's own lines are real historical
  // postings that a separately-posted reversal entry cancels out, not lines
  // that stopped existing. Excluding them here would keep a reversal's
  // inverted lines while dropping the original, skewing this sign-off
  // snapshot's totals away from a true net position.
  const entries = (
    await ctx.db
      .query("journalEntries")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect()
  ).filter((e) => e.status === "POSTED" || e.status === "REVERSED");

  const byCurrency = new Map<string, { totalDebitsMinor: number; totalCreditsMinor: number }>();
  for (const entry of entries) {
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
      .collect();
    for (const line of lines) {
      const bucket = byCurrency.get(line.currency) ?? { totalDebitsMinor: 0, totalCreditsMinor: 0 };
      bucket.totalDebitsMinor += line.debitMinor;
      bucket.totalCreditsMinor += line.creditMinor;
      byCurrency.set(line.currency, bucket);
    }
  }
  return Array.from(byCurrency.entries()).map(([currency, totals]) => ({
    currency,
    ...totals,
    isBalanced: totals.totalDebitsMinor === totals.totalCreditsMinor,
  }));
}

/**
 * The first POSTED OPENING_BALANCE journal of the org, in `by_org` index order.
 *
 * `by_org` is every journal the org has ever written, so this walks it lazily
 * and stops at the first match rather than collecting the range.
 */
async function findPostedOpeningBalanceJournal(
  ctx: QueryCtx,
  orgId: Id<"organizations">
): Promise<Doc<"journalEntries"> | null> {
  // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
  for await (const entry of ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId))) {
    if (entry.category === "OPENING_BALANCE" && entry.status === "POSTED") return entry;
  }
  return null;
}

async function hasOpeningBalanceCommitment(ctx: QueryCtx, orgId: Id<"organizations">): Promise<boolean> {
  // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
  const postedJournal = await findPostedOpeningBalanceJournal(ctx, orgId);
  if (postedJournal) return true;
  const pendingDraft = await ctx.db
    .query("openingBalanceDrafts")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING_APPROVAL"))
    .first();
  return pendingDraft !== null;
}

/**
 * True once the org has ANY POSTED or REVERSED journal entry. Status, not period
 * state, decides: a REVERSED entry is still history, and a later period being
 * open says nothing about earlier postings. DRAFT/VALIDATED never count.
 *
 * Deliberately no category filter: an ordinary new opening after the reversal of
 * an old one is refused too. No correction path exists yet (SCRUM-850); the
 * refusal only tells the finance owner a cutover correction needs review.
 */
async function hasPostedLedgerActivity(ctx: QueryCtx, orgId: Id<"organizations">): Promise<boolean> {
  for (const status of ["POSTED", "REVERSED"] as const) {
    const entry = await ctx.db
      .query("journalEntries")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
      .first();
    if (entry) return true;
  }
  return false;
}

/**
 * The English text of the coded refusal; lib/i18n/domains/common.ts carries the
 * same text under `ServerError_OPENING_BALANCE_AFTER_LEDGER_ACTIVITY`.
 */
export const POSTED_LEDGER_ACTIVITY_MESSAGE =
  "This organization already has posted ledger activity, so an opening balance cannot be posted. The cutover needs finance-owner review.";

function refuseOpeningAfterLedgerActivity(): never {
  throwAppError(AppErrorCode.OPENING_BALANCE_AFTER_LEDGER_ACTIVITY, POSTED_LEDGER_ACTIVITY_MESSAGE);
}

export const draftOpeningBalance = mutation({
  args: {
    orgId: v.id("organizations"),
    lines: v.array(v.object({
      accountId: v.id("chartOfAccounts"),
      debitMinor: v.number(),
      creditMinor: v.number(),
      description: v.optional(v.string()),
      bankAccountId: v.optional(v.id("bankAccounts")),
    })),
    asOfDate: v.number(),
    memo: v.optional(v.string()),
    // The exact canonical code the caller converted the entered decimals under.
    // See assertDenominationUnchanged — this binds the integers to a scale.
    expectedCurrency: v.string(),
    allocations: v.optional(v.array(openingAllocationValidator)),
  },
  handler: async (ctx, args): Promise<{ draftId: string }> => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    // Before anything is read for validation and long before anything is
    // written: if the denomination moved under the caller, none of the numbers
    // below mean what they say.
    await assertDenominationUnchanged(ctx, args.orgId, args.expectedCurrency);

    if (await hasOpeningBalanceCommitment(ctx, args.orgId)) {
      throw new ConvexError("An opening balance has already been posted or is awaiting approval for this organization.");
    }

    // Preflight only: don't knowingly create a draft that approval must refuse.
    // Activity that lands after this point is still caught at posting time.
    if (await hasPostedLedgerActivity(ctx, args.orgId)) {
      refuseOpeningAfterLedgerActivity();
    }

    validateManualJournalLines(args.lines as ManualJournalLine[]);

    // Every account must belong to this org — an opening balance is a
    // direct-lines insert (no applyPostingRule resolution in between), so
    // nothing else would catch a cross-tenant account id otherwise.
    // Deliberately not checking allowManualPosting here (unlike manual
    // journals): the whole point of an opening balance is to seed starting
    // values for system-controlled accounts (Cash, Fixed Assets, etc.) that
    // normally block manual posting. A deactivated account is still rejected,
    // though — seeding a starting balance into an account the org has retired
    // is always a mistake, and (unlike system accounts) a custom account can be
    // deactivated while still technically allowing manual posting.
    for (const line of args.lines) {
      const account = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", line.accountId, "Opening account not found in this organization.");
      if (!account.active) {
        throw new ConvexError(`Account "${account.name}" is inactive and cannot carry an opening balance. Reactivate it first or use a different account.`);
      }
    }

    await assertOpeningBankIdentities(ctx, args.orgId, args.lines, args.expectedCurrency);

    if (!(await getOpenPeriodForDate(ctx, args.orgId, args.asOfDate))) {
      throw new ConvexError("No open accounting period covers the opening-balance date. Create and open a period first.");
    }

    await prepareOpeningAllocations(ctx, { ...args, currency: args.expectedCurrency, actorId: user._id });

    const now = Date.now();
    const draftId = await ctx.db.insert("openingBalanceDrafts", {
      orgId: args.orgId,
      status: "PENDING_APPROVAL",
      lines: args.lines,
      asOfDate: args.asOfDate,
      memo: args.memo,
      allocations: args.allocations,
      createdBy: user._id,
      createdAt: now,
      // Snapshot the denomination and the preparer's identity at draft time.
      // Neither can be re-derived at approval: orgSettings only locks the org
      // currency once a row exists in one of six financial tables and a draft
      // is not one of them, and the preparer's user row is hard-deleted on
      // offboarding. Written on the direct-post path too so both routes leave
      // an identically-shaped record.
      currency: await getOrgCurrency(ctx, args.orgId),
      preparedByName: user.name || user.email || undefined,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "CREATE_MANUAL_JOURNAL_DRAFT",
      resourceType: "openingBalanceDrafts",
      resourceId: draftId.toString(),
      description: `Opening balance draft submitted for approval: ${args.lines.length} lines.`,
      after: { lines: args.lines.length },
    });

    return { draftId: draftId.toString() };
  },
});

export const approveOpeningBalance = mutation({
  args: {
    orgId: v.id("organizations"),
    draftId: v.id("openingBalanceDrafts"),
  },
  handler: async (ctx, args): Promise<{ journalId: string }> => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const draft = await requireOwnedRow(ctx, args.orgId, "openingBalanceDrafts", args.draftId, "Opening balance draft not found.");
    if (draft.status !== "PENDING_APPROVAL") {
      throw new ConvexError("This opening balance draft has already been resolved.");
    }
    // Segregation of duties, same as approveManualJournal: seeding an org's
    // entire starting GL position is at least as high-risk as an ordinary
    // manual journal, so the two-person check holds on *this* path.
    //
    // Owners have a separate, explicitly named route that does not go through
    // here — `postOpeningBalanceDirect`. That is deliberate: a single-owner
    // dealership has nobody to be the second person, which is why this
    // capability had no UI at all. Keeping the bypass as its own owner-gated
    // mutation means the control is still enforced wherever it can be, and the
    // exception is visible in the API surface rather than hidden behind a flag.
    if (draft.createdBy === user._id) {
      throw new ConvexError("Opening balance approver cannot be the same as the preparer.");
    }

    // A denomination the product cannot vouch for cannot be posted, and posting
    // the org's entire starting position on a guessed scale is not a recoverable
    // mistake. Refuse rather than assume: rejecting and re-submitting takes a
    // minute, and `rejectOpeningBalanceDraft` stays available so this is never a
    // dead end.
    //
    // `denominationOf`, not `!draft.currency`. Truthiness answers a different
    // question — "is there a string here" — and lets "JD", "XYZ" and "jod"
    // through to `scaleForCurrency`, which prices anything it does not
    // recognise at scale 2. This is the same authority `applications.ts` uses
    // at handover and finalization, so one rule governs every path that seals
    // money irreversibly.
    if (denominationOf(draft.currency) === null) {
      throw new ConvexError(unvouchableDenominationMessage(draft.currency));
    }

    const journalId = await postOpeningBalanceDraft(ctx, {
      orgId: args.orgId,
      draft,
      approverId: user._id,
      autoApproved: false,
    });

    return { journalId: journalId.toString() };
  },
});

/**
 * Turns an opening-balance draft into a posted journal entry.
 *
 * Shared by the two-person `approveOpeningBalance` path and the owner-only
 * `postOpeningBalanceDirect` one, so both produce byte-identical ledger
 * effects. Everything that differs between them — who may call it, and whether
 * a second person was involved — is decided by the caller before this runs;
 * this function makes no authorization decisions of its own.
 */
type OpeningPreflightCode = "LEDGER_ACTIVITY" | "LINES" | "ACCOUNT" | "PERIOD" |
  "DENOMINATION" | "BANK" | "ALLOCATIONS" | "UNAVAILABLE";

class OpeningPreflightError extends Error {
  constructor(readonly code: OpeningPreflightCode, readonly original: unknown) {
    super(`Opening preflight ${code}`);
  }
}

async function preflightStep<T>(code: OpeningPreflightCode, check: () => Promise<T> | T): Promise<T> {
  try { return await check(); }
  catch (error) { throw new OpeningPreflightError(code, error); }
}

/** Every check here reads only. The pending query and mutation invoke this
 * same function; the mutation invokes it again in its posting transaction. */
async function inspectOpeningPreflight(ctx: QueryCtx | MutationCtx, args: {
  orgId: Id<"organizations">;
  draft: Doc<"openingBalanceDrafts">;
  actorId: Id<"users">;
}): Promise<{
  totalDebits: number;
  periodId: Id<"accountingPeriods">;
  currency: string;
  scale: number;
  allocationPlan: OpeningAllocationPlan;
}> {
  const { orgId, draft, actorId } = args;
  await preflightStep("LEDGER_ACTIVITY", async () => {
    if (await hasPostedLedgerActivity(ctx, orgId)) refuseOpeningAfterLedgerActivity();
  });
  const totalDebits = await preflightStep("LINES", () => validateManualJournalLines(draft.lines as ManualJournalLine[]));
  await preflightStep("ACCOUNT", async () => {
    for (const line of draft.lines) {
      const account = await requireOwnedRow(ctx, orgId, "chartOfAccounts", line.accountId, "Opening account not found in this organization.");
      if (!account.active) throw new ConvexError(`Account "${account.name}" is inactive and cannot carry an opening balance. Reactivate it first or use a different account.`);
    }
  });
  const period = await preflightStep("PERIOD", async () => {
    const value = await getOpenPeriodForDate(ctx, orgId, draft.asOfDate);
    if (!value) throw new ConvexError("No open accounting period covers the opening-balance date. Create and open a period first.");
    return value;
  });
  const denomination = await preflightStep("DENOMINATION", () => {
    const value = denominationOf(draft.currency);
    if (value === null) throw new ConvexError(unvouchableDenominationMessage(draft.currency));
    return value;
  });
  await preflightStep("BANK", () => assertOpeningBankIdentities(ctx, orgId, draft.lines, denomination.code));
  const allocationPlan = await preflightStep("ALLOCATIONS", () => prepareOpeningAllocations(ctx, {
    orgId, currency: denomination.code, lines: draft.lines, asOfDate: draft.asOfDate,
    allocations: draft.allocations, actorId,
  }));
  return { totalDebits, periodId: period._id, currency: denomination.code,
    scale: denomination.scale, allocationPlan };
}

async function postOpeningBalanceDraft(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    draft: Doc<"openingBalanceDrafts">;
    approverId: Id<"users">;
    autoApproved: boolean;
  },
): Promise<Id<"journalEntries">> {
  const { orgId, draft, approverId, autoApproved } = args;

  // The read-only preflight is repeated here in the posting transaction. The
  // wrapper is unwrapped before any write, preserving the original refusal and
  // Convex's uncaught-exception rollback behavior.
  let preflight: Awaited<ReturnType<typeof inspectOpeningPreflight>>;
  try { preflight = await inspectOpeningPreflight(ctx, { orgId, draft, actorId: approverId }); }
  catch (error) {
    if (error instanceof OpeningPreflightError) throw error.original;
    throw error;
  }
  const { totalDebits, periodId, currency, scale, allocationPlan } = preflight;
  const now = Date.now();

  const journalId = await ctx.db.insert("journalEntries", {
    orgId,
    periodId,
    journalNumber: "OB-pending",
    accountingDate: draft.asOfDate,
    sourceType: "cutover",
    sourceId: orgId.toString(),
    category: "OPENING_BALANCE",
    memo: draft.memo ?? "Opening balance",
    status: "POSTED",
    currency,
    postedBy: approverId,
    postedAt: now,
    createdAt: now,
  });
  const journalNumber = `OB-${journalId.toString().replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase()}`;
  await ctx.db.patch(journalId, { journalNumber });

  // The scale came from the checked draft denomination above.
  for (let i = 0; i < draft.lines.length; i++) {
    const line = draft.lines[i];
    await ctx.db.insert("journalLines", {
      orgId,
      journalEntryId: journalId,
      lineNumber: i + 1,
      accountId: line.accountId,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      currency,
      scale,
      accountingDate: draft.asOfDate,
      description: line.description,
      bankAccountId: line.bankAccountId,
    });
    // GL Phase 18: this is a direct journalLines insert (not routed through
    // postAccountingEvent), so it must keep the running snapshot in sync
    // itself, exactly like postingEngine.ts and reversals.ts do.
    await incrementAccountSnapshot(ctx, {
      orgId,
      accountId: line.accountId,
      currency,
      periodId,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
    });
  }

  const allocationResults = await materializeOpeningAllocations(ctx, allocationPlan, draft._id, approverId);
  await ctx.db.patch(draft._id, {
    status: "POSTED",
    reviewedBy: approverId,
    decidedAt: now,
    journalEntryId: journalId,
    autoApproved,
    allocationResults,
  });

  await auditLog(ctx, {
    orgId,
    actorId: approverId,
    actionType: "POST_MANUAL_JOURNAL",
    resourceType: "journalEntries",
    resourceId: journalId.toString(),
    // The audit line says which route was taken. An owner self-posting is a
    // legitimate operation here, but it is not the same event as a
    // two-person approval and the log should never conflate them.
    description: autoApproved
      ? `Opening balance posted by owner without second approval: ${draft.lines.length} lines, ${totalDebits} total.`
      : `Opening balance posted: ${draft.lines.length} lines, ${totalDebits} total.`,
    after: {
      lines: draft.lines.length,
      totalDebits,
      preparedBy: draft.createdBy,
      autoApproved,
    },
  });

  return journalId;
}

/**
 * Drafts and immediately posts an opening balance, for owners only.
 *
 * The two-person check on `approveOpeningBalance` assumes there is a second
 * MANAGE_FINANCE person to be the approver. In a single-owner dealership there
 * is not, which is why this capability shipped with no UI and no way to use it.
 *
 * This is that exception, deliberately built as its own mutation rather than a
 * flag on the existing pair:
 *
 * - It is gated on the OWNER role itself, not on MANAGE_FINANCE, so granting
 *   someone finance permissions does not also hand them the bypass.
 * - It still writes a full `openingBalanceDrafts` row, so a posted opening
 *   balance looks the same to every reader whichever route created it, and
 *   `autoApproved` records which one did.
 * - The audit entry names the bypass explicitly.
 *
 * Every other guard is unchanged: one opening balance per org, balanced lines,
 * accounts in this org and active, and an open period covering the date.
 */
export const postOpeningBalanceDirect = mutation({
  args: {
    orgId: v.id("organizations"),
    lines: v.array(v.object({
      accountId: v.id("chartOfAccounts"),
      debitMinor: v.number(),
      creditMinor: v.number(),
      description: v.optional(v.string()),
      bankAccountId: v.optional(v.id("bankAccounts")),
    })),
    asOfDate: v.number(),
    memo: v.optional(v.string()),
    // The exact canonical code the caller converted the entered decimals under.
    // See assertDenominationUnchanged — this binds the integers to a scale.
    expectedCurrency: v.string(),
    allocations: v.optional(v.array(openingAllocationValidator)),
  },
  handler: async (ctx, args): Promise<{ journalId: string; draftId: string }> => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    if (!isSystemOwnerRole(role)) {
      throw new ConvexError(
        "Only an owner can post an opening balance without a second approver. Save it for approval instead."
      );
    }

    // Before the draft insert AND before the post — this route does both in one
    // mutation, so it is the one where a late refusal would be worst.
    await assertDenominationUnchanged(ctx, args.orgId, args.expectedCurrency);

    if (await hasOpeningBalanceCommitment(ctx, args.orgId)) {
      throw new ConvexError("An opening balance has already been posted or is awaiting approval for this organization.");
    }

    // Same preflight as draftOpeningBalance, so the stable coded refusal for
    // late openings still wins over the bank check below (the poster repeats it).
    if (await hasPostedLedgerActivity(ctx, args.orgId)) {
      refuseOpeningAfterLedgerActivity();
    }

    validateManualJournalLines(args.lines as ManualJournalLine[]);

    // Before the draft insert: a refused bank identity must leave no row behind.
    await assertOpeningBankIdentities(ctx, args.orgId, args.lines, args.expectedCurrency);

    // The denomination to stamp on the row. Already proved vouchable AND equal
    // to what the caller converted under by the assertion above, which is why
    // this is a plain read rather than a second guard — one rule, checked once,
    // at the boundary. (The shared poster re-checks vouchability independently
    // as the chokepoint for callers that never came through here.)
    const orgDenomination = await getOrgCurrency(ctx, args.orgId);
    await prepareOpeningAllocations(ctx, { ...args, currency: orgDenomination, actorId: user._id });

    const now = Date.now();
    const draftId = await ctx.db.insert("openingBalanceDrafts", {
      orgId: args.orgId,
      status: "PENDING_APPROVAL",
      lines: args.lines,
      asOfDate: args.asOfDate,
      memo: args.memo,
      createdBy: user._id,
      createdAt: now,
      // Snapshot the denomination and the preparer's identity at draft time.
      // Neither can be re-derived at approval: orgSettings only locks the org
      // currency once a row exists in one of six financial tables and a draft
      // is not one of them, and the preparer's user row is hard-deleted on
      // offboarding. Written on the direct-post path too so both routes leave
      // an identically-shaped record. Vouched for immediately above, so the row
      // cannot be created carrying a denomination the poster would refuse.
      currency: orgDenomination,
      allocations: args.allocations,
      preparedByName: user.name || user.email || undefined,
    });

    const draft = await ctx.db.get(draftId);
    if (!draft) throw new ConvexError("Opening balance draft could not be created.");

    // Account and period validation live in the shared poster, so this path
    // cannot drift from the reviewed one. A throw there rolls back the draft
    // insert above with it, leaving nothing half-created.
    const journalId = await postOpeningBalanceDraft(ctx, {
      orgId: args.orgId,
      draft,
      approverId: user._id,
      autoApproved: true,
    });

    return { journalId: journalId.toString(), draftId: draftId.toString() };
  },
});

export const rejectOpeningBalanceDraft = mutation({
  args: {
    orgId: v.id("organizations"),
    draftId: v.id("openingBalanceDrafts"),
    rejectionReason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const rejectionReason = args.rejectionReason.trim();
    if (!rejectionReason) {
      throw new ConvexError("A rejection reason is required.");
    }

    const draft = await requireOwnedRow(ctx, args.orgId, "openingBalanceDrafts", args.draftId, "Opening balance draft not found.");
    if (draft.status !== "PENDING_APPROVAL") {
      throw new ConvexError("This opening balance draft has already been resolved.");
    }
    if (await containsEmployeeAdvanceControl(ctx, args.orgId, draft)) {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_PAYROLL]);
    }
    if (draft.createdBy === user._id) {
      throw new ConvexError("Opening balance approver cannot be the same as the preparer.");
    }

    const now = Date.now();
    await ctx.db.patch(draft._id, {
      status: "REJECTED",
      reviewedBy: user._id,
      decidedAt: now,
      rejectionReason,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "REJECT_MANUAL_JOURNAL",
      resourceType: "openingBalanceDrafts",
      resourceId: draft._id.toString(),
      description: `Opening balance draft rejected: ${rejectionReason}`,
      after: { createdBy: draft.createdBy, rejectionReason },
    });
  },
});

/** Checks both allocations and GL controls. Older drafts may contain the
 * control line without operational rows; they are still payroll-sensitive. */
async function containsEmployeeAdvanceControl(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  draft: Doc<"openingBalanceDrafts">,
): Promise<boolean> {
  if (draft.allocations?.some((row) => (row.kind === "EMPLOYEE_ADVANCE" || row.kind === "EMPLOYEE_COMMISSION"))) return true;
  for (const line of draft.lines) {
    const account = await ctx.db.get(line.accountId);
    if (account?.orgId === orgId && (account.systemKey === SYSTEM_KEYS.EMPLOYEE_ADVANCES || account.systemKey === SYSTEM_KEYS.COMMISSION_PAYABLE)) return true;
  }
  return false;
}

export const listPendingOpeningBalanceDrafts = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const openingReader=createOpeningSettlementReader(ctx,args.orgId);
    const { role, user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const drafts = await ctx.db
      .query("openingBalanceDrafts")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING_APPROVAL"))
      .collect();

    // `preparedByName` and `currency` are resolved here rather than in the
    // client because both are load-bearing for the approval decision and
    // neither is on the draft row.
    //
    // The name is what makes the segregation-of-duties check meaningful to a
    // human: approveOpeningBalance refuses when approver === preparer, and a
    // reviewer who cannot see who prepared it is being asked to rubber-stamp.
    //
    // The currency drives the minor-unit scale the amounts are rendered at.
    // Scale is per-currency (3 for JOD/KWD/BHD/OMR, 2 otherwise), so a client
    // that guessed would display an opening balance off by a factor of ten on
    // exactly the currencies this product is used in. Mirrors the same
    // reasoning as openingBalanceStatus.
    const orgCurrency = await getOrgCurrency(ctx, args.orgId);

    const mayViewPayroll = isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_PAYROLL) ||
      role.permissions.includes(PERMISSIONS.MANAGE_PAYROLL);
    const visibleDrafts = [];
    for (const draft of drafts) {
      if (mayViewPayroll || !(await containsEmployeeAdvanceControl(ctx, args.orgId, draft))) visibleDrafts.push(draft);
    }
    return await Promise.all(
      visibleDrafts.map(async (draft) => {
        // Snapshot first, live lookup only as a fallback for drafts written
        // before the snapshot existed. The live row is the unreliable one:
        // offboarding hard-deletes users (memberships.ts), which would render
        // the preparer as "Unknown" on the very screen where identifying them
        // is the control.
        const preparer = draft.preparedByName ? null : await ctx.db.get(draft.createdBy);
        const draftCurrency = draft.currency ?? orgCurrency;
        // SCRUM-54: the approver must see WHICH physical bank each bank line
        // seeds. The name is reported only for a bank approval would accept
        // (same org, live, in the draft's currency); `null` on a line that
        // requires a bank means approval will refuse it.
        const lines = await Promise.all(
          draft.lines.map(async (line) => {
            const account = await ctx.db.get(line.accountId);
            const bank = line.bankAccountId ? await ctx.db.get(line.bankAccountId) : null;
            const usable =
              bank !== null && bank.orgId === args.orgId && !bank.isDeleted && bank.isActive && bank.currency === draftCurrency;
            return {
              ...line,
              requiresBankAccount: account?.systemKey === SYSTEM_KEYS.BANK_ACCOUNT,
              bankAccountName: usable ? bank.name : null,
            };
          })
        );
        const payrollSensitive = await containsEmployeeAdvanceControl(ctx, args.orgId, draft);
        const viewerCanManagePayroll = isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.MANAGE_PAYROLL);
        let blockerCodes: Array<OpeningPreflightCode | "PAYROLL_AUTHORITY" | "OWN_DRAFT"> = [];
        if (draft.createdBy === user._id) blockerCodes = ["OWN_DRAFT"];
        else if (payrollSensitive && !viewerCanManagePayroll) blockerCodes = ["PAYROLL_AUTHORITY"];
        else {
          try { await inspectOpeningPreflight(ctx, { orgId: args.orgId, draft, actorId: user._id }); }
          catch (error) { blockerCodes = [error instanceof OpeningPreflightError ? error.code : "UNAVAILABLE"]; }
        }
        const stockEvidence = (draft.allocations ?? []).some((allocation) => allocation.kind === "VEHICLE_INVENTORY")
          ? await listOpeningStockEvidence(ctx, args.orgId).catch(() => []) : [];
        const resetGeneration = orgResetState(await ctx.db.get(args.orgId)).generation;
        const allocationDetails = await Promise.all((draft.allocations ?? []).map(async (allocation) => {
          const account = await ctx.db.get(allocation.accountId);
          let partyId: string | null = null;
          let allocationStatus: "AVAILABLE" | "UNALLOCATED" | "UNAVAILABLE" = "AVAILABLE";
          let partyName: string | null = null;
          let partyDetail: string | null = null;
          let partyAvailable = false;
          if (allocation.kind === "CUSTOMER_RECEIVABLE") {
            partyId = allocation.customerId;
            const customer = await ctx.db.get(allocation.customerId);
            if (customer?.orgId === args.orgId && !customer.isDeleted) {
              partyName = `${customer.firstName} ${customer.lastName}`.trim();
              partyDetail = customer.phone ? `•••${customer.phone.slice(-4)}` : customer.email ?? null;
              partyAvailable = true;
            }
          } else if (isRemainingOpeningKind(allocation.kind) && allocation.kind !== "EMPLOYEE_COMMISSION") {
            partyName = "counterpartyName" in allocation ? allocation.counterpartyName : null;
            partyAvailable = "counterpartyName" in allocation;
            const basis = draft.status === "POSTED" ? await resolveOpeningSettlementBasis(ctx,args.orgId,{draftId:draft._id,rowKey:allocation.rowKey},allocation.kind,openingReader) : null;
            allocationStatus = basis?.kind === "UNAVAILABLE" ? "UNAVAILABLE" : allocation.kind === "UNALLOCATED_LIABILITY" ? "UNALLOCATED" : "AVAILABLE";
          } else if (allocation.kind === "EMPLOYEE_ADVANCE" || allocation.kind === "EMPLOYEE_COMMISSION") {
            partyId = allocation.userId;
            const membership = await ctx.db.query("memberships")
              .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", allocation.userId)).unique();
            const employee = membership ? await ctx.db.get(allocation.userId) : null;
            if (membership && !membership.offboardingStatus && employee) {
              partyName = employee.name ?? employee.email;
              partyDetail = employee.email;
              partyAvailable = true;
            }
          } else if (allocation.kind === "PREPAID_EXPENSE") {
            partyId = allocation.rowKey;
            partyName = allocation.title;
            partyAvailable = allocation.attestedUnexpiredBenefit === true;
          } else if (allocation.kind === "VEHICLE_INVENTORY") {
            partyId = allocation.vehicleId;
            const vehicle = await ctx.db.get(allocation.vehicleId);
            const proof = stockEvidence.find((item) => item.vehicleId === allocation.vehicleId);
            if (vehicle?.orgId === args.orgId && !vehicle.isDeleted) {
              partyName = vehicle.vin ?? null;
              partyDetail = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
              partyAvailable = vehicle.sourceType === "STOCK" && vehicle.openingStockImportId !== undefined &&
                vehicle.openingStockRowId !== undefined && proof?.vin === vehicle.vin &&
                proof?.costMinor === allocation.amountMinor && proof?.currency === draft.currency &&
                proof?.command.resetGeneration === resetGeneration &&
                proof?.command.idempotencyKey === `${vehicle.openingStockImportId}:${vehicle.openingStockRowId}`;
            }
          } else if (allocation.kind === "PARTNER_CAPITAL") {
            partyId = allocation.partnerId;
            const partner = await ctx.db.get(allocation.partnerId);
            if (partner?.orgId === args.orgId && !partner.isDeleted) {
              partyName = partner.partnerName;
              partyDetail = String(partner._id).slice(-6);
              partyAvailable = true;
            }
          }
          return {
            rowKey: allocation.rowKey,
            kind: allocation.kind,
            allocationStatus,
            purpose: "purpose" in allocation ? allocation.purpose : undefined,
            accountId: allocation.accountId,
            accountCode: account?.orgId === args.orgId ? account.code : null,
            accountName: account?.orgId === args.orgId ? account.name : null,
            accountNameAr: account?.orgId === args.orgId ? account.nameAr : undefined,
            partyId,
            partyName,
            partyDetail,
            partyAvailable,
            amountMinor: allocation.amountMinor,
            title: "title" in allocation ? allocation.title : undefined,
            dueDate: allocation.kind === "CUSTOMER_RECEIVABLE" ? allocation.dueDate : undefined,
            note: allocation.kind === "EMPLOYEE_ADVANCE" ? allocation.note : undefined,
            startYearMonth: allocation.kind === "PREPAID_EXPENSE" ? allocation.startYearMonth : undefined,
            termMonths: allocation.kind === "PREPAID_EXPENSE" ? allocation.termMonths : undefined,
            expenseSystemKey: allocation.kind === "PREPAID_EXPENSE" ? allocation.expenseSystemKey : undefined,
            attestedUnexpiredBenefit: allocation.kind === "PREPAID_EXPENSE" ? allocation.attestedUnexpiredBenefit : undefined,
          };
        }));
        return {
          _id: draft._id,
          asOfDate: draft.asOfDate,
          memo: draft.memo,
          createdBy: draft.createdBy,
          lines,
          allocations: draft.allocations,
          allocationDetails,
          payrollSensitive,
          viewerCanManagePayroll,
          readiness: { blockerCodes, canApprove: blockerCodes.length === 0,
            canReject: draft.createdBy !== user._id && (!payrollSensitive || viewerCanManagePayroll) },
          // `null`, never an English literal. The client renders this inside a
          // <bdi> on a screen this PR hardened for Arabic bidi — shipping
          // "Unknown" there would put untranslated English in the RTL run.
          // Translation is the client's job; the server reports absence.
          preparedByName:
            draft.preparedByName || preparer?.name || preparer?.email || null,
          currency: draftCurrency,
          // The SAME authority the server refuses on, not a lookalike. This was
          // `Boolean(draft.currency)` to match the old `!draft.currency` guard,
          // and both were truthiness: a draft denominated "JD" reported
          // denomination-known, the panel enabled Approve, and the refusal
          // arrived as a raw error toast — exactly the dead-end behaviour this
          // flag exists to remove. `denominationOf` is the one rule for both
          // sides, so the screen can never offer an approval the poster will
          // refuse.
          denominationKnown: denominationOf(draft.currency) !== null,
        };
      })
    );
  },
});

export const hasOpeningBalance = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
    const existing = await findPostedOpeningBalanceJournal(ctx, args.orgId);
    return existing !== null;
  },
});

/**
 * Everything the opening-balance UI needs, in one subscription.
 *
 * `canPostDirectly` is computed here rather than in the client on purpose.
 * `usePermissions` derives ownership from `roleName === "OWNER"`, while the
 * server gate is `isSystemOwnerRole`, which honours an explicit
 * `isSystemOwnerRole` flag first and only then falls back to the name — *and*
 * requires the role to hold every defined permission. Those two rules can
 * disagree: a role flagged as the system owner but named something else passes
 * the server and fails the client, and a role named "OWNER" with the flag off
 * does the reverse. Re-deriving an authorization rule in the browser is how a
 * UI ends up offering a button the server refuses, so the server answers it.
 */
export const openingBalanceStatus = query({
  args: { orgId: v.id("organizations") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    posted: boolean;
    pendingExists: boolean;
    pendingDraftId: string | null;
    canPostDirectly: boolean;
    canManageFinance: boolean;
    canSelectCustomers: boolean;
    canSelectEmployees: boolean;
    canSelectPartners: boolean;
    currency: string;
  }> => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
    const postedEntry = await findPostedOpeningBalanceJournal(ctx, args.orgId);

    const pending = await ctx.db
      .query("openingBalanceDrafts")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING_APPROVAL"))
      .first();

    const isOwner = isSystemOwnerRole(role);
    const canManageFinance =
      isOwner || role.permissions.includes(PERMISSIONS.MANAGE_FINANCE);
    const canEnter = canManageFinance && postedEntry === null && pending === null;

    const mayViewPayroll = isOwner || role.permissions.includes(PERMISSIONS.VIEW_PAYROLL) ||
      role.permissions.includes(PERMISSIONS.MANAGE_PAYROLL);
    const pendingVisible = !pending || mayViewPayroll || !(await containsEmployeeAdvanceControl(ctx, args.orgId, pending));

    return {
      posted: postedEntry !== null,
      pendingExists: pending !== null,
      pendingDraftId: pendingVisible ? pending?._id.toString() ?? null : null,
      canPostDirectly: isOwner && canManageFinance,
      canManageFinance,
      canSelectCustomers: canEnter && (isOwner || role.permissions.includes(PERMISSIONS.VIEW_CUSTOMERS)),
      canSelectEmployees: canEnter && (isOwner || (role.permissions.includes(PERMISSIONS.MANAGE_PAYROLL) &&
        role.permissions.includes(PERMISSIONS.VIEW_USERS))),
      canSelectPartners: canEnter,
      // The form converts entered amounts to minor units, and the scale is
      // per-currency (3 for JOD/KWD/BHD/OMR, 2 otherwise). Returned here so the
      // client uses the org's real currency rather than assuming one — getting
      // this wrong posts amounts off by a factor of ten.
      currency: await getOrgCurrency(ctx, args.orgId),
    };
  },
});

/** Server-classified account choices for the once-per-org opening editor.
 * Unsupported controls stay visible so the operator can see why a line is
 * unavailable; no client copy of the financial policy table is authoritative. */
export const listOpeningAccountPolicies = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    if (await findPostedOpeningBalanceJournal(ctx, args.orgId)) return [];
    const pending = await ctx.db.query("openingBalanceDrafts")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING_APPROVAL"))
      .first();
    if (pending) return [];
    const currency = await getOrgCurrency(ctx, args.orgId);
    const accounts = await ctx.db.query("chartOfAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(201);
    if (accounts.length > 200) throw new ConvexError("Opening account choices require finance review.");
    const canonical = await Promise.all([
      SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS,
      SYSTEM_KEYS.EMPLOYEE_ADVANCES,
      SYSTEM_KEYS.PARTNER_CAPITAL,
      SYSTEM_KEYS.PREPAID_EXPENSES,
      SYSTEM_KEYS.VEHICLE_INVENTORY,
    ].map(async (key) => {
      try { return await resolveSystemAccount(ctx, args.orgId, key); }
      catch { return null; }
    }));
    return await Promise.all(accounts.map(async (account) => {
      const candidate = !account.systemKey && isOpeningPartnerAccount(account);
      const classified = openingPolicyForAccount(account, candidate);
      let policy: OpeningPolicy | "PARTNER_CAPITAL_CANDIDATE" | "UNAVAILABLE" = "UNSUPPORTED";
      if (account.active &&
          (!account.currencyRestriction || account.currencyRestriction === currency)) {
        if (candidate) policy = "PARTNER_CAPITAL_CANDIDATE";
        else if (classified === "CUSTOMER_RECEIVABLE") policy = canonical[0] === null ? "UNAVAILABLE"
          : account._id === canonical[0] ? classified : "UNSUPPORTED";
        else if (classified === "EMPLOYEE_ADVANCE") policy = canonical[1] === null ? "UNAVAILABLE"
          : account._id === canonical[1] ? classified : "UNSUPPORTED";
        else if (classified === "PARTNER_CAPITAL") policy = canonical[2] === null ? "UNAVAILABLE"
          : account._id === canonical[2] ? classified : "UNSUPPORTED";
        else if (classified === "PREPAID_EXPENSE") policy = canonical[3] === null ? "UNAVAILABLE"
          : account._id === canonical[3] ? classified : "UNSUPPORTED";
        else if (classified === "VEHICLE_INVENTORY") policy = canonical[4] === null ? "UNAVAILABLE"
          : account._id === canonical[4] ? classified : "UNSUPPORTED";
        else if (classified && (isRemainingOpeningKind(classified) || classified === "DECLARED_LIABILITY" || classified === "LEDGER_ONLY")) policy = classified;
      }
      const candidates:RemainingOpeningKind[] = policy === "DECLARED_LIABILITY" ? ["SUPPLIER_PAYABLE","OTHER_PAYABLE","EMPLOYEE_COMMISSION","UNALLOCATED_LIABILITY"] : isRemainingOpeningKind(policy) ? [policy] : [];
      const allowedKinds:RemainingOpeningKind[]=[];
      for(const kind of candidates)if(await openingAccountAllowsFamily(ctx,args.orgId,account,currency,kind,kind === "UNALLOCATED_LIABILITY" ? "CUSTOMER_DEPOSIT" : undefined))allowedKinds.push(kind);
      if(candidates.length && !allowedKinds.length)policy="UNSUPPORTED";
      return { accountId:account._id,policy,allowedKinds,allowedPurposes:allowedKinds.includes("UNALLOCATED_LIABILITY") ? account.systemKey ? ["CUSTOMER_DEPOSIT"] : ["CUSTOMER_DEPOSIT","UNIDENTIFIED_RECEIPT"] : undefined };
    }));
  },
});

/** Finance-only selector for imported physical opening stock. Command proof,
 * not mutable vehicle fields, supplies the set that approval must exhaust. */
export const listOpeningStockChoices = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);
    const evidence = await listOpeningStockEvidence(ctx, args.orgId);
    const resetGeneration = orgResetState(await ctx.db.get(args.orgId)).generation;
    return await Promise.all(evidence.map(async ({ vehicleId, vin, costMinor, currency: basisCurrency, command }) => {
      const vehicle = await ctx.db.get(vehicleId);
      const available = !!vehicle && vehicle.orgId === args.orgId && !vehicle.isDeleted &&
        vehicle.sourceType === "STOCK" && !!vehicle.vin && vehicle.purchasePrice !== undefined &&
        vehicle.vin === vin && basisCurrency === currency &&
        toMinorUnits(vehicle.purchasePrice, currency) === costMinor &&
        command.resetGeneration === resetGeneration &&
        vehicle.openingStockImportId !== undefined && vehicle.openingStockRowId !== undefined &&
        command.idempotencyKey === `${vehicle.openingStockImportId}:${vehicle.openingStockRowId}`;
      return { vehicleId, vin: vehicle?.orgId === args.orgId ? vehicle.vin ?? null : null,
        label: vehicle?.orgId === args.orgId ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
        amountMinor: available ? costMinor : null,
        available };
    }));
  },
});

/** Current readback is anchored to its real live source journal, not the age
 * of a retained historical header. Reset history never lends another source. */
async function selectOpeningReadbackDraft(ctx:QueryCtx,orgId:Id<"organizations">):Promise<Doc<"openingBalanceDrafts">|null>{
  const limit=100;
  const [drafts,journals]=await Promise.all([
    ctx.db.query("openingBalanceDrafts").withIndex("by_org_status",q=>q.eq("orgId",orgId).eq("status","POSTED")).take(limit+1),
    ctx.db.query("journalEntries").withIndex("by_org_source",q=>q.eq("orgId",orgId).eq("sourceType","cutover").eq("sourceId",String(orgId))).take(limit+1),
  ]);
  const refuse=()=>new ConvexError("Opening allocation readback requires finance review.");
  if(drafts.length>limit || journals.length>limit)throw refuse();
  const live=journals.filter(journal=>journal.category === "OPENING_BALANCE" && journal.status === "POSTED");
  if(live.length>1)throw refuse();
  if(live.length===1){
    const matches=drafts.filter(draft=>draft.journalEntryId === live[0]._id);
    if(matches.length!==1 || matches[0].asOfDate!==live[0].accountingDate || matches[0].currency!==undefined && matches[0].currency!==live[0].currency)throw refuse();
    return matches[0];
  }
  if(drafts.length===0)return null;
  if(drafts.length!==1)throw refuse();
  const historical=drafts[0];
  const journal=historical.journalEntryId?await ctx.db.get(historical.journalEntryId):null;
  if(journal && (journal.orgId!==orgId || journal.sourceType!=="cutover" || journal.sourceId!==String(orgId) || journal.category!=="OPENING_BALANCE" || journal.status!=="REVERSED" || journal.accountingDate!==historical.asOfDate || historical.currency!==undefined && journal.currency!==historical.currency))throw refuse();
  return historical;
}

/** Readback of the immutable opening commitment. Amount and account come
 * from the posted draft, never a mutable outstanding balance. */
export const postedOpeningAllocationReadback = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const openingReader=createOpeningSettlementReader(ctx,args.orgId);
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const draft=await selectOpeningReadbackDraft(ctx,args.orgId);
    if(!draft)return null;
    const journal = draft.journalEntryId ? await ctx.db.get(draft.journalEntryId) : null;
    const journalStatus = journal?.orgId === args.orgId && journal.category === "OPENING_BALANCE"
      ? journal.status : "MISSING";
    const resultCounts = new Map<string, number>();
    const resultByKey = new Map<string, NonNullable<typeof draft.allocationResults>[number]>();
    for (const result of draft.allocationResults ?? []) {
      resultCounts.set(result.rowKey, (resultCounts.get(result.rowKey) ?? 0) + 1);
      resultByKey.set(result.rowKey, result);
    }
    const mayViewPayroll = isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.VIEW_PAYROLL) ||
      role.permissions.includes(PERMISSIONS.MANAGE_PAYROLL);
    const rows = await Promise.all((draft.allocations ?? []).map(async (allocation) => {
      if ((allocation.kind === "EMPLOYEE_ADVANCE" || allocation.kind === "EMPLOYEE_COMMISSION") && !mayViewPayroll) {
        return { kind: allocation.kind, restricted: true as const };
      }
      const account = await ctx.db.get(allocation.accountId);
      const ownedAccount = account?.orgId === args.orgId ? account : null;
      const result = resultCounts.get(allocation.rowKey) === 1 ? resultByKey.get(allocation.rowKey) : undefined;
      let partyId: string | null = null;
      let partyName: string | null = null;
      let documentId: string | null = null;
      let recordAvailable = false;
      if (allocation.kind === "CUSTOMER_RECEIVABLE") {
        partyId = allocation.customerId;
        const customer = await ctx.db.get(allocation.customerId);
        if (customer?.orgId === args.orgId && !customer.isDeleted) {
          partyName = `${customer.firstName} ${customer.lastName}`.trim();
        }
        if (result?.kind === allocation.kind) {
          documentId = result.receivableId;
          const receivable = await ctx.db.get(result.receivableId);
          const canonical = await ctx.db.get(result.canonicalReceivableDocumentId);
          recordAvailable = receivable?.orgId === args.orgId && receivable.openingBalanceDraftId === draft._id &&
            receivable.canonicalReceivableDocumentId === result.canonicalReceivableDocumentId &&
            canonical?.orgId === args.orgId && canonical.sourceType === "legacy_receivable" &&
            canonical.sourceId === result.receivableId && canonical.customerId === allocation.customerId;
        }
      } else if (isRemainingOpeningKind(allocation.kind)) {
        partyName = "counterpartyName" in allocation ? allocation.counterpartyName : null;
        const basis = await resolveOpeningSettlementBasis(ctx,args.orgId,{draftId:draft._id,rowKey:allocation.rowKey},allocation.kind,openingReader);
        recordAvailable = basis.kind === "AVAILABLE";
        if (allocation.kind === "EMPLOYEE_COMMISSION") {
          partyId = allocation.userId;
          const employee = await ctx.db.get(allocation.userId);
          partyName = employee?.name ?? employee?.email ?? null;
        }
        if (result?.kind === "SUPPLIER_RECOVERABLE") {
          documentId = result.recoveryId;
          const row = await ctx.db.get(result.recoveryId);
          try {recordAvailable = recordAvailable && !!row && !!await openingRecoveryBasis(ctx,args.orgId,row,openingReader);} catch {recordAvailable=false;}
        }
        else if (result?.kind === "SUPPLIER_PAYABLE" || result?.kind === "OTHER_PAYABLE") {
          documentId = result.payableId;
          const row = await ctx.db.get(result.payableId);
          try {recordAvailable = recordAvailable && !!row && !!await openingPayableBasis(ctx,args.orgId,row,openingReader);} catch {recordAvailable=false;}
        }
        else if (result?.kind === "EMPLOYEE_COMMISSION") {
          documentId = result.openingCommissionLiabilityId;
          recordAvailable = recordAvailable && (await resolveOpeningCommissionBasis(ctx,args.orgId,result.openingCommissionLiabilityId,openingReader)).kind === "AVAILABLE";
        }
      } else if (allocation.kind === "EMPLOYEE_ADVANCE") {
        partyId = allocation.userId;
        const employee = await ctx.db.get(allocation.userId);
        partyName = employee?.name ?? employee?.email ?? null;
        if (result?.kind === allocation.kind) {
          documentId = result.advanceId;
          const advance = await ctx.db.get(result.advanceId);
          recordAvailable = advance?.orgId === args.orgId && advance.openingBalanceDraftId === draft._id &&
            !advance.isDeleted;
        }
      } else if (allocation.kind === "PREPAID_EXPENSE") {
        partyId = allocation.rowKey;
        partyName = allocation.title;
        if (result?.kind === allocation.kind) {
          documentId = result.scheduleId;
          const basis = await resolvePrepaidScheduleSource(ctx, args.orgId, result.scheduleId);
          recordAvailable = basis.kind === "OPENING" && basis.draftId === draft._id && basis.rowKey === allocation.rowKey;
        }
      } else if (allocation.kind === "VEHICLE_INVENTORY") {
        partyId = allocation.vehicleId;
        const vehicle = await ctx.db.get(allocation.vehicleId);
        if (vehicle?.orgId === args.orgId) partyName = vehicle.vin ?? null;
        if (result?.kind === allocation.kind && result.vehicleId === allocation.vehicleId) {
          documentId = allocation.vehicleId;
          try { recordAvailable = await assertOpeningVehicleBasis(ctx, args.orgId, allocation.vehicleId) === "POSTED"; }
          catch { recordAvailable = false; }
        }
      } else if (allocation.kind === "PARTNER_CAPITAL") {
        partyId = allocation.partnerId;
        const partner = await ctx.db.get(allocation.partnerId);
        if (partner?.orgId === args.orgId && !partner.isDeleted) partyName = partner.partnerName;
        if (result?.kind === allocation.kind && result.partnerId === allocation.partnerId) {
          documentId = result.partnerId;
          recordAvailable = partner?.orgId === args.orgId && !partner.isDeleted &&
            partner.openingBalanceDraftId === draft._id;
        }
      }
      return { kind: allocation.kind, rowKey: allocation.rowKey, restricted: false as const,
        accountId: allocation.accountId, accountCode: ownedAccount?.code ?? null,
        accountName: ownedAccount?.name ?? null, accountNameAr: ownedAccount?.nameAr,
        amountMinor: allocation.amountMinor, title:"title" in allocation ? allocation.title : undefined, partyId, partyName, documentId, recordAvailable,
        purpose: "purpose" in allocation ? allocation.purpose : undefined,
        allocationStatus: journalStatus !== "POSTED" || !recordAvailable ? "UNAVAILABLE" as const : allocation.kind === "UNALLOCATED_LIABILITY" ? "UNALLOCATED" as const : "AVAILABLE" as const };
    }));
    return { draftId: draft._id, journalEntryId: draft.journalEntryId ?? null, journalStatus,
      currency: draft.currency ?? null, asOfDate: draft.asOfDate, rows };
  },
});

/**
 * Parallel-reporting comparison for a cutover period: legacy operational
 * totals (the pre-GL transactions table) against what's actually landed in
 * the GL for events sourced from that same table, so a human can confirm
 * the migration neither lost nor double-counted anything.
 */
export const compareLegacyToGL = query({
  args: {
    orgId: v.id("organizations"),
    fromDate: v.number(),
    toDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const currency = await getOrgCurrency(ctx, args.orgId);

    const legacyTxns = (
      await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).filter((t) => !t.isDeleted && t.date >= args.fromDate && t.date <= args.toDate);

    let legacyInMinor = 0;
    let legacyOutMinor = 0;
    for (const tx of legacyTxns) {
      const minor = toMinorUnits(tx.amount, currency);
      if (tx.type === "IN") legacyInMinor += minor;
      else legacyOutMinor += minor;
    }

    const glEvents = (
      await ctx.db
        .query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect()
    ).filter((e) => e.sourceType === "transactions" && e.occurredAt >= args.fromDate && e.occurredAt <= args.toDate);

    const postedEvents = glEvents.filter((e) => e.status === "POSTED");
    let glTotalDebitMinor = 0;
    let glTotalCreditMinor = 0;
    const glCurrencies = new Set<string>();
    for (const event of postedEvents) {
      if (!event.journalEntryId) continue;
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event.journalEntryId!))
        .collect();
      for (const line of lines) {
        glTotalDebitMinor += line.debitMinor;
        glTotalCreditMinor += line.creditMinor;
        glCurrencies.add(line.currency);
      }
    }

    const migratedTransactionIds = new Set(postedEvents.map((e) => e.sourceId));
    const unmigrated = legacyTxns.filter((tx) => !migratedTransactionIds.has(tx._id.toString()));

    // The legacy `transactions` table never recorded a per-row currency, so
    // legacyInMinor/legacyOutMinor above assume every row used the org's
    // CURRENT currency setting. That assumption breaks if the org changed
    // currency (GL Phase 14) partway through this date range — there is no
    // way to recover which currency an old row was actually in, so instead
    // of silently producing a wrong-looking-right number, flag it: if the
    // GL side (which does record currency per line) shows more than one
    // currency, or a currency other than the org's current one, this
    // comparison isn't trustworthy for this range.
    const multiCurrencyWarning =
      glCurrencies.size > 1 || (glCurrencies.size === 1 && !glCurrencies.has(currency));

    return {
      currency,
      multiCurrencyWarning,
      legacy: {
        transactionCount: legacyTxns.length,
        totalInMinor: legacyInMinor,
        totalOutMinor: legacyOutMinor,
      },
      gl: {
        migratedEventCount: postedEvents.length,
        totalDebitMinor: glTotalDebitMinor,
        totalCreditMinor: glTotalCreditMinor,
        isBalanced: glTotalDebitMinor === glTotalCreditMinor,
        currencies: Array.from(glCurrencies),
      },
      unmigratedCount: unmigrated.length,
      unmigratedTransactionIds: unmigrated.map((tx) => tx._id.toString()),
    };
  },
});

export const signOffCutover = mutation({
  args: {
    orgId: v.id("organizations"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const legacyTransactions = await ctx.db
      .query("transactions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const activeLegacy = legacyTransactions.filter((t) => !t.isDeleted);

    const glEvents = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) => q.eq("orgId", args.orgId).eq("sourceType", "transactions"))
      .collect();
    const migratedIds = new Set(
      glEvents.filter((e) => e.status === "POSTED").map((e) => e.sourceId)
    );
    const migratedCount = activeLegacy.filter((t) => migratedIds.has(t._id.toString())).length;

    const trialBalanceByCurrency = await sumAllPostedJournalLinesByCurrency(ctx, args.orgId);

    const unmigratedTransactionCount = activeLegacy.length - migratedCount;
    const isBalanced = trialBalanceByCurrency.every((b) => b.isBalanced);

    // A sign-off is an attestation that the cutover is DONE and correct —
    // recording one while transactions remain unaccounted for, or while the
    // trial balance doesn't foot, would let the org proceed as if
    // production-ready when it isn't. Neither is overridable here.
    //
    // ⚠️ SCRUM-234 changed what this refusal can honestly tell an operator.
    // The gate is unchanged, but the remedy it used to name is gone: this
    // count is satisfied only by a POSTED event sourced from `transactions`,
    // and `accountingMigration.migrateUnpostedTransactions` — the sole
    // production writer of that source family — now refuses unconditionally.
    // So there is no longer any tool a caller can run to drive this to zero.
    //
    // Under SCRUM-231's clean-slate launch that is the intended shape: the
    // wipe leaves zero active legacy rows, so the count is zero and sign-off
    // passes without any migration ever running. It only STAYS zero while
    // nothing writes new legacy rows, which is SCRUM-53's containment.
    //
    // OWNERSHIP, ruled explicitly so the two tickets cannot blur:
    //
    //   SCRUM-234 fixes the now-FALSE OPERATOR INSTRUCTION that migration
    //             retirement caused. Message and this comment only.
    //   SCRUM-231 redesigns WHAT CUTOVER SIGN-OFF MEANS.
    //
    // So nothing else here moves: the predicate, the counts, the snapshot, the
    // attestation's meaning, the permissions and the control flow are all
    // untouched. Redefining the predicate — gating on the legacy table being
    // empty rather than on a per-row migrated event — is a segregation-of-duties
    // change to an accounting attestation, and it belongs to SCRUM-231's
    // clean-slate preflight, not to a rider on a write-authority retirement.
    //
    // For whoever picks up that redesign: under SCRUM-231 a migrated legacy row
    // is STILL legacy state and must fail the attestation. The successor is a
    // zero-state proof (`CLEAN_SLATE_V2` or an equivalent durable discriminator
    // persisted on the sign-off), not a migration-completeness proof — so a
    // future reader can tell whether the accountant certified a historical
    // migration or a destructive reset.
    if (unmigratedTransactionCount > 0) {
      throw new ConvexError(
        `Cannot sign off: ${unmigratedTransactionCount} legacy transaction(s) have no accounting event sourced from the legacy ledger. ` +
          "Legacy transaction migration is retired (SCRUM-234), so there is no migration tool to run: these rows must be cleared " +
          "by the clean-slate accounting reset (orgFinancialReset.resetOrgFinancialData, which lists `transactions` in RESET_TABLES) " +
          "before cutover can be signed off. That reset is gated on SCRUM-231 and is not authorized on its own."
      );
    }
    if (!isBalanced) {
      const badCurrencies = trialBalanceByCurrency.filter((b) => !b.isBalanced).map((b) => b.currency);
      throw new ConvexError(`Cannot sign off: the trial balance is unbalanced for: ${badCurrencies.join(", ")}.`);
    }

    // Segregation of duties: the sign-off can't be self-certified by the
    // same person who approved (posted) the org's opening balance — an
    // independent reviewer must confirm the starting position, not the
    // person who set it.
    // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
    const openingBalanceJournal = await findPostedOpeningBalanceJournal(ctx, args.orgId);
    if (openingBalanceJournal && openingBalanceJournal.postedBy === user._id) {
      throw new ConvexError(
        "Cannot sign off: the signer must be different from whoever approved and posted the opening balance."
      );
    }

    const snapshot = {
      legacyTransactionCount: activeLegacy.length,
      migratedTransactionCount: migratedCount,
      unmigratedTransactionCount,
      trialBalanceByCurrency,
      isBalanced,
    };

    const signOffId = await ctx.db.insert("accountingCutoverSignOffs", {
      orgId: args.orgId,
      snapshot,
      notes: args.notes,
      signedOffBy: user._id,
      signedOffAt: Date.now(),
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "POST_EVENT",
      resourceType: "accountingCutoverSignOffs",
      resourceId: signOffId.toString(),
      description: `Accounting cutover signed off: ${snapshot.migratedTransactionCount}/${snapshot.legacyTransactionCount} legacy transactions migrated, trial balance ${snapshot.isBalanced ? "balanced" : "UNBALANCED"}.`,
      after: snapshot,
    });

    return { signOffId: signOffId.toString(), snapshot };
  },
});

export const listSignOffs = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("accountingCutoverSignOffs")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();
  },
});
