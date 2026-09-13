import { Doc } from "../_generated/dataModel";
import { PERMISSIONS, isSystemOwnerRole, type Permission } from "./permissions";

/**
 * What a caller is allowed to read off a `financeApplications` row (SCRUM-117).
 *
 * ## Why an ALLOWLIST, and why it is exhaustive
 *
 * The previous boundary was a hand-maintained blocklist inside
 * `redactSettlementEvidence`: spread the whole document, then blank six named
 * fields. Every field the list did not name travelled to whoever could read the
 * row — and the two doors that return one, `applications.get` (VIEW_SALES) and
 * `financingEconomics.getEconomics` (VIEW_FINANCE_APPLICATIONS), are held by
 * the default SALES and MANAGER templates, neither of which holds VIEW_FINANCE.
 *
 * That is how the appraisal gap, its full allocation, the resolver, the time
 * and the free-text note reached a role the gap-resolution mutation refuses to
 * let anywhere near the decision. It is the same shape the file's own comments
 * record twice before: gate `dealCockpit`, and `applications.get` still returns
 * the row; gate that, and `getEconomics` still returns it to a weaker role.
 *
 * A blocklist fails OPEN by omission. This map fails CLOSED by construction:
 * it is a total `Record` over `financeApplications`' own keys, so a field added
 * to the schema without a visibility decision is a TYPE ERROR here, not a
 * silent disclosure. The same discipline `deriveDealStages` uses for stages.
 *
 * ## The classes
 *
 * - `OPEN` — lifecycle, identity, dimensions and workflow metadata. Carries no
 *   monetary quantity and reconstructs none. This is what keeps the ordinary
 *   application workflow working for SALES and MANAGER, which the owner-proxy
 *   ruling (SCRUM-117) requires: requiring VIEW_FINANCE for the whole query was
 *   considered and rejected.
 * - `FINANCE` — VIEW_FINANCE. Every amount, every snapshot that carries one,
 *   every free-text field that records one in practice, the metadata of the
 *   monetary agreements (who settled the gap, when, why), and every OPERAND a
 *   withheld amount can be reconstructed from. `appliedLtvPercent` is in here
 *   for exactly that reason: with the funded portion it divides straight back
 *   to the approved amount, which is how a `view:sales` caller recovered it.
 * - `DISBURSEMENT_WORKFLOW` — VIEW_FINANCE *or* CONFIRM_FINANCE_DISBURSEMENT.
 *   The two figures the supplier-disbursement confirmation screen must prefill.
 *   Narrower than OPEN and wider than FINANCE on purpose: a role whose whole job
 *   is confirming that payment cannot do it against a blank amount.
 * - `COST` — VIEW_COST_PRICE, the rule the vehicle queries already apply.
 *
 * ## What this does NOT claim
 *
 * A projection cannot un-say what another surface already said. The overrides
 * history is projected beside this (`projectFinanceApplicationOverrides`) and
 * `financedConsignedSettlement.test.ts` sweeps every public query of both
 * application-facing modules for these names on the whole serialized response.
 * Anything else that learns to return one of these rows must call this helper —
 * that obligation is what the sweep enforces.
 */
type FieldVisibility = "OPEN" | "FINANCE" | "DISBURSEMENT_WORKFLOW" | "COST";

/**
 * Every key of the row, classified. Total by type: adding a schema field
 * without a decision here fails the build.
 */
const FIELD_VISIBILITY: Record<
  Exclude<keyof Doc<"financeApplications">, "_id" | "_creationTime">,
  FieldVisibility
