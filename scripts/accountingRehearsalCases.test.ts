/**
 * Does the rehearsal actually CATCH anything?
 *
 * A rehearsal that only ever passes is decoration, and a green cloud run would
 * tell nobody anything. These tests drive `runRehearsalCases` against an
 * in-memory backend whose behaviour can be broken on purpose, and assert that
 * the case which exists to catch each defect is the case that goes red.
 *
 * This is the same discipline as the mutation battery on the client ratchet: the
 * instrument gets attacked before its output is quoted.
 *
 * ⚠️ EVIDENCE BOUNDARY. The fake below is a MODEL of the deposit-release
 * contract, not the product. It proves the ASSERTIONS discriminate; it proves
 * nothing about Convex, and in particular its `fireConcurrentReleases` stand-in
 * cannot interleave anything. Real interleaving is exactly what the cloud run
 * exists for, and nothing here substitutes for it.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CURRENCY_SCALES, DEFAULT_ORG_CURRENCY, assertBothAttemptsExecuted, runRehearsalCases } from "./accountingRehearsalCases.mjs";

type Deposit = {
  _id: string;
  releasedAmountMinor: number;
  refundedAmountMinor: number;
  releaseCount: number;
  freeMinor: number;
  committedMinor: number;
  vehicleId: string;
  customerId?: string;
  amountMinor?: number;
  status: string;
};

type Defects = {
  /** Distinct keys each pay the ORIGINAL free balance — the OCC failure C2 hunts. */
  doublePayOnDistinctKeys?: boolean;
  /** A later genuine payout is served the earlier one's stored result — the stale-key incident. */
  suppressNextGeneration?: boolean;
  /** Identity is not required at all. */
  acceptUnidentified?: boolean;
  /** Anyone at all may release. */
  acceptUnauthenticated?: boolean;
  /** The chart ships without 2110. */
  noUnappliedLiability?: boolean;
  /** A caller may name someone else's organization — the cross-tenant Critical. */
  acceptForeignOrg?: boolean;
  /** The chart is missing an account the product's own validator requires. */
  missingSystemAccount?: boolean;
  /** A replay posts a SECOND accounting event while leaving the deposit row alone. */
  doublePostOnReplay?: boolean;
  /** The money moves but the books never hear about it. */
  noCanonicalPayment?: boolean;
  /** A journal entry whose debits and credits disagree. */
  unbalancedJournal?: boolean;
  /** A posting failed on its way to the ledger and nobody noticed. */
  stuckFailedOutbox?: boolean;
  /** The GL is written even though no period is open — the partial-post outcome. */
  partialGlWhileClosed?: boolean;
  /** Money leaves while the books are shut and nothing is queued to catch up. */
  loseThePostingWhileClosed?: boolean;
  /** One concurrency worker crashes before it sends — the RG-01 false pass. */
  oneWorkerCrashes?: boolean;
  /** The two workers run one after the other — nothing concurrent was measured. */
  sequentialWorkers?: boolean;
  /** The second worker got a 503 with a non-JSON body — never reached the handler (Codex RG-01-R1). */
  loserGetsGatewayError?: boolean;
  /** The second worker was refused at the auth layer, HTTP 200, status error (Codex RG-01-R1). */
  loserGetsAuthError?: boolean;
  /** The PRODUCT refuses a same-key replay instead of serving the first result — a real defect. */
  sameKeyReplayRefused?: boolean;
  /** The period cannot be closed at all — so the property is UNTESTED, not proven. */
  refuseClose?: boolean;
  /** A replayed create makes a SECOND row — the double-spend. */
  duplicateOnCreateReplay?: boolean;
  /** A replayed create is REFUSED — safe-looking, and not safe. */
  refuseCreateReplay?: boolean;
  /** An over-payment settles the invoice and the excess simply disappears. */
  swallowOverpayment?: boolean;
  /** Applying a retained credit does not reduce the liability. */
  ignoreRetainedApplication?: boolean;
  /** Only part of the receipt is retained — a real shortfall, not a scale difference. */
  shortRetention?: boolean;
  /** A consigned sale is posted as if the dealership owned the car — ACC-1. */
  postConsignedAsOwned?: boolean;
  /** The consigned sale posts no journal at all. */
  silentConsignedSale?: boolean;
  /** A returned cheque ERASES its clearing instead of reversing it. */
  eraseOnChequeReturn?: boolean;
  /** A returned cheque posts nothing at all — the books still say money arrived. */
  silentChequeReturn?: boolean;
  // ── the owner-proxy's evidence-floor closure (2026-09-11): the false-pass shapes it named ──
  /** The org's currency is one the product does not denominate — expectations cannot be derived. */
  orgCurrencyUnknown?: boolean;
  /** No orgSettings row exists at all — the shape of a FRESH organization on the cloud. */
  noOrgSettingsRow?: boolean;
  /** Journal lines are written at a different minor-unit scale than the org's currency. */
  linesAtWrongScale?: boolean;
  /** The refund credits the BANK instead of cash — balanced, wrong account. */
  refundPostsWrongAccount?: boolean;
  /** The refund posts one minor unit short on the credit — B2 would still balance it away. */
  refundPostsWrongAmount?: boolean;
  /** The refund's event names no journal entry at all. */
  refundEventUnlinked?: boolean;
  /** A SECOND perfectly balanced entry for the same refund. */
  duplicateRefundJournal?: boolean;
  /** Money received on account is credited to INCOME instead of the 2110 liability (ACC-9). */
  onAccountPostsAsIncome?: boolean;
  /** The retained position says 500 while the 2110 control account carries less. */
  retainedPositionDriftsFromGl?: boolean;
  /** Applying a retained credit reduces the position but posts nothing to the GL. */
  applicationPostsNothing?: boolean;
  /** The reversal entry exists but nothing links it to the clearing it reverses. */
  reversalUnlinked?: boolean;
  /** The reversal is for HALF the clearing — linked, and wrong. */
  reversalWrongAmount?: boolean;
  /** The cheque bounces, the GL reverses, and the receivable still reads PAID. */
  receivableNotReopened?: boolean;
  /** A replayed create hands back the SAME id and posts its footprint AGAIN. */
  doubleFootprintOnReplay?: boolean;
  /** A completed work order with a posted expense can be edited (and re-posted). */
  workOrderLockOpen?: boolean;
};

