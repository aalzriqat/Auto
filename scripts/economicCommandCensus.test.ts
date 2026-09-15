/**
 * The 115-entry economic-command classification ratchet (SCRUM-313; 113 at the
 * RC, +1 for SCRUM-83's `financingEconomics.resolveAppraisalGap`, +1 for
 * SCRUM-215's `financeDealCosts.recordTemplateFeeActual`).
 *
 * OWNER RULING: every public mutation that can reach a money-bearing sink must
 * carry EXACTLY ONE classification, and this must FAIL whenever a new public
 * financial writer is in none of them. The old 31-command SCRUM-57 manifest is
 * explicitly a SUBSET of this population, not an equal.
 *
 * The mechanism is recorded per entry, not just the bucket, because
 * IDENTITY_GUARDED can be satisfied by more than one mechanism —
 * `vehicles.importBulk` carries a stable per-row import identity rather than
 * `runWithIdempotency`, and forcing everything through one helper would be a
 * false uniformity.
 *
 * The self-tests at the top come first deliberately, in the same spirit as
 * `tenantWriteGuard.test.ts`: a guard nobody has watched fail is not a guard.
 * They pin the FOUR blind spots this analyzer actually had, each of which
 * produced a wrong census before it was caught. Deleting any of them re-opens a
 * hole that has already cost real analysis once.
 */
import { describe, expect, test } from "vitest";
import path from "node:path";
import {
  buildGraph,
  censusForward,
  censusReverse,
  findSinks,
  hasCommandIdentity,
  mintsAndPostsLocally,
  mintsAndPostsTransitively,
  MONEY_TABLES,
  type Bucket,
  type SymbolRecord,
} from "./economicCommandCensus";

const CONVEX_ROOT = path.resolve(__dirname, "..", "convex");

