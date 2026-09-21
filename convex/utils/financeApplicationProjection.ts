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
 * Five workflow tiers, not one wall. The owner-proxy ruling of 2026-09-13
 * SUPERSEDED this module's first formulation ("every reconstructable operand is
 * VIEW_FINANCE-only") as too broad for the product, after independently
 * checking the default templates on main `75372e0e5`: default SALES and default
 * MANAGER both legitimately run finance applications and neither holds
 * VIEW_FINANCE, so a single finance wall either blanks the screen SALES must
 * type into or the one MANAGER must approve from.
 *
 * - `OPEN` - lifecycle, identity, dimensions and workflow metadata. Carries no
 *   monetary quantity and reconstructs none.
 * - `QUOTATION_WORKFLOW` - CREATE_FINANCE_APPLICATION *or*
 *   APPROVE_FINANCE_APPLICATION *or* VIEW_FINANCE. The submitted quotation is a
 *   QUOTATION-WORKFLOW FACT, not an accounting secret: SALES types it and
 *   MANAGER approves against it. Ruling #1.
 * - `APPROVAL_WORKFLOW` - APPROVE_FINANCE_APPLICATION *or*
 *   CONFIRM_FINANCE_DISBURSEMENT *or* VIEW_FINANCE. The approved dealer purchase
 *   amount and the RAW appraisal gap. Ruling #2.
 *
 *   WARNING: a holder of both this class and `QUOTATION_WORKFLOW` - default
 *   MANAGER - can compute `gap = quotation - approved`. That is RULED ACCEPTED,
 *   not a leak: it is the operational approval fact that role exists to act on.
 *   Do not "fix" it by narrowing either class, and do not report it as a defect
 *   in a later review; the ruling is explicit that it must not be described as
 *   a leak.
 * - `GAP_ALLOCATION` - APPROVE_FINANCE_APPLICATION *or* VIEW_FINANCE, and
 *   deliberately NOT CONFIRM_FINANCE_DISBURSEMENT. The customer/dealer shares,
 *   their three destinations, and the resolver/time/notes. Needed to resolve the
 *   approval workflow; not ordinary sales visibility, and nothing the
 *   disbursement tier must see to confirm a payment. Ruling #4.
 * - `DISBURSEMENT_WORKFLOW` - VIEW_FINANCE *or* CONFIRM_FINANCE_DISBURSEMENT.
 *   Two fields: `financedSaleNetReceivableMinor`, the narrow already-approved
 *   workflow exception ruling #3 allows (load-bearing, not cosmetic - see the
 *   note on the field itself), and `plannedCustody`, the handover cash plan
 *   the same tier acts on when it opens the custody record.
 * - `FINANCE` - VIEW_FINANCE. The accounting economics, per ruling #3:
 *   `appliedLtvPercent`, the funding composition (funded / unfinanced / dealer
 *   contribution), the expected dealer remittance, the customer-to-finance-
 *   company amount, profit and cost economics, every calculation snapshot and
 *   its operands, and every free-text field that records an amount in practice.
 *   Also every solver INPUT (`targetSellingAmountMinor`,
 *   `targetNetProceedsMinor`, the buffer, the dealer-borne expenses):
 *   publishing the quotation is ruled safe, publishing what it was computed
 *   FROM is not.
 * - `COST` - VIEW_COST_PRICE, the rule the vehicle queries already apply.
 *
 * A role holding only VIEW_FINANCE_APPLICATIONS - a custom view-only role -
 * therefore reads `OPEN` and nothing else: lifecycle and status, no quotation,
 * no approval, no raw gap, no allocation, no composition, no cost. Ruling #5.
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
type FieldVisibility =
  | "OPEN"
  | "QUOTATION_WORKFLOW"
  | "APPROVAL_WORKFLOW"
  | "GAP_ALLOCATION"
  | "DISBURSEMENT_WORKFLOW"
  | "FINANCE"
  | "COST";

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
  /** Ruling #1: the workflow fact SALES records and MANAGER approves against. */
  submittedQuotationMinor: "QUOTATION_WORKFLOW",
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
  /**
   * The approved amount's DECOMPOSITION. Ruling #3 names all three as
   * accounting economics behind `view:finance`.
   *
   * An earlier revision of this module put them in the disbursement tier,
   * arguing they could not be separated from the approval because
   * `funded + contribution` IS the approved amount. Ruling #3 resolves that the
   * other way round, and it costs nothing: the tier that may read the approval
   * now reads it DIRECTLY (`approvedDealerPurchaseAmountMinor` is
   * `APPROVAL_WORKFLOW`), so there is no addition left to perform, and for
   * everyone else the composition is analysis rather than workflow. Strictly
   * tighter than main `75372e0e5`, where all three were ungated on every door.
   *
   * The screens that show them - `FinanceCompanyDecisionCard`,
   * `ConfirmHandoverDialog` - already render each row only when it is non-null,
   * so a caller without `view:finance` loses those rows and no other behavior.
   */
  financeCompanyFundedPortionMinor: "FINANCE",
  unfinancedPortionMinor: "FINANCE",
  dealerContributionMinor: "FINANCE",
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
  /**
   * The planned custody handler and the amount agreed to hand over. Carries a
   * monetary quantity (the planned advance) and a person, so it sits with the
   * money the disbursement tier acts on — the same tier that opens the actual
   * custody record — and the projection for the deal screen resolves the
   * holder's display name through `listDealCosts`, never here.
   */
  plannedCustody: "DISBURSEMENT_WORKFLOW",
  failureNotes: "FINANCE",
  appraisalFeeResponsibilityReason: "FINANCE",
  /** Rates and fee templates. The `requiresLtvPercent` flag below replaces the
   *  one workflow question a non-finance caller asked of it. */
  companyRuleSnapshot: "FINANCE",
  customerQuotePricingSnapshot: "FINANCE",
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
  /** Ruling #2: an approval fact for the roles that approve and disburse. */
  rawAppraisalGapMinor: "APPROVAL_WORKFLOW",
  customerGapShareMinor: "GAP_ALLOCATION",
  dealerGapShareMinor: "GAP_ALLOCATION",
  customerGapCashToDealerMinor: "GAP_ALLOCATION",
  customerGapInstallmentToDealerMinor: "GAP_ALLOCATION",
  customerGapToFinanceCompanyMinor: "GAP_ALLOCATION",
  gapResolvedAt: "GAP_ALLOCATION",
  gapResolvedBy: "GAP_ALLOCATION",
  gapResolutionNotes: "GAP_ALLOCATION",

  // --- Settlement evidence: tier 1, unchanged ------------------------------
  supplierDisbursedAmountMinor: "FINANCE",
  supplierDisbursementReference: "FINANCE",
  supplierDisbursementApprovedAtRecordingMinor: "FINANCE",
  supplierDisbursementConfirmedAt: "FINANCE",
  supplierDisbursementConfirmedBy: "FINANCE",

  // --- The approval, and the one disbursement prefill ----------------------
  /**
   * Ruling #2 moved this from the disbursement tier to the APPROVAL tier: the
   * role that APPROVES the purchase may read the amount it approved, and so may
   * the role that confirms the payment against it.
   *
   * The three recovery routes that made the old `redactSettlementEvidence`
   * comment honest are closed independently of this class: the LTV division
   * (both operands are FINANCE), the approval notes (FINANCE), and the
   * stringified override history (`projectFinanceApplicationOverrides`). So for
   * a role outside this tier this is a real boundary, not a display gate.
   *
   * Its decomposition - funded, unfinanced, dealer contribution - is FINANCE
   * above rather than sitting beside it. An earlier revision of this module
   * argued they could not be separated, because `funded + contribution` IS the
   * approval. Ruling #3 resolves that the other way round and it costs nothing:
   * the tier that may read the approval reads it DIRECTLY, so there is no
   * addition to perform, and the composition is accounting analysis for
   * everyone else. Strictly tighter than main `75372e0e5`, where all three were
   * ungated.
   */
  approvedDealerPurchaseAmountMinor: "APPROVAL_WORKFLOW",
  /**
   * The ONLY member of `DISBURSEMENT_WORKFLOW`, and the narrow exception ruling
   * #3 permits for an already-approved workflow tier. Load-bearing, not
   * cosmetic: `confirmDisbursement` checks the caller's amount against this
   * frozen net receivable FIRST, and `DealCockpit` sends
   * `financedSaleNetReceivableMinor ?? principal`. Withheld from the default
   * MANAGER - who holds CONFIRM_FINANCE_DISBURSEMENT and not VIEW_FINANCE -
   * every deal carrying an applied deposit or a withheld fee would confirm the
   * principal and be refused, from a dialog offering no field to correct it.
   * That is the workflow dead-end the ruling forbids.
   */
  financedSaleNetReceivableMinor: "DISBURSEMENT_WORKFLOW",

  // --- Cost, the rule the vehicle queries already apply --------------------
  vehiclePurchaseCostMinor: "COST",
};

