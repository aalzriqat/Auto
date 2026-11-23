import { isRt11DoorDisabled } from "../../utils/rt11DoorContainment";
import type { QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import { PERMISSIONS, isSystemOwnerRole } from "../../utils/permissions";
import { isForwardPlanVersion } from "../../utils/financedSalePostingPlan";
import { denominationOf } from "../../utils/money";
import { isConsignedAgentSale } from "../../utils/vehicleOwnership";
import {
  hasClearedLinkedCheque,
  latestReturnedAfterClearing,
} from "../../utils/fcCheque";
import { projectDealVehicleProfile } from "../../utils/dealVehicleProfile";
import { manualPayerLabel } from "../../utils/manualFinancePayer";
import type { TenantAuthContext } from "../../utils/tenancy";
import { readCockpitWorkflow } from "./cockpitWorkflow";
import {
  projectCockpitMoney,
  type ReadReceivableOutstanding,
  type SettlementAdviceEvidence,
} from "./cockpitMoney";

import {
  economicsStamp,
  handoverEvidenceFor,
  type ApprovalAnomaly,
} from "./handover";
import { settlementPayerForApplication } from "./settlementRouting";

export async function projectApplicationCockpit(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  auth: Pick<TenantAuthContext, "user" | "role">,
  approvedAmountIsFarFromEvidenceFor: ApprovalAnomaly,
  getReceivableOutstandingMinor: ReadReceivableOutstanding,
) {
  const { user, role } = auth;

  // The money panel is a separate permission from the deal itself: a
  // salesperson tracks their own deal's progress without seeing what the
  // dealership makes on it. Withheld on the SERVER rather than hidden in the
  // component, because a permission enforced by rendering is not enforced.
  const canSeeMoney =
    isSystemOwnerRole(role) ||
    role.permissions.includes(PERMISSIONS.VIEW_FINANCE);

  const [customer, vehicle, company, salesperson, quote, finalizedSale] =
    await Promise.all([
      ctx.db.get(app.customerId),
      ctx.db.get(app.vehicleId),
      app.companyId ? ctx.db.get(app.companyId) : Promise.resolve(null),
      ctx.db.get(app.salespersonId),
      ctx.db.get(app.quoteId),
      app.finalizedSaleId
        ? ctx.db.get(app.finalizedSaleId)
        : Promise.resolve(null),
    ]);
  const canViewVehicles =
    isSystemOwnerRole(role) ||
    role.permissions.includes(PERMISSIONS.VIEW_VEHICLES);
  const vehicleProfile = await projectDealVehicleProfile(
    ctx,
    vehicle,
    app.orgId,
    canViewVehicles,
  );

  /**
   * The sale this deal should be READ at — or null when there is no sale that
   * can actually render one.
   *
   * Deliberately NOT `app.finalizedSaleId`. That id survives operations which
   * make the sale unreadable: `sales.softDelete` sets `isDeleted` and nothing
   * anywhere clears `finalizedSaleId`, so a finalized deal whose sale was
   * deleted still carries a perfectly plausible-looking id. `sales.dealCockpit`
   * returns `null` for a deleted sale, so sending a caller there would replace
   * a screen that renders with one that says the sale does not exist — and the
   * application cockpit, which still renders fine, would have become
   * unreachable. Settlement notifications deep-link to the application URL, so
   * that is a live audit path, not a hypothetical one.
   *
   * Validated on the server because the client cannot see `isDeleted` and must
   * not be the thing deciding whether a redirect target is real.
   */
  const canonicalSaleId =
    finalizedSale &&
    !finalizedSale.isDeleted &&
    finalizedSale.orgId === app.orgId
      ? finalizedSale._id
      : null;

  const {
    linkedCheques,
    liveFcCheques,
    chequeMethodRegistered,
    chequeFaceUnrecorded,
    documents,
    settlementFacts,
    disbursementApplies,
    forwardProof,
    planVersion,
    cancelPermitted,
    cancelForwardOk,
    disbursementCheque,
    stages,
  } = await readCockpitWorkflow(ctx, app, quote, role);

  // SCRUM-37: a log row's orgId is not forced to match its application's.
  const timeline = (
    await ctx.db
      .query("applicationStatusLog")
      .withIndex("by_application", (q) => q.eq("applicationId", app._id))
      .collect()
  ).filter((entry) => entry.orgId === app.orgId);
  const actorNames = new Map<string, string>();
  for (const entry of timeline) {
    if (actorNames.has(entry.changedBy)) continue;
    const actor = await ctx.db.get(entry.changedBy);
    actorNames.set(entry.changedBy, actor?.name ?? "");
  }

  const adviceRequiresReconciliation =
    app.supplierDisbursementStatus === "REQUIRES_RECONCILIATION";
  const settlementAdviceEvidence: SettlementAdviceEvidence | null =
    adviceRequiresReconciliation
      ? {
          recordedMinor: app.supplierDisbursedAmountMinor ?? null,
          approvedMinor:
            app.supplierDisbursementApprovedAtRecordingMinor ??
            app.approvedDealerPurchaseAmountMinor ??
            null,
          currency: app.economicsCurrency ?? null,
          /**
           * The rest of the recorded advice, so the correction form can open
           * showing what is actually on file.
           *
           * Not decoration. A dialog that is never told the cheque number
           * cannot prefill it, and the first version of this form opened
           * blank on the reference and on today's date — so an operator
           * correcting the amount submitted an empty reference and a wrong
           * date alongside it. The server no longer accepts that as an
           * instruction to erase them, and this stops the form asking.
           */
          recordedReference: app.supplierDisbursementReference ?? null,
          recordedAt: app.supplierDisbursementConfirmedAt ?? null,
        }
      : null;

  /**
   * `finalizeDeal`'s settlement-route prerequisite, evaluated with its own
   * inputs rather than approximated.
   *
   * Scoped exactly as the mutation scopes it: a consigned car (the supplier's,
   * so somebody owes somebody), and an EXTERNAL financier — which is the quote
   * MODE, not `companyId`, because a MANUAL_FINANCE_COMPANY deal structurally
   * cannot carry one. Nothing already closed is asked, since its sale has
   * already posted one of the two answers.
   */
  const settlementRouteRequired =
    app.status !== "CLOSED" &&
    app.supplierSettlementRoute === undefined &&
    vehicle !== null &&
    isConsignedAgentSale(vehicle) &&
    (await settlementPayerForApplication(ctx, app)).external;

  const base = {
    /**
     * What KIND of deal this is. SCRUM-29 put a cash deal on the same screen,
     * and the view branches on this rather than inferring the kind from which
     * fields happen to be populated.
     */
    dealKind: "FINANCED" as const,
    /** The id whose tail the header shows — the application on this side. */
    dealRef: app._id as string,
    /** SCRUM-808: the shareable per-organization number, absent until the deploy backfill reaches an older deal. */
    ...(app.dealNumber === undefined ? {} : { dealNumber: app.dealNumber }),
    applicationId: app._id,
    /** The sale this became, once it has one. Absent before finalization. */
    saleId: app.finalizedSaleId ?? null,
    /**
     * Where this deal's canonical screen lives, or null when it lives here.
     *
     * Differs from `saleId` exactly when the sale exists but cannot be read —
     * see the derivation above. Callers routing on this must use it rather than
     * `saleId`, or they will send an operator to a screen that reports the sale
     * does not exist.
     */
    canonicalSaleId,
    status: app.status,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    customer: customer && {
      id: customer._id,
      name: `${customer.firstName} ${customer.lastName}`.trim(),
      phone: customer.phone,
    },
    vehicle: vehicle && {
      id: vehicle._id,
      label: `${vehicle.make} ${vehicle.model} ${vehicle.year}`.trim(),
      vin: vehicle.vin,
      /** `لدى المورد` vs dealership-owned. The screen says whose car this is. */
      consigned: isConsignedAgentSale(vehicle),
      supplierName: vehicle.sourcedFromName,
      /** SCRUM-372 vehicle card. Allowlisted — see `projectDealVehicleProfile`. */
      profile: vehicleProfile,
    },
    salespersonName: salesperson?.name ?? "",
    financeCompanyName: company?.name ?? manualPayerLabel(app) ?? "",
    /**
     * That the recorded settlement advice disagrees with what the deal was
     * approved at — and nothing about by how much.
     *
     * Outside the money gate on purpose. This is a WORKFLOW condition: it
     * says the deal is waiting on a human, and a state nobody is shown is not
     * a recovery path, it is the same dead end in a different place. Whoever
     * can see the deal can see that it is stuck.
     *
     * An earlier revision put the amounts out here with it, on the reasoning
     * that the person who chases a settlement advice is not always the one
     * allowed to see margins. That reasoning was wrong about which figure was
     * being published: `approvedMinor` is one subtraction from the
     * dealership's margin, so it handed `view:sales` exactly what the money
     * gate exists to withhold. The condition is public; the evidence is not.
     */
    settlementAdviceRequiresReconciliation: adviceRequiresReconciliation,
    /**
     * Whether the fact `finalizeDeal` demands about the payment is on file.
     *
     * Deliberately `expectedPaymentMethod && expectedPaymentDate` — the exact
     * pair `finalizeDeal` refuses without — and NOT the
     * `expectedPaymentRegisteredAt` timestamp that `registerExpectedPayment`
     * checks for a repeat. The two answer different questions, and the
     * difference is only visible on a row written before that timestamp
     * existed: reading the timestamp would tell such a deal to register a
     * payment it already has, and the mutation would agree and overwrite it.
     * The review dialog gates on the method for the same reason.
     *
     * A WORKFLOW condition, so it sits outside the money gate with
     * `settlementAdviceRequiresReconciliation`: it carries no amount, no date
     * and no method — only that the step is done. Whoever may see the deal may
     * see which step it is waiting on.
     */
    expectedPaymentRegistered:
      Boolean(app.expectedPaymentMethod && app.expectedPaymentDate) &&
      (!chequeMethodRegistered || liveFcCheques.length > 0),
    /**
     * SCRUM-447 D1/D6 workflow flags (no amounts): the live cheque has no
     * recorded face (legacy row — attest it), and whether the registered
     * payment can still be corrected (not cancelled, not disbursed).
     */
    chequeFaceUnrecorded: disbursementApplies && chequeFaceUnrecorded,
    // CLOSED, not disbursed, nothing registered: the state correctExpectedPayment
    // leaves a closed deal in, where registering again is the only way forward.
    expectedPaymentReRegistrable:
      disbursementApplies &&
      app.status === "CLOSED" &&
      !app.disbursedAt &&
      !app.expectedPaymentMethod &&
      !app.expectedPaymentRegisteredAt,
    // The registered method is a cheque (a workflow fact, no amount).
    chequePaymentRegistered: chequeMethodRegistered,
    // SCRUM-447 B2/B4 workflow flags: a cheque payment is registered but no
    // live cheque backs it (returned/cancelled) and it is still correctable,
    // and a live cheque's face was attested by a finance manager.
    // A CLEARED row takes precedence (mirrors correctExpectedPayment, which
    // refuses it): that deal needs accounting review, never a correction.
    chequeNeedsCorrection:
      disbursementApplies &&
      chequeMethodRegistered &&
      liveFcCheques.length === 0 &&
      !hasClearedLinkedCheque(linkedCheques) &&
      app.status !== "CANCELLED" &&
      !app.disbursedAt,
    chequeNeedsAccountingReview:
      chequeMethodRegistered &&
      hasClearedLinkedCheque(linkedCheques) &&
      app.status !== "CANCELLED" &&
      !app.disbursedAt,
    chequeFaceAttested: liveFcCheques.some(
      (row) => row.faceAttestedAt !== undefined,
    ),
    // The row the attest action targets. An id, not an amount.
    unattestedChequeId: disbursementApplies
      ? (liveFcCheques.find((row) => row.amountMinor === undefined)?._id ??
        null)
      : null,
    expectedPaymentCorrectable:
      app.status !== "CANCELLED" &&
      app.disbursedAt === undefined &&
      (!isRt11DoorDisabled("EXPECTED_PAYMENT_PAID_PILOT_DISABLED") ||
        app.supplierDisbursementConfirmedAt === undefined) &&
      Boolean(app.expectedPaymentMethod),
    /**
     * That `finalizeDeal` will refuse until the settlement route is recorded.
     *
     * The SAME predicate the mutation refuses on, evaluated here rather than
     * reconstructed: a consigned car, an external financier, and no route
     * chosen. It cannot be derived from anything the screen already had —
     * `money.routeKnown` answers whether the SALE is readable, and an absent
     * route reads as the legacy THROUGH_DEALERSHIP default everywhere else, so
     * both would report this deal as perfectly fine.
     *
     * Without it the cockpit offered a close that the server was certain to
     * reject, on the ordinary shape of a consigned financed deal, and it did
     * so one step AFTER handover had sealed the approved amount.
     *
     * A workflow condition with no amounts in it, so it sits outside the money
     * gate like the other two.
     */
    supplierSettlementRouteRequired: settlementRouteRequired,
    /**
     * The stamp the handover confirmation must send back, on `base` so it
     * survives the money gate below.
     *
     * A caller who cannot see the figures still needs it: the deal must not
     * be sealed against economics that moved, whoever is looking. Putting it
     * inside `money` would have recreated the defect this replaces — an
     * obligation only the permitted could discharge.
     */
    economicsStamp: economicsStamp(app),
    /**
     * SCRUM-571 (D-48): the QUALITATIVE state of the customer's invoice, for every
     * caller. The amount rides in `money.customerInvoice` for `view:finance` only.
     */
    customerInvoiceState: settlementFacts.customerInvoice.state,
    /**
     * The denomination this deal's money may be SPELLED in, or null.
     *
     * The cockpit is a money-READING surface, not only a place to act. It
     * formatted every figure through the fallback scaler, so a legacy row
     * carrying "JD" displayed 11,500,000 fils as 115,000 — a dealer reading a
     * real deal off by a factor of ten. Handover already refused such a row,
     * which protects the irreversible step and does nothing whatever for the
     * number on the screen.
     *
     * The same authority the writers assert against, so the page cannot show
     * money in a denomination the mutations would reject.
     */
    denomination: denominationOf(app.economicsCurrency),
    /**
     * Whether any economics are actually ON this deal.
     *
     * The client had to guess at this and guessed with `Boolean(deal.money)`,
     * which is PERMISSION-shaped: `buildCockpitMoney` returns zeroed rows for
     * any caller holding `view:finance`, recorded or not. That put a red
     * "record it again" panel on every freshly created financed deal for the
     * owner, about figures that had never been recorded once.
     *
     * Any of the three, not just the approved amount: a deal carrying only a
     * quotation still shows money, so a denomination nobody can vouch for
     * matters there too.
     */
    economicsRecorded:
      app.submittedQuotationMinor !== undefined ||
      app.approvedDealerPurchaseAmountMinor !== undefined ||
      app.financeCompanyFundedPortionMinor !== undefined,
    /**
     * What the handover confirmation shows, on `base` so it survives the
     * money gate — and derived through `redactSettlementEvidence`, the same
     * policy `applications.get` uses.
     *
     * The cockpit used to read these from `getEconomics`, which it only
     * mounts for `view:finance_applications`. A role holding
     * `confirm:finance_disbursement` without it is ENTITLED to the approved
     * amount — `applications.get` shows it — yet the cockpit rendered the
     * confirmation with no figures and no anomaly warning, while the stamp
     * still arrived and the handover still sealed. The two entry points to
     * the same one-way door disagreed about the same deal for the same
     * caller, and the cockpit was the one that showed less.
     *
     * Redaction is a DISPLAY question and belongs here. What must never come
     * back is keying the OBLIGATION to it: the stamp above is demanded of
     * everyone, and a caller shown nothing is still held to the deal not
     * having moved.
     */
    handoverEvidence: await handoverEvidenceFor(
      ctx,
      app,
      role,
      approvedAmountIsFarFromEvidenceFor,
    ),
    /**
     * The FIGURES behind that flag, and they are gated.
     *
     * `null` here means one of two different things and the client must not
     * try to tell them apart: either there is no discrepancy, or the caller
     * may not see the amounts. `settlementAdviceRequiresReconciliation`
     * above is the only thing that answers "is this deal stuck".
     */
    settlementAdviceDiscrepancy: null as SettlementAdviceEvidence | null,
    stages,
    /**
     * SCRUM-435 - the dealership's payment of the deposit and its
     * contribution to the finance company. STATUS ONLY here: no amount, no
     * deposit or contribution split. The figures are FINANCE-tier and ride
     * in `money.forward` for a caller who may see money.
     */
    forward: {
      /** v2/v3 deal (the manager-cancels rule applies, whether or not anything is due). Name kept for the wire. */
      planV2: isForwardPlanVersion(planVersion),
      applies: forwardProof.applies,
      state: forwardProof.state,
      returnedExceptionOpen: forwardProof.returnedExceptionOpen,
      /**
       * The payment currently on the books, for the void / report-returned
       * actions. An id, not an amount. Null when nothing settled is on the books.
       */
      onBooksForwardId: forwardProof.onBooksForwardId,
      /**
       * After the transfer (to the dealership, or a supplier advice on file) a payment can only be
       * reported returned, not voided. The same predicate `reverseFinanceCompanyForward` refuses on.
       */
      transferConfirmed:
        app.disbursedAt !== undefined ||
        app.supplierDisbursementConfirmedAt !== undefined ||
        app.supplierDisbursedAmountMinor !== undefined,
      /** Exactly the permissions the commands require. */
      mayRecord:
        isSystemOwnerRole(role) ||
        (role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT) &&
          role.permissions.includes(PERMISSIONS.VIEW_FINANCE)),
      /**
       * Whether this caller may cancel in the current status: the permission
       * tiers and, on a CLOSED v2 deal, the forward proof, exactly as
       * `cancelApplication` applies them (SCRUM-413 D-b, D-37). The other
       * CLOSED refusals (disbursement already confirmed, supplier already
       * paid, ...) are NOT mirrored here.
       */
      mayCancelFinalized: cancelPermitted && cancelForwardOk,
    },
    /**
     * SCRUM-239: the bank returned the finance company's cheque AFTER it
     * cleared. `mayReturn` is computed here from the same permissions and the
     * same cheque binding the command requires, so the screen offers only what
     * the server accepts. `chequeId` names the cleared cheque to return;
     * `lastReturnedChequeId` is the newest cheque already returned after
     * clearing, which is how the screen sees the fact it wrote.
     */
    disbursementReturn: {
      mayReturn:
        disbursementCheque !== null &&
        (isSystemOwnerRole(role) ||
          (role.permissions.includes(
            PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
          ) &&
            role.permissions.includes(PERMISSIONS.VIEW_FINANCE))),
      chequeId: disbursementCheque?._id ?? null,
      lastReturnedChequeId:
        latestReturnedAfterClearing(linkedCheques)?._id ?? null,
    },
    documents,
    timeline: timeline
      .slice()
      .sort((a, b) => a.changedAt - b.changedAt)
      .map((entry) => ({
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        changedAt: entry.changedAt,
        actorName: actorNames.get(entry.changedBy) ?? "",
        note: entry.note,
      })),
  };

  if (!canSeeMoney)
    return { ...base, money: null, firstPaymentCorrection: null };

  return {
    ...base,
    ...(await projectCockpitMoney(
      ctx,
      app,
      quote,
      settlementFacts,
      forwardProof,
      user,
      role,
      settlementAdviceEvidence,
      getReceivableOutstandingMinor,
    )),
  };
}