const CLASSIFICATION: Record<string, { bucket: Bucket; mechanism: string }> = {
  "accountingCutover.approveOpeningBalance": { bucket: "STATE_GUARDED", mechanism: "refuses unless the draft is in an approvable state; proven by rehearsal R10-style replay" },
  "accountingCutover.draftOpeningBalance": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "accountingCutover.postOpeningBalanceDirect": { bucket: "STATE_GUARDED", mechanism: "refuses when an opening balance is already posted or awaiting approval" },
  "accountingCutover.rejectOpeningBalanceDraft": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "accountingMigration.backfillFixedAssetMinorUnits": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "accountingMigration.backfillPartnerEquityMinorUnits": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "accountingOutbox.retryFailed": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "applications.amendSupplierDisbursementAdvice": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.cancelApplication": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.confirmDisbursement": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.confirmSupplierDisbursement": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.createFromQuote": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "applications.finalizeDeal": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.registerExpectedPayment": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "applications.registerVehicleHandover": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "applications.setSupplierSettlementRoute": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "applications.updateStatus": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "bankReconciliation.confirmMatch": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "branches.migrateToDefaultBranch": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "cashDrawer.approveVariance": { bucket: "STATE_GUARDED", mechanism: "hookCashDrawerDeposited keys on `cash_drawer_deposited_${sessionId}` — the pre-existing session" },
  "cashDrawer.beginCount": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "cashDrawer.close": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "cashDrawer.open": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "cashDrawer.recordMovement": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.applyRetainedCredit": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.clearCheque": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.createInstallmentPlan": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.createReceivable": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.depositCheque": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.recordPayment": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.registerCheque": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.replaceCheque": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.respondToApproval": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.returnCheque": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.returnClearedCheque": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.reviewCashierReconciliation": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.submitCashierReconciliation": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "customers.softDelete": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "deposits.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "deposits.release": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "deposits.releaseVehicleAllocation": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "deposits.resolveReleasedAllocation": { bucket: "STATE_GUARDED", mechanism: "operates on an existing deposit allocation; the application id it posts under pre-exists the call" },
  "deposits.voidDeposit": { bucket: "STATE_GUARDED", mechanism: "posts only from pre-existing durable state, so its accounting idempotency key is stable across a retry and the posting engine dedupes it" },
  "expenses.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "expenses.remove": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "expenses.reverseExpense": { bucket: "STATE_GUARDED", mechanism: "posts only from pre-existing durable state, so its accounting idempotency key is stable across a retry and the posting engine dedupes it" },
  "expenses.update": { bucket: "STATE_GUARDED", mechanism: "reverses through hookPrepaidExpenseAmortizationsReversed, whose reversal key is derived from the original posted event, not from a fresh id" },
  "financeDealCosts.adoptCompanyFeeTemplates": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic (a rule-snapshot patch on financeApplications); adopts configured fee templates into an empty snapshot slot, owner-only and audited, and posts nothing" },
  "financeDealCosts.classifyDealAccounting": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financeDealCosts.openDealCustody": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted; the ISSUED entry it mints posts under `custody_entry_${entryId}` INSIDE the idempotent section, so a replay returns the stored custody id and never reaches the hook" },
  "financeDealCosts.planCustodyHandler": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic (a `plannedCustody` patch on financeApplications); names who will handle the handover before any cash moves, audited, and posts nothing" },
  "financeDealCosts.migrateLegacyCustodyToLedger": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted on the custody id; every posting it makes is keyed on PRE-EXISTING entry, fee and custody ids through the same hooks the product uses, and a fresh key against a record already CANONICAL is refused inside the section" },
  "financeDealCosts.reconcileDealCustody": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted on custody id, normalised notes and write-off reason; the write-off branch additionally posts CUSTODY_WRITTEN_OFF keyed on the pre-existing custody id plus a stored version, and every mutable-state check is inside the section" },
  "financeDealCosts.reconcileDealFee": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financeDealCosts.recordActualFeeAmount": { bucket: "STATE_GUARDED", mechanism: "sets a named field on one identified row; the custody posting it re-syncs (`syncCustodyFeePosting`) is keyed on the PRE-EXISTING fee id plus a version stored on the row, so a retry finds `custodyPosted` already matching and posts nothing" },
  "financeDealCosts.recordCustodyMovement": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "financeDealCosts.recordDealFee": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "financeDealCosts.recordTemplateFeeActual": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted (position included); one live line per (deal, position) refused inside the idempotent section" },
  "financeDealCosts.recordLegalInvoice": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financeDealCosts.reopenDealCustody": { bucket: "STATE_GUARDED", mechanism: "reverses the stored write-off posting version through reverseEventIfPosted, whose key derives from the pre-existing custody id and version; a retry finds status === OPEN and returns before any posting" },
  "financeDealCosts.setFeeCustody": { bucket: "STATE_GUARDED", mechanism: "charges or releases an EXISTING fee line: the posting it syncs is keyed on the pre-existing fee id plus a version stored on the row (`custodyPosted`), so a retry after a lost response finds the target state already on the books and posts nothing; a second identical call returns early on `fee.custodyId === args.custodyId`" },
  "financeDealCosts.voidDealFee": { bucket: "STATE_GUARDED", mechanism: "voids one identified row and reverses its stored custody posting version through reverseEventIfPosted; a retry finds `voidedAt` set and returns before any posting" },
  "financialAudit.approveManualJournal": { bucket: "STATE_GUARDED", mechanism: "refuses unless status === PENDING_APPROVAL; a second approval cannot produce a second journal (rehearsal R10)" },
  "financialAudit.createManualJournal": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financialAudit.rejectManualJournal": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financingEconomics.approveDealerPurchaseAmount": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financingEconomics.recordAppraisal": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financingEconomics.recordSubmittedQuotation": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financingEconomics.reopenApproval": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financingEconomics.resolveAppraisalGap": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table (financeApplications gap shares/destinations) only through the patch heuristic; no posting call is reachable from its own body. Replay-safe by state: refuses once gapResolution is CUSTOMER_ABSORBS/SPLIT/DEALER_ABSORBS and checks the economics stamp before any write (SCRUM-83)" },
  "financingEconomics.resolveFinancingReconciliation": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "fixedAssets.capitalize": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "fixedAssets.dispose": { bucket: "STATE_GUARDED", mechanism: "hookAssetDisposed keys on `asset_disposed_${assetId}` — the PRE-EXISTING asset, so a retry reproduces the key and the posting engine dedupes it" },
  "fixedAssets.impair": { bucket: "STATE_GUARDED", mechanism: "hookAssetImpaired keys on `asset_impaired_${assetId}` — pre-existing asset id, stable across a retry" },
  "fixedAssets.remove": { bucket: "STATE_GUARDED", mechanism: "delegates to dispose; same stable `asset_disposed_${assetId}` key" },
  "fixedAssets.update": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "orgSettings.upsert": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "partnerEquity.add": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "partnerEquity.recordEquityMovement": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "partnerEquity.remove": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "partnerEquity.update": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "paymentIntents.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "paymentIntents.expire": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "paymentIntents.markSettled": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "payroll.approveRun": { bucket: "STATE_GUARDED", mechanism: "hookPayrollAccrued keys on `payroll_accrued_${itemId}`; items are minted by createRun, so at approve time the id pre-exists and the key is stable" },
  "payroll.cancelRun": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "payroll.createRun": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "payroll.payRun": { bucket: "STATE_GUARDED", mechanism: "hookPayrollPaid keys on `payroll_paid_${itemId}` — pre-existing payroll item" },
  "payroll.recordAdvance": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "payroll.recoverAdvance": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "prepaidExpenses.approveCorrectionRequest": { bucket: "STATE_GUARDED", mechanism: "refuses unless request.status === PENDING" },
  "prepaidExpenses.correctSchedule": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "prepaidExpenses.redriveScheduleEvents": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "prepaidExpenses.retryAmortizationFailure": { bucket: "STATE_GUARDED", mechanism: "hookPrepaidExpenseAmortized keys on `prepaid_amort_${scheduleId}_${yearMonth}` — both pre-existing/deterministic, which is precisely what makes a RETRY endpoint safe" },
  "sales.completeDraft": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sales.completeFromQuote": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sales.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sales.createDraft": { bucket: "NON_ECONOMIC", mechanism: "prepareSaleCompletion(DRAFT) writes no rows and insertSaleRecord(PENDING) only inserts the sale; applySaleCompletionSideEffects is never reached" },
  "sales.markCommissionPaid": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sales.markCommissionUnpaid": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "sales.recalculateCommission": { bucket: "STATE_GUARDED", mechanism: "makeCommissionHook keys on `${prefix}_${saleId}` — pre-existing sale" },
  "sales.setCommissionAmount": { bucket: "STATE_GUARDED", mechanism: "convergent set-to-value: commissionAmount is SET, and deltaMinor = next - previous, so a retry computes 0, posts nothing and burns no adjustment sequence" },
  "sales.softDelete": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "sales.update": { bucket: "STATE_GUARDED", mechanism: "posts only from pre-existing durable state, so its accounting idempotency key is stable across a retry and the posting engine dedupes it" },
  "sourcingPayables.markPaid": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sourcingPayables.recordPartialPayment": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sourcingPayables.setDisputed": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "supplierReceivables.recordReceipt": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "supplierReceivables.setDisputed": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "vehicleEdits.resolve": { bucket: "STATE_GUARDED", mechanism: "refuses unless request.status === PENDING; the same mutation transitions it to APPROVED/REJECTED" },
  "vehicles.correctAcquisitionCost": { bucket: "STATE_GUARDED", mechanism: "convergent set-to-value: the retry re-reads the patched cost, delta === 0, and throws UNCAUGHT so Convex rolls back before the insert and the hook" },
  "vehicles.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "vehicles.createReservation": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "vehicles.importBulk": { bucket: "IDENTITY_GUARDED", mechanism: "per-row import identity `${importId}:${row.rowId}` — a SECOND valid mechanism, not runWithIdempotency" },
  "vehicles.releaseReservation": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "vehicles.update": { bucket: "STATE_GUARDED", mechanism: "hookVehicleAcquired keys on `vehicle_acquired_${vehicleId}` — pre-existing vehicle (contrast vehicles.create, where that id is minted in-call, which is why THAT one needs identity)" },
  "vehicles.upsertLandedCosts": { bucket: "STATE_GUARDED", mechanism: "convergent: accountDeltas = newSums - oldSums against the STORED items, so a retry yields zero deltas and never reaches the posting call. NOTE the posting mints `editToken: crypto.randomUUID()` server-side — that would be a retry hole if the deltas were absolute; it is safe ONLY because the guard above it is convergent" },
  "workOrders.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "workOrders.update": { bucket: "STATE_GUARDED", mechanism: "refuses when the work order already carries expenseId, which this same mutation patches on success" },
};

