import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { newContainedContext } from "../containedContext";
import { PILOT_ACCOUNTING_VIEWS, PILOT_G8_ROLE_TAG, PILOT_HUNT_LOCALES, PILOT_HUNT_VIEWPORTS, withLocalePage } from "../fixtures/pilotHunt";
import { ensureFinanceCompany, ZERO_FEE_COMPANY, CUSTOMER_STATUS } from "../fixtures/financedDeal";
import { ensureSupplier } from "../fixtures/dealScenarios";
import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { authenticatedConvexClient, USER_AUTH_FILE, testDataSuffix, testVin } from "../utils";
import { openHuntPage, readHuntAttestation, type Attestation } from "../role-audit/runtime";
import { requireReadyScreen } from "../role-audit/readiness";
import { ROLE_ROUTE_GUARDS, ROLE_ROUTE_ANY_GUARDS, SCREEN_AUDIT_ROUTES } from "../fixtures/screenAuditRoutes";

let attestation: Attestation;
test.beforeAll(() => {
  attestation = readHuntAttestation();
  expect(attestation.primary.roleName).toBe("OWNER");
  expect(attestation.approver.roleName).toBe(process.env.HUNT_AUDIT_ROLE);
});

async function visit(page: Page, baseURL: string | undefined, route: typeof SCREEN_AUDIT_ROUTES[number]) {
  const orgId = attestation.orgId as Id<"organizations">;
  const path = `/${orgId}/${route}`;
  await openHuntPage(page, baseURL, path);
  const client = await authenticatedConvexClient(page);
  const membership = await client.query(api.memberships.getMyMembership, { orgId });
  expect(membership._id).toBe(attestation.approver.membershipId);
  expect([...membership.permissions].sort()).toEqual([...attestation.approver.permissions].sort());
  const allowed = (ROLE_ROUTE_GUARDS[route] ?? []).every(p => membership.permissions.includes(p)) &&
    (ROLE_ROUTE_ANY_GUARDS[route] === undefined || ROLE_ROUTE_ANY_GUARDS[route].some(p => membership.permissions.includes(p)));
  const denied = page.getByRole("heading", { name: /^(Access Not Allowed|الوصول غير مسموح)$/ });
  if (allowed) {
    await requireReadyScreen(page, 15_000, path);
    await expect(denied).toHaveCount(0);
  } else await expect(denied).toBeVisible();
  await expect(page.locator("main")).not.toHaveText(/^\s*$/);
  await expect(page.locator("main")).not.toContainText(/Something went wrong|Application error|حدث خطأ ما/);
  return { allowed, client, orgId, permissions: membership.permissions };
}

test("protected role routes render actual authority across audited pages", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const route of ["expenses", "payroll", "reports", "commissions", "sales", "sales/sales", "tasks", "marketplace/requests", "leads", "social-inbox", "sourcing", "suppliers"] as const) {
    await visit(page, baseURL, route);
  }
  expect(errors).toEqual([]);
});

test("lead screen and create dialog respect actual audited role authority", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const { allowed, permissions } = await visit(page, baseURL, "leads");
  const add = page.getByRole("button", { name: /^(Add Lead|إضافة عميل محتمل)$/ });
  if (allowed && permissions.includes("create:leads")) {
    await add.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog")).not.toContainText(/Something went wrong|Application error/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } else await expect(add).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("approval screen renders authorized queue or explicit role refusal", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const { allowed, permissions, client, orgId } = await visit(page, baseURL, "approvals");
  if (allowed && permissions.includes("confirm:finance_disbursement")) {
    const pending = await client.query(api.depositRequests.listPending, { orgId });
    await expect(page.getByTestId("pending-deposit-loading")).toHaveCount(0);
    if (pending.length === 0) await expect(page.getByTestId("pending-deposit-empty")).toBeVisible();
    else await expect(page.getByTestId("pending-deposit-requests").locator("li")).toHaveCount(pending.length);
  }
  expect(errors).toEqual([]);
});

test("sales quote picker respects audited role and tenant choice authority", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const { allowed, client, orgId } = await visit(page, baseURL, "sales/sales");
  const create = page.getByRole("button", { name: /^(Create Quote|إنشاء عرض سعر)$/ });
  if (allowed) {
    const choices = await client.query(api.orgCustomerStatuses.listForQuotes, { orgId });
    await create.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("checkbox")).toHaveCount(choices.length);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } else await expect(create).toHaveCount(0);
  expect(errors).toEqual([]);
});