> = {
  // --- Identity, tenancy and the lifecycle the workflow is made of ----------
  orgId: "OPEN",
  quoteId: "OPEN",
  customerId: "OPEN",
  vehicleId: "OPEN",
  vehicleItems: "OPEN",
  currentCommitmentClaims: "OPEN",
  companyId: "OPEN",
  salespersonId: "OPEN",
  status: "OPEN",
  /**
   * The salesperson's own application note, not a finance artifact — the field
   * the sales floor writes and reads to run the application. `approvedPurchaseNotes`,
   * which in practice records the approved figure as free text, is FINANCE.
   */
  notes: "OPEN",
  createdAt: "OPEN",
  updatedAt: "OPEN",
  quoteModeAtSubmission: "OPEN",
  approvedBy: "OPEN",
  approvedAt: "OPEN",
  finalizedSaleId: "OPEN",
  disbursedAt: "OPEN",
  vehicleHandoverAt: "OPEN",
  vehicleHandoverBy: "OPEN",
  vehicleHandoverNotes: "OPEN",
  expectedPaymentMethod: "OPEN",
  expectedPaymentDate: "OPEN",
  expectedPaymentRegisteredAt: "OPEN",
  expectedPaymentRegisteredBy: "OPEN",
  cancelledBy: "OPEN",
  cancelledAt: "OPEN",
  cancellationReason: "OPEN",
  // The five dimensions the stage rail is drawn from. Qualitative by design —
  // `deriveDealStages` publishes the stage rail to every caller precisely
  // because it names no amount, and `gapResolution` is the dimension, not the
  // allocation: the shares and destinations behind it are FINANCE below.
  creditDecision: "OPEN",
  appraisalStatus: "OPEN",
  gapResolution: "OPEN",
  settlementStatus: "OPEN",
  handoverStatus: "OPEN",
  // WHICH currency, never HOW MUCH. Withholding it would leave a screen unable
  // to label the figures it is allowed to show.
  economicsCurrency: "OPEN",
  // Provenance of the quotation, not the quotation.
  submittedQuotationSource: "OPEN",
  submittedQuotationAt: "OPEN",
  submittedQuotationBy: "OPEN",
  approvedPurchaseBasis: "OPEN",
  approvedPurchaseAppraisalId: "OPEN",
  approvedPurchaseExceptionRuleVersion: "OPEN",
  approvedPurchaseApprovedBy: "OPEN",
  approvedPurchaseApprovedAt: "OPEN",
  supplierSettlementRoute: "OPEN",
  /**
   * WHETHER the supplier was paid — normalized by the caller below. Deliberately
   * open: hiding it is what produced a permanent "awaiting supplier disbursement"
   * on a settled deal, with no state that could ever clear it.
   */
  supplierDisbursementStatus: "OPEN",
  legalInvoiceNumber: "OPEN",
  legalInvoiceDate: "OPEN",
  legalInvoiceRecordedBy: "OPEN",
  legalInvoiceRecordedAt: "OPEN",
  legalInvoiceIssuedTo: "OPEN",
  legalInvoiceIssuedToOther: "OPEN",
  accountingClassification: "OPEN",
  accountingClassifiedBy: "OPEN",
  accountingClassifiedAt: "OPEN",
  failureReason: "OPEN",
  failedAt: "OPEN",
  failedBy: "OPEN",
  appraisalFeeResponsibility: "OPEN",
  companyRuleVersionId: "OPEN",
  needsFinancingReconciliation: "OPEN",
  financingBackfilledAt: "OPEN",
  /**
   * A revision COUNTER, and the token `economicsStamp` is built from. It says
   * the figures moved, never what they are — which is the whole reason the
   * stamp was built this way rather than out of the amounts.
   */
  economicsRevision: "OPEN",

  // --- The money, and everything it can be rebuilt from --------------------
  targetSellingAmountMinor: "FINANCE",
  submittedQuotationMinor: "FINANCE",
  /** Free text explaining a figure, which in practice restates it. */
  submittedQuotationOverrideReason: "FINANCE",
  /** The solver's own inputs and result. */
  quotationCalculationSnapshot: "FINANCE",
  estimatedDealerBorneExpensesMinor: "FINANCE",
  quotationBufferMinor: "FINANCE",
  dealerEstimateMinor: "FINANCE",
  /**
   * The reconstruction operand named in this boundary's own history:
   * `financeCompanyFundedPortionMinor ÷ (appliedLtvPercent / 100)` returns the
   * approved amount, and at 100% LTV they are simply equal. Gating the funded
   * portion without gating this leaves the division one visible field away.
   */
  appliedLtvPercent: "FINANCE",
  customerFirstPaymentMinor: "FINANCE",
  customerContributionToFinanceCompanyMinor: "FINANCE",
  dealerContributionSettlement: "FINANCE",
  customerContributionSettlement: "FINANCE",
  expectedDealerRemittanceMinor: "FINANCE",
  actualDealerReceiptTotalMinor: "FINANCE",
  customerFinancingPrincipalMinor: "FINANCE",
  estimatedClosingExpensesMinor: "FINANCE",
  actualClosingExpensesMinor: "FINANCE",
  targetNetProceedsMinor: "FINANCE",
  legalInvoiceAmountMinor: "FINANCE",
  financedSaleRecognitionFingerprint: "FINANCE",
  /** Free text that records the approved figure — the second recovery route. */
  approvedPurchaseNotes: "FINANCE",
  accountingClassificationNotes: "FINANCE",
  failureNotes: "FINANCE",
  appraisalFeeResponsibilityReason: "FINANCE",
  /** Rates and fee templates. The `requiresLtvPercent` flag below replaces the
   *  one workflow question a non-finance caller asked of it. */
  companyRuleSnapshot: "FINANCE",
  financingReconciliationReason: "FINANCE",
  /** Both snapshots carry the figures the decision was taken against. */
  manualFinanceSnapshot: "FINANCE",
  underwritingSnapshot: "FINANCE",
  disbursedAmountMinor: "FINANCE",
  /**
   * Command keys. No monetary quantity, but no reader outside the server
   * either — fail closed rather than publish a replay handle.
   */
  finalizationIdempotencyKey: "FINANCE",
  disbursementIdempotencyKey: "FINANCE",

  // --- The appraisal gap: the amount, its allocation and its metadata ------
  rawAppraisalGapMinor: "FINANCE",
  customerGapShareMinor: "FINANCE",
  dealerGapShareMinor: "FINANCE",
  customerGapCashToDealerMinor: "FINANCE",
  customerGapInstallmentToDealerMinor: "FINANCE",
  customerGapToFinanceCompanyMinor: "FINANCE",
  gapResolvedAt: "FINANCE",
  gapResolvedBy: "FINANCE",
  gapResolutionNotes: "FINANCE",

  // --- Settlement evidence: tier 1, unchanged ------------------------------
  supplierDisbursedAmountMinor: "FINANCE",
  supplierDisbursementReference: "FINANCE",
  supplierDisbursementApprovedAtRecordingMinor: "FINANCE",
  supplierDisbursementConfirmedAt: "FINANCE",
  supplierDisbursementConfirmedBy: "FINANCE",

  // --- The disbursement confirmation's two prefills ------------------------
  /**
   * Tier 2, now a real boundary rather than a display gate: the recovery routes
   * that made the old comment honest (the LTV division, the approval notes, the
   * override history) are closed above and in `projectFinanceApplicationOverrides`.
   */
  approvedDealerPurchaseAmountMinor: "DISBURSEMENT_WORKFLOW",
  /**
   * The approved amount's own DECOMPOSITION, and therefore its own class.
   *
   * `handoverEvidenceFor` states the rule this follows, and states it as an
   * invariant rather than a preference: with the approved amount withheld but
   * its two addends shown, an operator recovers it by adding them —
   * `funded + contribution` IS the approved amount. So a caller who may see the
   * figure may see the split, and a caller who may not, sees neither. Splitting
   * these two classes apart would either disclose the whole number with an
   * extra step or blank a confirmation screen that is entitled to it.
   *
   * They reconstruct the APPROVED AMOUNT and nothing else: the appraisal gap
   * needs the submitted quotation, which is FINANCE above, so this class cannot
   * rebuild the figure SCRUM-117 is about.
   */
  financeCompanyFundedPortionMinor: "DISBURSEMENT_WORKFLOW",
  unfinancedPortionMinor: "DISBURSEMENT_WORKFLOW",
  dealerContributionMinor: "DISBURSEMENT_WORKFLOW",
  /**
   * The frozen net receivable the finance-company disbursement is confirmed
   * against. Same gate as the amount beside it, for the same reason: the
   * confirmation screen cannot ask about a figure it may not read.
   */
  financedSaleNetReceivableMinor: "DISBURSEMENT_WORKFLOW",

  // --- Cost, the rule the vehicle queries already apply --------------------
  vehiclePurchaseCostMinor: "COST",
};