describe("analyzer self-tests — the four blind spots, pinned", () => {
  test("BLIND SPOT 1: a callee is resolved through imports, never by bare name", () => {
    // `create`, `add` and `update` are symbol names in dozens of modules. Bare
    // name resolution fused the graph and reported 348 of 349 public mutations
    // as economic. If a future edit reintroduces name-based linking, the
    // population explodes and this catches it.
    const g = buildGraph(CONVEX_ROOT);
    const population = censusForward(g);
    const publicMutations = [...g.symbols.values()].filter((s) => s.kind === "publicMutation");
    expect(publicMutations.length).toBeGreaterThan(300);
    // A fused graph puts essentially EVERY public mutation in the population.
    expect(population.size).toBeLessThan(publicMutations.length * 0.6);
  });

  test("BLIND SPOT 2: a financial sink is not only a ledger insert", () => {
    // Defining a sink as a journal/accountingEvents insert dropped seven
    // already-protected commands that move money without posting. Those tables
    // must remain in the money-bearing set.
    for (const table of ["deposits", "paymentIntents", "financeDealCustody", "financeDealFees"]) {
      expect(MONEY_TABLES).toContain(table);
    }
  });

  test("BLIND SPOT 3: ctx.db.patch is reachable by sink detection", () => {
    // patch/replace take a DOCUMENT ID, never a table name, so a call-site
    // regex can only ever see inserts. A function that only patches, while
    // naming a money table in a typed id, must still be a sink.
    const onlyPatches: SymbolRecord = {
      id: "synthetic.patchesOnly",
      file: "synthetic",
      name: "patchesOnly",
      kind: "publicMutation",
      line: 1,
      body: [
        "export const patchesOnly = mutation({",
        "  handler: async (ctx, args: { id: Id<\"receivables\"> }) => {",
        "    await ctx.db.patch(args.id, { outstandingAmount: 0 });",
        "  },",
        "});",
      ].join("\n"),
    };
    const sinks = findSinks(new Map([[onlyPatches.id, onlyPatches]]));
    expect([...sinks]).toEqual(["synthetic.patchesOnly"]);
  });

  test("BLIND SPOT 4: mint-and-post detection is transitive through a helper", () => {
    // `partnerEquity.add` -> `recordMovement` mints the transactions row and
    // posts. A local-only check calls the command safe; the owner found this by
    // hand. The local check must say NO and the transitive one must say YES, or
    // the ratchet has the same hole it had before.
    const command: SymbolRecord = {
      id: "synthetic.command", file: "synthetic", name: "command", kind: "publicMutation", line: 1,
      body: [
        "export const command = mutation({",
        "  handler: async (ctx, args) => {",
        "    return await helper(ctx, args);",
        "  },",
        "});",
      ].join("\n"),
    };
    const helper: SymbolRecord = {
      id: "synthetic.helper", file: "synthetic", name: "helper", kind: "helper", line: 10,
      body: [
        "async function helper(ctx, args) {",
        "  const transactionId = await ctx.db.insert(\"partnerEquityTransactions\", { ...args });",
        "  const hookArgs = { transactionId, orgId: args.orgId };",
        "  await hookCapitalContributed(ctx, hookArgs);",
        "  return transactionId;",
        "}",
      ].join("\n"),
    };
    const symbols = new Map([[command.id, command], [helper.id, helper]]);
    const g = {
      symbols,
      edges: new Map([[command.id, new Set([helper.id])], [helper.id, new Set<string>()]]),
      rEdges: new Map([[helper.id, new Set([command.id])], [command.id, new Set<string>()]]),
      sinks: new Set<string>(),
    };
    expect(mintsAndPostsLocally(command.body)).toBe(false);
    expect(mintsAndPostsTransitively(g, command.id)).toBe(true);
  });
});

