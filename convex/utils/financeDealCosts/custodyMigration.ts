import type { DealCostAccounting } from "./dealCostAccounting";
import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { PERMISSIONS } from "../permissions";
import { APPLICATION_NOT_FOUND, CUSTODY_NOT_FOUND, isTimestamp } from "./dealCostGuards";
import {
  assertNotCustodian,
  custodyEntriesFor,
  isRecordedCustodyMethod,
  requireCustodyBank,
} from "./custodyRecords";
import { assertRt11DoorAllowed } from "../rt11DoorContainment";
import { runWithIdempotency } from "../idempotency";
import { ConvexError } from "convex/values";
import { syncCustodyPayable } from "./custodyPosting";
import { assertCustodyAccountingReady } from "./dealCostAccounting";
import { custodyTotalsFromLog } from "./custodyLedger";
import { loadActiveFees, summarizeReadableCustody } from "../settlementDeductions";
import { custodyFeeExpenseKey } from "../dealCustodyPosting";
import {
  custodyEntryPostKey,
  custodyFeePostKey,
  nextStoredVersion,
  type CustodyLedgerDependency,
} from "../custodySourceLedger";
import {
  hookCustodyCashMoved,
  hookCustodyCashReversed,
  hookCustodyFeePaid,
  hookCustodyWrittenOff,
} from "../../accounting/workflowHooks";
import { assertFeeDocWithinBytes, feeAfterPatch } from "../feeDocLimits";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";

/**
 * Posts a custody record from before ledger posting — every cash leg, every
 * reversal, every custody-paid line at its recorded actual and, for a
 * written-off record, the shortage — from the facts already on the record,
 * and only then marks it CANONICAL (final round B).
 *
 * The explicit door `assertCustodyOnLedger` and the family gate point at.
 * Nothing here is inferred: each posting is dated when the record says the
 * money moved (the entry's own date; the line's paid date, or the day it was
 * recorded where no paid date is known; the closure date for a write-off),
 * carries the amount the row carries, and goes through the same hooks the
 * product uses, so a date in a closed month queues exactly as it would have.
 * Where the record contradicts itself — a stored total its own log does not
 * project to, a line that already carries a posting, a write-off with no
 * shortage behind it, a line in another currency or of a treatment custody
 * cannot expense — it is REFUSED with the reason and nothing is posted; the
 * record stays legacy for a person to repair. The one-idempotency-key
 * command replays its stored result; a fresh key against a record already
 * on the ledger is refused, so the family is posted exactly once.
 *
 * Operator authority: confirming disbursements AND managing finance, and
 * never the holder — the same separation every other custody command keeps.
 */
export async function migrateLegacyCustodyToLedgerHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    custodyId: Id<"financeDealCustody">;
    idempotencyKey: string;
  },
  accounting: DealCostAccounting
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [
    PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    PERMISSIONS.MANAGE_FINANCE,
  ]);
  const owned = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeDealCustody",
    args.custodyId,
    CUSTODY_NOT_FOUND
  );
  assertNotCustodian(owned, user._id, "Migrating a custody record to the ledger");
  assertRt11DoorAllowed("CUSTODY_MIGRATION_PILOT_DISABLED");

  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "financeDealCosts.migrateLegacyCustodyToLedger",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      fingerprint: JSON.stringify({ custodyId: args.custodyId }),
    },
    async () => {
      const custody = await ctx.db.get(args.custodyId);
      if (custody === null) throw new ConvexError(CUSTODY_NOT_FOUND);
      if (custody.ledgerPosting === "CANONICAL") {
        throw new ConvexError("This custody record is already on the ledger; there is nothing to migrate.");
      }
      await assertCustodyAccountingReady(ctx, args.orgId, "migrating this custody record to the ledger", accounting);
      // The deal the family is posted against must exist in this org (R6,
      // F3) — proven before the first leg posts, so an orphaned or
      // re-pointed record is refused whole and nothing reaches the books.
      const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", custody.applicationId, APPLICATION_NOT_FOUND);

      // The log, proven in full, must project to exactly the totals the
      // row claims — a disagreement is a record somebody has to look at.
      const entries = await custodyEntriesFor(ctx, args.custodyId, "migrating this custody record");
      const projected = custodyTotalsFromLog(entries, custody);
      if (
        projected.issuedMinor !== custody.issuedMinor ||
        projected.returnedMinor !== custody.returnedMinor ||
        projected.reimbursedMinor !== custody.reimbursedMinor
      ) {
        throw new ConvexError(
          `This custody record's stored totals (issued ${custody.issuedMinor}, returned ${custody.returnedMinor}, reimbursed ${custody.reimbursedMinor}) do not match its own movement log (${projected.issuedMinor}, ${projected.returnedMinor}, ${projected.reimbursedMinor}), so it cannot be migrated as it stands. Correct the record first; nothing has been posted.`
        );
      }
      // A payment method is an attribute of ONE money movement and is never
      // inferred (SCRUM-469): a leg with no recorded instrument would be booked
      // to CASH_ON_HAND by the posting rules. Every non-reversal entry is
      // proven BEFORE the first leg posts, so the record is refused whole and
      // nothing reaches the books.
      const methodless = entries.filter(
        (entry) => entry.kind !== "REVERSAL" && !isRecordedCustodyMethod(entry.method)
      );
      if (methodless.length > 0) {
        const named = methodless
          .map((entry) => `${entry.kind} ${entry.amountMinor} on ${new Date(entry.occurredAt).toISOString().slice(0, 10)} (${entry._id})`)
          .join("; ");
        throw new ConvexError(
          `${methodless.length === 1 ? "A movement" : `${methodless.length} movements`} on this custody record has no method recorded (cash, bank transfer, cheque or card), so it cannot be posted to the ledger without guessing the account: ${named}. Have the movement reviewed and its method recorded; nothing has been posted.`
        );
      }
      for (const entry of entries) {
        if (entry.kind === "REVERSAL") continue;
        await requireCustodyBank(ctx, args.orgId, entry.kind, entry.method, entry.bankAccountId, custody.currency);
      }
      const fees = await loadActiveFees(ctx, custody.applicationId);
      const linked = fees.filter((fee) => fee.custodyId === custody._id);
      for (const fee of linked) {
        if (fee.custodyPosted !== undefined) {
          throw new ConvexError(
            "A cost charged to this custody record already carries a custody posting, which a record from before ledger posting cannot have. Have the record reviewed; nothing has been posted."
          );
        }
        if (fee.currency !== custody.currency) {
          throw new ConvexError(
            `A cost charged to this custody record is in ${fee.currency} while the record is in ${custody.currency}; it cannot be posted against the record. Correct the line first; nothing has been posted.`
          );
        }
        if (fee.paidBy !== "EMPLOYEE" || fee.deductedFromSettlement) {
          throw new ConvexError(
            "A cost charged to this custody record is not recorded as paid by the employee out of custody (or is deducted from the settlement), so it cannot be posted against the record. Correct the line first; nothing has been posted."
          );
        }
        const expense = custodyFeeExpenseKey(fee.accountingTreatment);
        if (expense.systemKey === null) throw new ConvexError(expense.refusal);
      }
      // Every balance below is read through the same readable-summary
      // contract the writers use; an unreadable amount refuses here.
      const summary = summarizeReadableCustody(custody, fees, "migrating this custody record");
      if (custody.status === "WRITTEN_OFF") {
        if (custody.writeOffPosted !== undefined) {
          throw new ConvexError(
            "This custody record already carries a write-off posting, which a record from before ledger posting cannot have. Have the record reviewed; nothing has been posted."
          );
        }
        if (summary.overReturnedMinor > 0 || summary.employeeOwesDealerMinor <= 0) {
          throw new ConvexError(
            "This custody record is marked written off, but its movements and costs leave no shortage to write off. Have the record reviewed; nothing has been posted."
          );
        }
      }

      // Cash legs first, each dated when the record says the cash moved;
      // then the reversals, each cancelling its target's journal (or its
      // still-queued post) the way the product's own reversal does.
      const byId = new Map(entries.map((entry) => [entry._id, entry]));
      // Every posting the family's payable position is a consequence of;
      // the delta at the end is chained behind all of them, so a leg or a
      // line dated into a closed month holds the payable with it.
      const payableDependencies: CustodyLedgerDependency[] = [];
      const reversedEntryIds = new Set(
        entries.filter((entry) => entry.kind === "REVERSAL").map((entry) => entry.reversesEntryId)
      );
      let cashLegs = 0;
      let reversals = 0;
      for (const entry of entries) {
        if (entry.kind === "REVERSAL") continue;
        await hookCustodyCashMoved(ctx, { orgId: args.orgId, entry, custody, kind: entry.kind, actorId: user._id });
        payableDependencies.push({
          must: reversedEntryIds.has(entry._id) ? "OFF_BOOKS" : "SETTLED",
          idempotencyKey: custodyEntryPostKey(entry._id),
        });
        cashLegs += 1;
      }
      for (const entry of entries) {
        if (entry.kind !== "REVERSAL") continue;
        // Proven by `custodyTotalsFromLog` above: present, on this record, not itself a reversal.
        const target = byId.get(entry.reversesEntryId!)!;
        if (target.kind === "REVERSAL") throw new ConvexError("A reversal on this custody record names another reversal.");
        await hookCustodyCashReversed(ctx, {
          orgId: args.orgId,
          entryId: target._id,
          kind: target.kind,
          reversalEntryId: entry._id,
          reason: entry.note?.trim() || "Custody movement reversed (posted by the custody accounting migration).",
          actorId: user._id,
          reversalDate: entry.occurredAt,
        });
        reversals += 1;
      }

      // The custody-paid lines, at their recorded actuals.
      let feesPosted = 0;
      let latestFact = entries.reduce((latest, entry) => Math.max(latest, entry.occurredAt), 0);
      for (const fee of linked) {
        if (fee.actualAmountMinor === undefined || fee.actualAmountMinor <= 0) continue;
        const version = nextStoredVersion(fee.custodyPostingVersion, "A cost charged to this custody record", "migrating this custody record");
        const occurredAt = fee.paidAt !== undefined && isTimestamp(fee.paidAt) ? fee.paidAt : fee.createdAt;
        latestFact = Math.max(latestFact, occurredAt);
        await hookCustodyFeePaid(ctx, {
          orgId: args.orgId,
          fee,
          custodyId: custody._id,
          vehicleId: app.vehicleId,
          version,
          amountMinor: fee.actualAmountMinor,
          actorId: user._id,
          occurredAt,
        });
        const migratedPatch = {
          custodyPosted: { version, amountMinor: fee.actualAmountMinor, custodyId: custody._id, occurredAt },
          custodyPostingVersion: version,
          updatedAt: Date.now(),
        };
        assertFeeDocWithinBytes(feeAfterPatch(fee, migratedPatch), "migrating this custody record");
        await ctx.db.patch(fee._id, migratedPatch);
        payableDependencies.push({ must: "SETTLED", idempotencyKey: custodyFeePostKey(fee._id, version) });
        feesPosted += 1;
      }

      // The shortage a written-off record absorbed, dated at its closure.
      let writeOffPosted = false;
      if (custody.status === "WRITTEN_OFF") {
        const version = nextStoredVersion(custody.writeOffPostingVersion, "This custody record", "migrating this custody record");
        const occurredAt = custody.reconciledAt ?? custody.updatedAt;
        latestFact = Math.max(latestFact, occurredAt);
        await hookCustodyWrittenOff(ctx, {
          orgId: args.orgId,
          custody,
          version,
          amountMinor: summary.employeeOwesDealerMinor,
          reason: custody.writeOffReason?.trim() || "Custody shortage written off (posted by the custody accounting migration).",
          actorId: user._id,
          occurredAt,
          // Every leg and line posted above: the shortage is what they leave.
          dependencies: [...payableDependencies],
        });
        await ctx.db.patch(args.custodyId, {
          writeOffPosted: { version, amountMinor: summary.employeeOwesDealerMinor, occurredAt },
          writeOffPostingVersion: version,
        });
        writeOffPosted = true;
      }

      // The marker LAST, once every fact is on the books or queued — and
      // then the payable position the family leaves, dated at the latest
      // fact it is made of. `syncCustodyPayable` posts only for a CANONICAL
      // record, which is exactly what this record has just become.
      await ctx.db.patch(args.custodyId, { ledgerPosting: "CANONICAL", updatedAt: Date.now() });
      await syncCustodyPayable(ctx, args.custodyId, user._id, latestFact > 0 ? latestFact : Date.now(), payableDependencies);
      return { custodyId: args.custodyId, cashLegs, reversals, feesPosted, writeOffPosted };
    }
  );
}
