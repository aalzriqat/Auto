import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { ConvexError } from "convex/values";
import { requireOwnedRow } from "../tenancy";
import { custodyEntriesFor } from "./custodyRecords";
import { isMinorAmount } from "../financingEconomics";
import { CUSTODY_NOT_FOUND } from "./dealCostGuards";

/**
 * Whether a reversal may cancel the movement it names.
 *
 * Seven checks that all have to hold before an entry is admitted, lifted out of
 * the handler so the handler reads as: authorize, validate the amount, validate
 * the kind, insert.
 */
export async function assertReversalAllowed(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  custodyId: Id<"financeDealCustody">,
  reversesEntryId: Id<"financeDealCustodyEntries"> | undefined,
  amountMinor: number
): Promise<void> {
  if (!reversesEntryId) {
    throw new ConvexError("Say which movement this reverses.");
  }
  const target = await requireOwnedRow(
    ctx, orgId, "financeDealCustodyEntries", reversesEntryId,
    "That movement was not found in this organization."
  );
  if (target.custodyId !== custodyId) {
    throw new ConvexError("That movement belongs to a different custody record.");
  }
  if (target.kind === "REVERSAL") {
    throw new ConvexError("A reversal cannot itself be reversed. Record the movement again.");
  }
  if (target.amountMinor !== amountMinor) {
    throw new ConvexError(
      `A reversal must cancel the whole movement. That one was ${target.amountMinor} minor units.`
    );
  }
  // "Already reversed?" is one indexed point read (`by_reverses`), the same
  // read the movement log answers it with — not a scan of the whole log.
  const priorReversal = await ctx.db
    .query("financeDealCustodyEntries")
    .withIndex("by_reverses", (q) => q.eq("reversesEntryId", reversesEntryId))
    .first();
  if (priorReversal !== null) {
    throw new ConvexError("That movement has already been reversed.");
  }

  // A reimbursement is calculated against what the person was given: they spent
  // more than the advance, so the difference was paid back to them. Retracting
  // the issuance afterwards leaves that payment standing on a baseline that no
  // longer exists, and the outstanding figure silently re-derives the entire
  // advance as a fresh debt — a settled record turning into "700 still owed"
  // with nobody having moved any money.
  //
  // This is not the totals invariant and cannot be enforced there: zero issued
  // alongside a reimbursement is a perfectly true state on its own, it is what
  // paying out of pocket looks like. What is not true is reaching it by
  // withdrawing the issuance the reimbursement was measured from, so the guard
  // belongs on that dependency.
  if (target.kind !== "ISSUED") return;
  // The whole log, bounded, for the one check that needs it; refused past
  // the cap rather than decided on a prefix.
  const already = await custodyEntriesFor(ctx, custodyId, "reversing this issuance");
  const reversed = new Set(
    already
      .filter((row) => row.kind === "REVERSAL" && row.reversesEntryId)
      .map((row) => row.reversesEntryId!)
  );
  const settledAgainst = already.filter(
    (row) => row.kind === "REIMBURSED" && !reversed.has(row._id)
  );
  if (settledAgainst.length > 0) {
    const paidMinor = settledAgainst.reduce((sum, row) => sum + row.amountMinor, 0);
    throw new ConvexError(
      `A reimbursement of ${paidMinor} minor units was already paid against this handover. Reverse that reimbursement first, otherwise the payment stays on the record measured against an issuance that no longer exists.`
    );
  }
}

/**
 * The entries a custody log's reversals cancel — after EVERY historical
 * reversal has been proven well-formed against the same bounded log.
 *
 * A reversal is a claim that one earlier movement never counted. Taken on
 * trust, a corrupt one (legacy or raw-edited; the schema admits it) removes
 * money from the totals that was really moved: a reversal of 1 against an
 * issuance of 700,000 erased the whole advance, a reversal naming an entry on
 * another custody record erased a movement that was never on this log, and
 * two reversals of one target cancelled it twice as far as the set was
 * concerned. `assertReversalAllowed` proves all of this for the reversal
 * being RECORDED; the totals are recomputed from the stored log, so the log
 * is proven again here, in full, before a single amount is added. Any
 * failure throws uncaught, and the caller's insert rolls back with it.
 */
function validatedReversalTargets(
  entries: ReadonlyArray<Doc<"financeDealCustodyEntries">>,
  custody: Pick<Doc<"financeDealCustody">, "_id" | "orgId">
): Set<Id<"financeDealCustodyEntries">> {
  const byId = new Map(entries.map((entry) => [entry._id, entry]));
  const reversedIds = new Set<Id<"financeDealCustodyEntries">>();
  // Annotated on the binding, which is what lets control flow treat a call
  // as a throw and narrow `target` below it.
  const refuse: (what: string) => never = (what) => {
    throw new ConvexError(
      `A reversal on this custody record ${what}, so its totals cannot be recomputed. Correct that movement before recording more.`
    );
  };
  for (const reversal of entries) {
    if (reversal.kind !== "REVERSAL") continue;
    if (!isMinorAmount(reversal.amountMinor) || reversal.amountMinor <= 0) {
      refuse(`carries an amount that is not a positive readable figure (${reversal.amountMinor})`);
    }
    if (reversal.reversesEntryId === undefined) refuse("names no movement to cancel");
    // Both rows are anchored to the CUSTODY RECORD's org — never to each
    // other, which would let two rows sharing the same wrong org pass.
    if (reversal.orgId !== custody.orgId) refuse("belongs to another organization");
    const target = byId.get(reversal.reversesEntryId);
    // Same bounded log, so same custody by construction — the org and custody
    // are still compared, because a row is what it says, not where it was read.
    if (target === undefined || target.custodyId !== custody._id || target.orgId !== custody.orgId) {
      refuse("names a movement that is not on this custody record");
    }
    if (target.kind === "REVERSAL") refuse("names another reversal, which cannot itself be reversed");
    if (!isMinorAmount(target.amountMinor) || target.amountMinor !== reversal.amountMinor) {
      refuse(`cancels ${reversal.amountMinor} against a movement of ${target.amountMinor}; a reversal must cancel the whole movement`);
    }
    if (reversedIds.has(target._id)) refuse("names a movement that is already reversed");
    reversedIds.add(target._id);
  }
  return reversedIds;
}

