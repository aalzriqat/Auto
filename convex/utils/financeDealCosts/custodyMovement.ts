import type { DealCostAccounting } from "./dealCostAccounting";
import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { PERMISSIONS } from "../permissions";
import {
  APPLICATION_NOT_FOUND,
  assertDealAcceptsNewCustodyCash,
  assertNotFuture,
  assertTimestamp,
  CUSTODY_NOT_FOUND,
  dealEconomicsFrozen,
} from "./dealCostGuards";
import { assertRt11DoorAllowed } from "../rt11DoorContainment";
import { assertMinorAmount } from "../financingEconomics";
import { ConvexError } from "convex/values";
import { runWithIdempotency } from "../idempotency";
import {
  assertCustodyOnLedger,
  assertNotCustodian,
  requireCustodyBank,
  requireCustodyMethod,
} from "./custodyRecords";
import { postCustodyEntry, syncCustodyPayable } from "./custodyPosting";
import { assertCustodyAccountingReady } from "./dealCostAccounting";
import { loadActiveFees, summarizeReadableCustody } from "../settlementDeductions";
import { assertReversalAllowed, recomputeCustodyTotals } from "./custodyLedger";
import { hookCustodyCashReversed } from "../../accounting/workflowHooks";
import { custodyEntryPostKey } from "../custodySourceLedger";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";

/**
 * Records a movement on an open custody record.
 *
 * Every total on the record is the sum of these, so a correction is a further
 * entry rather than an overwrite — the movement that was wrong stays visible
 * alongside the one that fixed it.
 */