function makeBackend(defects: Defects = {}) {
  const deposits = new Map<string, Deposit>();
  const commands = new Map<string, string>();
  const createdByKey = new Map<string, string>();
  /**
   * THE BOOKS, modelled the way the product keeps them and the way the closure
   * cases read them: an accounting EVENT bound to a journal ENTRY bound to
   * LINES on accounts that carry a system key, a currency and a scale. The
   * earlier fake kept bare entries with anonymous lines, which is exactly the
   * shape the owner-proxy found the runner asserting against — "some balanced
   * entry appeared" — so the fake could not have caught the gap either.
   */
  const events: Array<Record<string, any>> = [];
  const journalEntries: Array<Record<string, any>> = [];
  const journalLines = new Map<string, Array<Record<string, any>>>();
  const collectionPayments: Array<Record<string, any>> = [];
  const canonicalPayments = new Map<string, Record<string, any>>();
  const pendingEvents: Array<Record<string, any>> = [];
  const retained = new Map<string, { receiptMovementId: string; customerId: string; remainingUnappliedMinor: number; receiptPosted: boolean; applications: number }>();
  const cheques = new Map<string, Record<string, any>>();
  const receivables = new Map<string, Record<string, any>>();
  const fixedAssets: Array<Record<string, any>> = [];
  const partners: Array<Record<string, any>> = [];
  const equityTxs: Array<Record<string, any>> = [];
  const workOrders: Array<Record<string, any>> = [];
  /**
   * THREE decimal places, matching the deployment the rehearsal actually runs
   * against. The fake used 100 and therefore agreed with my wrong expectation
   * of 50,000 — two wrongs that cancelled locally and separated on the cloud.
   * The runner now reads the currency from the org and derives the scale from
   * its pinned mirror of the product's table — so this fake reports a currency,
   * and `MINOR_SCALE` is what that currency implies.
   */
  const ORG_CURRENCY = defects.orgCurrencyUnknown ? "XXX" : "JOD";
  const MINOR_SCALE = 1000;
  const LINE_SCALE = defects.linesAtWrongScale ? 2 : 3;
  const vehicles = new Map<string, Record<string, any>>();
  /** The chart, keyed the way the product keys it, so lines resolve to system keys. */
  const CHART = [
    { _id: "acct_cash", code: "1000", type: "ASSET", name: "Cash", systemKey: "CASH_ON_HAND", normalBalance: "DEBIT" },
    { _id: "acct_bank", code: "1010", type: "ASSET", name: "Bank", systemKey: "BANK_ACCOUNT", normalBalance: "DEBIT" },
    { _id: "acct_ar", code: "1200", type: "ASSET", name: "AR Customers", systemKey: "ACCOUNTS_RECEIVABLE_CUSTOMERS", normalBalance: "DEBIT" },
    { _id: "acct_2110", code: "2110", type: "LIABILITY", name: "Unapplied Customer Receipts", systemKey: "UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY", normalBalance: "CREDIT" },
    { _id: "acct_depl", code: "2120", type: "LIABILITY", name: "Customer Deposits", systemKey: "CUSTOMER_DEPOSITS_LIABILITY", normalBalance: "CREDIT" },
    { _id: "acct_comm", code: "4200", type: "REVENUE", name: "Consignment Commission", systemKey: "CONSIGNMENT_COMMISSION_REVENUE", normalBalance: "CREDIT" },
    { _id: "acct_misc", code: "4900", type: "REVENUE", name: "Misc Income", systemKey: "MISCELLANEOUS_INCOME", normalBalance: "CREDIT" },
    { _id: "acct_ap", code: "2100", type: "LIABILITY", name: "AP Suppliers", systemKey: "ACCOUNTS_PAYABLE_SUPPLIERS", normalBalance: "CREDIT" },
    { _id: "acct_rev", code: "4000", type: "REVENUE", name: "Sales Revenue", systemKey: "SALES_REVENUE", normalBalance: "CREDIT" },
    { _id: "acct_cogs", code: "5000", type: "EXPENSE", name: "COGS", systemKey: "COST_OF_VEHICLES_SOLD", normalBalance: "DEBIT" },
    { _id: "acct_inv", code: "1300", type: "ASSET", name: "Vehicle Inventory", systemKey: "VEHICLE_INVENTORY", normalBalance: "DEBIT" },
    { _id: "acct_fa", code: "1500", type: "ASSET", name: "Fixed Assets", systemKey: "FIXED_ASSETS", normalBalance: "DEBIT" },
    { _id: "acct_cap", code: "3000", type: "EQUITY", name: "Partner Capital", systemKey: "PARTNER_CAPITAL", normalBalance: "CREDIT" },
    { _id: "acct_draw", code: "3100", type: "EQUITY", name: "Partner Drawings", systemKey: "PARTNER_DRAWINGS", normalBalance: "DEBIT" },
    { _id: "acct_exp", code: "6000", type: "EXPENSE", name: "General Expense", systemKey: "GENERAL_EXPENSE", normalBalance: "DEBIT" },
  ];
  const accountIdOf = (key: string) => {
    const hit = CHART.find((a) => a.systemKey === key);
    if (!hit) throw new Error(`fake chart has no ${key}`);
    return hit._id;
  };
  /** quoteId -> vehicleId, because a deposit names a QUOTE and is read back by VEHICLE. */
  const quoteVehicle = new Map<string, string>();
  const quoteCustomer = new Map<string, string>();
  let periodStatus = "OPEN";
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;

  type Line = { key: string; debitMinor?: number; creditMinor?: number; customerId?: string };
  /** One economic occurrence: an event, its entry, its lines — all linked. */
  function post(
    eventType: string,
    sourceType: string,
    sourceId: string,
    lines: Line[],
    opts: { category?: string; unlinked?: boolean; payload?: Record<string, any> } = {}
  ) {
    const eventId = id("evt");
    const entryId = id("je");
    events.push({
      _id: eventId,
      eventType,
      sourceType,
      sourceId,
      eventVersion: 1,
      status: "POSTED",
      journalEntryId: opts.unlinked ? undefined : entryId,
      payload: opts.payload ?? {},
    });
    journalEntries.push({
      _id: entryId,
      accountingEventId: eventId,
      sourceType,
      sourceId,
      category: opts.category ?? "SYSTEM",
      status: "POSTED",
      journalNumber: `JE-${seq}`,
    });
    journalLines.set(
      entryId,
      lines.map((l, i) => ({
        _id: id("jl"),
        journalEntryId: entryId,
        lineNumber: i + 1,
        accountId: accountIdOf(l.key),
        debitMinor: l.debitMinor ?? 0,
        creditMinor: l.creditMinor ?? 0,
        currency: ORG_CURRENCY,
        scale: LINE_SCALE,
        customerId: l.customerId,
      }))
    );
    return { eventId, entryId };
  }
  /** The product's reversal: the original stays, marked, and names its reverser. */
  function reverse(eventId: string) {
    const original = events.find((e) => e._id === eventId)!;
    const entry = journalEntries.find((j) => j._id === original.journalEntryId)!;
    const lines = journalLines.get(entry._id) ?? [];
    const factor = defects.reversalWrongAmount ? 0.5 : 1;
    const reversal = post(
      original.eventType,
      original.sourceType,
      original.sourceId,
      lines.map((l) => ({
        key: CHART.find((a) => a._id === l.accountId)!.systemKey,
        debitMinor: Math.round(l.creditMinor * factor),
        creditMinor: Math.round(l.debitMinor * factor),
        customerId: l.customerId,
      })),
      { category: "REVERSAL" }
    );
    // A reversal's event carries the reversed event's type in the product too;
    // the case finds the ORIGINAL by status, so mark the reversal's event as
    // such and keep it out of the "one POSTED occurrence" count.
    const reversalEvent = events.find((e) => e._id === reversal.eventId)!;
    reversalEvent.eventType = `${original.eventType}_REVERSAL`;
    reversalEvent.reversalOfEventId = eventId;
    original.status = "REVERSED";
    entry.status = "REVERSED";
    if (!defects.reversalUnlinked) {
      original.reversedByEventId = reversal.eventId;
      entry.reversedByJournalEntryId = reversal.entryId;
      journalEntries.find((j) => j._id === reversal.entryId)!.reversalOfJournalEntryId = entry._id;
    }
    return reversal;
  }

  /**
   * The identity contract on a CREATE, modelled the way RT1/RT2 assert it: a
   * replayed key replays. `probe` mode returns null when the caller must go on
   * and build the row itself, so deposits keep their own construction.
   */
  function replayableCreate(prefix: string, args: Record<string, any>, probe = false) {
    const key = args.idempotencyKey;
    if (key && createdByKey.has(key)) {
      if (defects.refuseCreateReplay) {
        return { ok: false as const, error: "Duplicate request." };
      }
      if (defects.duplicateOnCreateReplay) {
        const fresh = id(prefix);
        createdByKey.set(key, fresh);
        return { ok: true as const, value: fresh };
      }
      return { ok: true as const, value: createdByKey.get(key)! };
    }
    if (probe) return null;
    const made = id(prefix);
    if (key) createdByKey.set(key, made);
    return { ok: true as const, value: made };
  }
  /** A replay that hands back the same id and STILL posts again — the footprint defect. */
  const replayedFootprint = (args: Record<string, any>) =>
    Boolean(args.idempotencyKey && createdByKey.has(args.idempotencyKey) && defects.doubleFootprintOnReplay);

  const release = (args: Record<string, any>, authed: boolean) => {
    if (!authed && !defects.acceptUnauthenticated) {
      return { ok: false as const, error: "Unauthenticated: You must be logged in." };
    }
    // Tenancy is modelled because the TEN case asserts on it. A fake that
    // ignored `orgId` would make TEN red against a HEALTHY backend, which would
    // teach the reader to expect a red case and stop reading — the failure mode
    // that makes a noisy suite worse than none.
    if (args.orgId !== "org_1" && !defects.acceptForeignOrg) {
      return { ok: false as const, error: "You do not have access to this organization." };
    }
    if (!args.idempotencyKey && !defects.acceptUnidentified) {
      return { ok: false as const, error: "This economic command requires a command identity." };
    }
    const deposit = deposits.get(args.depositId);
    if (!deposit) return { ok: false as const, error: "deposit not found" };

    const fingerprint = JSON.stringify([args.depositId, args.resolution, args.refundMethod]);
    if (args.idempotencyKey) {
      const seen = commands.get(args.idempotencyKey);
      if (seen !== undefined) {
        if (seen !== fingerprint) {
          return { ok: false as const, error: "This command was already run with different request content." };
        }
        // A replay that re-posts to the ledger while leaving the deposit row
        // alone is invisible to every case that reads only the row — which is
        // exactly why B1 counts the events.
        if (defects.doublePostOnReplay) {
          postRefundToTheBooks(deposit, deposit.releasedAmountMinor, true);
        }
        if (defects.sameKeyReplayRefused) {
          return { ok: false as const, error: "There is nothing left of this deposit to refund or forfeit." };
        }
        return { ok: true as const, value: null }; // faithful replay
      }
      if (defects.suppressNextGeneration && deposit.releaseCount > 0) {
        return { ok: true as const, value: null }; // a NEW key served as a replay
      }
    }

    const payable = defects.doublePayOnDistinctKeys ? 2_000_000 : deposit.freeMinor;
    if (payable <= 0) {
      return { ok: false as const, error: "There is nothing left of this deposit to refund or forfeit." };
    }
    if (args.idempotencyKey) commands.set(args.idempotencyKey, fingerprint);
    deposit.freeMinor = defects.doublePayOnDistinctKeys ? deposit.freeMinor : 0;
    deposit.releasedAmountMinor += payable;
    deposit.refundedAmountMinor += payable;
    deposit.releaseCount += 1;
    if (deposit.freeMinor === 0 && deposit.committedMinor === 0) deposit.status = args.resolution;
    if (periodStatus === "OPEN") {
      postRefundToTheBooks(deposit, payable, false);
    } else {
      // No open period is a TEMPORARY HOLD: the decision stands, the posting
      // waits. Writing the journal anyway is the partial-post defect P1 hunts.
      if (defects.partialGlWhileClosed) postRefundToTheBooks(deposit, payable, false);
      if (!defects.loseThePostingWhileClosed) {
        pendingEvents.push({ _id: id("pev"), status: "PENDING", eventType: "DEPOSIT_REFUNDED" });
      }
    }
    return { ok: true as const, value: null };
  };

  /** The ledger side of a refund — what B1 and B2 reconcile the row against. */
  function postRefundToTheBooks(deposit: Deposit, payable: number, isReplayDuplicate: boolean) {
    const creditKey = defects.refundPostsWrongAccount ? "BANK_ACCOUNT" : "CASH_ON_HAND";
    const creditAmount = defects.refundPostsWrongAmount ? payable - 1 : payable;
    post(
      "DEPOSIT_REFUNDED",
      "deposits",
      deposit._id,
      [
        { key: "CUSTOMER_DEPOSITS_LIABILITY", debitMinor: payable, customerId: deposit.customerId },
        // An unbalanced entry is a GL that does not add up — B2's whole subject.
        { key: creditKey, creditMinor: defects.unbalancedJournal ? payable - 1 : creditAmount, customerId: deposit.customerId },
      ],
      { unlinked: defects.refundEventUnlinked, payload: { depositId: deposit._id, amountMinor: payable } }
    );
    if (defects.duplicateRefundJournal && !isReplayDuplicate) {
      // A second, perfectly balanced entry for the same refund — B2 passes it.
      const entryId = id("je");
      journalEntries.push({ _id: entryId, sourceType: "deposits", sourceId: deposit._id, category: "SYSTEM", status: "POSTED" });
      journalLines.set(entryId, [
        { accountId: "acct_depl", debitMinor: payable, creditMinor: 0, currency: ORG_CURRENCY, scale: LINE_SCALE },
        { accountId: "acct_cash", debitMinor: 0, creditMinor: payable, currency: ORG_CURRENCY, scale: LINE_SCALE },
      ]);
    }
    if (isReplayDuplicate) return;
    const canonicalId = id("cp");
    if (!defects.noCanonicalPayment) {
      canonicalPayments.set(canonicalId, { _id: canonicalId, amountMinor: payable, status: "SETTLED" });
    }
    collectionPayments.push({
      _id: id("colp"),
      vehicleId: deposit.vehicleId,
      reference: `Deposit refund ${deposit._id}`,
      direction: "OUT",
      method: "REFUND",
      amount: payable / MINOR_SCALE,
      canonicalPaymentId: defects.noCanonicalPayment ? undefined : canonicalId,
    });
  }

  /** A customer receipt: cash in, against AR (allocated) or 2110 (on account). */
  function postReceipt(paymentId: string, customerId: string, amountMinor: number, allocatedMinor: number, cashKey: string) {
    const lines: Line[] = [{ key: cashKey, debitMinor: amountMinor, customerId }];
    if (allocatedMinor > 0) lines.push({ key: "ACCOUNTS_RECEIVABLE_CUSTOMERS", creditMinor: allocatedMinor, customerId });
    const unapplied = amountMinor - allocatedMinor;
    if (unapplied > 0) {
      lines.push({
        key: defects.onAccountPostsAsIncome ? "MISCELLANEOUS_INCOME" : "UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY",
        creditMinor: defects.retainedPositionDriftsFromGl ? unapplied - 50_000 : unapplied,
        customerId,
      });
      if (defects.retainedPositionDriftsFromGl) lines[0].debitMinor = amountMinor - 50_000;
    }
    return post("COLLECTION_PAYMENT", "collectionPayments", paymentId, lines, { payload: { customerId } });
  }

  const receivableRow = (rid: string, args: Record<string, any>, amount: number) => {
    receivables.set(rid, {
      _id: rid,
      customerId: String(args.customerId),
      title: args.title,
      originalAmount: amount,
      outstandingAmount: amount,
      status: "OPEN",
    });
    post("RECEIVABLE_CREATED", "receivables", rid, [
      { key: "ACCOUNTS_RECEIVABLE_CUSTOMERS", debitMinor: Math.round(amount * MINOR_SCALE), customerId: String(args.customerId) },
      { key: args.creditSystemKey ?? "MISCELLANEOUS_INCOME", creditMinor: Math.round(amount * MINOR_SCALE), customerId: String(args.customerId) },
    ]);
  };
  const settle = (rid: string | undefined, amount: number) => {
    if (!rid) return;
    const r = receivables.get(rid);
    if (!r) return;
    r.outstandingAmount = Math.max(0, r.outstandingAmount - amount);
    r.status = r.outstandingAmount === 0 ? "PAID" : "PARTIALLY_PAID";
  };

  /**
   * The seated MANAGER does not hold manage:finance in this product, so a case
   * that routes a finance mutation through the approver is refused. Modelled
   * because the fake's permissive version let RV1 reach the cloud before
   * anything told me.
   */
  const call = (authed: boolean, canManageFinance = true) => async (
    kind: string,
    fnPath: string,
    args: Record<string, any>
  ) => {
    switch (fnPath) {
      case "orgSettings:get":
        // The product resolves the denomination from orgSettings, defaulting to
        // JOD when no row exists; the fake exposes the explicit form.
        return { ok: true as const, value: defects.noOrgSettingsRow ? null : { orgId: "org_1", currency: ORG_CURRENCY } };
      case "chartOfAccounts:initialize":
        return { ok: true as const, value: null };
      case "chartOfAccounts:list":
        return {
          ok: true as const,
          value: defects.noUnappliedLiability ? CHART.filter((a) => a.code !== "2110") : CHART,
        };
      case "accountingPeriods:create":
        return { ok: true as const, value: id("period") };
      case "accountingPeriods:list":
        return { ok: true as const, value: [{ _id: "p1", status: periodStatus }] };
      case "accountingPeriods:close":
        if (defects.refuseClose) {
          return { ok: false as const, error: "The close checklist is not clean." };
        }
        periodStatus = "CLOSED";
        return { ok: true as const, value: null };
      case "collections:createReceivable": {
        // The product refuses to INFER a credit account from an ambiguous
        // source type. The fake accepted anything, so the cloud run was the
        // first thing to tell me — twice, in one run. A fake more permissive
        // than the product turns every one of its preconditions into a
        // cloud-only discovery.
        const ambiguous = args.sourceType === "OTHER" || args.sourceType === "CHEQUE";
        if (ambiguous && !args.creditSystemKey) {
          return {
            ok: false as const,
            error: "This receivable's credit account isn't obvious from its source type — specify creditSystemKey.",
          };
        }
        const again = replayedFootprint(args);
        const made = replayableCreate("recv", args)!;
        if (made.ok && (!receivables.has(String(made.value)) || again)) {
          receivableRow(again ? id("recv-dup") : String(made.value), args, Number(args.amount));
        }
        return made;
      }
      case "collections:createInstallmentPlan": {
        const key = args.idempotencyKey;
        if (key && createdByKey.has(key) && !defects.duplicateOnCreateReplay && !defects.refuseCreateReplay) {
          if (defects.doubleFootprintOnReplay) receivableRow(id("inst-dup"), args, Number(args.totalAmount) / Number(args.installmentCount));
          return { ok: true as const, value: JSON.parse(createdByKey.get(key)!) };
        }
        if (key && createdByKey.has(key) && defects.refuseCreateReplay) return { ok: false as const, error: "Duplicate request." };
        const n = Number(args.installmentCount);
        const each = Number(args.totalAmount) / n;
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const rid = id("inst");
          receivableRow(rid, args, each);
          ids.push(rid);
        }
        if (key) createdByKey.set(key, JSON.stringify(ids));
        return { ok: true as const, value: ids };
      }
      case "collections:listReceivables":
        return { ok: true as const, value: { page: [...receivables.values()], isDone: true, continueCursor: null } };
      case "collections:recordPayment": {
        const made = replayableCreate("pay", args, true);
        if (made) return made;
        // An allocation may not exceed what is owed. The product enforces this
        // and the fake did not, so my "over-payment becomes a credit" model
        // survived locally and died on the cloud.
        if (args.receivableId && Number(args.amount) > 1000) {
          return {
            ok: false as const,
            error: "Payment amount cannot exceed the outstanding receivable amount.",
          };
        }
        const paymentId = id("pay");
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, paymentId);
        const amountMinor = Math.round(Number(args.amount) * MINOR_SCALE);
        // Money with no receivable named is money the dealership holds without
        // a claim against it: a LIABILITY, never income (ACC-9).
        const unappliedMinor = args.receivableId
          ? 0
          : Math.round(amountMinor * (defects.shortRetention ? 0.6 : 1));
        settle(args.receivableId, Number(args.amount));
        if (unappliedMinor > 0 && !defects.swallowOverpayment) {
          const movementId = id("mov");
          retained.set(movementId, {
            receiptMovementId: movementId,
            customerId: String(args.customerId),
            remainingUnappliedMinor: unappliedMinor,
            receiptPosted: true,
            applications: 0,
          });
        }
        collectionPayments.push({ _id: paymentId, direction: "IN", method: args.method, amount: Number(args.amount), receivableId: args.receivableId });
        postReceipt(paymentId, String(args.customerId), amountMinor, args.receivableId ? amountMinor : 0, "CASH_ON_HAND");
        return { ok: true as const, value: paymentId };
      }
      case "collections:listRetainedCredits": {
        const all = [...retained.values()].filter(
          (r) => !args.customerId || r.customerId === String(args.customerId)
        );
        const visible = args.onlyRemaining ? all.filter((r) => r.remainingUnappliedMinor > 0) : all;
        return { ok: true as const, value: { page: visible, isDone: true, continueCursor: null } };
      }
      case "collections:applyRetainedCredit": {
        const made = replayableCreate("apply", args, true);
        if (made) return made;
        const position = retained.get(String(args.receiptMovementId));
        if (!position) return { ok: false as const, error: "Retained position not found." };
        const applicationId = id("rcapp");
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, applicationId);
        const amountMinor = Math.round(Number(args.requestedAmount) * MINOR_SCALE);
        if (!defects.ignoreRetainedApplication) position.remainingUnappliedMinor -= amountMinor;
        position.applications += 1;
        settle(args.receivableId, Number(args.requestedAmount));
        if (!defects.applicationPostsNothing) {
          post(
            "RECEIPT_CREDIT_APPLIED",
            "receiptApplications",
            `rcapp:${position.receiptMovementId.length}:${position.receiptMovementId}:${position.applications}`,
            [
              { key: "UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY", debitMinor: amountMinor, customerId: position.customerId },
              { key: "ACCOUNTS_RECEIVABLE_CUSTOMERS", creditMinor: amountMinor, customerId: position.customerId },
            ],
            { payload: { applicationId } }
          );
        }
        return {
          ok: true as const,
          value: { applicationId, sequence: position.applications, appliedMinor: amountMinor, remainingUnappliedMinor: position.remainingUnappliedMinor },
        };
      }
      case "collections:registerCheque": {
        const chequeId = id("chq");
        cheques.set(chequeId, { _id: chequeId, status: "REGISTERED", receivableId: args.receivableId, customerId: String(args.customerId), amount: Number(args.amount) });
        return { ok: true as const, value: chequeId };
      }
      case "collections:depositCheque": {
        const cheque = cheques.get(String(args.chequeId));
        if (cheque) cheque.status = "DEPOSITED";
        return { ok: true as const, value: null };
      }
      case "collections:clearCheque": {
        if (!canManageFinance) {
          return { ok: false as const, error: "Forbidden: Missing required permissions: manage:finance" };
        }
        const made = replayableCreate("clr", args, true);
        if (made) return made;
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, id("clr"));
        const cheque = cheques.get(String(args.chequeId));
        if (!cheque) return { ok: false as const, error: "Cheque not found" };
        cheque.status = "CLEARED";
        const paymentId = id("pay");
        collectionPayments.push({ _id: paymentId, direction: "IN", method: "CHEQUE", amount: cheque.amount, chequeId: cheque._id, receivableId: cheque.receivableId });
        settle(cheque.receivableId, cheque.amount);
        const { eventId } = postReceipt(paymentId, cheque.customerId, Math.round(cheque.amount * MINOR_SCALE), Math.round(cheque.amount * MINOR_SCALE), "BANK_ACCOUNT");
        cheque.clearingEventId = eventId;
        return { ok: true as const, value: null };
      }
      case "collections:returnClearedCheque": {
        if (!canManageFinance) {
          return { ok: false as const, error: "Forbidden: Missing required permissions: manage:finance" };
        }
        const made = replayableCreate("ret", args, true);
        if (made) return made;
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, id("ret"));
        const cheque = cheques.get(String(args.chequeId));
        if (!cheque) return { ok: false as const, error: "Cheque not found" };
        if (defects.eraseOnChequeReturn) {
          // Balances perfectly, and destroys the record that it ever happened.
          const original = events.find((e) => e._id === cheque.clearingEventId)!;
          journalEntries.splice(journalEntries.findIndex((j) => j._id === original.journalEntryId), 1);
          events.splice(events.indexOf(original), 1);
          cheques.delete(String(args.chequeId));
          return { ok: true as const, value: null };
        }
        cheque.status = "RETURNED";
        if (!defects.silentChequeReturn) reverse(cheque.clearingEventId);
        if (!defects.receivableNotReopened) {
          const r = receivables.get(cheque.receivableId);
          if (r) {
            r.outstandingAmount += cheque.amount;
            r.status = r.outstandingAmount >= r.originalAmount ? "OPEN" : "PARTIALLY_PAID";
          }
        }
        return { ok: true as const, value: null };
      }
      case "collections:listCheques":
        return { ok: true as const, value: { page: [...cheques.values()], isDone: true, continueCursor: null } };
      case "users:getMe":
        return { ok: true as const, value: { _id: "user_owner" } };
      case "sales:create": {
        const made = replayableCreate("sale", args, true);
        if (made) return made;
        const saleId = id("sale");
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, saleId);
        const vehicle = vehicles.get(String(args.vehicleId));
        const priceMinor = Math.round(Number(args.salePrice) * MINOR_SCALE);
        const costMinor = Math.round((vehicle?.purchasePrice ?? 0) * MINOR_SCALE);
        if (defects.silentConsignedSale) {
          events.push({ _id: id("evt"), eventType: "SALE_COMPLETED", sourceType: "sales", sourceId: saleId, status: "POSTED", payload: { saleAmountMinor: priceMinor } });
          return { ok: true as const, value: saleId };
        }
        const consigned = vehicle?.sourceType === "SOURCED" && !defects.postConsignedAsOwned;
        post(
          "SALE_COMPLETED",
          "sales",
          saleId,
          consigned
            ? [
                // Agent basis: gross arrives, the supplier's share is a
                // liability from the instant it lands, the spread is commission.
                { key: "CASH_ON_HAND", debitMinor: priceMinor },
                { key: "ACCOUNTS_PAYABLE_SUPPLIERS", creditMinor: costMinor },
                { key: "CONSIGNMENT_COMMISSION_REVENUE", creditMinor: priceMinor - costMinor },
              ]
            : [
                // Owned basis — WRONG for a consigned car, and it balances.
                { key: "CASH_ON_HAND", debitMinor: priceMinor },
                { key: "SALES_REVENUE", creditMinor: priceMinor },
                { key: "COST_OF_VEHICLES_SOLD", debitMinor: costMinor },
                { key: "VEHICLE_INVENTORY", creditMinor: costMinor },
              ],
          { payload: { saleAmountMinor: priceMinor } }
        );
        return { ok: true as const, value: saleId };
      }
      case "organizations:create":
        // A genuinely different organization the caller owns — what the TEN case
        // needs in order to test OWNERSHIP rather than id syntax.
        return { ok: true as const, value: id("org") };
      case "customers:create":
        return { ok: true as const, value: id("cust") };
      case "vehicles:create":
        // Non-probe mode never returns null; the assertion keeps that visible
        // to the type checker instead of widening every caller's result.
        // The product refuses a SOURCED vehicle without `sourceCost` — and
        // ignores `purchasePrice` for it. Modelled so the wrong field fails here.
        if (args.sourceType === "SOURCED" && (args.sourceCost === undefined || args.sourceCost === null)) {
          return { ok: false as const, error: "Sourced vehicles require a supplier cost (sourceCost)." };
        }
        const madeVehicle = replayableCreate("veh", args)!;
        if (madeVehicle.ok) {
          vehicles.set(String(madeVehicle.value), {
            sourceType: args.sourceType,
            purchasePrice: Number(args.sourceType === "SOURCED" ? args.sourceCost : (args.purchasePrice ?? 0)),
          });
        }
        return madeVehicle;
      case "quotes:saveQuote": {
        const quoteId = id("quote");
        quoteVehicle.set(quoteId, String(args.vehicleId ?? ""));
        quoteCustomer.set(quoteId, String(args.customerId ?? ""));
        return { ok: true as const, value: quoteId };
      }
      case "deposits:create": {
        const replayed = replayableCreate("dep", args, true);
        if (replayed) return replayed;
        const depositId = id("dep");
        // Taking a deposit POSTS. Modelling that is not decoration: P1's first
        // cloud run failed because it measured its journal window from before
        // the fixture, so these ordinary open-period entries were counted as
        // postings made while the books were shut. The fake did not post on
        // create, so nothing here could reproduce it. It does now.
        const amountMinor = Math.round(Number(args.amount) * MINOR_SCALE);
        if (periodStatus === "OPEN") {
          post("DEPOSIT_RECEIVED", "deposits", depositId, [
            { key: "CASH_ON_HAND", debitMinor: amountMinor, customerId: String(args.customerId ?? "") },
            { key: "CUSTOMER_DEPOSITS_LIABILITY", creditMinor: amountMinor, customerId: String(args.customerId ?? "") },
          ]);
        }
        deposits.set(depositId, {
          _id: depositId,
          releasedAmountMinor: 0,
          refundedAmountMinor: 0,
          releaseCount: 0,
          freeMinor: 2_000_000,
          committedMinor: 1_000_000,
          vehicleId: quoteVehicle.get(String(args.quoteId)) ?? String(args.vehicleId ?? ""),
          customerId: String(args.customerId ?? quoteCustomer.get(String(args.quoteId)) ?? ""),
          status: "HELD",
        });
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, depositId);
        return { ok: true as const, value: depositId };
      }
      case "vehicles:createReservation": {
        const again = replayedFootprint(args);
        const made = replayableCreate("resv", args, true);
        if (made && !again) return made;
        const reservationId = again ? createdByKey.get(args.idempotencyKey)! : id("resv");
        if (args.idempotencyKey && !again) createdByKey.set(args.idempotencyKey, reservationId);
        const depositId = id("dep");
        const amountMinor = Math.round(Number(args.depositAmount ?? 0) * MINOR_SCALE);
        deposits.set(depositId, {
          _id: depositId, releasedAmountMinor: 0, refundedAmountMinor: 0, releaseCount: 0,
          freeMinor: amountMinor, committedMinor: 0, vehicleId: String(args.vehicleId), customerId: String(args.customerId), status: "HELD",
          amountMinor,
        } as Deposit);
        post("DEPOSIT_RECEIVED", "deposits", depositId, [
          { key: "CASH_ON_HAND", debitMinor: amountMinor, customerId: String(args.customerId) },
          { key: "CUSTOMER_DEPOSITS_LIABILITY", creditMinor: amountMinor, customerId: String(args.customerId) },
        ]);
        return { ok: true as const, value: reservationId };
      }
      case "fixedAssets:capitalize": {
        const again = replayedFootprint(args);
        const made = replayableCreate("asset", args, true);
        if (made && !again) return made;
        const assetId = again ? createdByKey.get(args.idempotencyKey)! : id("asset");
        if (!again && args.idempotencyKey) createdByKey.set(args.idempotencyKey, assetId);
        fixedAssets.push({ _id: again ? id("asset-dup") : assetId, name: args.name });
        post("ASSET_CAPITALIZED", "fixedAssets", assetId, [
          { key: "FIXED_ASSETS", debitMinor: Number(args.costMinor) },
          { key: "CASH_ON_HAND", creditMinor: Number(args.costMinor) },
        ]);
        return { ok: true as const, value: assetId };
      }
      case "fixedAssets:list":
        return { ok: true as const, value: { page: [...fixedAssets], isDone: true, continueCursor: null } };
      case "partnerEquity:add": {
        const again = replayedFootprint(args);
        const made = replayableCreate("partner", args, true);
        if (made && !again) return made;
        const partnerId = again ? createdByKey.get(args.idempotencyKey)! : id("partner");
        if (!again && args.idempotencyKey) createdByKey.set(args.idempotencyKey, partnerId);
        partners.push({ _id: again ? id("partner-dup") : partnerId, partnerName: args.partnerName });
        if (args.openingContributionMinor) {
          const txId = id("eqtx");
          equityTxs.push({ _id: txId, partnerId, type: "CONTRIBUTION", amountMinor: Number(args.openingContributionMinor) });
          post("CAPITAL_CONTRIBUTED", "partnerEquityTransactions", txId, [
            { key: "CASH_ON_HAND", debitMinor: Number(args.openingContributionMinor) },
            { key: "PARTNER_CAPITAL", creditMinor: Number(args.openingContributionMinor) },
          ]);
        }
        return { ok: true as const, value: partnerId };
      }
      case "partnerEquity:list":
        return { ok: true as const, value: { page: [...partners], isDone: true, continueCursor: null } };
      case "partnerEquity:listTransactions":
        return { ok: true as const, value: equityTxs.filter((t) => t.partnerId === String(args.partnerId)) };
      case "partnerEquity:recordEquityMovement": {
        const again = replayedFootprint(args);
        const made = replayableCreate("eqtx", args, true);
        if (made && !again) return made;
        const txId = again ? createdByKey.get(args.idempotencyKey)! : id("eqtx");
        if (!again && args.idempotencyKey) createdByKey.set(args.idempotencyKey, txId);
        equityTxs.push({ _id: again ? id("eqtx-dup") : txId, partnerId: String(args.partnerId), type: args.type, amountMinor: Number(args.amountMinor) });
        post(args.type === "DRAW" ? "PARTNER_DREW" : "CAPITAL_CONTRIBUTED", "partnerEquityTransactions", txId, [
          { key: args.type === "DRAW" ? "PARTNER_DRAWINGS" : "CASH_ON_HAND", debitMinor: Number(args.amountMinor) },
          { key: args.type === "DRAW" ? "CASH_ON_HAND" : "PARTNER_CAPITAL", creditMinor: Number(args.amountMinor) },
        ]);
        return { ok: true as const, value: txId };
      }
      case "workOrders:create": {
        const again = replayedFootprint(args);
        const made = replayableCreate("wo", args, true);
        if (made && !again) return made;
        const workOrderId = again ? createdByKey.get(args.idempotencyKey)! : id("wo");
        if (!again && args.idempotencyKey) createdByKey.set(args.idempotencyKey, workOrderId);
        const totalCost = (args.tasks ?? []).reduce((s: number, t: any) => s + t.partsCost + t.laborCost, 0);
        let expenseId: string | undefined;
        if (args.status === "COMPLETED" && totalCost > 0) expenseId = postExpense(totalCost);
        workOrders.push({ _id: again ? id("wo-dup") : workOrderId, vehicleId: String(args.vehicleId), title: args.title, status: args.status, expenseId });
        return { ok: true as const, value: workOrderId };
      }
      case "workOrders:update": {
        const wo = workOrders.find((w) => w._id === String(args.workOrderId));
        if (!wo) return { ok: false as const, error: "Work Order not found" };
        if (wo.expenseId && !defects.workOrderLockOpen) {
          return { ok: false as const, error: "Completed work orders with posted expenses are locked. Use a correction or reversal workflow before editing." };
        }
        const totalCost = (args.tasks ?? []).reduce((s: number, t: any) => s + t.partsCost + t.laborCost, 0);
        if (args.status === "COMPLETED" && !wo.expenseId && totalCost > 0) wo.expenseId = postExpense(totalCost);
        else if (args.status === "COMPLETED" && wo.expenseId && defects.workOrderLockOpen) postExpense(totalCost, wo.expenseId);
        wo.title = args.title;
        wo.status = args.status;
        return { ok: true as const, value: null };
      }
      case "workOrders:list":
        return { ok: true as const, value: workOrders.filter((w) => !args.vehicleId || w.vehicleId === String(args.vehicleId)) };
      case "chartOfAccounts:validateSystemAccounts":
        return {
          ok: true as const,
          value: defects.missingSystemAccount
            ? { valid: false, missing: ["UNAPPLIED_CUSTOMER_RECEIPTS"] }
            : { valid: true, missing: [] },
        };
      case "accountingLedger:listAccountingEvents":
        return {
          ok: true as const,
          value: args.sourceType
            ? events.filter((e) => e.sourceType === args.sourceType && String(e.sourceId) === String(args.sourceId))
            : [...events],
        };
      case "accountingLedger:listJournalEntries":
        // A COPY. Returning the live array handed P1 the same object twice, so
        // its before/after lengths were necessarily equal and the partial-post
        // defect walked straight past it. A real query returns a fresh result;
        // a fake that shares state silently disables the assertions built on it.
        return { ok: true as const, value: journalEntries.map((j) => ({ ...j })) };
      case "accountingLedger:getJournalEntry": {
        const entry = journalEntries.find((j) => j._id === String(args.journalEntryId));
        return {
          ok: true as const,
          value: entry ? { entry: { ...entry }, lines: journalLines.get(entry._id) ?? [] } : null,
        };
      }
      case "accountingLedger:getAccountActivity": {
        const account = CHART.find((a) => a._id === String(args.accountId));
        if (!account) return { ok: true as const, value: null };
        const lines = [...journalLines.values()].flat().filter((l) => l.accountId === account._id);
        return { ok: true as const, value: { account, lines } };
      }
      case "accountingOutbox:listPending":
        return {
          ok: true as const,
          value:
            args.status === "FAILED"
              ? defects.stuckFailedOutbox
                ? [{ _id: "pev_stuck", status: "FAILED", eventType: "DEPOSIT_REFUNDED" }]
                : []
              : [...pendingEvents],
        };
      case "collections:listPayments":
        return {
          ok: true as const,
          value: { page: [...collectionPayments], isDone: true, continueCursor: null },
        };
      case "subledger:getPaymentBalance": {
        const payment = canonicalPayments.get(args.paymentId);
        return { ok: true as const, value: payment ? { payment, unappliedMinor: 0 } : null };
      }
      case "deposits:allocateToVehicles": {
        // Re-allocating a car to 0 frees its share — the supported operation the
        // second genuine payout depends on.
        const zeroed = (args.allocations ?? []).some((a: any) => a.amount === 0);
        if (zeroed) {
          for (const deposit of deposits.values()) {
            if (deposit.committedMinor > 0) {
              deposit.freeMinor += 1_000_000;
              deposit.committedMinor -= 1_000_000;
            }
          }
        }
        return { ok: true as const, value: null };
      }
      case "deposits:release":
        return release(args, authed);
      case "deposits:listByVehicle":
        // Actually FILTERS. Returning every deposit made RT1's "one row for this
        // vehicle" assertion unsatisfiable against a healthy backend, which
        // would have taught the reader that a red RT1 is normal.
        return {
          ok: true as const,
          value: [...deposits.values()].filter((d) => d.vehicleId === String(args.vehicleId)),
        };
      default:
        return { ok: false as const, error: `unmodelled function ${fnPath}` };
    }
  };

  /** A work-order expense: one expense row, one EXPENSE_POSTED. */
  function postExpense(totalCost: number, existing?: string) {
    const expenseId = existing ?? id("exp");
    post("EXPENSE_POSTED", "expenses", expenseId, [
      { key: "GENERAL_EXPENSE", debitMinor: Math.round(totalCost * MINOR_SCALE) },
      { key: "CASH_ON_HAND", creditMinor: Math.round(totalCost * MINOR_SCALE) },
    ]);
    return expenseId;
  }
  const authedCall = call(true);
  // The seated MANAGER: authenticated, and WITHOUT manage:finance.
  const approverCall = call(true, false);
  const must = async (kind: string, fnPath: string, args: Record<string, any>) => {
    const r = await authedCall(kind, fnPath, args);
    if (!r.ok) throw new Error(`${fnPath} failed: ${r.error}`);
    return r.value;
  };

  const approverMust = async (kind: string, fnPath: string, args: Record<string, any>) => {
    const r = await approverCall(kind, fnPath, args);
    if (!r.ok) throw new Error(`${fnPath} failed: ${r.error}`);
    return r.value;
  };
  return { authedCall, approverCall, anonymousCall: call(false), must, approverMust, deposits };
}

