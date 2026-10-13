import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { supportedCurrencyScale } from "../../convex/utils/money";
import { newContainedContext } from "../containedContext";
import { APPROVER_AUTH_FILE, USER_AUTH_FILE, authenticatedConvexClient } from "../utils";
import { buildDealWithRecordedEconomics, openDealDetails } from "../fixtures/financedDeal";

/**
 * SCRUM-834: a deal whose costs carry an amount nobody has checked cannot close,
 * and the Handover costs panel must show an action that clears it.
 *
 * This is an interactive replay in a real signed-in session against the real
 * backend, not a painted fixture. The deal is built through the screens an
 * operator uses (two seats, as `deal-cockpit-measure.spec.ts` does). The one
 * thing that is NOT built through a screen is the cost line itself: the "Add
 * cost" form offers only the handover fee types and records an actual with no
 * estimate, so the lines that used to be dead ends (a finance-company fee, an
 * appraisal fee) have no screen that creates them. They are recorded through
 * the public `financeDealCosts.recordDealFee` command, as the signed-in owner,
 * which is the path such lines arrive by. Every step AFTER that is a click.
 *
 * EN and AR, 1280px and 390px. Each of the four reconcile cases:
 *   1. the closing checklist names the costs as BLOCKED and offers its link;
 *   2. the link lands on the Handover costs panel;
 *   3. the row shows the estimate and the actual side by side, and the three
 *      actions (reconcile, record actual, remove) are all inside the viewport;
 *   4. Reconcile with a note resolves it: the status badge, the checklist and
 *      the stored record (status, notes, amount) all say so.
 * The fifth case corrects a disputed amount and then removes the line.
 *
 * Not covered here, and why (see regression/README.md for the library rules):
 *   - The permission negative. Both seats this suite owns (OWNER, MANAGER) hold
 *     create:finance_application and confirm:finance_disbursement, so there is
 *     no seat that is refused. It is proven at the component level
 *     (`HandoverCostRowRoutes.test.tsx`) and the backend (`financeDealCosts.test.ts`).
 *   - The foreign-currency negative. A line in another currency than the deal's
 *     is a legacy record; the public command refuses to create one, so a
 *     browser session cannot reach that state. Same two places.
 *   - The bound execution-fee section. The suite's finance company is
 *     configured with a zero execution fee, so that section is not drawn;
 *     `HandoverExecutionFeeReconcile.test.tsx` covers it.
 *
 * A seat that is not provisioned is a FAILURE here, never a silent no-op: the
 * library treats a replay that cannot run as red.
 */

test.describe.configure({ mode: "serial", timeout: 600_000 });
test.use({ actionTimeout: 25_000 });

type Locale = "en" | "ar";
type Viewport = { name: string; width: number; height: number };

const WIDE: Viewport = { name: "1280", width: 1280, height: 900 };
const PHONE: Viewport = { name: "390", width: 390, height: 844 };

/** Hand-written copy (lib/i18n/domains/sales.ts), so a changed label fails here instead of following the app. */
const COPY = {
  en: {
    reconcile: "Reconcile fee",
    recordActual: "Record actual",
    saveActual: "Save actual",
    remove: "Remove cost",
    confirmRemove: "Remove",
    confirmReconcile: "Confirm reconciliation",
    statusActual: "Actual recorded",
    statusReconciled: "Reconciled",
  },
  ar: {
    reconcile: "تسوية الرسم",
    recordActual: "تسجيل الفعلي",
    saveActual: "حفظ الفعلي",
    remove: "إزالة المصروف",
    confirmRemove: "إزالة",
    confirmReconcile: "تأكيد التسوية",
    statusActual: "فعلي مسجّل",
    statusReconciled: "مُطابَق",
  },
} as const;

/** The Jira figures: estimated 1,250 against an actual 1,500. */
const ESTIMATED_MAJOR = 1250;
const ACTUAL_MAJOR = 1500;

