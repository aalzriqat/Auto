import type { DealCostAccounting } from "./dealCostAccounting";
import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { PERMISSIONS } from "../permissions";
import { APPLICATION_NOT_FOUND, CUSTODY_NOT_FOUND } from "./dealCostGuards";
import { assertCustodyOnLedger, assertNotCustodian } from "./custodyRecords";
import { ConvexError } from "convex/values";
import { loadActiveFees, summarizeReadableCustody } from "../settlementDeductions";
import { assertRt11DoorAllowed } from "../rt11DoorContainment";
import { runWithIdempotency } from "../idempotency";
import { assertCustodyAccountingReady } from "./dealCostAccounting";
import { assertStoredVersion, custodyPositionDependencies, nextStoredVersion } from "../custodySourceLedger";
import { hookCustodyWriteOffReversed, hookCustodyWrittenOff } from "../../accounting/workflowHooks";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { assertNoActiveDealUnwind } from "../dealUnwindGuard";

/**
 * Closes a custody record once nothing is outstanding in either direction.
 *
 * Refuses while the employee still holds money OR the dealership still owes
 * them. The second half is the one worth stating: a record where the dealership
 * owes 50 is not "reconciled with a small variance", it is an unpaid debt to a
 * person, and closing it would quietly write that debt off.
 */
export async function reconcileDealCustodyHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    custodyId: Id<"financeDealCustody">;
    notes: string;
    writeOffReason?: string;
    idempotencyKey: string;
  },
  accounting: DealCostAccounting
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [
    PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
  ]);
  const owned = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeDealCustody",
    args.custodyId,
    CUSTODY_NOT_FOUND
  );
  // Authority, outside the wrapper: the holder never closes their own
  // record, and a replay by the holder is refused the same way.
  assertNotCustodian(owned, user._id, "Closing a custody record");
  const notes = args.notes.trim();
  if (!notes) {
    throw new ConvexError("Record what was checked before closing this custody record.");
  }
  const writeOffReason = args.writeOffReason?.trim() || undefined;
  // A balanced closure stays allowed even when a reason was supplied.
  if (writeOffReason) {
    const summary = summarizeReadableCustody(owned, await loadActiveFees(ctx, owned.applicationId), "closing this custody record");
    if (!summary.settled && summary.employeeOwesDealerMinor > 0 && summary.overReturnedMinor === 0 &&
        summary.reimbursementOutstandingMinor === 0 && summary.reimbursementOverpaidMinor === 0) {
      assertRt11DoorAllowed("CUSTODY_WRITEOFF_PILOT_DISABLED");
    }
  }

  // A closure that writes off posts a journal, and a closure at all is
  // what lets the deal classify — so a lost response must replay the
  // stored outcome rather than refuse on the state it created (final
  // round F). Every mutable-state check is INSIDE the section; the
  // fingerprint is every persisted intent field, normalised as stored.
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "financeDealCosts.reconcileDealCustody",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      fingerprint: JSON.stringify({
        custodyId: args.custodyId,
        notes,
        writeOffReason: writeOffReason ?? null,
      }),
    },
    async () => {
      const custody = await ctx.db.get(args.custodyId);
      if (custody === null) throw new ConvexError(CUSTODY_NOT_FOUND);
      if (custody.status !== "OPEN") {
        throw new ConvexError("This custody record is already closed.");
      }

      const fees = await loadActiveFees(ctx, custody.applicationId);
      const summary = summarizeReadableCustody(custody, fees, "closing this custody record");

      // A write-off is the dealership absorbing a loss. It is NOT a way to stop
      // owing somebody: money the dealership owes an employee, closed unpaid, is
      // just a decision not to pay a person — and the classification gate would
      // then wave the deal through as settled. That direction has to be paid or
      // explicitly reversed.
      if (summary.reimbursementOutstandingMinor > 0) {
        throw new ConvexError(
          `${summary.reimbursementOutstandingMinor} minor units are still owed to this person. Record the reimbursement before closing — a debt owed to an employee cannot be written off here.`
        );
      }
      if (summary.reimbursementOverpaidMinor > 0) {
        throw new ConvexError(
          `This person has been reimbursed ${summary.reimbursementOverpaidMinor} minor units more than they were owed. Reverse the duplicate movement before closing.`
        );
      }
      if (!summary.settled && !writeOffReason) {
        throw new ConvexError(
          `This custody record does not balance. ${summary.employeeOwesDealerMinor} minor units are still unaccounted for — record the receipts or the returned balance. To close it anyway, record a write-off reason.`
        );
      }

      const now = Date.now();
      const writingOff = Boolean(writeOffReason) && !summary.settled;
      if (writingOff) {
        // The only residual a write-off may absorb is cash the employee holds
        // and cannot account for. An over-return is a log that cannot be true,
        // not a shortage, and is corrected rather than expensed.
        if (summary.overReturnedMinor > 0 || summary.employeeOwesDealerMinor <= 0) {
          throw new ConvexError(
            "This record's movements contradict each other (more returned than issued). Reverse the movement that is wrong; there is no shortage to write off."
          );
        }
        assertCustodyOnLedger(custody, "writing off its shortage");
        await assertCustodyAccountingReady(ctx, args.orgId, "writing off a custody shortage", accounting);
        const version = nextStoredVersion(custody.writeOffPostingVersion, "This custody record", "writing off a custody shortage");
        await hookCustodyWrittenOff(ctx, {
          orgId: args.orgId,
          custody,
          version,
          amountMinor: summary.employeeOwesDealerMinor,
          reason: writeOffReason!,
          actorId: user._id,
          occurredAt: now,
          // The residual is what these leave; the write-off follows them.
          dependencies: await custodyPositionDependencies(ctx, custody, "writing off a custody shortage"),
        });
        await ctx.db.patch(args.custodyId, {
          writeOffPosted: { version, amountMinor: summary.employeeOwesDealerMinor, occurredAt: now },
          writeOffPostingVersion: version,
        });
      }
      await ctx.db.patch(args.custodyId, {
        status: writingOff ? "WRITTEN_OFF" : "RECONCILED",
        reconciledAt: now,
        reconciledBy: user._id,
        reconciliationNotes: notes,
        writeOffReason: writingOff ? writeOffReason : undefined,
        updatedAt: now,
      });
      return args.custodyId;
    }
  );
}

