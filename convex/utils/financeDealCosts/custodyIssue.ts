import type { DealCostAccounting } from "./dealCostAccounting";
import { requireOrgMember, requireOwnedRow, requireTenantAuth } from "../tenancy";
import { PERMISSIONS } from "../permissions";
import {
  APPLICATION_NOT_FOUND,
  assertDealAcceptsNewCustodyCash,
  assertNotFuture,
  assertTimestamp,
} from "./dealCostGuards";
import { assertMinorAmount } from "../financingEconomics";
import { ConvexError } from "convex/values";
import { runWithIdempotency } from "../idempotency";
import { custodyFor, requireCustodyBank, requireCustodyMethod } from "./custodyRecords";
import { AppErrorCode } from "../errors";
import { postCustodyEntry } from "./custodyPosting";
import { assertCustodyAccountingReady } from "./dealCostAccounting";
import { resolveDealCurrency } from "../settlementDeductions";
import { recomputeCustodyTotals } from "./custodyLedger";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";

/**
 * Opens a custody record for an employee sent out to pay a deal's costs.
 *
 * One open record per employee per deal: a second would let the same receipt be
 * reconciled twice and make "what is this person holding" ambiguous.
 */
export async function openDealCustodyHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    userId: Id<"users">;
    issuedMinor: number;
    bankAccountId?: Id<"bankAccounts">;
    method?: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";
    reference?: string;
    note?: string;
    occurredAt?: number;
    idempotencyKey: string;
  },
  accounting: DealCostAccounting
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [
    PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
  ]);
  const app = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeApplications",
    args.applicationId,
    APPLICATION_NOT_FOUND
  );
  assertMinorAmount(args.issuedMinor, "Issued amount");
  if (args.issuedMinor <= 0) {
    throw new ConvexError("The amount handed over must be greater than zero.");
  }

  // The sole record of cash handed to a person. Letting the same someone
  // issue it to themselves, reimburse themselves and close the record is an
  // uncontrolled loop around the one control this table provides — the same
  // separation the approval path already enforces.
  if (args.userId === user._id) {
    throw new ConvexError(
      "Custody has to be issued by somebody other than the person receiving it."
    );
  }

  assertTimestamp(args.occurredAt, "The movement date");
  assertNotFuture(args.occurredAt, Date.now(), "The movement date");

  // The one-open-record rule stops a retry creating a second custody, so the
  // key is not what protects the money here — it is what makes the retry
  // return the record instead of an error about a record the caller's own
  // first attempt created.
  //
  // Which is why the rule lives INSIDE the callback. Checked before the
  // wrapper it ran on every replay, found the row the first attempt had just
  // inserted, and threw the exact error the key exists to prevent — the
  // comment here described behaviour the ordering made impossible. A replay
  // never reaches the callback, so it returns the stored id; a genuine second
  // request does reach it, and still fails.
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "financeDealCosts.openDealCustody",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // EVERY persisted intent field, normalised as it is stored (final
      // round D): the note is on the entry, so a retry carrying a
      // different note under the same key is a different intent.
      fingerprint: JSON.stringify({
        applicationId: args.applicationId,
        userId: args.userId,
        issuedMinor: args.issuedMinor,
        method: args.method ?? null,
        ...(args.bankAccountId ? { bankAccountId: args.bankAccountId } : {}),
        reference: args.reference?.trim() || null,
        note: args.note?.trim() || null,
        occurredAt: args.occurredAt ?? null,
      }),
    },
    async () => {
      // A payment method belongs to a NEW money movement (SCRUM-469). It is
      // checked INSIDE the section, not before it: a command that already
      // completed (a pre-deploy client sent none) must replay its stored
      // result, and only a genuinely new command is refused. The refusal is an
      // uncaught throw, so the STARTED row rolls back with the transaction.
      requireCustodyMethod(args.method, "handing cash to an employee");
      // ⚠️ Every MUTABLE-state check is inside the section (Codex
      // AF-CUST-06): a replay of an issuance that succeeded must return the
      // stored record even if the recipient has since begun offboarding, the
      // deal has since finalized or the chart has since changed — refusing
      // it would tell the operator the cash never left when it did.
      //
      // The recipient must be a member of this organization. Without this a
      // caller could hand custody — and a reimbursement claim — to a user id
      // from another tenant. The shared helper also rejects a membership
      // mid-offboarding: cash handed to somebody on the way out leaves a
      // balance they can never return, reconcile or claim against themselves.
      await requireOrgMember(
        ctx,
        args.orgId,
        args.userId,
        AppErrorCode.ASSIGNED_USER_NOT_MEMBER,
        "That person is not a member of this organization."
      );
      // Fresh cash for a finalized, closed, cancelled or rejected deal is a
      // new economic fact on a deal with no handover to fund, not the
      // settlement of an existing one (R5, F3).
      assertDealAcceptsNewCustodyCash(app, "handing cash to an employee");
      // Cash leaves the drawer here. Refused before anything is written when
      // the ledger cannot take the posting.
      await assertCustodyAccountingReady(ctx, args.orgId, "handing cash to an employee", accounting);
      const existing = (await custodyFor(ctx, args.applicationId, "opening custody on this deal")).find(
        (row) => row.userId === args.userId && row.status === "OPEN"
      );
      if (existing) {
        throw new ConvexError(
          "This person already holds an open custody record on this deal. Record the money against that one."
        );
      }


      const currency = await resolveDealCurrency(ctx, app, "opening custody on this deal");
      const bankAccountId = await requireCustodyBank(ctx, args.orgId, "ISSUED", args.method, args.bankAccountId, currency);
      const now = Date.now();
      const custodyId = await ctx.db.insert("financeDealCustody", {
        orgId: args.orgId,
        applicationId: args.applicationId,
        userId: args.userId,
        currency,
        issuedMinor: 0,
        returnedMinor: 0,
        reimbursedMinor: 0,
        status: "OPEN",
        // Opened by a writer that posts: every movement on this record has
        // a journal behind it. A record without the marker predates that.
        ledgerPosting: "CANONICAL",
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      });

      const entryId = await ctx.db.insert("financeDealCustodyEntries", {
        orgId: args.orgId,
        custodyId,
        kind: "ISSUED",
        amountMinor: args.issuedMinor,
        method: args.method,
        bankAccountId,
        reference: args.reference?.trim() || undefined,
        note: args.note?.trim() || undefined,
        occurredAt: args.occurredAt ?? now,
        recordedBy: user._id,
        recordedAt: now,
      });
      await recomputeCustodyTotals(ctx, custodyId);
      await postCustodyEntry(ctx, custodyId, entryId, user._id);
      return custodyId;
    }
  );
}