export async function recordCustodyMovementHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    custodyId: Id<"financeDealCustody">;
    kind: "ISSUED" | "RETURNED" | "REIMBURSED" | "REVERSAL";
    reversesEntryId?: Id<"financeDealCustodyEntries">;
    amountMinor: number;
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
  const ownedCustody = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeDealCustody",
    args.custodyId,
    CUSTODY_NOT_FOUND
  );
  // RT11-DOORS: before the idempotency claim, which itself writes.
  if (args.kind === "REVERSAL" || args.kind === "REIMBURSED") {
    const parent = await requireOwnedRow(ctx, args.orgId, "financeApplications", ownedCustody.applicationId, APPLICATION_NOT_FOUND);
    if (dealEconomicsFrozen(parent).frozen) {
      assertRt11DoorAllowed("CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED");
    }
  }
  assertMinorAmount(args.amountMinor, "Amount");
  if (args.amountMinor <= 0) {
    throw new ConvexError("The amount must be greater than zero.");
  }
  assertTimestamp(args.occurredAt, "The movement date");
  assertNotFuture(args.occurredAt, Date.now(), "The movement date");
  // Shape-only: a non-reversal naming a target is malformed whatever the
  // state. Every check that reads MUTABLE state lives inside the idempotent
  // section below.
  if (args.kind !== "REVERSAL" && args.reversesEntryId) {
    throw new ConvexError("Only a reversal may name the movement it cancels.");
  }

  // The one that matters most: a retried REIMBURSED records the dealership
  // paying the same person twice. The module surfaces that afterwards as
  // `reimbursementOverpaidMinor` rather than clamping it away, which is right
  // — but detecting a double payment is a worse outcome than not making one.
  //
  // Other state-dependent checks stay inside the callback. RT11-DOORS
  // containment above deliberately precedes even a stored replay. A
  // replay of a movement that already SUCCEEDED must return the stored
  // result, not a refusal describing the state that success created: a
  // RETURNED whose own first attempt filled the advance ("would return more
  // than issued"), a REVERSAL whose target its own first attempt reversed
  // ("already reversed"), a movement whose record was reconciled between the
  // lost response and the retry ("already closed"), an org whose chart was
  // torn down since. Checked before the wrapper, each one threw on the retry
  // and told the operator the money had NOT moved when it had.
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "financeDealCosts.recordCustodyMovement",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // Every persisted intent field (final round D): the note is stored
      // on the entry and, for a reversal, is the reason its journal
      // carries — a note-only change is a different command.
      fingerprint: JSON.stringify({
        custodyId: args.custodyId,
        kind: args.kind,
        reversesEntryId: args.reversesEntryId ?? null,
        amountMinor: args.amountMinor,
        method: args.method ?? null,
        ...(args.bankAccountId ? { bankAccountId: args.bankAccountId } : {}),
        reference: args.reference?.trim() || null,
        note: args.note?.trim() || null,
        occurredAt: args.occurredAt ?? null,
      }),
    },
    async () => {
      // A payment method belongs to a NEW money movement (SCRUM-469), so it is
      // checked inside the section: a completed command replays its stored
      // result even when it was sent without one (a pre-deploy client). A
      // REVERSAL is exempt: it is the inverse of its target's journal.
      if (args.kind !== "REVERSAL") {
        requireCustodyMethod(args.method, "recording this custody movement");
      } else if (args.bankAccountId) {
        throw new ConvexError("A reversal uses the original movement's bank account; do not choose another one.");
      }
      // Re-read inside the section: the row loaded for ownership above is
      // the same row, but the state it carries is what this attempt acts on.
      const current = await ctx.db.get(args.custodyId);
      if (current === null) throw new ConvexError(CUSTODY_NOT_FOUND);
      if (current.status !== "OPEN") {
        throw new ConvexError(
          "This custody record is already closed. Reopen it before recording more movement."
        );
      }
      assertCustodyOnLedger(current, "recording a movement on it");
      assertNotCustodian(current, user._id, "Recording a custody movement");
      // Every kind moves cash or cancels a cash posting; none is recorded
      // operationally without the ledger — see `assertCustodyAccountingReady`.
      await assertCustodyAccountingReady(ctx, args.orgId, "recording this custody movement", accounting);
      // A reimbursement pays a DEBT the record itself states (Codex
      // AF-CUST-02): nothing owed means nothing to pay, and more than is
      // owed is a double payment the module used to merely surface
      // afterwards. Now that it moves real cash it is refused before any
      // write — judged on the live lines inside the transaction, never on a
      // figure the screen carried in.
      if (args.kind === "REIMBURSED") {
        const owed = summarizeReadableCustody(
          current,
          await loadActiveFees(ctx, current.applicationId),
          "reimbursing this employee"
        ).reimbursementOutstandingMinor;
        if (owed <= 0) {
          throw new ConvexError("Nothing is owed to this employee on this custody record; there is no reimbursement to pay.");
        }
        if (args.amountMinor > owed) {
          throw new ConvexError(
            `That would reimburse ${args.amountMinor} minor units against ${owed} owed. Pay what is owed, or correct the costs first.`
          );
        }
      }
      // More cash against an EXISTING record is still fresh cash on a
      // recognized deal — the same door `openDealCustody` closes. Settling
      // what the employee already holds is separate from fresh issuance;
      // RT11-DOORS above gates finalized reimbursement/reversal. Inside the
      // section, like every other
      // state check here, so a replay of an issuance that succeeded before
      // the deal froze still returns its stored result. The parent is
      // loaded through the owned-row check, never optionally: an anchor
      // that is missing or in another organization has no lifecycle to
      // judge, and "nothing to judge" is a refusal, not a pass.
      if (args.kind === "ISSUED") {
        const parentApp = await requireOwnedRow(
          ctx,
          args.orgId,
          "financeApplications",
          current.applicationId,
          APPLICATION_NOT_FOUND
        );
        assertDealAcceptsNewCustodyCash(parentApp, "handing more cash to an employee");
      }
      if (args.kind === "REVERSAL") {
        await assertReversalAllowed(ctx, args.orgId, args.custodyId, args.reversesEntryId, args.amountMinor);
      }
      // A return larger than what was handed over is a typo, not a fact —
      // and left alone it drives the balance negative, so the module then
      // instructs somebody to pay a reimbursement that is not owed.
      if (args.kind === "RETURNED") {
        const projected = current.returnedMinor + args.amountMinor;
        if (projected > current.issuedMinor) {
          throw new ConvexError(
            `That would return ${projected} minor units against ${current.issuedMinor} issued. Correct the issuance first, or reverse the movement that is wrong.`
          );
        }
      }

      const bankAccountId = args.kind === "REVERSAL"
        ? undefined
        : await requireCustodyBank(ctx, args.orgId, args.kind, args.method, args.bankAccountId, current.currency);

      const now = Date.now();
      const entryId = await ctx.db.insert("financeDealCustodyEntries", {
        orgId: args.orgId,
        custodyId: args.custodyId,
        kind: args.kind,
        ...(args.reversesEntryId ? { reversesEntryId: args.reversesEntryId } : {}),
        amountMinor: args.amountMinor,
        method: args.method,
        bankAccountId,
        reference: args.reference?.trim() || undefined,
        note: args.note?.trim() || undefined,
        occurredAt: args.occurredAt ?? now,
        recordedBy: user._id,
        recordedAt: now,
      });
      await recomputeCustodyTotals(ctx, args.custodyId);
      if (args.kind === "REVERSAL") {
        // The reversal's whole accounting effect is the canonical inverse
        // of its target's journal — dated NOW, into an open period, so a
        // correction after a close never rewrites the closed month.
        const target = await ctx.db.get(args.reversesEntryId!);
        if (target === null || target.kind === "REVERSAL") {
          throw new ConvexError("That movement was not found in this organization.");
        }
        await hookCustodyCashReversed(ctx, {
          orgId: args.orgId,
          entryId: target._id,
          kind: target.kind,
          reversalEntryId: entryId,
          reason: args.note?.trim() || "Custody movement reversed.",
          actorId: user._id,
          reversalDate: now,
        });
        // The split follows the position the reversal left, dated with it
        // — and held behind the reversal itself: a DEFERRED one leaves the
        // leg on the books, and the delta must not move the payable while
        // the clearing account still carries the cash.
        await syncCustodyPayable(ctx, args.custodyId, user._id, now, [
          { must: "OFF_BOOKS", idempotencyKey: custodyEntryPostKey(target._id) },
        ]);
      } else {
        await postCustodyEntry(ctx, args.custodyId, entryId, user._id);
      }
      return args.custodyId;
    }
  );
}