function allows(role: Doc<"roles">, permission: Permission): boolean {
  return isSystemOwnerRole(role) || role.permissions.includes(permission);
}

/** Which classes this role may read. */
function visibilityFor(role: Doc<"roles">): Record<FieldVisibility, boolean> {
  const finance = allows(role, PERMISSIONS.VIEW_FINANCE);
  return {
    OPEN: true,
    FINANCE: finance,
    DISBURSEMENT_WORKFLOW: finance || allows(role, PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT),
    COST: allows(role, PERMISSIONS.VIEW_COST_PRICE),
  };
}

/**
 * The row as this caller may read it.
 *
 * Built by walking the classification, not by spreading and subtracting: a key
 * this map does not carry cannot reach the caller, which is the property the
 * previous blocklist could not have. `_id` and `_creationTime` are Convex's own
 * and always travel.
 *
 * Withheld fields are set to `undefined` rather than omitted, so the returned
 * shape stays the same for every caller and `JSON.stringify` drops them on the
 * wire — a consumer never has to narrow a union to read anything.
 */
export function projectFinanceApplication<T extends Doc<"financeApplications">>(
  app: T,
  role: Doc<"roles">
): T {
  const may = visibilityFor(role);
  const projected: Record<string, unknown> = {
    _id: app._id,
    _creationTime: app._creationTime,
  };
  for (const [field, visibility] of Object.entries(FIELD_VISIBILITY)) {
    projected[field] = may[visibility] ? (app as Record<string, unknown>)[field] : undefined;
  }
  /**
   * NORMALIZED, exactly as the previous helper did: the status field post-dates
   * some recorded advices, and `amendSupplierDisbursementAdvice` treats absence
   * the same way with `?? "CONFIRMED"`. Derived from the RAW row, because the
   * two fields it reads are FINANCE and would be blank in the projection — the
   * whole point is to publish WHETHER without WHEN or HOW MUCH.
   *
   * ⚠️ A DISPLAY PROXY FOR "AN ADVICE IS ON FILE", never an assertion that it
   * agreed with the approval. Do not branch on `=== "CONFIRMED"` from a
   * projected payload; ask the raw field, as `dealCockpit` does.
   */
  projected.supplierDisbursementStatus =
    app.supplierDisbursementStatus ??
    (app.supplierDisbursementConfirmedAt !== undefined ||
    app.supplierDisbursedAmountMinor !== undefined
      ? ("CONFIRMED" as const)
      : undefined);
  return projected as T;
}