/** Mirrors the real recorder: a failure is captured as evidence, never thrown. */
const recordCase = (
  results: Array<Record<string, unknown>>,
  id: string,
  description: string,
  assertion: () => unknown
) =>
  Promise.resolve()
    .then(assertion)
    .then((detail) => {
      results.push({ id, description, status: "PASS", detail: detail ?? null });
    })
    .catch((error) => {
      results.push({
        id,
        description,
        // Mirrors the real recorder: "could not be tested" is a THIRD outcome,
        // and collapsing it into FAIL is what tempts someone to weaken the
        // assertion until the red goes away.
        status: (error as any)?.__unproven ? "UNPROVEN" : "FAIL",
        detail: String((error as Error)?.message ?? error),
      });
    });

async function runAgainst(defects: Defects = {}) {
  const backend = makeBackend(defects);
  const results: Array<Record<string, unknown>> = [];
  await runRehearsalCases({
    results,
    orgId: "org_1",
    config: { convexUrl: "https://x.convex.cloud" },
    tokens: { sales: "t-sales", approver: "t-approver" },
    asSales: backend.authedCall,
    asApprover: backend.approverCall,
    anonymousCall: backend.anonymousCall,
    salesMust: backend.must,
    approverMust: backend.approverMust,
    recordCase,
    unproven: (reason: string) => {
      const error = new Error(reason);
      error.name = "Unproven";
      (error as any).__unproven = true;
      throw error;
    },
    // The harness cannot interleave; it issues each attempt in turn. That is
    // enough to exercise the ASSERTIONS, and is precisely why the cloud run is
    // not optional.
    // The harness cannot interleave, so it FAKES the shape of two overlapping
    // workers: both "sent" at one instant, each "received" a little later. That
    // is enough to exercise the execution assertions, and it is why the two
    // defects below exist — a crashed worker and a sequential pair are the two
    // ways a concurrency case can pass while measuring nothing (Codex RG-01).
    fireConcurrentReleases: async ({ attempts }: any) => {
      const out = [];
      const sentAt = 1_700_000_000_000;
      let index = 0;
      for (const attempt of attempts) {
        const mine = index++;
        if (defects.loserGetsGatewayError && mine === 1) {
          // What rehearsalReleaseWorker.mjs emits for a non-JSON 503: exit 0,
          // status "error", a message — everything the first gate asked for.
          out.push({
            label: attempt.label,
            exitCode: 0,
            result: { sentAt, receivedAt: sentAt + 450, httpStatus: 503, status: "error", error: "non-JSON response" },
          });
          continue;
        }
        if (defects.loserGetsAuthError && mine === 1) {
          out.push({
            label: attempt.label,
            exitCode: 0,
            result: {
              sentAt,
              receivedAt: sentAt + 450,
              httpStatus: 200,
              status: "error",
              error: "Unauthenticated: You must be logged in.",
            },
          });
          continue;
        }
        if (defects.oneWorkerCrashes && mine === 1) {
          // Never reached the backend: no request, no product result.
          out.push({
            label: attempt.label,
            exitCode: 1,
            result: { status: "worker_error", error: "REHEARSAL_TOKEN is required" },
          });
          continue;
        }
        const r = await backend.approverCall("mutation", "deposits:release", attempt.args);
        const start = defects.sequentialWorkers ? sentAt + mine * 1000 : sentAt;
        out.push({
          label: attempt.label,
          exitCode: 0,
          result: {
            sentAt: start,
            receivedAt: start + 400 + mine * 50,
            httpStatus: 200,
            status: r.ok ? "success" : "error",
            error: r.ok ? null : r.error,
          },
        });
      }
      return out;
    },
  } as never);
  return results;
}