// G8 additions are tagged and run in their own project (pilot-g8-role-hunt),
// which nothing depends on. It sits at the same dependency depth as
// role-regressions, so it finishes before the route matrix isolates the approver.
// The owner prepares QA rows; the audited seat never gains authority.
async function pilotPaint(page: Page, path: string, allowed: boolean, locale: "en" | "ar") {
  // Bound to the requested locale: an Arabic page showing the English denial is a failure.
  const denied = page.getByRole("heading", { name: locale === "ar" ? "الوصول غير مسموح" : "Access Not Allowed", exact: true });
  if (allowed) {
    await requireReadyScreen(page, 20_000, path);
    await expect(denied).toHaveCount(0);
  } else await expect(denied).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
  // A 320 CSS-pixel web viewport is the WCAG reflow probe. Scrollable tables
  // remain valid; this checks page-level overflow, not all WCAG requirements.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

async function pilotCapture(page: Page, testInfo: TestInfo, cell: string) {
  const file = testInfo.outputPath(cell, "role-locale-route.png");
  await mkdir(dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true });
}

// Each locale/viewport cell runs on its own page (withLocalePage) so exactly one
// locale init script is installed; pageerrors from every cell are collected.
test("pilot Accounting traversal paints every section and nested reader", { tag: PILOT_G8_ROLE_TAG }, async ({ context, baseURL }, testInfo) => {
  const errors: string[] = [];
  for (const locale of PILOT_HUNT_LOCALES) for (const viewport of PILOT_HUNT_VIEWPORTS) {
    await withLocalePage(context, locale, viewport, async page => {
      const { allowed, orgId, permissions } = await visit(page, baseURL, "accounting");
      for (const [index, view] of PILOT_ACCOUNTING_VIEWS.entries()) {
        const path = `/${orgId}/accounting`;
        await openHuntPage(page, baseURL, `${path}?section=${view.section}`);
        await pilotPaint(page, path, allowed, locale);
        if (allowed) {
          // Radix mounts only the active TabsContent, so the one tabpanel in <main>
          // with no tabpanel ancestor is the requested section's own panel. The
          // section id is part of its generated id (`<base>-content-<section>`);
          // AccountingClient silently falls back to Overview for an unknown or
          // unmounted section, which this assertion refuses, with or without tabs.
          let scope: Locator = page.locator('xpath=//main//*[@role="tabpanel"][not(ancestor::*[@role="tabpanel"])]');
          await expect(scope).toHaveAttribute("id", new RegExp(`-content-${view.section}$`));
          // Each inner tab is looked up only inside the panel opened by the previous
          // step. The section nav also has a `receivables` trigger (visible from sm
          // up) that an unscoped `-trigger-receivables` match would hit as well.
          // Radix tab IDs encode the stable tab value in both locales.
          for (const tab of view.tabs) {
            const trigger = scope.locator(`[role="tab"][id$="-trigger-${tab}"]:visible`);
            if (tab === "approvals" && !permissions.some(permission => permission === "approve:requests" || permission === "manage:finance")) {
              await expect(trigger).toHaveCount(0);
              continue;
            }
            await trigger.click();
            await expect(trigger).toHaveAttribute("aria-selected", "true");
            const panelId = await trigger.getAttribute("aria-controls");
            expect(panelId).toBeTruthy();
            scope = page.locator(`[id="${panelId}"]`);
            await expect(scope).toBeVisible();
          }
          await pilotPaint(page, path, true, locale);
          if (view.section === "journal" && view.tabs.some(tab => tab === "manual")) {
            await expect(page.getByTestId("manual-journals-pilot-off-notice")).toBeVisible();
            await expect(page.getByTestId("new-manual-journal-btn")).toBeDisabled();
          }
        }
        await pilotCapture(page, testInfo, `${locale}-${viewport.name}-accounting-${index}`);
      }
    }, message => errors.push(message));
  }
  expect(errors).toEqual([]);
});

test("pilot Sales opens CASH and configured FINANCED entry panels for each audited role", { tag: PILOT_G8_ROLE_TAG }, async ({ context, baseURL }, testInfo) => {
  const errors: string[] = [];
  for (const locale of PILOT_HUNT_LOCALES) for (const viewport of PILOT_HUNT_VIEWPORTS) {
    await withLocalePage(context, locale, viewport, async page => {
      const { allowed, orgId } = await visit(page, baseURL, "sales");
      for (const mode of ["cash", "installment"] as const) {
        await openHuntPage(page, baseURL, `/${orgId}/sales`);
        const button = page.locator(`#btn-new-${mode}-sale`);
        if (allowed) {
          await button.click();
          await requireReadyScreen(page, 20_000, `/${orgId}/sales`);
          await expect(page.getByRole("button", { name: /Select an available vehicle|اختر.*مركبة|اختيار.*مركبة/ }).first()).toBeVisible();
        } else await expect(button).toHaveCount(0);
        await pilotPaint(page, `/${orgId}/sales`, allowed, locale);
        await pilotCapture(page, testInfo, `${locale}-${viewport.name}-${mode}`);
      }
    }, message => errors.push(message));
  }
  expect(errors).toEqual([]);
});

