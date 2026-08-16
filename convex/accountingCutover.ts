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
import { requireTenantAuth } from "./utils/tenancy";
import { isSystemOwnerRole, PERMISSIONS } from "./utils/permissions";
import { getOpenPeriodForDate } from "./accountingPeriods";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { validateManualJournalLines, auditLog, type ManualJournalLine } from "./financialAudit";
import { toMinorUnits, denominationOf } from "./utils/money";
import { Doc, Id } from "./_generated/dataModel";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";

/**
 * One refusal, worded for the two things that are actually different to the
 * person reading it: nothing was ever recorded, versus something was recorded
 * that AutoFlow will not price.
 *
 * Both are dead ends only if rejection is unavailable, and it is not —
 * `rejectOpeningBalanceDraft` stays open on every path, so the org re-submits
 * in a supported currency rather than being stuck.
 */
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

async function hasOpeningBalanceCommitment(ctx: QueryCtx, orgId: Id<"organizations">): Promise<boolean> {
  const postedJournal = await ctx.db
    .query("journalEntries")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .filter((q) => q.and(q.eq(q.field("category"), "OPENING_BALANCE"), q.eq(q.field("status"), "POSTED")))
    .first();
  if (postedJournal) return true;
  const pendingDraft = await ctx.db
    .query("openingBalanceDrafts")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING_APPROVAL"))
    .first();
  return pendingDraft !== null;
}