type Shape = {
  feeType: "FINANCE_COMPANY_FEE" | "APPRAISAL_FEE";
  paidTo: "FINANCE_COMPANY" | "APPRAISER";
  accountingTreatment: "FINANCE_COMPANY_COMMISSION" | "APPRAISAL_EXPENSE";
};
const FINANCE_COMPANY_FEE: Shape = {
  feeType: "FINANCE_COMPANY_FEE",
  paidTo: "FINANCE_COMPANY",
  accountingTreatment: "FINANCE_COMPANY_COMMISSION",
};
const APPRAISAL_FEE: Shape = {
  feeType: "APPRAISAL_FEE",
  paidTo: "APPRAISER",
  accountingTreatment: "APPRAISAL_EXPENSE",
};

type Session = {
  page: Page;
  close: () => Promise<void>;
  client: Awaited<ReturnType<typeof authenticatedConvexClient>>;
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  currency: string;
  scale: number;
};

let dealUrl = "";

function requireSeats(): void {
  if (!process.env.E2E_APPROVER_USER || !process.env.E2E_APPROVER_PASSWORD) {
    throw new Error(
      "E2E_APPROVER_USER / E2E_APPROVER_PASSWORD are not provisioned, so the deal cannot be built and the SCRUM-834 reconcile route cannot be replayed. A replay that cannot run is a failure.",
    );
  }
}

