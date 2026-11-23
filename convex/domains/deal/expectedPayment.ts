import { ConvexError } from "convex/values";
import { assertRt11DoorAllowed } from "../../utils/rt11DoorContainment";
import { type MutationCtx, type QueryCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { requireOwnedRow } from "../../utils/tenancy";
import { assertNoActiveDealUnwind } from "../../utils/dealUnwindGuard";
import { getOrgCurrency } from "../../accounting/workflowHooks";
import { fromMinorUnits } from "../../utils/money";
import { auditLog } from "../../utils/financialAuditWriter";
import {
  chequesForApplication,
  liveChequesForApplication,
  parseFaceAmountMinor,
  dealChequeCurrency,
  ATTESTATION_NOTE_MAX_LENGTH,
} from "../../utils/fcCheque";
import {
  settlesDirectToSupplier,
  closedDealSettlesDirectToSupplier,
} from "./settlementRouting";
import { FINANCE_APP_RECEIVABLE_SOURCE } from "./financeReceivables";

type RegisterExpectedPaymentInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  method: "CASH" | "INTERNAL_INSTALLMENT" | "CHEQUE" | "BANK_TRANSFER";
  expectedDate: number;
  chequeDetails?: {
    bank: string;
    chequeNumber: string;
  };
  faceAmount?: string;
};

/**
 * Registers how and when the deal's payment is expected to arrive — cash,
 * in-house installment with the customer, a finance-company cheque, or a bank
 * transfer — before finalizeDeal. For CHEQUE this opens a postDatedCheques
 * record drawn by the deal's finance company (the through-dealership route
 * only), which is cleared by confirmDisbursement, never from customer
 * collections.
 */
// SCRUM-447 D1: the face printed on the instrument, as a decimal string at
// the deal currency's scale. Required for CHEQUE; never derived from the quote.
// Membership first, the row proven to belong to the org second, and only
// then the permission — because which permission applies depends on the row.
// SCRUM-447 D3: APPROVED, or CLOSED but not yet disbursed (re-registration
// after correctExpectedPayment). A cancelled or disbursed deal never.
// SCRUM-447 B2: the operator who CORRECTS a closed deal (MANAGE_FINANCE) must
// be able to finish the recovery; the default ACCOUNTANT holds the former
// and not REGISTER_EXPECTED_PAYMENT. Either permission suffices, and only on
// a CLOSED, undisbursed deal — the APPROVED flow is unchanged.
export async function executeRegisterExpectedPayment(
  ctx: MutationCtx,
  args: RegisterExpectedPaymentInput,
  app: Doc<"financeApplications">,
  user: Doc<"users">,
  closedUndisbursed: boolean,
  registerChequeCore: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      customerId: Id<"customers">;
      vehicleId: Id<"vehicles">;
      applicationId: Id<"financeApplications">;
      bank: string;
      chequeNumber: string;
      chequeDate: number;
      amount: number;
      amountMinor: number;
      currency: string;
      drawerType: "FINANCE_COMPANY";
      financeCompanyId?: Id<"financeCompanies">;
      originApplicationId: Id<"financeApplications">;
      actorId: Id<"users">;
    },
  ) => Promise<unknown>,
) {
  if (app.status !== "APPROVED" && !closedUndisbursed) {
    throw new ConvexError(
      "Application must be APPROVED before registering expected payment.",
    );
  }
  if (!app.vehicleHandoverAt)
    throw new ConvexError(
      "Register the vehicle handover before the expected payment.",
    );
  // A legacy row can carry a method with no `registeredAt`; it is still registered.
  if (app.expectedPaymentRegisteredAt || app.expectedPaymentMethod) {
    throw new ConvexError("Expected payment has already been registered.");
  }
  if ((await liveChequesForApplication(ctx, args.applicationId)).length > 0) {
    throw new ConvexError(
      "This deal already has a live finance-company cheque. Correct the expected payment first.",
    );
  }
  // A date this mutation ACCEPTS but `finalizeDeal` will not.
  //
  // `v.number()` admits 0 and NaN, and 0 is what the date field produces for
  // 1970-01-01. `finalizeDeal` tests `!app.expectedPaymentDate`, so a zero
  // sails in here and then blocks the close — while THIS mutation refuses a
  // second attempt because it has already stamped
  // `expectedPaymentRegisteredAt`. With the handover recorded the approval can
  // no longer be reopened either, so the deal has no supported way forward at
  // all: the only remedy left is cancelling the application.
  //
  // Refused at the boundary rather than repaired downstream, because the
  // state is unrecoverable once written.
  if (!Number.isFinite(args.expectedDate) || args.expectedDate <= 0) {
    throw new ConvexError("Record a valid date for the expected payment.");
  }

  if (args.method === "CHEQUE") {
    if (
      !args.chequeDetails?.bank?.trim() ||
      !args.chequeDetails?.chequeNumber?.trim()
    ) {
      throw new ConvexError(
        "Bank and cheque number are required for a cheque payment.",
      );
    }
    // SCRUM-447 D3: a finance-company cheque needs a real drawer (the deal's
    // finance company) and the through-dealership route. The direct route means
    // the company pays the supplier, so no cheque reaches the dealership.
    if (!app.companyId) {
      throw new ConvexError(
        "A cheque payment needs a finance company on the deal so the drawer can be named.",
      );
    }
    const settlesDirect =
      app.status === "CLOSED"
        ? await closedDealSettlesDirectToSupplier(ctx, app)
        : await settlesDirectToSupplier(ctx, app);
    if (settlesDirect) {
      throw new ConvexError(
        "This deal settles directly with the supplier, so no finance-company cheque reaches the dealership.",
      );
    }
    // D1: the face is what the operator reads off the instrument — never the
    // quote's financed amount. Parsed exactly at the deal currency's scale.
    const orgCurrency = await getOrgCurrency(ctx, args.orgId);
    const chequeCurrency = await dealChequeCurrency(ctx, app, orgCurrency);
    const amountMinor = parseFaceAmountMinor(args.faceAmount, chequeCurrency);
    await registerChequeCore(ctx, {
      orgId: args.orgId,
      customerId: app.customerId,
      vehicleId: app.vehicleId,
      applicationId: args.applicationId,
      bank: args.chequeDetails.bank,
      chequeNumber: args.chequeDetails.chequeNumber,
      chequeDate: args.expectedDate,
      amount: fromMinorUnits(amountMinor, chequeCurrency),
      amountMinor,
      currency: chequeCurrency,
      drawerType: "FINANCE_COMPANY",
      financeCompanyId: app.companyId,
      originApplicationId: args.applicationId,
      actorId: user._id,
    });
  }

  const now = Date.now();
  await ctx.db.patch(args.applicationId, {
    expectedPaymentMethod: args.method,
    expectedPaymentDate: args.expectedDate,
    expectedPaymentRegisteredAt: now,
    expectedPaymentRegisteredBy: user._id,
    updatedAt: now,
  });
  return now;
}

type CorrectExpectedPaymentInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  reason: string;
};

/**
 * SCRUM-447 D3: undoes a registered expected payment on a deal that has not
 * been disbursed, so it can be registered again correctly (wrong method, wrong
 * cheque, a returned cheque). Allowed on an APPROVED or CLOSED-not-disbursed
 * deal; refused when cancelled, disbursed, or when the finance-company
 * receivable holds any receipt/allocation.
 *
 * The single live/last finance-company cheque decides the rest: HELD becomes
 * CANCELLED, RETURNED is allowed as it is, DEPOSITED is refused (record its
 * return first) and CLEARED is refused. The cheque KEEPS its applicationId —
 * lineage is permanent. Everything below the refusals is one transaction; a
 * repeat call is refused as "nothing registered".
 */
export async function executeCorrectExpectedPayment(
  ctx: MutationCtx,
  args: CorrectExpectedPaymentInput,
  app: Doc<"financeApplications">,
  user: Doc<"users">,
  reason: string,
  assertNoActiveAllocations: (
    ctx: QueryCtx | MutationCtx,
    receivableDocumentId: Id<"receivableDocuments">,
  ) => Promise<void>,
) {
  if (app.status === "CANCELLED")
    throw new ConvexError("This application was cancelled.");
  await assertNoActiveDealUnwind(ctx, args.orgId, args.applicationId);
  if (
    app.disbursedAt !== undefined ||
    app.supplierDisbursementConfirmedAt !== undefined
  ) {
    assertRt11DoorAllowed("EXPECTED_PAYMENT_PAID_PILOT_DISABLED");
    // Preserve the pre-pilot disbursement restriction if this switch is retired.
    if (app.disbursedAt !== undefined) {
      throw new ConvexError(
        "Disbursement has already been confirmed for this deal, so its expected payment can no longer be corrected.",
      );
    }
  }
  if (!app.expectedPaymentMethod) {
    throw new ConvexError(
      "Nothing registered — there is no expected payment to correct.",
    );
  }

  // No receipt or allocation may sit on the finance-company receivable.
  const financeReceivable = app.companyId
    ? await ctx.db
        .query("receivableDocuments")
        .withIndex("by_org_source", (q) =>
          q
            .eq("orgId", args.orgId)
            .eq("sourceType", FINANCE_APP_RECEIVABLE_SOURCE)
            .eq("sourceId", args.applicationId),
        )
        .unique()
    : null;
  if (financeReceivable && financeReceivable.status !== "CANCELLED") {
    await assertNoActiveAllocations(ctx, financeReceivable._id);
  }

  const rows = await chequesForApplication(ctx, args.applicationId);
  if (rows.some((row) => row.status === "CLEARED")) {
    throw new ConvexError(
      "The finance-company cheque for this deal was already cleared, so the expected payment cannot be corrected.",
    );
  }
  if (rows.some((row) => row.status === "DEPOSITED")) {
    throw new ConvexError(
      "The finance-company cheque is deposited. Record its return first, then correct the expected payment.",
    );
  }
  const heldRows = rows.filter((row) => row.status === "HELD");
  const now = Date.now();
  for (const row of heldRows) {
    await ctx.db.patch(row._id, {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledBy: user._id,
      cancellationReason: reason,
      updatedAt: now,
    });
  }

  await ctx.db.patch(args.applicationId, {
    expectedPaymentMethod: undefined,
    expectedPaymentDate: undefined,
    expectedPaymentRegisteredAt: undefined,
    expectedPaymentRegisteredBy: undefined,
    updatedAt: now,
  });

  await auditLog(ctx, {
    orgId: args.orgId,
    actorId: user._id,
    actionType: "CORRECT_EXPECTED_PAYMENT",
    resourceType: "financeApplications",
    resourceId: args.applicationId,
    description: `Expected payment corrected: ${reason}`,
    before: {
      expectedPaymentMethod: app.expectedPaymentMethod,
      expectedPaymentDate: app.expectedPaymentDate,
      chequeIds: heldRows.map((row) => row._id),
    },
    after: { expectedPaymentMethod: null, expectedPaymentDate: null },
  });
  return now;
}