test("pilot Deals opens owned and SOURCED cash and configured financed detail screens", { tag: PILOT_G8_ROLE_TAG }, async ({ context, browser, baseURL }, testInfo) => {
  const ownerContext = await newContainedContext(browser, { storageState: USER_AUTH_FILE });
  const paths: string[] = [];
  try {
    const ownerPage = await ownerContext.newPage();
    await ownerPage.addInitScript(() => localStorage.setItem("autoflow-locale", "en"));
    const orgId = attestation.orgId as Id<"organizations">;
    await openHuntPage(ownerPage, baseURL, `/${orgId}/sales`);
    await ensureFinanceCompany(ownerPage);
    const owner = await authenticatedConvexClient(ownerPage);
    const company = (await owner.query(api.finance.listCompanies, { orgId })).find(c => c.name === ZERO_FEE_COMPANY.name);
    expect(company).toBeDefined();
    if (!company) throw new Error("Configured QA financier missing");
    const statuses = await owner.query(api.orgCustomerStatuses.listForQuotes, { orgId });
    const status = statuses.find(s => s.label === CUSTOMER_STATUS);
    expect(status).toBeDefined();
    if (!status) throw new Error("Configured QA customer status missing");
    // SCRUM-868 P2: the consignment supplier travels as a master id; the server writes the name.
    const consignor = await ensureSupplier(owner, orgId, "QA TEST G8 Supplier");
    for (const sourceType of ["STOCK", "SOURCED"] as const) for (const mode of ["CASH", "CONFIGURED_FINANCE_COMPANY"] as const) {
      const tag = `QA TEST G8 ${sourceType} ${mode} ${testDataSuffix()}`;
      const vehicleId = await owner.mutation(api.vehicles.create, {
        orgId, vin: testVin(), make: "Playwright", model: tag, year: 2024, mileage: 100,
        color: "Black", fuelType: "Petrol", transmission: "Automatic", sellingPrice: 15_000,
        status: "AVAILABLE", sourceType,
        ...(sourceType === "SOURCED" ? { sourcedSupplierId: consignor, sourceCost: 10_000 } : {}),
        idempotencyKey: tag,
      });
      const customerId = await owner.mutation(api.customers.create, { orgId, firstName: "QA TEST", lastName: tag });
      if (mode === "CASH") {
        const saleId = await owner.mutation(api.sales.createDraft, {
          orgId, vehicleId, customerId, salespersonId: attestation.primary.userId as Id<"users">,
          salePrice: 15_000, saleDate: Date.now(), financingType: "CASH", idempotencyKey: tag,
          ...(sourceType === "SOURCED" ? { supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const } : {}),
        });
        paths.push(`/${orgId}/sales/${saleId}/deal`);
      } else {
        const quoteId = await owner.mutation(api.quotes.saveQuote, {
          orgId, vehicleId, customerId, companyId: company._id, customerEligibilityStatusIds: [status._id],
          mode, vehiclePrice: 15_000, downPayment: 3_000, termMonths: 60,
        });
        const applicationId = await owner.mutation(api.applications.createFromQuote, { orgId, quoteId });
        paths.push(`/${orgId}/applications/${applicationId}/deal`);
      }
    }
    const errors: string[] = [];
    for (const locale of PILOT_HUNT_LOCALES) for (const viewport of PILOT_HUNT_VIEWPORTS) {
      await withLocalePage(context, locale, viewport, async page => {
        const { allowed } = await visit(page, baseURL, "deals");
        for (const [index, path] of paths.entries()) {
          if (allowed) {
            // Follow the actual row link: a direct URL alone misses list/cockpit integration.
            await openHuntPage(page, baseURL, `/${orgId}/deals`);
            const link = page.locator(`main a[href="${path}"]`).first();
            await link.click();
          } else await openHuntPage(page, baseURL, path);
          await pilotPaint(page, path, allowed, locale);
          await pilotCapture(page, testInfo, `${locale}-${viewport.name}-deal-${index}`);
        }
      }, message => errors.push(message));
    }
    expect(errors).toEqual([]);
  } finally { await ownerContext.close(); }
});