/** The signed-in owner's session on the deal, in one language at one width, with a backend client of the same identity. */
async function openSession(browser: Browser, locale: Locale, viewport: Viewport): Promise<Session> {
  const context = await newContainedContext(browser, {
    storageState: USER_AUTH_FILE,
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  // Set before the app boots: the language provider reads it on mount.
  await page.addInitScript((value) => {
    window.localStorage.setItem("autoflow-locale", value);
  }, locale);
  await page.goto(dealUrl);
  await expect(page.getByTestId("deal-next-step")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe(locale === "ar" ? "rtl" : "ltr");

  const match = /\/([^/]+)\/applications\/([^/]+)\/deal$/.exec(new URL(dealUrl).pathname);
  if (!match) throw new Error(`Unexpected deal URL shape: ${dealUrl}`);
  const orgId = match[1] as Id<"organizations">;
  const applicationId = match[2] as Id<"financeApplications">;
  const client = await authenticatedConvexClient(page);
  const costs = await client.query(api.financeDealCosts.listDealCosts, { orgId, applicationId });
  const scale = supportedCurrencyScale(costs.currency);
  if (scale === null) throw new Error(`The deal's currency ${costs.currency} has no known scale.`);
  return { page, close: () => context.close(), client, orgId, applicationId, currency: costs.currency, scale };
}

async function recordCost(
  s: Session,
  shape: Shape | "ANCHOR",
  description: string,
): Promise<Id<"financeDealFees">> {
  const common = {
    orgId: s.orgId,
    applicationId: s.applicationId,
    description,
    paidBy: "DEALER" as const,
    expectedCurrency: s.currency,
    idempotencyKey: randomUUID(),
  };
  if (shape === "ANCHOR") {
    return await s.client.mutation(api.financeDealCosts.recordDealFee, {
      ...common,
      feeType: "OTHER_CLOSING_EXPENSE",
      paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE",
      actualAmountMinor: 0,
    });
  }
  return await s.client.mutation(api.financeDealCosts.recordDealFee, {
    ...common,
    feeType: shape.feeType,
    paidTo: shape.paidTo,
    accountingTreatment: shape.accountingTreatment,
    estimatedAmountMinor: ESTIMATED_MAJOR * 10 ** s.scale,
    actualAmountMinor: ACTUAL_MAJOR * 10 ** s.scale,
  });
}

async function storedFee(s: Session, feeId: Id<"financeDealFees">) {
  const costs = await s.client.query(api.financeDealCosts.listDealCosts, { orgId: s.orgId, applicationId: s.applicationId });
  return costs.fees.find((fee) => fee._id === feeId);
}

/** The control is drawn AND fully inside the viewport (a phone must not push it off-screen). */
async function expectInsideViewport(page: Page, control: Locator, what: string): Promise<void> {
  await expect(control, `${what} is not drawn`).toBeVisible();
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(box, `${what} has no box`).not.toBeNull();
  expect(box!.x, `${what} starts left of the viewport`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what} ends right of the viewport`).toBeLessThanOrEqual(width + 1);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "the page scrolls horizontally").toBeLessThanOrEqual(1);
}

/** Cases 1-4: an unchecked finance-company fee is reconciled from its row. */
async function replayReconcile(browser: Browser, locale: Locale, viewport: Viewport): Promise<void> {
  const copy = COPY[locale];
  const s = await openSession(browser, locale, viewport);
  try {
    const { page } = s;
    const feeId = await recordCost(s, FINANCE_COMPANY_FEE, `E2E SCRUM-834 finance fee ${locale} ${viewport.name}`);

    await openDealDetails(page);
    const check = page.getByTestId("closing-check-COSTS_CLOSABLE");
    const row = page.getByTestId(`deal-handover-cost-${feeId}`);

    // 1. The dead end as the owner saw it: the checklist blocks on the costs and links to them.
    await expect(check).toHaveAttribute("data-status", "BLOCKED");
    const go = page.getByTestId("closing-check-go-COSTS_CLOSABLE");
    await expect(go).toBeVisible();

    // 2. The link lands on the panel that holds the fee.
    await go.click();
    await expect(page.getByTestId("deal-handover-costs")).toBeInViewport();

    // 3. The variance is on the row (estimate beside actual), unchecked, with every route offered.
    await expect(row).toContainText("1,250");
    await expect(row).toContainText("1,500");
    await expect(row).toContainText(copy.statusActual);
    const reconcile = row.getByRole("button", { name: copy.reconcile, exact: true });
    await expectInsideViewport(page, reconcile, "Reconcile");
    await expectInsideViewport(page, row.getByRole("button", { name: copy.recordActual, exact: true }), "Record actual");
    await expectInsideViewport(page, row.getByRole("button", { name: copy.remove, exact: true }), "Remove cost");
    await expectNoSidewaysScroll(page);
    const before = await storedFee(s, feeId);
    expect(before?.status).toBe("ACTUAL_RECORDED");
    expect(before?.actualAmountMinor).toBe(ACTUAL_MAJOR * 10 ** s.scale);

    // 4. Reconcile with a note: the row, the checklist and the stored record agree.
    const note = `SCRUM-834 replay ${locale} ${viewport.name}: matched to the company letter`;
    await reconcile.click();
    await page.locator("#reconcile-notes").fill(note);
    await page.getByRole("button", { name: copy.confirmReconcile, exact: true }).click();

    await expect(row).toContainText(copy.statusReconciled);
    await expect(row.getByRole("button", { name: copy.reconcile, exact: true })).toHaveCount(0);
    await expect(check).toHaveAttribute("data-status", "READY");
    await expect(page.getByTestId("closing-check-go-COSTS_CLOSABLE")).toHaveCount(0);
    await expectNoSidewaysScroll(page);
    await expect
      .poll(async () => (await storedFee(s, feeId))?.status, { message: "the stored cost never became RECONCILED" })
      .toBe("RECONCILED");
    const after = await storedFee(s, feeId);
    expect(after?.reconciliationNotes).toBe(note);
    expect(after?.actualAmountMinor).toBe(ACTUAL_MAJOR * 10 ** s.scale);
  } finally {
    await s.close();
  }
}

test.describe("SCRUM-834: an unchecked cost has a way to clear it from the Handover costs panel", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    requireSeats();
    // Both storage states are passed explicitly: `browser.newContext()` does not inherit the project's.
    const salesContext = await newContainedContext(browser, { storageState: USER_AUTH_FILE });
    const approverContext = await newContainedContext(browser, { storageState: APPROVER_AUTH_FILE });
    try {
      dealUrl = await buildDealWithRecordedEconomics(
        await salesContext.newPage(),
        await approverContext.newPage(),
        "COSTROUTE",
      );
    } finally {
      await salesContext.close();
      await approverContext.close();
    }
  });

  test("en @ 1280: an unchecked finance-company fee shows its variance and is reconciled from its row", async ({ browser }) => {
    await replayReconcile(browser, "en", WIDE);
  });

  test("ar @ 1280: an unchecked finance-company fee shows its variance and is reconciled from its row", async ({ browser }) => {
    await replayReconcile(browser, "ar", WIDE);
  });

  test("en @ 390: an unchecked finance-company fee shows its variance and is reconciled from its row", async ({ browser }) => {
    await replayReconcile(browser, "en", PHONE);
  });

  test("ar @ 390: an unchecked finance-company fee shows its variance and is reconciled from its row", async ({ browser }) => {
    await replayReconcile(browser, "ar", PHONE);
  });

  test("ar @ 390: a disputed appraisal fee is corrected and then removed from its row, clearing the blocker", async ({ browser }) => {
    const copy = COPY.ar;
    const s = await openSession(browser, "ar", PHONE);
    try {
      const { page } = s;
      // An already-checked line is on the deal, so removing the disputed one leaves the costs closable.
      const anchorId = await recordCost(s, "ANCHOR", "E2E SCRUM-834 anchor: no closing costs were borne");
      await s.client.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId,
        feeId: anchorId,
        notes: "E2E SCRUM-834 anchor reconciled",
        expectedActualAmountMinor: 0,
        expectedActualEvidenceRevision: 0,
      });
      const feeId = await recordCost(s, APPRAISAL_FEE, "E2E SCRUM-834 disputed appraisal fee");

      await openDealDetails(page);
      const check = page.getByTestId("closing-check-COSTS_CLOSABLE");
      const row = page.getByTestId(`deal-handover-cost-${feeId}`);
      await expect(check).toHaveAttribute("data-status", "BLOCKED");
      await expect(row).toContainText("1,500");

      // Correct the actual to the estimate.
      await expectInsideViewport(page, row.getByRole("button", { name: copy.recordActual, exact: true }), "Record actual");
      await row.getByRole("button", { name: copy.recordActual, exact: true }).click();
      await page.locator(`#actual-amount-${feeId}`).fill(String(ESTIMATED_MAJOR));
      await page.getByRole("button", { name: copy.saveActual, exact: true }).click();
      await expect(row).not.toContainText("1,500");
      await expect(row).toContainText("1,250");
      await expect
        .poll(async () => (await storedFee(s, feeId))?.actualAmountMinor, { message: "the corrected actual was not stored" })
        .toBe(ESTIMATED_MAJOR * 10 ** s.scale);
      // A correction is a new recording of the evidence, and the line is still unchecked.
      const corrected = await storedFee(s, feeId);
      expect(corrected?.actualEvidenceRevision).toBe(1);
      expect(corrected?.status).toBe("ACTUAL_RECORDED");
      await expect(check).toHaveAttribute("data-status", "BLOCKED");

      // Then remove it, with a reason.
      await expectInsideViewport(page, row.getByRole("button", { name: copy.remove, exact: true }), "Remove cost");
      await row.getByRole("button", { name: copy.remove, exact: true }).click();
      await page.locator("#void-reason").fill("E2E SCRUM-834: charged to the wrong deal");
      await page.getByRole("button", { name: copy.confirmRemove, exact: true }).click();

      await expect(row).toHaveCount(0);
      await expect(check).toHaveAttribute("data-status", "READY");
      await expectNoSidewaysScroll(page);
      expect(await storedFee(s, feeId)).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});
