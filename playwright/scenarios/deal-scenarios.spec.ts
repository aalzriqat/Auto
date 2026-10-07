import { test, expect, type Page } from "@playwright/test";
import type { Id } from "../../convex/_generated/dataModel";
import { APPROVER_AUTH_FILE, authenticatedConvexClient, resolveOrgId, testDataSuffix } from "../utils";
import { ensureFinanceCompany } from "../fixtures/financedDeal";
import {
  type DepositTreatment,
  type FinancedScenario,
  approveCreditDecision,
  cancelDeal,
  closeFinancedDeal,
  confirmDisbursement,
  createCostedVehicle,
  decideDeposit,
  ensureCompany,
  quoteFinancedDeal,
  recordApproved,
  resolveAppraisalGap,
  recordForward,
  recordQuotationAmount,
  recordQuoteDeposit,
  scenarioCustomer,
  startApplication,
} from "../fixtures/dealScenarios";
import {
  type ExpectedLedgerDelta,
  drainOutbox,
  ensureLedgerMonthOpen,
  expectLedgerDelta,
  expectOnlyKnownDefect,
  jod,
  ledgerDelta,
  snapshotLedger,
} from "../ledger";

/**
 * Whole financed deals, start to finish, with the general ledger checked after
 * every step that moves money (SCRUM-595).
 *
 * Every expected figure below is a HAND-WRITTEN literal, derived in the comment
 * beside it from the owner's rulings on SCRUM-486 (c21360):
 *   OR-1  the company owes the APPROVED amount;
 *   OR-3  the dealer's contribution is contra-revenue (4180) and is forwarded
 *         to the company together with any deposit the dealer holds;
 * and from the owner's funding ruling (funded = approved × ratio, unfunded =
 * approved × (1 − ratio), dealer contribution = unfunded − first payment; the
 * company remits the full approved amount, never netted):
 *   funded       = min(approved × LTV, approved − first payment)
 *   contribution = approved − funded − first payment   (never below 0)
 * The two agree while the first payment is at most the unfunded part, the only
 * case the owner has ruled. Scenarios whose first payment is above it (the LTV
 * 90 / 3,000 first-payment ones, contribution 0) pin the CURRENT formula, which
 * lends less than approved × ratio; that case is open on SCRUM-613, and those
 * expectations change with its ruling.
 * Nothing here imports a money helper, so a wrong formula in production cannot
 * certify itself (SCRUM-486 A10).
 *
 * The ledger delta is org-wide: an account nobody listed must not move. So the
 * file runs serially on a deployment nothing else is writing to.
 *
 * Accounts (default chart): 1100 cash · 1110 bank · 1300 cheques in hand ·
 * 1210 receivable from finance companies · 1400 vehicle inventory · 2100
 * customer deposits · 2220 payable to finance companies · 4100 vehicle sales ·
 * 4180 dealer financing contribution (contra) · 5100 cost of vehicles sold.
 */

// One deal at a time (the ledger delta is org-wide, run with --workers=1), but
// not "serial": one scenario's failure must not hide the others' results.
test.describe.configure({ timeout: 900_000 });
test.use({ actionTimeout: 25_000 });

const LTV90 = { name: "AutoFlow E2E Finance", ltvPercent: 90 };
const LTV70 = { name: "QA TEST Finance LTV70", ltvPercent: 70 };
const CAR = { price: 15_000, cost: 10_000, costPaidBy: "BANK_TRANSFER" as const };
const BASE = {
  vehicle: CAR,
  downPayment: 3_000,
  quotation: 13_000,
  approved: 13_000,
  legalInvoice: 13_000,
};

/**
 * The vehicle entering stock at cost: Dr inventory, Cr whatever paid for it —
 * cash 1100; bank 1110 for a transfer, a card, or a cheque the dealer writes;
 * supplier payable 2400 when bought on account.
 */
const ACQUIRED_CREDIT = { CASH: "1100", BANK_TRANSFER: "1110", CHEQUE: "1110", CARD: "1110", ON_ACCOUNT: "2400" } as const;
function acquired(paidBy: keyof typeof ACQUIRED_CREDIT): ExpectedLedgerDelta {
  return { "1400": { dr: jod(10_000) }, [ACQUIRED_CREDIT[paidBy]]: { cr: jod(10_000) } };
}
/** The cost of sale at close: Dr 5100, Cr 1400, at cost. */
const COST_OF_SALE: ExpectedLedgerDelta = { "5100": { dr: jod(10_000) }, "1400": { cr: jod(10_000) } };

type Expectation = {
  /**
   * An open defect that makes ONE step post wrong lines today. Only that step
   * is relaxed, and only to the exact wrong lines recorded here; every other
   * step, and any other wrong posting in this one, still fails normally. The
   * step fails the moment it posts as ruled, so the entry is removed and the
   * ruled literal takes over (Codex AF-430-02: a whole-test `test.fail` would
   * excuse any failure in the scenario).
   */
  knownDefect?: { key: string; step: "disbursement"; posts: ExpectedLedgerDelta };
  deposit?: ExpectedLedgerDelta;
  close: ExpectedLedgerDelta;
  /** Absent: the deal owes the company nothing and no forward is offered. */
  forward?: ExpectedLedgerDelta;
  disbursement: ExpectedLedgerDelta;
};

