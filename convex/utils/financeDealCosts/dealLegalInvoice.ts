import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { PERMISSIONS } from "../permissions";
import { APPLICATION_NOT_FOUND, assertDealEconomicsOpen, assertNotFuture, isTimestamp } from "./dealCostGuards";
import { assertNoActiveDealUnwind } from "../dealUnwindGuard";
import { assertMinorAmount } from "../financingEconomics";
import { ConvexError } from "convex/values";
import {
  describeLegalInvoiceRecord,
  nextLegalInvoiceRevision,
  readLegalInvoiceRecipient,
} from "../legalInvoiceRecord";
import { dealSettlesDirect, financedSaleRecognitionApplies } from "../financedSaleRecognition";
import { checkLegalInvoiceEvidence } from "../financedSalePostingPlan";
import { isConsignedAgentSale } from "../vehicleOwnership";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";

// ---------------------------------------------------------------------------
// The legal invoice (and the retired accounting classification)
// ---------------------------------------------------------------------------

/**
 * Records the deal's legally documented transaction price.
 *
 * This figure comes off the invoice and the purchase agreement. It is asked for
 * explicitly, and never derived from the dealer's target selling amount or the
 * finance company's approved purchase amount, because on a financed deal those
 * are three different numbers describing three different things — and only this
 * one is what the parties signed.
 *
 * SCRUM-411 (plan v3): a deal no longer needs an invoice to close - the server
 * derives the sale consideration - so this records OPTIONAL evidence of a
 * document that really exists. Nothing is defaulted: the amount, number and date
 * are the caller's explicit input. On a financed deal the server refuses a
 * document that cannot be the deal's own: not issued to the finance company, not
 * for the approved amount, or issued by the wrong party for the car's ownership
 * (an importer's invoice is never recorded as the dealership's). It never
 * becomes the revenue source; plan v1/v2 deals finalized earlier keep theirs.
 */