type AttestChequeFaceInput = {
  orgId: Id<"organizations">;
  chequeId: Id<"postDatedCheques">;
  faceAmount: string;
  note: string;
};

/**
 * SCRUM-447 D1: records the printed face of a finance-company cheque that has
 * none in minor units (a row registered before the face was captured).
 * MANAGE_FINANCE; only an application-linked HELD/DEPOSITED cheque with no
 * `amountMinor`; refused once it exists (an attested face is never edited).
 * The legacy `amount` is never touched, and the audit event carries it.
 */
// SCRUM-447 B4: why the operator says this is the printed face. Required.
export async function executeAttestChequeFace(
  ctx: MutationCtx,
  args: AttestChequeFaceInput,
  user: Doc<"users">,
) {
  const note = args.note.trim();
  if (!note)
    throw new ConvexError("Add a note saying why this face is correct.");
  if (note.length > ATTESTATION_NOTE_MAX_LENGTH) {
    throw new ConvexError(
      `Keep the attestation note to ${ATTESTATION_NOTE_MAX_LENGTH} characters or fewer.`,
    );
  }
  const cheque = await requireOwnedRow(
    ctx,
    args.orgId,
    "postDatedCheques",
    args.chequeId,
    "Cheque not found.",
  );
  if (cheque.isDeleted === true) throw new ConvexError("Cheque not found.");
  if (!cheque.applicationId) {
    throw new ConvexError(
      "Only a finance-deal cheque can have its face attested here.",
    );
  }
  if (cheque.status !== "HELD" && cheque.status !== "DEPOSITED") {
    throw new ConvexError(
      "Only a held or deposited cheque can have its face attested.",
    );
  }
  if (cheque.amountMinor !== undefined) {
    throw new ConvexError(
      "This cheque's face amount is already recorded and cannot be changed.",
    );
  }
  const app = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeApplications",
    cheque.applicationId,
    "Application not found",
  );
  if (app.status === "CANCELLED" || app.disbursedAt) {
    throw new ConvexError("This deal is cancelled or already disbursed.");
  }
  const currency = await dealChequeCurrency(
    ctx,
    app,
    await getOrgCurrency(ctx, args.orgId),
  );
  const amountMinor = parseFaceAmountMinor(args.faceAmount, currency);
  const now = Date.now();
  await ctx.db.patch(args.chequeId, {
    amountMinor,
    currency,
    faceAttestedBy: user._id,
    faceAttestedAt: now,
    faceAttestationNote: note,
    updatedAt: now,
  });
  await auditLog(ctx, {
    orgId: args.orgId,
    actorId: user._id,
    actionType: "ATTEST_CHEQUE_FACE",
    resourceType: "postDatedCheques",
    resourceId: args.chequeId,
    description: `Cheque face attested by a finance manager: ${note}`,
    before: { amount: cheque.amount },
    after: { amountMinor, currency, note },
  });
  return now;
}