/**
 * The override history, projected.
 *
 * `recordOverride` stringifies whatever moved into `previousValue`/`newValue`
 * and takes a free-text `reason` — so the history restates the approved amount,
 * the gap allocation and anything else a correction touched. It was the third
 * of the three documented ways a `view:sales` caller recovered the approved
 * amount, and the one the projection above cannot reach.
 *
 * Withheld WHOLESALE for a caller without VIEW_FINANCE rather than filtered by
 * which `field` looks monetary. A detector keyed on the field name fails open
 * the first time a new command records a correction under a name nobody
 * predicted, and the values are free text that can restate a figure whatever
 * the row is called. What survives is the fact that a correction happened, by
 * whom and when — the audit trail's existence, without its contents.
 */
export function projectFinanceApplicationOverrides(
  overrides: Array<Doc<"financeApplicationOverrides">>,
  role: Doc<"roles">
): Array<Doc<"financeApplicationOverrides">> {
  if (allows(role, PERMISSIONS.VIEW_FINANCE)) return overrides;
  return overrides.map((row) => ({
    ...row,
    previousValue: undefined,
    newValue: undefined as unknown as string,
    reason: undefined as unknown as string,
  }));
}

/**
 * Whether this deal needs the operator to name the purchase LTV, as a fact
 * rather than as three fields to compare.
 *
 * The screen used to derive it from `companyRuleSnapshot` and
 * `appliedLtvPercent`, both now FINANCE — and a SALES caller who is not told
 * the rate is missing types a quotation the server then refuses, which is the
 * workflow dead-end the ruling forbids. So the server answers the question it
 * already owns, and publishes a boolean that names no rate.
 */
export function requiresLtvPercentFor(app: Doc<"financeApplications">): boolean {
  return (
    app.companyRuleSnapshot !== undefined &&
    app.appliedLtvPercent === undefined &&
    app.companyRuleSnapshot.defaultLtvPercent === undefined
  );
}