export async function recordLegalInvoiceHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    legalInvoiceAmountMinor: number;
    legalInvoiceNumber: string;
    legalInvoiceDate: number;
    issuedTo: "CUSTOMER" | "FINANCE_COMPANY" | "OTHER";
    issuedToOther?: string;
    issuedBy?: "DEALERSHIP" | "THIRD_PARTY";
    issuerName?: string;
    expectedEconomicsStamp?: string;
    expectedInvoiceRevision?: number;
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
  // SCRUM-693: the invoice is the recognition source an unwind is reversing.
  await assertNoActiveDealUnwind(ctx, args.orgId, args.applicationId);
  assertMinorAmount(args.legalInvoiceAmountMinor, "Legal invoice amount");
  if (args.legalInvoiceAmountMinor <= 0) {
    throw new ConvexError("The invoice amount must be greater than zero.");
  }
  // The printed invoice date is validated as a real timestamp and refused when
  // it is in the future. Plans v1/v2 dated the sale from this field
  // (`financedSaleRecognitionDate`); plan v3 dates it from the handover and
  // keeps this date as evidence only, but the rule stays so a stored date is
  // always a real past instant. No tolerance window (final round C): an
  // invoice date is a calendar date, sent as UTC midnight for a past day
  // and as the current instant for today, so a value past the server's
  // clock is a day that has not occurred, not clock skew. Judged against
  // the one instant this command captures.
  const now = Date.now();
  if (!isTimestamp(args.legalInvoiceDate)) {
    throw new ConvexError(`The invoice date must be a real timestamp (got ${args.legalInvoiceDate}).`);
  }
  assertNotFuture(args.legalInvoiceDate, now, "The invoice date");
  // Once the sale is recognized the recorded invoice is part of its evidence
  // (and, for a v1/v2 deal, what it was recognized from); replacing it would
  // rewrite the record behind a posted journal.
  assertDealEconomicsOpen(app, "recording or replacing the legal invoice");
  const { invoiceNumber, issuedToOther } = readLegalInvoiceRecipient(args);

  // SCRUM-411: the invoice is optional evidence of a document that really
  // exists, so it must be one this deal could have. Checked against the
  // server's own figures (the approval, the car's ownership), never the
  // caller's say-so.
  const issuedBy = args.issuedBy ?? "DEALERSHIP";
  const issuerName = issuedBy === "THIRD_PARTY" ? args.issuerName?.trim() || undefined : undefined;
  if (financedSaleRecognitionApplies(app, { settlesDirect: await dealSettlesDirect(ctx, app) })) {
    const vehicle = await requireOwnedRow(ctx, args.orgId, "vehicles", app.vehicleId, "Vehicle not found.");
    const evidence = checkLegalInvoiceEvidence({
      legalInvoiceAmountMinor: args.legalInvoiceAmountMinor,
      legalInvoiceIssuedTo: args.issuedTo,
      legalInvoiceIssuedBy: issuedBy,
      legalInvoiceIssuerName: issuerName,
      approvedAmountMinor: app.approvedDealerPurchaseAmountMinor,
      vehicleIsConsigned: isConsignedAgentSale(vehicle),
    });
    if (!evidence.ok) throw new ConvexError(evidence.refusal.message);
  } else if (issuedBy === "THIRD_PARTY" && !issuerName) {
    throw new ConvexError("Name the third party that issued the invoice.");
  }

  // Any change to a recorded invoice is audited, whatever moved — and the
  // comparison has to cover every field the patch below writes, or the claim
  // is false for whichever field it forgot. It forgot two: the date, which
  // decides the period revenue lands in, and the free-text recipient, which
  // is the counterparty's whole identity when issuedTo is OTHER. Both could
  // be moved silently while the amount stood still.
  const nextIssuedToOther = args.issuedTo === "OTHER" ? issuedToOther : undefined;
  const replacing =
    app.legalInvoiceAmountMinor !== undefined &&
    (app.legalInvoiceAmountMinor !== args.legalInvoiceAmountMinor ||
      (app.legalInvoiceNumber ?? "") !== invoiceNumber ||
      app.legalInvoiceDate !== args.legalInvoiceDate ||
      app.legalInvoiceIssuedTo !== args.issuedTo ||
      (app.legalInvoiceIssuedBy ?? "DEALERSHIP") !== issuedBy ||
      (app.legalInvoiceIssuerName ?? undefined) !== issuerName ||
      (app.legalInvoiceIssuedToOther ?? undefined) !== nextIssuedToOther);
  const legalInvoiceRevision = nextLegalInvoiceRevision(app, args, replacing);
  if (legalInvoiceRevision === null) return args.applicationId;
  if (replacing) {
    await ctx.db.insert("financeApplicationOverrides", {
      orgId: args.orgId,
      applicationId: args.applicationId,
      field: "legalInvoiceAmountMinor",
      previousValue: describeLegalInvoiceRecord(
        app.legalInvoiceAmountMinor, app.legalInvoiceNumber,
        app.legalInvoiceDate, app.legalInvoiceIssuedTo, app.legalInvoiceIssuedToOther,
        app.legalInvoiceIssuedBy ?? "DEALERSHIP", app.legalInvoiceIssuerName
      ),
      newValue: describeLegalInvoiceRecord(
        args.legalInvoiceAmountMinor, invoiceNumber,
        args.legalInvoiceDate, args.issuedTo, nextIssuedToOther,
        issuedBy, issuerName
      ),
      reason: "The recorded legal invoice was replaced.",
      changedBy: user._id,
      changedAt: now,
    });
  }
  await ctx.db.patch(args.applicationId, {
    legalInvoiceAmountMinor: args.legalInvoiceAmountMinor,
    legalInvoiceNumber: invoiceNumber,
    legalInvoiceDate: args.legalInvoiceDate,
    legalInvoiceIssuedTo: args.issuedTo,
    legalInvoiceIssuedToOther: nextIssuedToOther,
    legalInvoiceIssuedBy: issuedBy,
    legalInvoiceIssuerName: issuerName,
    legalInvoiceRecordedBy: user._id,
    legalInvoiceRecordedAt: now,
    legalInvoiceRevision,
    updatedAt: now,
  });
  return args.applicationId;
}