/**
 * The totals a custody log projects to, after every entry and every reversal
 * on it has been proven well-formed. Shared by `recomputeCustodyTotals`,
 * which persists them, and by the legacy migration, which compares them with
 * what the row already claims and refuses on a disagreement rather than
 * deciding which side to believe.
 */
export function custodyTotalsFromLog(
  entries: ReadonlyArray<Doc<"financeDealCustodyEntries">>,
  custody: Pick<Doc<"financeDealCustody">, "_id" | "orgId">
): { issuedMinor: number; returnedMinor: number; reimbursedMinor: number } {
  const reversedIds = validatedReversalTargets(entries, custody);

  let issuedMinor = 0;
  let returnedMinor = 0;
  let reimbursedMinor = 0;
  const add = (kind: Doc<"financeDealCustodyEntries">["kind"], amount: number): void => {
    // No `else` fallback. A future kind falling through to "reimbursed" would
    // inflate what the dealership has paid back, drive the outstanding figure
    // to zero and report the record settled — the "unknown treated as fine"
    // shape, with the compiler silent because `else` accepts anything.
    switch (kind) {
      case "ISSUED":
        issuedMinor += amount;
        return;
      case "RETURNED":
        returnedMinor += amount;
        return;
      case "REIMBURSED":
        reimbursedMinor += amount;
        return;
      case "REVERSAL":
        return;
      default: {
        const unhandled: never = kind;
        throw new ConvexError(
          `Unhandled custody entry kind ${String(unhandled)}. Its effect on the balance has to be stated explicitly.`
        );
      }
    }
  };

  for (const entry of entries) {
    // A reversal and the entry it cancels contribute nothing between them, so
    // both are skipped rather than one being subtracted from the other —
    // netting a negative AND skipping the target applied the correction twice.
    // Both rows stay in the table; only their effect on the totals is removed.
    if (entry.kind === "REVERSAL") continue;
    if (reversedIds.has(entry._id)) continue;
    // Every HISTORICAL entry is re-validated, not only the one this mutation
    // just inserted: the writers assert the amount, the schema does not, and
    // a corrupt entry (legacy or raw-edited) would otherwise be folded into a
    // total that the mutation then persists as fact. The throw rolls the
    // caller's insert back with it — nothing commits.
    if (!isMinorAmount(entry.amountMinor)) {
      throw new ConvexError(
        `A recorded movement on this custody record (${entry.kind}, ${entry.amountMinor}) is not a readable amount, so its totals cannot be recomputed. Correct that movement before recording more.`
      );
    }
    add(entry.kind, entry.amountMinor);
  }
  // Safe entries can still add to an unsafe total; a total that is not a
  // safe integer is not persisted.
  if (![issuedMinor, returnedMinor, reimbursedMinor].every((total) => Number.isSafeInteger(total))) {
    throw new ConvexError(
      "The movements on this custody record add up to an amount outside the readable range, so its totals cannot be recomputed."
    );
  }

  // The invariant, enforced once where every path converges rather than per
  // movement. Guarding only the RETURNED mutation left the reversal of an
  // ISSUED entry free to reach the same state from the other side: return the
  // whole advance, then reverse the issuance, and the log says more came back
  // than ever went out — after which the module reported a reimbursement due
  // and instructed somebody to pay it. A throw here rolls the entry insert back
  // with it, so no path can commit a log that cannot be true.
  if (returnedMinor > issuedMinor) {
    throw new ConvexError(
      `That would leave ${returnedMinor} minor units returned against ${issuedMinor} issued, which cannot both be true. Reverse the return as well, or record the issuance that is missing.`
    );
  }
  return { issuedMinor, returnedMinor, reimbursedMinor };
}

/**
 * Recomputes a custody record's totals from its entries.
 *
 * The totals are a projection of the movement log, never a number a caller
 * hands in — so correcting a mistyped issuance means adding a correcting entry
 * that stays visible, rather than overwriting a figure and losing the fact that
 * it ever differed.
 */
export async function recomputeCustodyTotals(
  ctx: MutationCtx,
  custodyId: Id<"financeDealCustody">
): Promise<void> {
  // Bounded, and refused past the bound: a total decided on a prefix of the
  // log would be persisted as fact. The throw rolls the caller's insert back.
  const entries = await custodyEntriesFor(ctx, custodyId, "recomputing this custody record's totals");
  // The custody row is the anchor every entry is proven against — its org and
  // its id — not the entries' own claims about themselves.
  const custody = await ctx.db.get(custodyId);
  if (custody === null) throw new ConvexError(CUSTODY_NOT_FOUND);
  await ctx.db.patch(custodyId, {
    ...custodyTotalsFromLog(entries, custody),
    updatedAt: Date.now(),
  });
}