describe("SCRUM-313 economic command classification ratchet", () => {
  const g = buildGraph(CONVEX_ROOT);
  const forward = censusForward(g);
  const reverse = censusReverse(g);

  test("the population is derived identically in both directions", () => {
    const onlyForward = [...forward].filter((x) => !reverse.has(x)).sort((a, b) => a.localeCompare(b));
    const onlyReverse = [...reverse].filter((x) => !forward.has(x)).sort((a, b) => a.localeCompare(b));
    expect(onlyForward).toEqual([]);
    expect(onlyReverse).toEqual([]);
  });

  test("the population is exactly the classified set", () => {
    const classified = Object.keys(CLASSIFICATION).sort((a, b) => a.localeCompare(b));
    const population = [...forward].sort((a, b) => a.localeCompare(b));
    // Both directions, so a NEW public financial writer fails here rather than
    // entering the codebase unclassified, and a classification for a command
    // that no longer exists fails too rather than rotting.
    expect(population.filter((p) => !CLASSIFICATION[p])).toEqual([]);
    expect(classified.filter((c) => !forward.has(c))).toEqual([]);
    // 116 → 118: `financeDealCosts.planCustodyHandler` and `financeDealCosts.setFeeCustody` (AF-80).
    // 118 → 119: `financeDealCosts.migrateLegacyCustodyToLedger` (AF-80 final round B).
    expect(population.length).toBe(119);
  });

  test("every entry carries exactly one bucket and a stated mechanism", () => {
    const buckets: Bucket[] = ["IDENTITY_GUARDED", "STATE_GUARDED", "NON_ECONOMIC", "RETIRED"];
    for (const [id, entry] of Object.entries(CLASSIFICATION)) {
      expect(buckets, id).toContain(entry.bucket);
      expect(entry.mechanism.trim().length, id).toBeGreaterThan(20);
    }
  });

  test("every IDENTITY_GUARDED command actually carries identity", () => {
    // The bucket is a claim about the source. A command may satisfy it through
    // runWithIdempotency OR a documented equivalent, so the exceptions are named
    // explicitly rather than the assertion being weakened for everyone.
    const ALTERNATE_MECHANISM = new Set(["vehicles.importBulk"]);
    const liars: string[] = [];
    for (const [id, entry] of Object.entries(CLASSIFICATION)) {
      if (entry.bucket !== "IDENTITY_GUARDED") continue;
      if (ALTERNATE_MECHANISM.has(id)) continue;
      const sym = g.symbols.get(id);
      if (!sym || !hasCommandIdentity(sym.body)) liars.push(id);
    }
    expect(liars).toEqual([]);
  });

  test("no public mutation mints an id and posts without an explicit classification", () => {
    // The safety property, stated as the thing that actually hurts: a command
    // that creates a row and posts an accounting event keyed on that row's fresh
    // id is blind to its own retry. Every such command must be consciously
    // classified — over-inclusion is intended, since a false positive costs one
    // line here and a false negative duplicates money.
    const unclassified: string[] = [];
    for (const id of forward) {
      if (!mintsAndPostsTransitively(g, id)) continue;
      if (!CLASSIFICATION[id]) unclassified.push(id);
    }
    expect(unclassified).toEqual([]);
  });

  test("the SCRUM-57 manifest is a strict subset of this population", () => {
    // Recorded so nobody re-derives safety from the old 31-command manifest.
    const MANIFEST_SAMPLE = [
      "collections.recordPayment", "deposits.release", "paymentIntents.create",
      "financeDealCosts.recordDealFee", "applications.confirmSupplierDisbursement",
    ];
    for (const id of MANIFEST_SAMPLE) expect([...forward], id).toContain(id);
    expect(forward.size).toBeGreaterThan(31);
  });
});