function allows(role: Doc<"roles">, permission: Permission): boolean {
  return isSystemOwnerRole(role) || role.permissions.includes(permission);
}

/**
 * Which classes this role may read.
 *
 * VIEW_FINANCE satisfies every economic tier, so an ACCOUNTANT or an OWNER is
 * never narrowed by a workflow permission they do not hold. The workflow
 * permissions are OR-ed, deliberately: `requireTenantAuth` takes an array with
 * AND semantics, which is the right default for a door and the wrong one for
 * "any of the roles that legitimately participate".
 */
function visibilityFor(role: Doc<"roles">): Record<FieldVisibility, boolean> {
  const finance = allows(role, PERMISSIONS.VIEW_FINANCE);
  const approves = allows(role, PERMISSIONS.APPROVE_FINANCE_APPLICATION);
  const disburses = allows(role, PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  return {
    OPEN: true,
    QUOTATION_WORKFLOW:
      finance || approves || allows(role, PERMISSIONS.CREATE_FINANCE_APPLICATION),
    APPROVAL_WORKFLOW: finance || approves || disburses,
    GAP_ALLOCATION: finance || approves,
    DISBURSEMENT_WORKFLOW: finance || disburses,
    FINANCE: finance,
    COST: allows(role, PERMISSIONS.VIEW_COST_PRICE),
  };
}

/**
 * May this caller take part in the QUOTATION workflow (ruling #1)?
 *
 * Exported so `suggestQuotationForApplication` gates its result on the SAME
 * rule that classifies `submittedQuotationMinor` above, rather than on a second
 * copy of it. The calculator is the door that echoed the stored quotation back
 * without any quotation authority at all - the CRITICAL this successor closes -
 * and two hand-written copies of one boundary is how the next one arrives.
 */
export function mayReadQuotationWorkflow(role: Doc<"roles">): boolean {
  return visibilityFor(role).QUOTATION_WORKFLOW;
}

/**
 * May this caller read the accounting economics (ruling #3)?
 *
 * The gate on the calculator's LTV, funding composition and projected proceeds.
 */
export function mayReadFinanceEconomics(role: Doc<"roles">): boolean {
  return visibilityFor(role).FINANCE;
}

/**
 * May this caller ESTABLISH or CHANGE the per-deal `appliedLtvPercent`?
 *
 * The authority model replacing the third round of input filters (SCRUM-117,
 * owner-proxy ruling 2026-09-13 15:33). Three CRITICALs in a row came through
 * three different doors to the same figure, and they shared one shape:
 *
 *   quotation = f(hidden inputs, appliedLtvPercent)
 *
 * A role that may WRITE one operand and may SEE the output can solve for the
 * rest — at 100% the dealer contribution collapses and the output IS the
 * protected target in a single shot. Filtering arguments cannot fix that; the
 * only durable repair is that nobody who is barred from READING the economics
 * may WRITE the operand they are barred from reading.
 *
 * Hence BOTH permissions, not either:
 *
 *   • `approve:finance_application` — because the rate is an approval decision
 *     and always was; this is the endpoint authority that already existed;
 *   • `view:finance` — because a writer who cannot read the result is exactly
 *     the actor every reproduction used.
 *
 * Read permission alone grants NO write authority: an ACCOUNTANT holds
 * `view:finance` and not the approval, and is correctly refused here. The
 * system owner passes both through `allows`.
 *
 * Deliberately NOT a variant of `visibilityFor` — that map answers "what may
 * this role READ", and folding a write authority into it would be the same
 * conflation that made `handoverEvidenceFor` derive one field's visibility
 * from another's. This is a separate question with a separate answer, exported
 * once so `recordSubmittedQuotation` and `approveDealerPurchaseAmount` cannot
 * drift apart — the drift between those two is what left W2 open after round 3
 * closed W1.
 */
export function mayEstablishAppliedLtv(role: Doc<"roles">): boolean {
  return (
    allows(role, PERMISSIONS.VIEW_FINANCE) &&
    allows(role, PERMISSIONS.APPROVE_FINANCE_APPLICATION)
  );
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
 * whom and when - the audit trail's existence, without its contents.
 *
 * The return type is WIDENED rather than cast (Sonnet MAX, LOW). The first
 * version wrote `undefined as unknown as string` into `newValue` and `reason`,
 * which are required on the row, so every consumer was told by the type system
 * that a field this function had just blanked was a `string`. No consumer read
 * them yet, which is exactly when a contract lie is cheap to fix.
 */
export type ProjectedFinanceApplicationOverride = Omit<
  Doc<"financeApplicationOverrides">,
  "previousValue" | "newValue" | "reason"
> & {
  previousValue?: string;
  newValue?: string;
  reason?: string;
};

export function projectFinanceApplicationOverrides(
  overrides: Array<Doc<"financeApplicationOverrides">>,
  role: Doc<"roles">
): Array<ProjectedFinanceApplicationOverride> {
  if (allows(role, PERMISSIONS.VIEW_FINANCE)) return overrides;
  return overrides.map((row) => ({
    ...row,
    previousValue: undefined,
    newValue: undefined,
    reason: undefined,
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
