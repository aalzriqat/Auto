import { test, expect, type Page } from "@playwright/test";
import type { Id } from "../../convex/_generated/dataModel";
import { APPROVER_AUTH_FILE, authenticatedConvexClient, resolveOrgId, testDataSuffix } from "../utils";
import { ensureFinanceCompany } from "../fixtures/financedDeal";
import {
  type FinancedScenario,
  approveCreditDecision,
  closeFinancedDeal,
  confirmDisbursement,
  createCostedVehicle,
  ensureCompany,
  quoteFinancedDeal,
  recordApproved,
  recordForward,
  recordQuotationAmount,
  recordQuoteDeposit,
  scenarioCustomer,
  startApplication,
} from "../fixtures/dealScenarios";
import {
  type ExpectedLedgerDelta,
  ensureLedgerMonthOpen,
  expectLedgerDelta,
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
 * and from the v2 financed-sale plan:
 *   funded       = min(approved × LTV, approved − first payment)
 *   contribution = approved − funded − first payment   (never below 0)
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
   * A Jira key whose open defect makes this scenario fail today. The test is
   * marked expected-to-fail, so it turns red ("unexpectedly passed") the moment
   * the defect is fixed and the literal here must be re-checked.
   */
  knownDefect?: string;
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
      knownDefect: "SCRUM-599", // the receipt is posted to 1110, not 1100
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
];

async function step(
  label: string,
  page: Page,
  orgId: Id<"organizations">,
  expected: ExpectedLedgerDelta,
  action: () => Promise<void>,
): Promise<void> {
  const client = await authenticatedConvexClient(page);
  const before = await snapshotLedger(client, orgId);
  await action();
  // Postings land through the outbox; give it the time a dealer would.
  await expect
    .poll(async () => {
      const delta = await ledgerDelta(client, orgId, before);
      return delta.unposted.length === 0 && Object.keys(delta.byCode).length > 0;
    }, { timeout: 60_000, message: `${label}: the posting must land` })
    .toBe(true);
  const delta = await ledgerDelta(client, orgId, before);
  console.log(`LEDGER ${label}`, JSON.stringify(delta.byCode));
  await test.step(`${label}: ledger moved exactly as ruled`, async () => {
    expectLedgerDelta(delta, expected);
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
      test.fail(s.expect.knownDefect !== undefined, `Known defect ${s.expect.knownDefect}`);
      const orgId = (await resolveOrgId(page)) as Id<"organizations">;
      const client = await authenticatedConvexClient(page);
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

        await step(`${s.id} disbursement`, page, orgId, s.expect.disbursement, () =>
          confirmDisbursement(managerPage),
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