/**
 * Who may be handed this deal's cash: the org's active members, by display
 * name only. Its own read, shaped for the money permission (ACC-10): the
 * general member list needs VIEW_USERS and serves addresses, images and
 * roles, none of which the person handing over cash needs — and a
 * disbursement confirmer without VIEW_USERS would otherwise have a picker
 * with nobody in it. Bounded; a dealership past the cap gets a prefix and
 * the flag, never a refusal on the deal screen.
 *
 * The caller is in the list, MARKED (`isActor`), because the two doors this
 * feeds draw different lines: a plan may name anyone, the actor included
 * (`planCustodyHandler` has no self rule — a plan moves no money), while an
 * issuance is refused to the person issuing it (`openDealCustody`). The
 * issuance picker withholds the marked row so it never offers a choice the
 * server refuses; the plan picker serves the whole list.
 */
export const MAX_CUSTODY_CANDIDATES = 200;

export async function listCustodyCandidatesHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
  }
) {
  const { user: actor } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]);
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .take(MAX_CUSTODY_CANDIDATES + 1);
  const candidates: Array<{ userId: Id<"users">; name: string; isActor: boolean }> = [];
  for (const membership of memberships.slice(0, MAX_CUSTODY_CANDIDATES)) {
    // The same rule `requireOrgMember` applies to the recipient: a
    // membership mid-offboarding cannot be handed cash.
    if (membership.offboardingStatus) continue;
    const user = await ctx.db.get(membership.userId);
    if (user === null) continue;
    candidates.push({ userId: membership.userId, name: user.name ?? "", isActor: membership.userId === actor._id });
  }
  // The caller by id, independent of the cap: a caller past it is absent
  // from `candidates`, and a reader deciding "is this record the caller's
  // own?" must not read that absence as "not the caller" (SCRUM-439).
  return { actorId: actor._id, candidates, truncated: memberships.length > MAX_CUSTODY_CANDIDATES };
}

/**
 * Names who will handle this deal's finalization payments, BEFORE any cash
 * moves — or withdraws that plan. A plan and nothing else: no custody record,
 * no entry, no posting; `openDealCustody` is where money changes hands and it
 * may name somebody else. Refused once an open custody record exists on the
 * deal, because at that point the plan is history and the record is the fact.
 */
export async function planDealCustody(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    userId?: Id<"users">;
    amountMinor?: number;
    note?: string;
  }
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [
    PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
  ]);
  const app = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeApplications",
    args.applicationId,
    APPLICATION_NOT_FOUND
  );
  if (app.status === "CLOSED" || app.status === "CANCELLED" || app.status === "REJECTED") {
    throw new ConvexError("This deal is closed or stopped; its handover is not being planned.");
  }
  if (args.amountMinor !== undefined) {
    assertMinorAmount(args.amountMinor, "Planned amount");
    if (args.amountMinor <= 0) throw new ConvexError("The planned amount must be greater than zero.");
  }
  if (args.userId !== undefined) {
    await requireOrgMember(
      ctx,
      args.orgId,
      args.userId,
      AppErrorCode.ASSIGNED_USER_NOT_MEMBER,
      "That person is not a member of this organization."
    );
  }
  const openCustody = (await custodyFor(ctx, args.applicationId, "planning this deal's custody")).find(
    (row) => row.status === "OPEN"
  );
  if (openCustody) {
    throw new ConvexError(
      "Cash is already in an employee's custody on this deal. Settle that record before changing who handles the handover."
    );
  }
  const now = Date.now();
  const previous = app.plannedCustody;
  const next =
    args.userId === undefined
      ? undefined
      : {
          userId: args.userId,
          amountMinor: args.amountMinor,
          note: args.note?.trim() || undefined,
          plannedBy: user._id,
          plannedAt: now,
        };
  if (previous === undefined && next === undefined) return args.applicationId;
  await ctx.db.insert("financeApplicationOverrides", {
    orgId: args.orgId,
    applicationId: args.applicationId,
    field: "plannedCustody",
    previousValue: previous ? `${previous.userId} (${previous.amountMinor ?? "no amount"})` : undefined,
    newValue: next ? `${next.userId} (${next.amountMinor ?? "no amount"})` : "none",
    reason: next ? "Handover custody handler planned." : "Handover custody plan withdrawn.",
    changedBy: user._id,
    changedAt: now,
  });
  await ctx.db.patch(args.applicationId, { plannedCustody: next, updatedAt: now });
  return args.applicationId;
}