export const draftOpeningBalance = mutation({
  args: {
    orgId: v.id("organizations"),
    lines: v.array(v.object({
      accountId: v.id("chartOfAccounts"),
      debitMinor: v.number(),
      creditMinor: v.number(),
      description: v.optional(v.string()),
    })),
    asOfDate: v.number(),
    memo: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ draftId: string }> => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (await hasOpeningBalanceCommitment(ctx, args.orgId)) {
      throw new ConvexError("An opening balance has already been posted or is awaiting approval for this organization.");
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
      const account = await ctx.db.get(line.accountId);
      if (!account || account.orgId !== args.orgId) {
        throw new ConvexError(`Account ${line.accountId} not found in this organization.`);
      }
      if (!account.active) {
        throw new ConvexError(`Account "${account.name}" is inactive and cannot carry an opening balance. Reactivate it first or use a different account.`);
      }
    }

    if (!(await getOpenPeriodForDate(ctx, args.orgId, args.asOfDate))) {
      throw new ConvexError("No open accounting period covers the opening-balance date. Create and open a period first.");
    }

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

    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.orgId !== args.orgId) {
      throw new ConvexError("Opening balance draft not found.");
    }
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

  const totalDebits = validateManualJournalLines(draft.lines as ManualJournalLine[]);

  // Re-validate at approval time — an account may have been deactivated
  // between draft and approval (mirrors resolveManualJournalCurrency).
  for (const line of draft.lines) {
    const account = await ctx.db.get(line.accountId);
    if (!account || account.orgId !== orgId) {
      throw new ConvexError(`Account ${line.accountId} not found in this organization.`);
    }
    if (!account.active) {
      throw new ConvexError(`Account "${account.name}" is inactive and cannot carry an opening balance. Reactivate it first or use a different account.`);
    }
  }

  const period = await getOpenPeriodForDate(ctx, orgId, draft.asOfDate);
  if (!period) {
    throw new ConvexError("No open accounting period covers the opening-balance date. Create and open a period first.");
  }

  // The denomination the lines were ENTERED in, never the org's current one.
  // The two can differ: orgSettings locks the org currency only once a row
  // exists in one of six financial tables, and openingBalanceDrafts is not among
  // them — so a fresh org can draft in JOD, switch to USD, then approve. Since
  // minor-unit scale is per-currency (3 for JOD/KWD/BHD/OMR, 2 otherwise),
  // posting at the current currency would silently turn 1,000.000 JOD into
  // 10,000.00 USD across the org's entire starting position.
  //
  // And it is resolved through `denominationOf`, the shared fail-closed
  // authority, rather than by taking the string at its word. `scaleForCurrency`
  // answers 2 for ANYTHING it does not recognise (`utils/money.ts:110`) — a
  // deliberate choice for display code that must not crash, and the wrong one
  // here, where the guess would post the org's entire starting position an
  // order of magnitude out. `denominationOf` refuses absent, unsupported and
  // non-canonical spellings alike, and hands back the scale it vouched for.
  //
  // This is the CHOKEPOINT both routes share, so neither can post on a guess
  // even if a future caller forgets the boundary check. There is no fallback to
  // the org currency: a draft with no recorded denomination cannot have one
  // re-derived — the org's current setting is a known-wrong answer, not a
  // conservative one, which is the whole subject of SCRUM-62.
  const denomination = denominationOf(draft.currency);
  if (denomination === null) {
    throw new ConvexError(unvouchableDenominationMessage(draft.currency));
  }
  const currency = denomination.code;
  const now = Date.now();

  const journalId = await ctx.db.insert("journalEntries", {
    orgId,
    periodId: period._id,
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

  // The scale the authority vouched for, not a second lookup that could answer
  // differently from the code above.
  const scale = denomination.scale;
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
    });
    // GL Phase 18: this is a direct journalLines insert (not routed through
    // postAccountingEvent), so it must keep the running snapshot in sync
    // itself, exactly like postingEngine.ts and reversals.ts do.
    await incrementAccountSnapshot(ctx, {
      orgId,
      accountId: line.accountId,
      currency,
      periodId: period._id,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
    });
  }

  await ctx.db.patch(draft._id, {
    status: "POSTED",
    reviewedBy: approverId,
    decidedAt: now,
    journalEntryId: journalId,
    autoApproved,
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
    })),
    asOfDate: v.number(),
    memo: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ journalId: string; draftId: string }> => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    if (!isSystemOwnerRole(role)) {
      throw new ConvexError(
        "Only an owner can post an opening balance without a second approver. Save it for approval instead."
      );
    }

    if (await hasOpeningBalanceCommitment(ctx, args.orgId)) {
      throw new ConvexError("An opening balance has already been posted or is awaiting approval for this organization.");
    }

    validateManualJournalLines(args.lines as ManualJournalLine[]);

    // Checked BEFORE the draft row is written, not only inside the shared
    // poster. This path inserts the draft first and posts second; a refusal
    // that arrived only from the poster would still be correct about the money
    // — the whole mutation rolls back — but the boundary is where the caller
    // can see it, and it keeps the owner route holding exactly the same rule as
    // the two-person one instead of inheriting it by accident.
    const orgDenomination = await getOrgCurrency(ctx, args.orgId);
    if (denominationOf(orgDenomination) === null) {
      throw new ConvexError(unvouchableDenominationMessage(orgDenomination));
    }

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

    const draft = await ctx.db.get(args.draftId);
    if (!draft || draft.orgId !== args.orgId) {
      throw new ConvexError("Opening balance draft not found.");
    }
    if (draft.status !== "PENDING_APPROVAL") {
      throw new ConvexError("This opening balance draft has already been resolved.");
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

export const listPendingOpeningBalanceDrafts = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
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

    return await Promise.all(
      drafts.map(async (draft) => {
        // Snapshot first, live lookup only as a fallback for drafts written
        // before the snapshot existed. The live row is the unreliable one:
        // offboarding hard-deletes users (memberships.ts), which would render
        // the preparer as "Unknown" on the very screen where identifying them
        // is the control.
        const preparer = draft.preparedByName ? null : await ctx.db.get(draft.createdBy);
        return {
          ...draft,
          // `null`, never an English literal. The client renders this inside a
          // <bdi> on a screen this PR hardened for Arabic bidi — shipping
          // "Unknown" there would put untranslated English in the RTL run.
          // Translation is the client's job; the server reports absence.
          preparedByName:
            draft.preparedByName || preparer?.name || preparer?.email || null,
          currency: draft.currency ?? orgCurrency,
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
    const existing = await ctx.db
      .query("journalEntries")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.and(q.eq(q.field("category"), "OPENING_BALANCE"), q.eq(q.field("status"), "POSTED")))
      .first();
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
    pendingDraftId: string | null;
    canPostDirectly: boolean;
    canManageFinance: boolean;
    currency: string;
  }> => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const postedEntry = await ctx.db
      .query("journalEntries")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.and(q.eq(q.field("category"), "OPENING_BALANCE"), q.eq(q.field("status"), "POSTED")))
      .first();

    const pending = await ctx.db
      .query("openingBalanceDrafts")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING_APPROVAL"))
      .first();

    const isOwner = isSystemOwnerRole(role);
    const canManageFinance =
      isOwner || role.permissions.includes(PERMISSIONS.MANAGE_FINANCE);

    return {
      posted: postedEntry !== null,
      pendingDraftId: pending?._id.toString() ?? null,
      canPostDirectly: isOwner && canManageFinance,
      canManageFinance,
      // The form converts entered amounts to minor units, and the scale is
      // per-currency (3 for JOD/KWD/BHD/OMR, 2 otherwise). Returned here so the
      // client uses the org's real currency rather than assuming one — getting
      // this wrong posts amounts off by a factor of ten.
      currency: await getOrgCurrency(ctx, args.orgId),
    };
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
    // recording one while transactions remain unmigrated or the trial
    // balance doesn't foot would let the org proceed as if production-ready
    // when it isn't. Neither is overridable here: an incomplete migration or
    // an unbalanced ledger needs to be fixed, not signed off around.
    if (unmigratedTransactionCount > 0) {
      throw new ConvexError(
        `Cannot sign off: ${unmigratedTransactionCount} legacy transaction(s) are still unmigrated. Run the migration tools first.`
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
    const openingBalanceJournal = await ctx.db
      .query("journalEntries")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.and(q.eq(q.field("category"), "OPENING_BALANCE"), q.eq(q.field("status"), "POSTED")))
      .first();
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