const statusOf = (results: Array<Record<string, unknown>>, id: string) =>
  results.find((r) => r.id === id)?.status;

describe("the rehearsal passes against a backend that behaves", () => {
  test("every case is green when nothing is broken", async () => {
    const results = await runAgainst();
    const failures = results.filter((r) => r.status === "FAIL");
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    // UNPROVEN is not FAIL, so a case that quietly declined to run would slip
    // past the line above — which is precisely how a partial rehearsal gets
    // quoted as a complete one. Against a healthy backend nothing may decline.
    const declined = results.filter((r) => r.status === "UNPROVEN");
    expect(declined.map((d) => `${d.id}: ${d.detail}`)).toEqual([]);
    // And it actually ran the cases rather than finding nothing to do.
    expect(results.length).toBeGreaterThanOrEqual(18);
    for (const id of ["A3", "B1", "B2", "P1", "RT1", "RT2", "RC1", "RV1", "SR1", "C1", "C2"]) {
      expect(statusOf(results, id), `${id} must actually execute`).toBe("PASS");
    }
  });
});

describe("the rehearsal FAILS when the backend misbehaves — one defect per case", () => {
  test("C2 catches two distinct keys paying one free balance twice", async () => {
    // The defect the cloud run exists for: identity alone cannot stop this,
    // because two different keys are two different commands.
    const results = await runAgainst({ doublePayOnDistinctKeys: true });
    expect(statusOf(results, "C2")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "C2")?.detail)).toMatch(/released amount/i);
  });

  test("D2 catches a genuinely new payout being suppressed", async () => {
    // The original incident: money not moved, success reported.
    const results = await runAgainst({ suppressNextGeneration: true });
    expect(statusOf(results, "D2")).toBe("FAIL");
  });

  test("D4 catches an unidentified economic command being accepted", async () => {
    const results = await runAgainst({ acceptUnidentified: true });
    expect(statusOf(results, "D4")).toBe("FAIL");
  });

  test("UNAUTH catches money moving with no authentication at all", async () => {
    const results = await runAgainst({ acceptUnauthenticated: true });
    expect(statusOf(results, "UNAUTH")).toBe("FAIL");
  });

  test("TEN catches a release reaching across a tenant boundary", async () => {
    // TEN-1: naming an org is not the same as owning the row. Two cross-tenant
    // Criticals have already shipped from that conflation.
    const results = await runAgainst({ acceptForeignOrg: true });
    expect(statusOf(results, "TEN")).toBe("FAIL");
  });

  test("A1 catches a chart shipped without the 2110 liability", async () => {
    const results = await runAgainst({ noUnappliedLiability: true });
    expect(statusOf(results, "A1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "A1")?.detail)).toMatch(/2110 is absent/);
  });

  test("A3 catches a chart missing an account the product's own validator requires", async () => {
    const results = await runAgainst({ missingSystemAccount: true });
    expect(statusOf(results, "A3")).toBe("FAIL");
  });

  test("B1 catches a replay that posts a SECOND event while the deposit row stays still", async () => {
    // The row is correct, releaseCount is correct, every D-case passes — and the
    // books have been credited twice. Only a case that counts the events sees it.
    const results = await runAgainst({ doublePostOnReplay: true });
    expect(statusOf(results, "B1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "B1")?.detail)).toMatch(/DEPOSIT_REFUNDED events/);
    // And the row-only cases are blind to it, which is the reason B1 exists.
    expect(statusOf(results, "D1")).toBe("PASS");
  });

  test("B1 catches money leaving without ever reaching a canonical payment", async () => {
    const results = await runAgainst({ noCanonicalPayment: true });
    expect(statusOf(results, "B1")).toBe("FAIL");
  });

  test("B2 catches a journal entry whose debits and credits disagree", async () => {
    const results = await runAgainst({ unbalancedJournal: true });
    expect(statusOf(results, "B2")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "B2")?.detail)).toMatch(/do not balance/);
  });

  test("B2 catches a posting stuck FAILED on its way to the ledger", async () => {
    const results = await runAgainst({ stuckFailedOutbox: true });
    expect(statusOf(results, "B2")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "B2")?.detail)).toMatch(/FAILED in the outbox/);
  });

  test("P1 catches a GL written while no accounting period is open", async () => {
    // The partial post: the books move while they are shut, so the period's
    // reported balances and its journals stop agreeing with each other.
    const results = await runAgainst({ partialGlWhileClosed: true });
    expect(statusOf(results, "P1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "P1")?.detail)).toMatch(/journal entries written/);
  });

  test("P1 catches money leaving with no queued path to the books", async () => {
    const results = await runAgainst({ loseThePostingWhileClosed: true });
    expect(statusOf(results, "P1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "P1")?.detail)).toMatch(/no path to the books/);
  });

  test("P1 reports UNPROVEN rather than PASS when it cannot close the period", async () => {
    // The distinction the third status exists for: the product refusing to
    // close a period is not evidence that closed periods behave correctly.
    const results = await runAgainst({ refuseClose: true });
    expect(statusOf(results, "P1")).toBe("UNPROVEN");
  });

  test("RT1 catches a replayed create that makes a SECOND row", async () => {
    const results = await runAgainst({ duplicateOnCreateReplay: true });
    expect(statusOf(results, "RT1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "RT1")?.detail)).toMatch(/DIFFERENT id/);
  });

  test("RT1 catches a replayed create that is REFUSED", async () => {
    // A refused retry looks safe and is not: the first command stands while the
    // operator is told it failed, and the natural next action is to try again
    // with fresh content — which is how one intent becomes two commands.
    const results = await runAgainst({ refuseCreateReplay: true });
    expect(statusOf(results, "RT1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "RT1")?.detail)).toMatch(/refused/);
  });

  test("RC1 catches an over-payment whose excess simply disappears", async () => {
    // The customer's 500 is the dealership's liability, not its income. A
    // backend that keeps the change balances perfectly and is stealing.
    const results = await runAgainst({ swallowOverpayment: true });
    expect(statusOf(results, "RC1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "RC1")?.detail)).toMatch(/unaccounted for/);
  });

  test("RC1 catches a retained credit that is applied but never reduced", async () => {
    // Worse than a refusal: the invoice is settled from a liability that still
    // reads as owed, so the same 400 can be spent again.
    const results = await runAgainst({ ignoreRetainedApplication: true });
    expect(statusOf(results, "RC1")).toBe("FAIL");
  });

  test("RC1 still catches a real shortfall now that the scale is derived", async () => {
    // Deriving the scale from the returned amount must not turn ANY amount into
    // a valid one. 300 where 500 was received is a shortfall at every scale.
    const results = await runAgainst({ shortRetention: true });
    expect(statusOf(results, "RC1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "RC1")?.detail)).toMatch(/expected 500000, got 300000/);
  });

  test("RV1 catches a cheque return that ERASES its clearing", async () => {
    // Balances perfectly and destroys the history. ACC-3: a reversal ADDS.
    const results = await runAgainst({ eraseOnChequeReturn: true });
    expect(statusOf(results, "RV1")).toBe("FAIL");
  });

  test("RV1 catches a cheque that bounces with no accounting effect at all", async () => {
    const results = await runAgainst({ silentChequeReturn: true });
    expect(statusOf(results, "RV1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "RV1")?.detail)).toMatch(/expected REVERSED, got POSTED/);
  });

  test("SR1 catches a consigned car posted as dealership stock", async () => {
    // ACC-1. Same bottom line, revenue overstated by the price of the car,
    // and every entry balances — which is why nothing else notices.
    const results = await runAgainst({ postConsignedAsOwned: true });
    expect(statusOf(results, "SR1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "SR1")?.detail)).toMatch(/no commission revenue|was touched/);
  });

  test("SR1 catches a consigned sale that posts nothing", async () => {
    const results = await runAgainst({ silentConsignedSale: true });
    expect(statusOf(results, "SR1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "SR1")?.detail)).toMatch(/NO journal entry/);
  });

  test("C1/C2 do not PASS when one worker never reached the backend (RG-01)", async () => {
    // The single healthy worker produces EXACTLY the expected final state —
    // 2,000,000 released, count 1 — which is why the old cases could not tell.
    const results = await runAgainst({ oneWorkerCrashes: true });
    expect(statusOf(results, "C1")).toBe("UNPROVEN");
    expect(statusOf(results, "C2")).toBe("UNPROVEN");
    expect(String(results.find((r) => r.id === "C1")?.detail)).toMatch(/concurrency was NOT measured/);
  });

  test("C1/C2 do not PASS when the loser's error never came from the product (RG-01-R1)", async () => {
    // The first gate accepted ANY error carrying a message. A 503 whose body
    // was not JSON, and an auth-layer refusal, both arrive as exit 0 / status
    // "error" / a message — and the one healthy worker leaves the deposit at
    // exactly the expected state.
    for (const defect of ["loserGetsGatewayError", "loserGetsAuthError"] as const) {
      const results = await runAgainst({ [defect]: true });
      expect(statusOf(results, "C1")).toBe("UNPROVEN");
      expect(statusOf(results, "C2")).toBe("UNPROVEN");
      expect(String(results.find((r) => r.id === "C2")?.detail)).toMatch(/HTTP 503|not recognised as a product refusal/);
    }
  });

  test("C1 FAILS — not UNPROVEN — when the product refuses a same-key replay", async () => {
    // Polarity: a recognised product refusal on the SAME key is the command
    // log failing to honour its own identity. Reporting it as a harness gap
    // would hide a financial defect behind an infrastructure label.
    const results = await runAgainst({ sameKeyReplayRefused: true });
    expect(statusOf(results, "C1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "C1")?.detail)).toMatch(/refused by the product instead of replayed/);
    expect(statusOf(results, "C2")).toBe("PASS");
  });

  test("C1/C2 do not PASS when the two workers ran one after the other (RG-01)", async () => {
    const results = await runAgainst({ sequentialWorkers: true });
    expect(statusOf(results, "C1")).toBe("UNPROVEN");
    expect(statusOf(results, "C2")).toBe("UNPROVEN");
    expect(String(results.find((r) => r.id === "C2")?.detail)).toMatch(/did NOT overlap/);
  });

  test("a defect in one case does not silently take the others down with it", async () => {
    // Each case builds its own fixture, so an unrelated red must stay local —
    // otherwise one failure would mask the true state of everything after it.
    const results = await runAgainst({ noUnappliedLiability: true });
    expect(statusOf(results, "D1")).toBe("PASS");
    expect(statusOf(results, "C1")).toBe("PASS");
  });
});

describe("assertBothAttemptsExecuted — every branch watched failing (Sonnet MAX JOB2-F-01)", () => {
  // Each shape below is one way a concurrency case could certify a race it
  // never saw. A guard nobody has watched refuse is not a guard.
  const ok = (label: string, over: Record<string, unknown> = {}) => ({
    label,
    exitCode: 0,
    result: { sentAt: 100, receivedAt: 500, httpStatus: 200, status: "success", error: null, ...over },
  });
  const refusals = [/nothing left of this deposit/i];
  const run = (attempts: unknown[]) => () =>
    assertBothAttemptsExecuted(attempts as never, ["a", "b"], { productRefusals: refusals });

  test("the healthy pair is certified, with both outcomes named", () => {
    expect(run([ok("a"), ok("b")])().outcomes).toEqual({ a: "success", b: "success" });
    expect(
      run([ok("a"), ok("b", { status: "error", error: "There is nothing left of this deposit to refund." })])().outcomes
    ).toEqual({ a: "success", b: "refused" });
  });
  test("a missing label", () => expect(run([ok("a")])).toThrow(/b: no outcome recorded/));
  test("exit 0 with no body", () => expect(run([ok("a"), { label: "b", exitCode: 0, result: null }])).toThrow(/no result/));
  test("exit 0 with a non-object body", () =>
    expect(run([ok("a"), { label: "b", exitCode: 0, result: "garbage" }])).toThrow(/unparseable result/));
  test("an unknown worker status", () => expect(run([ok("a"), ok("b", { status: "timeout" })])).toThrow(/worker status timeout/));
  test("a non-200 transport answer", () =>
    expect(run([ok("a"), ok("b", { httpStatus: 503, status: "error", error: "non-JSON response" })])).toThrow(/HTTP 503/));
  test("an error the case does not recognise", () =>
    expect(run([ok("a"), ok("b", { status: "error", error: "Unauthenticated: You must be logged in." })])).toThrow(
      /not recognised as a product refusal/
    ));
  test("an error with no message", () =>
    expect(run([ok("a"), ok("b", { status: "error", error: null })])).toThrow(/not recognised as a product refusal/));
  test("timestamps not finite", () => expect(run([ok("a"), ok("b", { sentAt: NaN })])).toThrow(/timestamps not finite/));
  test("timestamps reversed", () =>
    expect(run([ok("a"), ok("b", { sentAt: 600, receivedAt: 500 })])).toThrow(/timestamps not finite\/ordered/));
  test("intervals that do not overlap", () =>
    expect(run([ok("a"), ok("b", { sentAt: 700, receivedAt: 900 })])).toThrow(/did NOT overlap/));
});

/**
 * The owner-proxy's evidence-floor closure (2026-09-11 09:51), controlled: each
 * false-pass shape it named — wrong account, wrong amount, wrong decimal scale,
 * a missing or unlinked reversal, a duplicate effect — turns exactly its own
 * case red against a backend that is otherwise healthy. A reconciliation that
 * has never been watched refusing is a title, not a reconciliation.
 */
describe("evidence-floor closure — the assertions detect incorrect results", () => {
  const detail = (results: Array<Record<string, unknown>>, id: string) => String(results.find((r) => r.id === id)?.detail);

  test("the runner's denomination table is a pinned MIRROR of convex/utils/money.ts, not a second opinion", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "convex", "utils", "money.ts"), "utf8");
    const block = src.match(/const CURRENCY_SCALES[^=]*=\s*\{([\s\S]*?)\};/);
    if (!block) throw new Error("CURRENCY_SCALES not found in convex/utils/money.ts");
    const product: Record<string, number> = {};
    for (const m of block[1].matchAll(/([A-Z]{3}):\s*(\d+)/g)) product[m[1]] = Number(m[2]);
    expect(Object.keys(product).length).toBeGreaterThan(5);
    expect(CURRENCY_SCALES).toEqual(product);
    // and the default the product applies when an org never chose a currency
    const hooks = fs.readFileSync(path.join(__dirname, "..", "convex", "accounting", "workflowHooks.ts"), "utf8");
    const def = hooks.match(/settings\?\.currency \?\? "([A-Z]{3})"/);
    if (!def) throw new Error("getOrgCurrency default not found in workflowHooks.ts");
    expect(DEFAULT_ORG_CURRENCY).toBe(def[1]);
  });

  test("a FRESH org with no settings row resolves to the product default and every money case still passes", async () => {
    // The shape the cloud actually presents: the first run of this closure
    // failed all four money cases because the runner read a field the org
    // record does not carry. The product default is the contract.
    const results = await runAgainst({ noOrgSettingsRow: true });
    for (const id of ["B1", "RC1", "RV1", "RT2"]) expect(statusOf(results, id)).toBe("PASS");
    expect((results.find((r) => r.id === "B1")?.detail as any)?.journal?.currency).toBe("JOD");
  });

  test("an org whose currency the product does not denominate makes the money cases UNPROVEN, not PASS", async () => {
    const results = await runAgainst({ orgCurrencyUnknown: true });
    for (const id of ["B1", "RC1", "RV1", "RT2"]) expect(statusOf(results, id)).toBe("UNPROVEN");
    expect(detail(results, "B1")).toMatch(/not in the rehearsal's mirror/);
  });

  // ── B1: the fourth surface, exactly ──
  test("B1 catches a refund that credits the wrong account", async () => {
    const results = await runAgainst({ refundPostsWrongAccount: true });
    expect(statusOf(results, "B1")).toBe("FAIL");
    expect(detail(results, "B1")).toMatch(/not exactly the expected posting/);
    expect(detail(results, "B1")).toMatch(/BANK_ACCOUNT/);
  });
  test("B1 catches a refund posted one minor unit short (B2 balance cannot)", async () => {
    const results = await runAgainst({ refundPostsWrongAmount: true });
    expect(statusOf(results, "B1")).toBe("FAIL");
    expect(detail(results, "B1")).toMatch(/not exactly the expected posting/);
  });
  test("B1 catches journal lines written at the wrong decimal scale", async () => {
    const results = await runAgainst({ linesAtWrongScale: true });
    expect(statusOf(results, "B1")).toBe("FAIL");
    expect(detail(results, "B1")).toMatch(/minor-unit scale on a journal line: expected 3, got 2/);
  });
  test("B1 catches a refund event that points at no journal entry", async () => {
    const results = await runAgainst({ refundEventUnlinked: true });
    expect(statusOf(results, "B1")).toBe("FAIL");
    expect(detail(results, "B1")).toMatch(/points at NO journal entry/);
  });
  test("B1 catches a SECOND balanced entry for the same refund", async () => {
    const results = await runAgainst({ duplicateRefundJournal: true });
    expect(statusOf(results, "B1")).toBe("FAIL");
    expect(detail(results, "B1")).toMatch(/bound to none of its events/);
    // and B2 — per-entry balance — is exactly the check that cannot see it
    expect(statusOf(results, "B2")).toBe("PASS");
  });

  // ── RC1: independent denomination, receipts on the books, GL control ──
  test("RC1 catches money received on account credited to INCOME instead of the 2110 liability (ACC-9)", async () => {
    const results = await runAgainst({ onAccountPostsAsIncome: true });
    expect(statusOf(results, "RC1")).toBe("FAIL");
    expect(detail(results, "RC1")).toMatch(/the receipt on account: journal lines are not exactly/);
    expect(detail(results, "RC1")).toMatch(/MISCELLANEOUS_INCOME/);
  });
  test("RC1 catches a retained position that disagrees with its GL control balance", async () => {
    const results = await runAgainst({ retainedPositionDriftsFromGl: true });
    expect(statusOf(results, "RC1")).toBe("FAIL");
    expect(detail(results, "RC1")).toMatch(/not exactly the expected posting|2110 net credit/);
  });
  test("RC1 catches a credit application that reduces the position but posts nothing", async () => {
    const results = await runAgainst({ applicationPostsNothing: true });
    expect(statusOf(results, "RC1")).toBe("FAIL");
    expect(detail(results, "RC1")).toMatch(/RECEIPT_CREDIT_APPLIED events .* expected 1, got 0/);
  });

  // ── RV1: exact reopening, linked and opposite ──
  test("RV1 catches a reversal that nothing links to the clearing it reverses", async () => {
    const results = await runAgainst({ reversalUnlinked: true });
    expect(statusOf(results, "RV1")).toBe("FAIL");
    expect(detail(results, "RV1")).toMatch(/names no reversing/);
  });
  test("RV1 catches a linked reversal for the wrong amount", async () => {
    const results = await runAgainst({ reversalWrongAmount: true });
    expect(statusOf(results, "RV1")).toBe("FAIL");
    expect(detail(results, "RV1")).toMatch(/the cheque-return reversal: journal lines are not exactly/);
  });
  test("RV1 catches a bounced cheque whose receivable still reads PAID", async () => {
    const results = await runAgainst({ receivableNotReopened: true });
    expect(statusOf(results, "RV1")).toBe("FAIL");
    expect(detail(results, "RV1")).toMatch(/outstanding on the receivable after the cheque bounced: expected 1200, got 0/);
  });

  // ── RT2: the eight named commands ──
  test("RT2 catches a replay that mints a second identity on any of the eight", async () => {
    const results = await runAgainst({ duplicateOnCreateReplay: true });
    expect(statusOf(results, "RT2")).toBe("FAIL");
    expect(detail(results, "RT2")).toMatch(/returned a DIFFERENT identity/);
  });
  test("RT2 catches a replay that is refused", async () => {
    const results = await runAgainst({ refuseCreateReplay: true });
    expect(statusOf(results, "RT2")).toBe("FAIL");
    expect(detail(results, "RT2")).toMatch(/was refused/);
  });
  test("RT2 catches a replay that returns the SAME id and posts its footprint AGAIN", async () => {
    // The shape the identity half cannot see: ids agree, the books moved twice.
    const results = await runAgainst({ doubleFootprintOnReplay: true });
    expect(statusOf(results, "RT2")).toBe("FAIL");
    expect(detail(results, "RT2")).toMatch(/occurrences for .*: expected 1, got 2|rows .*: expected 1, got 2|after the replay: expected 1, got 2/);
  });
  test("RT2 catches a work-order state barrier that lets a posted expense be edited", async () => {
    const results = await runAgainst({ workOrderLockOpen: true });
    expect(statusOf(results, "RT2")).toBe("FAIL");
    expect(detail(results, "RT2")).toMatch(/state barrier is open/);
  });
});
