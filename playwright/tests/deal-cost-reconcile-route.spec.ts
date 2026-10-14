import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { supportedCurrencyScale } from "../../convex/utils/money";
import { newContainedContext } from "../containedContext";
import { APPROVER_AUTH_FILE, USER_AUTH_FILE, authenticatedConvexClient } from "../utils";
import { EXECUTION_FEE_COMPANY, buildDealWithRecordedEconomics, openDealDetails } from "../fixtures/financedDeal";

/**
 * SCRUM-834: a deal whose costs carry an amount nobody has checked cannot close,
 * and the Handover costs panel must show an action that clears it.
 *
 * This is an interactive replay in a real signed-in session against the real
 * backend, not a painted fixture. The deal is built through the screens an
 * operator uses (two seats, as `deal-cockpit-measure.spec.ts` does). What is
 * NOT built through a screen is the cost setup. The "Add
 * cost" form offers only the handover fee types and records an actual with no
 * estimate, so the lines that used to be dead ends (a finance-company fee, an
 * appraisal fee) have no screen that creates them. They are recorded through
 * the public `financeDealCosts.recordDealFee` command, as the signed-in owner,
 * which is the path such lines arrive by. The rest of the setup is public
 * commands too: the appraisal case reconciles an anchor line and records a
 * second fee, and the execution-fee case binds its line with
 * `bindExecutionFeeLine`. Only the action under test is clicked.
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
 *   - The generic cases below do NOT prove the bound execution-fee path: the
 *     suite's default finance company is configured with a zero execution fee, so
 *     the section is not drawn for it and the fee is an ordinary row. That path,
 *     the original SCRUM-834 shape, is replayed separately on a deal created
 *     against a lender configured with a fee (EXECUTION_FEE_COMPANY).
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
    varianceOver: "Actual is higher than expected by",
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
    varianceOver: "الفعلي أعلى من المتوقّع بمقدار",
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
let executionFeeDealUrl = "";

function requireSeats(): void {
  if (!process.env.E2E_APPROVER_USER || !process.env.E2E_APPROVER_PASSWORD) {
    throw new Error(
      "E2E_APPROVER_USER / E2E_APPROVER_PASSWORD are not provisioned, so the deal cannot be built and the SCRUM-834 reconcile route cannot be replayed. A replay that cannot run is a failure.",
    );
  }
}

/** The signed-in owner's session on the deal, in one language at one width, with a backend client of the same identity. */
async function openSession(browser: Browser, url: string, locale: Locale, viewport: Viewport): Promise<Session> {
  const context = await newContainedContext(browser, {
    storageState: USER_AUTH_FILE,
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  // Set before the app boots: the language provider reads it on mount.
  await page.addInitScript((value) => {
    window.localStorage.setItem("autoflow-locale", value);
  }, locale);
  await page.goto(url);
  await expect(page.getByTestId("deal-next-step")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe(locale === "ar" ? "rtl" : "ltr");

  const match = /\/([^/]+)\/applications\/([^/]+)\/deal$/.exec(new URL(url).pathname);
  if (!match) throw new Error(`Unexpected deal URL shape: ${url}`);
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

/** Whether any part of the element is inside the viewport right now (no waiting, no retry). */
async function intersectsViewport(page: Page, target: Locator): Promise<boolean> {
  const box = await target.boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  return box !== null && box.y < height && box.y + box.height > 0;
}

/**
 * Scrolls so the checklist link is on screen and the fee row is NOT, so that the
 * row arriving in view after the click can only be the link's doing. The panel
 * sits above or below the checklist depending on the layout, so both alignments
 * are tried; if neither takes the row out of view the precondition is
 * unreachable and that is reported, never assumed.
 */
async function scrollLinkIntoViewWithRowOutOfView(page: Page, go: Locator, target: Locator): Promise<void> {
  // A row that is not rendered at all has no box and would read as "out of view".
  await expect(target, "the fee row is not rendered").toBeVisible();
  for (const block of ["start", "end"] as const) {
    await go.evaluate((element, alignment) => element.scrollIntoView({ block: alignment, behavior: "instant" }), block);
    await expect(go).toBeInViewport();
    if (!(await intersectsViewport(page, target))) return;
  }
  throw new Error("The fee row stays on screen whichever way the checklist link is scrolled to, so 'the link brought it into view' cannot be proven here.");
}

/**
 * Every test starts from a deal with no live cost line and leaves it so: the
 * lines are removed (an owner may remove a reconciled one) so the next test's
 * panel holds only its own row and the arrival check is about that row.
 */
async function retire(s: Session, feeIds: ReadonlyArray<Id<"financeDealFees">>): Promise<void> {
  for (const feeId of feeIds) {
    try {
      await s.client.mutation(api.financeDealCosts.voidDealFee, { orgId: s.orgId, feeId, reason: "E2E SCRUM-834 clean-up" });
    } catch (error) {
      console.warn(`[deal-cost-reconcile-route] could not remove ${feeId} after the test: ${String(error)}`);
    }
  }
}

/**
 * The fee must be an ordinary row of the generic list: not claimed by a
 * configured position of the finance company's policy and not the bound
 * execution fee. Otherwise the controls this test drives would be a different
 * surface from the one it is named after.
 */
async function expectGenericListRow(s: Session, feeId: Id<"financeDealFees">): Promise<void> {
  const costs = await s.client.query(api.financeDealCosts.listDealCosts, { orgId: s.orgId, applicationId: s.applicationId });
  expect(costs.executionFee?.boundFeeId ?? null, "the test fee is bound as the execution fee").not.toBe(feeId);
  if (costs.expected) {
    expect(costs.expected.unplannedLineIds, "the finance company's policy claims the test fee").toContain(feeId);
  }
  await expect(
    s.page.getByTestId("deal-execution-fee").getByTestId(`deal-handover-cost-${feeId}`),
    "the test fee is drawn inside the execution-fee section",
  ).toHaveCount(0);
}

/** Cases 1-4: an unchecked finance-company fee is reconciled from its row. */
async function replayReconcile(browser: Browser, locale: Locale, viewport: Viewport): Promise<void> {
  const copy = COPY[locale];
  const s = await openSession(browser, dealUrl, locale, viewport);
  const feeIds: Array<Id<"financeDealFees">> = [];
  try {
    const { page } = s;
    const feeId = await recordCost(s, FINANCE_COMPANY_FEE, `E2E SCRUM-834 finance fee ${locale} ${viewport.name}`);
    feeIds.push(feeId);

    await openDealDetails(page);
    const check = page.getByTestId("closing-check-COSTS_CLOSABLE");
    const row = page.getByTestId(`deal-handover-cost-${feeId}`);
    await expectGenericListRow(s, feeId);

    // 1. The dead end as the owner saw it: the checklist blocks on the costs and links to them.
    await expect(check).toHaveAttribute("data-status", "BLOCKED");
    const go = page.getByTestId("closing-check-go-COSTS_CLOSABLE");
    await expect(go).toBeVisible();

    // 2. The link brings the fee row into view -- from a scroll position where it was not.
    await scrollLinkIntoViewWithRowOutOfView(page, go, row);
    expect(await intersectsViewport(page, row), "the fee row was already on screen before the click").toBe(false);
    await go.click();
    await expect(row, "the link did not bring the fee row into view").toBeInViewport({ ratio: 1 });

    // 3. The variance is stated on the row, with the figures beside it, and every route is offered.
    await expect(row).toContainText("1,250");
    await expect(row).toContainText("1,500");
    await expect(row).toContainText(copy.statusActual);
    const rowVariance = row.getByTestId(`deal-handover-cost-${feeId}-variance`);
    await expect(rowVariance).toContainText(copy.varianceOver);
    await expect(rowVariance).toContainText("250");
    const reconcile = row.getByRole("button", { name: copy.reconcile, exact: true });
    await expectInsideViewport(page, reconcile, "Reconcile");
    await expectInsideViewport(page, row.getByRole("button", { name: copy.recordActual, exact: true }), "Record actual");
    await expectInsideViewport(page, row.getByRole("button", { name: copy.remove, exact: true }), "Remove cost");
    await expectNoSidewaysScroll(page);
    const before = await storedFee(s, feeId);
    expect(before?.status).toBe("ACTUAL_RECORDED");
    expect(before?.actualAmountMinor).toBe(ACTUAL_MAJOR * 10 ** s.scale);

    // 4. Reconcile with a note. The figures and the variance stay on screen while it is typed.
    const note = `SCRUM-834 replay ${locale} ${viewport.name}: matched to the company letter`;
    await reconcile.click();
    const form = row.getByTestId(`deal-handover-reconcile-${feeId}-form`);
    await expect(form).toBeVisible();
    await row.locator("#reconcile-notes").fill(note);
    await expect(form).toContainText("1,250");
    await expect(form).toContainText("1,500");
    await expect(form.getByTestId(`deal-handover-reconcile-${feeId}-variance`)).toContainText(copy.varianceOver);
    await expect(form.getByTestId(`deal-handover-reconcile-${feeId}-variance`)).toContainText("250");
    await row.getByRole("button", { name: copy.confirmReconcile, exact: true }).click();

    // The row, the checklist and the stored record agree.
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
    await retire(s, feeIds);
    await s.close();
  }
}

/**
 * The ORIGINAL SCRUM-834 shape: the finance company's execution fee, bound as
 * such, estimated 1,250 against an actual 1,500, on a deal created against a
 * lender configured with that fee. It is acted on in its own section and not in
 * the list.
 */
async function replayExecutionFee(browser: Browser, locale: Locale, viewport: Viewport): Promise<void> {
  const copy = COPY[locale];
  const s = await openSession(browser, executionFeeDealUrl, locale, viewport);
  const feeIds: Array<Id<"financeDealFees">> = [];
  try {
    const { page } = s;
    const feeId = await recordCost(s, FINANCE_COMPANY_FEE, `E2E SCRUM-834 execution fee ${locale} ${viewport.name}`);
    feeIds.push(feeId);
    await s.client.mutation(api.financeDealCosts.bindExecutionFeeLine, { orgId: s.orgId, feeId });

    // The deal really expects the fee, and the line really is the bound one.
    const costs = await s.client.query(api.financeDealCosts.listDealCosts, { orgId: s.orgId, applicationId: s.applicationId });
    expect(costs.executionFee?.expectedMinor, "the lender's configured execution fee did not reach the deal").toBe(ESTIMATED_MAJOR * 10 ** s.scale);
    expect(costs.executionFee?.boundFeeId).toBe(feeId);

    await openDealDetails(page);
    const check = page.getByTestId("closing-check-COSTS_CLOSABLE");
    const section = page.getByTestId("deal-execution-fee");
    await expect(check).toHaveAttribute("data-status", "BLOCKED");
    await expect(section).toBeVisible();

    // The variance, stated, in the section; the figures beside it.
    await expect(section.getByTestId("deal-execution-fee-variance")).toContainText(copy.varianceOver);
    await expect(section.getByTestId("deal-execution-fee-variance")).toContainText("250");
    await expect(section.getByTestId("deal-execution-fee-actual")).toContainText("1,500");
    await expect(section).toContainText("1,250");

    // Acted on there and only there: one Reconcile on the page, and it is the section's.
    await expect(page.getByRole("button", { name: copy.reconcile, exact: true })).toHaveCount(1);
    const reconcile = section.getByRole("button", { name: copy.reconcile, exact: true });
    await expectInsideViewport(page, reconcile, "Reconcile (section)");
    await expectNoSidewaysScroll(page);

    const note = `SCRUM-834 execution fee replay ${locale} ${viewport.name}: company letter`;
    await reconcile.click();
    const form = section.getByTestId("deal-execution-fee-reconcile-form");
    await expect(form).toBeVisible();
    await form.locator("#reconcile-notes").fill(note);
    await expect(form).toContainText("1,250");
    await expect(form).toContainText("1,500");
    await expect(form.getByTestId("reconcile-variance")).toContainText(copy.varianceOver);
    await expect(form.getByTestId("reconcile-variance")).toContainText("250");
    await form.getByRole("button", { name: copy.confirmReconcile, exact: true }).click();

    await expect(section.getByTestId("deal-execution-fee-linked")).toContainText(copy.statusReconciled);
    await expect(section.getByRole("button", { name: copy.reconcile, exact: true })).toHaveCount(0);
    await expect(check).toHaveAttribute("data-status", "READY");
    await expectNoSidewaysScroll(page);
    await expect
      .poll(async () => (await storedFee(s, feeId))?.status, { message: "the stored execution fee never became RECONCILED" })
      .toBe("RECONCILED");
    expect((await storedFee(s, feeId))?.reconciliationNotes).toBe(note);
  } finally {
    await retire(s, feeIds);
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
    const s = await openSession(browser, dealUrl, "ar", PHONE);
    const feeIds: Array<Id<"financeDealFees">> = [];
    try {
      const { page } = s;
      // An already-checked line is on the deal, so removing the disputed one leaves the costs closable.
      const anchorId = await recordCost(s, "ANCHOR", "E2E SCRUM-834 anchor: no closing costs were borne");
      feeIds.push(anchorId);
      await s.client.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId: s.orgId,
        feeId: anchorId,
        notes: "E2E SCRUM-834 anchor reconciled",
        expectedActualAmountMinor: 0,
        expectedActualEvidenceRevision: 0,
      });
      const feeId = await recordCost(s, APPRAISAL_FEE, "E2E SCRUM-834 disputed appraisal fee");
      feeIds.push(feeId);

      await openDealDetails(page);
      const check = page.getByTestId("closing-check-COSTS_CLOSABLE");
      const row = page.getByTestId(`deal-handover-cost-${feeId}`);
      await expectGenericListRow(s, feeId);
      await expect(check).toHaveAttribute("data-status", "BLOCKED");
      await expect(row).toContainText("1,500");

      // Correct the actual to the estimate; the stated variance goes with it.
      await expectInsideViewport(page, row.getByRole("button", { name: copy.recordActual, exact: true }), "Record actual");
      await row.getByRole("button", { name: copy.recordActual, exact: true }).click();
      await row.locator(`#actual-amount-${feeId}`).fill(String(ESTIMATED_MAJOR));
      await row.getByRole("button", { name: copy.saveActual, exact: true }).click();
      await expect(row).not.toContainText("1,500");
      await expect(row).toContainText("1,250");
      await expect(row.getByTestId(`deal-handover-cost-${feeId}-variance`)).not.toContainText(copy.varianceOver);
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
      await row.locator("#void-reason").fill("E2E SCRUM-834: charged to the wrong deal");
      await row.getByRole("button", { name: copy.confirmRemove, exact: true }).click();

      await expect(row).toHaveCount(0);
      await expect(check).toHaveAttribute("data-status", "READY");
      await expectNoSidewaysScroll(page);
      expect(await storedFee(s, feeId)).toBeUndefined();
    } finally {
      await retire(s, feeIds);
      await s.close();
    }
  });
});

test.describe("SCRUM-834: the bound execution fee is reconciled from its own section", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    requireSeats();
    const salesContext = await newContainedContext(browser, { storageState: USER_AUTH_FILE });
    const approverContext = await newContainedContext(browser, { storageState: APPROVER_AUTH_FILE });
    try {
      executionFeeDealUrl = await buildDealWithRecordedEconomics(
        await salesContext.newPage(),
        await approverContext.newPage(),
        "EXECFEE",
        EXECUTION_FEE_COMPANY,
      );
    } finally {
      await salesContext.close();
      await approverContext.close();
    }
  });

  test("en @ 1280: a bound finance-company execution fee shows its variance and is reconciled from its own section", async ({ browser }) => {
    await replayExecutionFee(browser, "en", WIDE);
  });

  test("ar @ 390: a bound finance-company execution fee shows its variance and is reconciled from its own section", async ({ browser }) => {
    await replayExecutionFee(browser, "ar", PHONE);
  });
});