const SCENARIOS: Array<FinancedScenario & { expect: Expectation }> = [
  {
    id: "F01",
    title: "LTV 90, no deposit: the first payment covers the unfinanced share",
    company: LTV90,
    ...BASE,
    expectedPayment: "BANK_TRANSFER",
    // funded = min(13,000×0.9=11,700, 13,000−3,000=10,000) = 10,000;
    // contribution = 13,000 − 10,000 − 3,000 = 0. Nothing to forward.
    expect: {
      close: {
        "1210": { dr: jod(13_000) }, // OR-1: the company owes the approved amount
        "4100": { cr: jod(13_000) }, // legal invoice to the company
        ...COST_OF_SALE,
      },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F02",
    title: "LTV 70, no deposit: the dealer contributes 900",
    company: LTV70,
    ...BASE,
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "BANK_TRANSFER",
    // funded = min(13,000×0.7=9,100, 10,000) = 9,100;
    // contribution = 13,000 − 9,100 − 3,000 = 900 → contra-revenue, forwarded.
    expect: {
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(900) }, // OR-3
        "2220": { cr: jod(900) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(900) }, "1110": { cr: jod(900) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F03",
    title: "LTV 90, 200 cash deposit: the deposit is forwarded to the company",
    company: LTV90,
    ...BASE,
    deposit: { amount: 200, method: "CASH" },
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "CASH",
    expect: {
      deposit: { "1100": { dr: jod(200) }, "2100": { cr: jod(200) } },
      // contribution 0 (as F01); the 200 held is part of the customer's
      // first payment, which belongs to the company → payable, forwarded.
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "2100": { dr: jod(200) },
        "2220": { cr: jod(200) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(200) }, "1100": { cr: jod(200) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F04",
    title: "LTV 70, 500 bank deposit: contribution and deposit forwarded together by cheque",
    company: LTV70,
    ...BASE,
    deposit: { amount: 500, method: "BANK_TRANSFER" },
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "CHEQUE",
    expect: {
      deposit: { "1110": { dr: jod(500) }, "2100": { cr: jod(500) } },
      // OR-3 shape: forward = contribution 900 + deposit 500 = 1,400.
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(900) },
        "2100": { dr: jod(500) },
        "2220": { cr: jod(1_400) },
        ...COST_OF_SALE,
      },
      // A cheque the dealer writes clears from the bank.
      forward: { "2220": { dr: jod(1_400) }, "1110": { cr: jod(1_400) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F05",
    title: "LTV 90, 300 cheque deposit, paid out by card",
    company: LTV90,
    ...BASE,
    deposit: { amount: 300, method: "CHEQUE" },
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "CARD",
    expect: {
      // A cheque received sits in cheques in hand until banked.
      deposit: { "1300": { dr: jod(300) }, "2100": { cr: jod(300) } },
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "2100": { dr: jod(300) },
        "2220": { cr: jod(300) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(300) }, "1110": { cr: jod(300) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F06",
    title: "LTV 90, 250 card deposit, company pays by cheque",
    company: LTV90,
    ...BASE,
    deposit: { amount: 250, method: "CARD" },
    expectedPayment: "CHEQUE",
    forwardMethod: "BANK_TRANSFER",
    expect: {
      deposit: { "1110": { dr: jod(250) }, "2100": { cr: jod(250) } },
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "2100": { dr: jod(250) },
        "2220": { cr: jod(250) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(250) }, "1110": { cr: jod(250) } },
      // Confirming receipt of the company's cheque CLEARS it in the same
      // transaction (applications.confirmDisbursement → markChequeClearedCore),
      // so the money is in the bank, not in cheques in hand: Dr 1110.
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F07",
    title: "LTV 70, no deposit, company pays in cash, contribution forwarded in cash",
    company: LTV70,
    ...BASE,
    expectedPayment: "CASH",
    forwardMethod: "CASH",
    expect: {
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(900) },
        "2220": { cr: jod(900) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(900) }, "1100": { cr: jod(900) } },
      // Cash received from the company is cash on hand.
      disbursement: { "1100": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F08",
    title: "LTV 70, small 1,000 first payment held in full as a cash deposit; car bought for cash",
    company: LTV70,
    ...BASE,
    vehicle: { ...CAR, costPaidBy: "CASH" },
    downPayment: 1_000,
    deposit: { amount: 1_000, method: "CASH" },
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "BANK_TRANSFER",
    // funded = min(13,000×0.7=9,100, 13,000−1,000=12,000) = 9,100;
    // contribution = 13,000 − 9,100 − 1,000 = 2,900; forward = 2,900 + 1,000 = 3,900.
    expect: {
      deposit: { "1100": { dr: jod(1_000) }, "2100": { cr: jod(1_000) } },
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(2_900) },
        "2100": { dr: jod(1_000) },
        "2220": { cr: jod(3_900) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(3_900) }, "1110": { cr: jod(3_900) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F09",
    title: "LTV 90, no deposit, car bought on account from the supplier",
    company: LTV90,
    ...BASE,
    vehicle: { ...CAR, costPaidBy: "ON_ACCOUNT" },
    expectedPayment: "BANK_TRANSFER",
    // As F01: contribution 0, nothing forwarded. Inventory is owed to the supplier.
    expect: {
      close: { "1210": { dr: jod(13_000) }, "4100": { cr: jod(13_000) }, ...COST_OF_SALE },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F10",
    title: "LTV 90, whole 3,000 first payment held as a cash deposit; car paid by dealer cheque",
    company: LTV90,
    ...BASE,
    vehicle: { ...CAR, costPaidBy: "CHEQUE" },
    deposit: { amount: 3_000, method: "CASH" },
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "CASH",
    // contribution 0 (as F01); the whole 3,000 held is forwarded.
    expect: {
      deposit: { "1100": { dr: jod(3_000) }, "2100": { cr: jod(3_000) } },
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "2100": { dr: jod(3_000) },
        "2220": { cr: jod(3_000) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(3_000) }, "1100": { cr: jod(3_000) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F11",
    title: "LTV 70, 3,000 cheque deposit, contribution + deposit forwarded by cheque; car paid by card",
    company: LTV70,
    ...BASE,
    vehicle: { ...CAR, costPaidBy: "CARD" },
    deposit: { amount: 3_000, method: "CHEQUE" },
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "CHEQUE",
    // contribution 900 (as F02); forward = 900 + 3,000 = 3,900.
    expect: {
      deposit: { "1300": { dr: jod(3_000) }, "2100": { cr: jod(3_000) } },
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(900) },
        "2100": { dr: jod(3_000) },
        "2220": { cr: jod(3_900) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(3_900) }, "1110": { cr: jod(3_900) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F12",
    title: "LTV 70, 500 first payment, no deposit: the dealer contributes 3,400",
    company: LTV70,
    ...BASE,
    downPayment: 500,
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "CARD",
    // funded = min(9,100, 12,500) = 9,100; contribution = 13,000 − 9,100 − 500 = 3,400.
    expect: {
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(3_400) },
        "2220": { cr: jod(3_400) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(3_400) }, "1110": { cr: jod(3_400) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F13",
    title: "LTV 90, no deposit, company pays in cash: nothing forwarded",
    company: LTV90,
    ...BASE,
    expectedPayment: "CASH",
    // As F01: contribution 0, nothing to forward.
    expect: {
      close: { "1210": { dr: jod(13_000) }, "4100": { cr: jod(13_000) }, ...COST_OF_SALE },
      disbursement: { "1100": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F14",
    title: "LTV 70, 200 cash deposit, company pays by cheque, 1,100 forwarded in cash",
    company: LTV70,
    ...BASE,
    deposit: { amount: 200, method: "CASH" },
    expectedPayment: "CHEQUE",
    forwardMethod: "CASH",
    // contribution 900 (as F02); forward = 900 + 200 = 1,100.
    expect: {
      deposit: { "1100": { dr: jod(200) }, "2100": { cr: jod(200) } },
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(900) },
        "2100": { dr: jod(200) },
        "2220": { cr: jod(1_100) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(1_100) }, "1100": { cr: jod(1_100) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F15",
    title: "LTV 90, whole 3,000 first payment as a bank deposit, company pays by cheque",
    company: LTV90,
    ...BASE,
    deposit: { amount: 3_000, method: "BANK_TRANSFER" },
    expectedPayment: "CHEQUE",
    forwardMethod: "BANK_TRANSFER",
    // contribution 0; the 3,000 held is forwarded.
    expect: {
      deposit: { "1110": { dr: jod(3_000) }, "2100": { cr: jod(3_000) } },
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "2100": { dr: jod(3_000) },
        "2220": { cr: jod(3_000) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(3_000) }, "1110": { cr: jod(3_000) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F16",
    title: "LTV 70, 900 card deposit, company pays in cash, 1,800 forwarded by card",
    company: LTV70,
    ...BASE,
    deposit: { amount: 900, method: "CARD" },
    expectedPayment: "CASH",
    forwardMethod: "CARD",
    // contribution 900; forward = 900 + 900 = 1,800.
    expect: {
      deposit: { "1110": { dr: jod(900) }, "2100": { cr: jod(900) } },
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(900) },
        "2100": { dr: jod(900) },
        "2220": { cr: jod(1_800) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(1_800) }, "1110": { cr: jod(1_800) } },
      disbursement: { "1100": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F17",
    title: "LTV 90, approved 12,000 below the 13,000 quotation (SCRUM-83)",
    company: LTV90,
    ...BASE,
    approved: 12_000,
    legalInvoice: 12_000,
    expectedPayment: "BANK_TRANSFER",
    // OR-1: the company owes the APPROVED 12,000.
    // funded = min(12,000×0.9=10,800, 12,000−3,000=9,000) = 9,000; contribution 0.
    expect: {
      close: { "1210": { dr: jod(12_000) }, "4100": { cr: jod(12_000) }, ...COST_OF_SALE },
      disbursement: { "1110": { dr: jod(12_000) }, "1210": { cr: jod(12_000) } },
    },
  },
  {
    id: "F18",
    title: "LTV 70, approved 12,000 below the 13,000 quotation: contribution 600",
    company: LTV70,
    ...BASE,
    approved: 12_000,
    legalInvoice: 12_000,
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "BANK_TRANSFER",
    // funded = min(12,000×0.7=8,400, 9,000) = 8,400; contribution = 12,000 − 8,400 − 3,000 = 600.
    expect: {
      close: {
        "1210": { dr: jod(12_000) },
        "4100": { cr: jod(12_000) },
        "4180": { dr: jod(600) },
        "2220": { cr: jod(600) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(600) }, "1110": { cr: jod(600) } },
      disbursement: { "1110": { dr: jod(12_000) }, "1210": { cr: jod(12_000) } },
    },
  },
  {
    id: "F19",
    title: "LTV 70, 500 cheque deposit, company pays by cheque, forwarded in cash; car on account",
    company: LTV70,
    ...BASE,
    vehicle: { ...CAR, costPaidBy: "ON_ACCOUNT" },
    deposit: { amount: 500, method: "CHEQUE" },
    expectedPayment: "CHEQUE",
    forwardMethod: "CASH",
    // contribution 900; forward = 900 + 500 = 1,400.
    expect: {
      deposit: { "1300": { dr: jod(500) }, "2100": { cr: jod(500) } },
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(900) },
        "2100": { dr: jod(500) },
        "2220": { cr: jod(1_400) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(1_400) }, "1100": { cr: jod(1_400) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F20",
    title: "LTV 90, zero first payment: the dealer contributes 1,300",
    company: LTV90,
    ...BASE,
    downPayment: 0,
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "BANK_TRANSFER",
    // funded = min(13,000×0.9=11,700, 13,000−0=13,000) = 11,700; contribution = 1,300.
    expect: {
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(1_300) },
        "2220": { cr: jod(1_300) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(1_300) }, "1110": { cr: jod(1_300) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  {
    id: "F21",
    title: "LTV 70, zero first payment: the dealer contributes 3,900, forwarded by cheque",
    company: LTV70,
    ...BASE,
    downPayment: 0,
    expectedPayment: "CHEQUE",
    forwardMethod: "CHEQUE",
    // funded = min(9,100, 13,000) = 9,100; contribution = 13,000 − 9,100 − 0 = 3,900.
    expect: {
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(3_900) },
        "2220": { cr: jod(3_900) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(3_900) }, "1110": { cr: jod(3_900) } },
      disbursement: { "1110": { dr: jod(13_000) }, "1210": { cr: jod(13_000) } },
    },
  },
  // The appraisal gap settled by the customer (SCRUM-83). Plan v2: the legal
  // invoice is approved + the customer's dealership-bound part, that part is a
  // customer receivable (1200), and the company still owes only the approved
  // amount (OR-1). Money the customer pays the finance company never touches
  // the dealership's books. The contribution formula ignores the gap entirely.
  {
    id: "F22",
    title: "LTV 90, approved 12,000 of 13,000: the customer pays the 1,000 gap in cash",
    company: LTV90,
    ...BASE,
    approved: 12_000,
    legalInvoice: 13_000,
    gap: { mode: "CUSTOMER_ABSORBS", cash: 1_000, installments: 0 },
    expectedPayment: "BANK_TRANSFER",
    // funded = min(10,800, 9,000) = 9,000; contribution 0. Net shortfall (SCRUM-766)
    // = showroom remainder 13,000 at quote − 12,000 actual = 1,000 (same LTV/first payment).
    expect: {
      close: {
        "1210": { dr: jod(12_000) },
        "1200": { dr: jod(1_000) },
        "4100": { cr: jod(13_000) },
        ...COST_OF_SALE,
      },
      disbursement: { "1110": { dr: jod(12_000) }, "1210": { cr: jod(12_000) } },
    },
  },
  {
    id: "F23",
    title: "LTV 70, approved 12,000 of 13,000: net shortfall 700 split, customer 400 by instalments, dealer 300",
    company: LTV70,
    ...BASE,
    approved: 12_000,
    legalInvoice: 12_400,
    gap: { mode: "SPLIT", customerShare: 400, cash: 0, installments: 400 },
    expectedPayment: "BANK_TRANSFER",
    forwardMethod: "BANK_TRANSFER",
    // contribution = 12,000 − 8,400 − 3,000 = 600 (as F18). Net shortfall = remainder at quote
    // 12,100 (contribution 900) − actual 11,400 = 700 (SCRUM-766), not the gross 1,000.
    expect: {
      close: {
        "1210": { dr: jod(12_000) },
        "1200": { dr: jod(400) },
        "4100": { cr: jod(12_400) },
        "4180": { dr: jod(600) },
        "2220": { cr: jod(600) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(600) }, "1110": { cr: jod(600) } },
      disbursement: { "1110": { dr: jod(12_000) }, "1210": { cr: jod(12_000) } },
    },
  },
  // F24 (customer pays the gap to the finance company) is RETIRED by SCRUM-766: that
  // destination is refused until PR-B (customer-pays-FC reduces the showroom
  // contribution). It returns, re-ruled, with PR-B; the refusal itself is pinned by
  // convex/financingEconomics.test.ts.
  {
    id: "F25",
    title: "LTV 90, 400 cash deposit, net shortfall 900: customer 500 (300 cash + 200 instalments), dealer 400",
    company: LTV90,
    ...BASE,
    approved: 12_000,
    legalInvoice: 12_500,
    deposit: { amount: 400, method: "CASH" },
    gap: { mode: "SPLIT", customerShare: 500, cash: 300, installments: 200 },
    expectedPayment: "CHEQUE",
    forwardMethod: "CASH",
    // contribution 0; forward = deposit 400. Customer receivable = 300 + 200. Net shortfall =
    // remainder at quote 12,100 (400 first payment) − actual 11,200 = 900 (SCRUM-766).
    expect: {
      deposit: { "1100": { dr: jod(400) }, "2100": { cr: jod(400) } },
      close: {
        "1210": { dr: jod(12_000) },
        "1200": { dr: jod(500) },
        "4100": { cr: jod(12_500) },
        "2100": { dr: jod(400) },
        "2220": { cr: jod(400) },
        ...COST_OF_SALE,
      },
      forward: { "2220": { dr: jod(400) }, "1100": { cr: jod(400) } },
      disbursement: { "1110": { dr: jod(12_000) }, "1210": { cr: jod(12_000) } },
    },
  },
];

async function step(
  label: string,
  page: Page,
  orgId: Id<"organizations">,
  expected: ExpectedLedgerDelta | ExpectedLedgerDelta[],
  action: () => Promise<void>,
  knownDefect?: { key: string; posts: ExpectedLedgerDelta },
): Promise<void> {
  const before = await snapshotLedger(await authenticatedConvexClient(page), orgId);
  await action();
  // A long UI action can outlive the Clerk token the first client carried.
  const client = await authenticatedConvexClient(page);
  // Postings land through the outbox; give it the time a dealer would.
  await expect
    .poll(async () => {
      const delta = await ledgerDelta(client, orgId, before);
      return delta.unposted.length === 0 && Object.keys(delta.byCode).length > 0;
    }, { timeout: 60_000, message: `${label}: the posting must land` })
    .toBe(true);
  const delta = await ledgerDelta(client, orgId, before);
  console.log(`LEDGER ${label}`, JSON.stringify(delta.byCode));
  for (const e of delta.newEntries) console.log(`  JOURNAL ${e.memo}`, JSON.stringify(e.byCode));
  if (!knownDefect) {
    await test.step(`${label}: ledger moved exactly as ruled`, async () => {
      expectLedgerDelta(delta, expected);
    });
    return;
  }
  await test.step(`${label}: ledger still shows only known defect ${knownDefect.key}`, async () => {
    test.info().annotations.push({
      type: "known-defect",
      description: `${knownDefect.key}: ${label} posts the recorded wrong lines`,
    });
    expectOnlyKnownDefect(delta, expected, knownDefect);
  });
}

test.describe("financed deals, start to finish, checked through the ledger", () => {
  test.skip(
    !process.env.E2E_APPROVER_USER || !process.env.E2E_APPROVER_PASSWORD,
    "Needs the second (approver) identity: a deal's own salesperson cannot approve it.",
  );

  test.beforeAll(async ({ browser }) => {
    console.log(
      "MATRIX\n" +
        SCENARIOS.map(
          (s) =>
            `${s.id} LTV${s.company.ltvPercent} deposit=${s.deposit ? `${s.deposit.amount}/${s.deposit.method}` : "none"} expected=${s.expectedPayment} forward=${s.forwardMethod ?? "none"} — ${s.title}`,
        ).join("\n"),
    );
    const context = await browser.newContext({ storageState: "playwright/.auth/user.json" });
    const page = await context.newPage();
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    await ensureLedgerMonthOpen(await authenticatedConvexClient(page), orgId);
    await ensureFinanceCompany(page);
    await ensureCompany(page, LTV70);
    await context.close();
  });

  for (const s of SCENARIOS) {
    test(`${s.id}: ${s.title}`, async ({ page, browser }) => {
      const orgId = (await resolveOrgId(page)) as Id<"organizations">;
      const client = await authenticatedConvexClient(page);
      // The matrix runs ~40 min; open the month this test posts in, not only
      // the one beforeAll saw, or a run across a month end holds postings.
      await ensureLedgerMonthOpen(client, orgId);
      const model = `QA-${s.id}-${testDataSuffix()}`;

      await step(`${s.id} acquisition`, page, orgId, acquired(s.vehicle.costPaidBy), async () => {
        await createCostedVehicle(client, orgId, { ...s.vehicle, model });
      });
      const customer = await scenarioCustomer(page, `QA${s.id}`);
      await quoteFinancedDeal(page, s, { model, customer });
      if (s.deposit) {
        await step(`${s.id} deposit`, page, orgId, s.expect.deposit!, () =>
          recordQuoteDeposit(page, s.deposit!),
        );
      }
      const dealUrl = await startApplication(page, customer);

      const approver = await browser.newContext({ storageState: APPROVER_AUTH_FILE });
      const managerPage = await approver.newPage();
      try {
        await approveCreditDecision(managerPage, dealUrl);
        if (s.quotation !== undefined) await recordQuotationAmount(page, dealUrl, s.quotation);
        await recordApproved(managerPage, dealUrl, s.approved);
        if (s.quotation !== undefined && s.approved < s.quotation) {
          await resolveAppraisalGap(managerPage, dealUrl, s.gap ?? { mode: "DEALER_ABSORBS" });
        }

        await step(`${s.id} close`, page, orgId, s.expect.close, () =>
          closeFinancedDeal(managerPage, dealUrl, s),
        );

        if (s.expect.forward) {
          await step(`${s.id} forward`, page, orgId, s.expect.forward, () =>
            recordForward(managerPage, s.forwardMethod!),
          );
        } else {
          await expect(
            managerPage.getByRole("button", { name: "Record payment to the finance company" }),
          ).toHaveCount(0);
        }

        await step(
          `${s.id} disbursement`,
          page,
          orgId,
          s.expect.disbursement,
          () => confirmDisbursement(managerPage),
          s.expect.knownDefect?.step === "disbursement" ? s.expect.knownDefect : undefined,
        );
        await managerPage.screenshot({
          path: test.info().outputPath(`${s.id}-final.png`),
          fullPage: true,
        });
      } finally {
        await approver.close();
      }
    });
  }
});

/** The exact reversal of a posting: every debit becomes a credit of the same amount. */
function mirror(delta: ExpectedLedgerDelta): ExpectedLedgerDelta {
  const out: ExpectedLedgerDelta = {};
  for (const [code, side] of Object.entries(delta)) out[code] = { dr: side.cr ?? 0, cr: side.dr ?? 0 };
  return out;
}

/** An action that must not touch the ledger: drained outbox, zero delta. */
async function noMovement(
  label: string,
  page: Page,
  orgId: Id<"organizations">,
  action: () => Promise<void>,
): Promise<void> {
  const before = await snapshotLedger(await authenticatedConvexClient(page), orgId);
  await action();
  const client = await authenticatedConvexClient(page);
  await drainOutbox(client, orgId);
  const delta = await ledgerDelta(client, orgId, before);
  console.log(`LEDGER ${label}`, JSON.stringify(delta.byCode));
  await test.step(`${label}: ledger did not move`, async () => {
    expectLedgerDelta(delta, {});
  });
}

type CancelScenario = FinancedScenario & {
  id: string;
  title: string;
  /** Cancel after the sale is closed (mirror reversal) or before it (no GL). */
  cancelAfterClose: boolean;
  decision?: {
    treatment: DepositTreatment;
    refundMethod?: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";
  };
  expect: { deposit?: ExpectedLedgerDelta; close?: ExpectedLedgerDelta; decision?: ExpectedLedgerDelta };
};

/** F04's close (LTV 70, 500 deposit): contribution 900, forward 1,400. */
const CLOSE_LTV70_DEPOSIT_500: ExpectedLedgerDelta = {
  "1210": { dr: jod(13_000) },
  "4100": { cr: jod(13_000) },
  "4180": { dr: jod(900) },
  "2100": { dr: jod(500) },
  "2220": { cr: jod(1_400) },
  ...COST_OF_SALE,
};

const CANCEL_SCENARIOS: CancelScenario[] = [
  {
    id: "C01",
    title: "closed, cancelled, cash deposit refunded in cash",
    company: LTV70,
    ...BASE,
    deposit: { amount: 500, method: "CASH" },
    expectedPayment: "BANK_TRANSFER",
    cancelAfterClose: true,
    decision: { treatment: "REFUND", refundMethod: "CASH" },
    expect: {
      deposit: { "1100": { dr: jod(500) }, "2100": { cr: jod(500) } },
      close: CLOSE_LTV70_DEPOSIT_500,
      // The reversal re-establishes the liability; the refund pays it out of the till.
      decision: { "2100": { dr: jod(500) }, "1100": { cr: jod(500) } },
    },
  },
  {
    id: "C02",
    title: "closed, cancelled, bank deposit forfeited to income",
    company: LTV70,
    ...BASE,
    deposit: { amount: 500, method: "BANK_TRANSFER" },
    expectedPayment: "BANK_TRANSFER",
    cancelAfterClose: true,
    decision: { treatment: "FORFEIT" },
    expect: {
      deposit: { "1110": { dr: jod(500) }, "2100": { cr: jod(500) } },
      close: CLOSE_LTV70_DEPOSIT_500,
      decision: { "2100": { dr: jod(500) }, "4200": { cr: jod(500) } },
    },
  },
  {
    id: "C03",
    title: "closed, cancelled, card deposit returned to the quote (no money moves)",
    company: LTV90,
    ...BASE,
    deposit: { amount: 1_000, method: "CARD" },
    expectedPayment: "BANK_TRANSFER",
    cancelAfterClose: true,
    decision: { treatment: "RETURN" },
    expect: {
      deposit: { "1110": { dr: jod(1_000) }, "2100": { cr: jod(1_000) } },
      // LTV 90: funded = min(11,700, 10,000) = 10,000; contribution 0; forward = deposit.
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "2100": { dr: jod(1_000) },
        "2220": { cr: jod(1_000) },
        ...COST_OF_SALE,
      },
    },
  },
  {
    id: "C04",
    title: "cancelled before close, cheque deposit refunded by bank transfer",
    company: LTV90,
    ...BASE,
    deposit: { amount: 300, method: "CHEQUE" },
    expectedPayment: "BANK_TRANSFER",
    cancelAfterClose: false,
    decision: { treatment: "REFUND", refundMethod: "BANK_TRANSFER" },
    expect: {
      deposit: { "1300": { dr: jod(300) }, "2100": { cr: jod(300) } },
      decision: { "2100": { dr: jod(300) }, "1110": { cr: jod(300) } },
    },
  },
  {
    id: "C05",
    title: "no deposit, LTV 70 closed then cancelled: pure mirror reversal",
    company: LTV70,
    ...BASE,
    expectedPayment: "BANK_TRANSFER",
    cancelAfterClose: true,
    expect: {
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "4180": { dr: jod(900) },
        "2220": { cr: jod(900) },
        ...COST_OF_SALE,
      },
    },
  },
  {
    id: "C06",
    title: "closed, cancelled, cash deposit refunded by a dealer cheque",
    company: LTV70,
    ...BASE,
    deposit: { amount: 500, method: "CASH" },
    expectedPayment: "BANK_TRANSFER",
    cancelAfterClose: true,
    decision: { treatment: "REFUND", refundMethod: "CHEQUE" },
    expect: {
      deposit: { "1100": { dr: jod(500) }, "2100": { cr: jod(500) } },
      close: CLOSE_LTV70_DEPOSIT_500,
      // An outbound cheque is drawn on the bank, not on cheques in hand.
      decision: { "2100": { dr: jod(500) }, "1110": { cr: jod(500) } },
    },
  },
  {
    id: "C07",
    title: "closed, cancelled, card deposit refunded to the card",
    company: LTV70,
    ...BASE,
    deposit: { amount: 500, method: "CARD" },
    expectedPayment: "CHEQUE",
    cancelAfterClose: true,
    decision: { treatment: "REFUND", refundMethod: "CARD" },
    expect: {
      deposit: { "1110": { dr: jod(500) }, "2100": { cr: jod(500) } },
      close: CLOSE_LTV70_DEPOSIT_500,
      decision: { "2100": { dr: jod(500) }, "1110": { cr: jod(500) } },
    },
  },
  {
    id: "C08",
    title: "cancelled before close, cash deposit forfeited",
    company: LTV90,
    ...BASE,
    deposit: { amount: 750, method: "CASH" },
    expectedPayment: "BANK_TRANSFER",
    cancelAfterClose: false,
    decision: { treatment: "FORFEIT" },
    expect: {
      deposit: { "1100": { dr: jod(750) }, "2100": { cr: jod(750) } },
      decision: { "2100": { dr: jod(750) }, "4200": { cr: jod(750) } },
    },
  },
  {
    id: "C09",
    title: "cancelled before close, bank deposit returned to the quote (no money moves)",
    company: LTV70,
    ...BASE,
    deposit: { amount: 400, method: "BANK_TRANSFER" },
    expectedPayment: "CASH",
    cancelAfterClose: false,
    decision: { treatment: "RETURN" },
    expect: {
      deposit: { "1110": { dr: jod(400) }, "2100": { cr: jod(400) } },
    },
  },
  {
    id: "C10",
    title: "closed, cancelled, cheque deposit forfeited (LTV 90)",
    company: LTV90,
    ...BASE,
    deposit: { amount: 300, method: "CHEQUE" },
    expectedPayment: "CHEQUE",
    cancelAfterClose: true,
    decision: { treatment: "FORFEIT" },
    expect: {
      deposit: { "1300": { dr: jod(300) }, "2100": { cr: jod(300) } },
      close: {
        "1210": { dr: jod(13_000) },
        "4100": { cr: jod(13_000) },
        "2100": { dr: jod(300) },
        "2220": { cr: jod(300) },
        ...COST_OF_SALE,
      },
      decision: { "2100": { dr: jod(300) }, "4200": { cr: jod(300) } },
    },
  },
  {
    id: "C11",
    title: "no deposit, cancelled before close: nothing reaches the ledger",
    company: LTV90,
    ...BASE,
    expectedPayment: "BANK_TRANSFER",
    cancelAfterClose: false,
    expect: {},
  },
  {
    id: "C12",
    title: "car on account, closed, cancelled, cash deposit refunded in cash",
    company: LTV70,
    ...BASE,
    vehicle: { ...CAR, costPaidBy: "ON_ACCOUNT" },
    deposit: { amount: 500, method: "CASH" },
    expectedPayment: "BANK_TRANSFER",
    cancelAfterClose: true,
    decision: { treatment: "REFUND", refundMethod: "CASH" },
    expect: {
      deposit: { "1100": { dr: jod(500) }, "2100": { cr: jod(500) } },
      close: CLOSE_LTV70_DEPOSIT_500,
      // The supplier payable from acquisition is untouched by the cancel.
      decision: { "2100": { dr: jod(500) }, "1100": { cr: jod(500) } },
    },
  },
  {
    id: "C13",
    title: "customer-paid gap (F22 shape) closed then cancelled: the customer receivable reverses too",
    company: LTV90,
    ...BASE,
    approved: 12_000,
    legalInvoice: 13_000,
    gap: { mode: "CUSTOMER_ABSORBS", cash: 1_000, installments: 0 },
    expectedPayment: "BANK_TRANSFER",
    cancelAfterClose: true,
    expect: {
      close: {
        "1210": { dr: jod(12_000) },
        "1200": { dr: jod(1_000) },
        "4100": { cr: jod(13_000) },
        ...COST_OF_SALE,
      },
    },
  },
];

test.describe("cancelled financed deals: the reversal and the deposit decision, through the ledger", () => {
  test.describe.configure({ timeout: 900_000 });
  test.skip(
    !process.env.E2E_APPROVER_USER || !process.env.E2E_APPROVER_PASSWORD,
    "Needs the second (approver) identity.",
  );

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: "playwright/.auth/user.json" });
    const page = await context.newPage();
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    await ensureLedgerMonthOpen(await authenticatedConvexClient(page), orgId);
    await ensureFinanceCompany(page);
    await ensureCompany(page, LTV70);
    await context.close();
  });

  for (const s of CANCEL_SCENARIOS) {
    test(`${s.id}: ${s.title}`, async ({ page, browser }) => {
      const orgId = (await resolveOrgId(page)) as Id<"organizations">;
      const client = await authenticatedConvexClient(page);
      // The matrix runs ~40 min; open the month this test posts in, not only
      // the one beforeAll saw, or a run across a month end holds postings.
      await ensureLedgerMonthOpen(client, orgId);
      const model = `QA-${s.id}-${testDataSuffix()}`;

      await step(`${s.id} acquisition`, page, orgId, acquired(s.vehicle.costPaidBy), async () => {
        await createCostedVehicle(client, orgId, { ...s.vehicle, model });
      });
      const customer = await scenarioCustomer(page, `QA${s.id}`);
      await quoteFinancedDeal(page, s, { model, customer });
      if (s.deposit) {
        await step(`${s.id} deposit`, page, orgId, s.expect.deposit!, () =>
          recordQuoteDeposit(page, s.deposit!),
        );
      }
      const dealUrl = await startApplication(page, customer);

      const approver = await browser.newContext({ storageState: APPROVER_AUTH_FILE });
      const managerPage = await approver.newPage();
      try {
        await approveCreditDecision(managerPage, dealUrl);
        if (s.quotation !== undefined) await recordQuotationAmount(page, dealUrl, s.quotation);
        await recordApproved(managerPage, dealUrl, s.approved);
        if (s.quotation !== undefined && s.approved < s.quotation) {
          await resolveAppraisalGap(managerPage, dealUrl, s.gap ?? { mode: "DEALER_ABSORBS" });
        }

        if (s.cancelAfterClose) {
          await step(`${s.id} close`, page, orgId, s.expect.close!, () =>
            closeFinancedDeal(managerPage, dealUrl, s),
          );
          await step(`${s.id} cancel`, page, orgId, mirror(s.expect.close!), () =>
            cancelDeal(managerPage, `cancel after close (${s.id})`),
          );
        } else {
          await managerPage.goto(dealUrl);
          await noMovement(`${s.id} cancel`, page, orgId, () =>
            cancelDeal(managerPage, `cancel before close (${s.id})`),
          );
        }

        if (s.decision) {
          const decide = () => decideDeposit(managerPage, customer, s.decision!);
          if (s.expect.decision) {
            await step(`${s.id} deposit decision`, page, orgId, s.expect.decision, decide);
          } else {
            await noMovement(`${s.id} deposit decision`, page, orgId, decide);
          }
        }
        await managerPage.screenshot({
          path: test.info().outputPath(`${s.id}-final.png`),
          fullPage: true,
        });
      } finally {
        await approver.close();
      }
    });
  }
});