/**
 * Reopens a closed custody record so it can be corrected.
 *
 * The mutation the closed path always needed. Without it, a late receipt
 * recorded against a reconciled record left it stored as balanced while the
 * arithmetic said the employee was out of pocket — and every route to fixing it
 * refused, with an error naming this function before it existed.
 */
export async function reopenDealCustodyHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    custodyId: Id<"financeDealCustody">;
    reason: string;
  }
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [
    PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
  ]);
  const custody = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeDealCustody",
    args.custodyId,
    CUSTODY_NOT_FOUND
  );
  assertRt11DoorAllowed("CUSTODY_REOPEN_PILOT_DISABLED");
  if (custody.status === "OPEN") return args.custodyId;
  // Reopening puts the record back where its holder can be reimbursed
  // from it; the holder does not reopen their own (final round E).
  assertNotCustodian(custody, user._id, "Reopening a custody record");
  const reason = args.reason.trim();
  if (!reason) {
    throw new ConvexError("Say why this custody record is being reopened.");
  }
  // The write-off version the row claims is proven a version before the
  // reversal is pinned to it (R7, F4): a NaN pin reverses nothing and
  // reports the loss withdrawn while Cash Over/Short still carries it.
  if (custody.writeOffPosted) {
    assertStoredVersion(custody.writeOffPosted.version, "This custody record's write-off posting", "reopening this custody record");
  }
  // The parent the stored row names is proven this org's BEFORE anything is
  // written (R8, F2): an owned custody row whose `applicationId` was
  // re-pointed at another tenant's deal would otherwise leave an audit row
  // against that deal and reverse a posted write-off. A missing or foreign
  // parent refuses here, with the override, the reversal and the status
  // patch all still unwritten.
  await requireOwnedRow(ctx, args.orgId, "financeApplications", custody.applicationId, APPLICATION_NOT_FOUND);
  // SCRUM-693 D2: an unwind proves the deal's custody closed at start and
  // again at finish; a reopen in between would race that proof.
  await assertNoActiveDealUnwind(ctx, args.orgId, custody.applicationId);

  // Reopening undoes a reconciliation somebody signed off, so it leaves a
  // row. (It no longer withdraws a classification: closing readiness is
  // re-derived from the live rows, so the open record is seen at once —
  // SCRUM-407.)
  await ctx.db.insert("financeApplicationOverrides", {
    orgId: args.orgId,
    applicationId: custody.applicationId,
    field: "financeDealCustody.status",
    // The whole of what the patch below erases, not just the status. A
    // write-off reason is the business justification for a loss the
    // dealership absorbed; losing it makes that loss unexplainable.
    previousValue: `${custody.status} (write-off: ${custody.writeOffReason ?? "none"}; notes: ${custody.reconciliationNotes ?? "none"})`,
    newValue: "OPEN",
    reason,
    changedBy: user._id,
    changedAt: Date.now(),
  });

  // A written-off shortage goes back onto the employee's clearing balance:
  // the loss was booked on the strength of a closure that is now withdrawn.
  if (custody.writeOffPosted) {
    await hookCustodyWriteOffReversed(ctx, {
      orgId: args.orgId,
      custodyId: custody._id,
      version: custody.writeOffPosted.version,
      reason: `Custody record reopened: ${reason}`,
      actorId: user._id,
      reversalDate: Date.now(),
    });
  }

  await ctx.db.patch(args.custodyId, {
    status: "OPEN",
    reconciledAt: undefined,
    reconciledBy: undefined,
    reconciliationNotes: undefined,
    writeOffReason: undefined,
    writeOffPosted: undefined,
    updatedAt: Date.now(),
  });
  return args.custodyId;
}
