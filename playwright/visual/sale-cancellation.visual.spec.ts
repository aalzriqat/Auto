import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import { newContainedContext } from "../containedContext";

/** SCRUM-476: real SaleDialog + native validation. Offline boundary, no app server/backend. */
const ROOT = resolve(__dirname, "../..");
const OUTPUT = resolve(ROOT, "test-results/sale-cancellation-visual");
type Locale = "en" | "ar";
const TEXT = {
  status: { en: "Status", ar: "الحالة" },
  cancelled: { en: "Cancelled (Refunded/Backed out)", ar: "ملغى (مسترجع / تراجع)" },
  save: { en: "Save Changes", ar: "حفظ التغييرات" },
  success: { en: "Sale updated successfully", ar: "تم تحديث تفاصيل البيع بنجاح" },
  warranty: { en: "Extended Warranty", ar: "تمديد الضمان" },
  term: { en: "Warranty Term (Months)", ar: "مدة الضمان (أشهر)" },
  fees: { en: "Dealer Fees", ar: "رسوم المعرض" },
  price: { en: "Sale Price (JOD)", ar: "سعر البيع (دينار)" },
  refusal: {
    en: "Cannot automatically cancel a sale after the supplier payable has been paid, in whole or in part. Nothing has been changed. The sale and the supplier payment stay as recorded.",
    ar: "لا يمكن إلغاء البيع تلقائياً بعد سداد ذمة المورّد كلياً أو جزئياً. لم يتم تغيير أي شيء، ويبقى البيع ودفعة المورّد كما هما مسجّلتان.",
  },
} as const;
let bundle = "";
let css = "";

test.beforeAll(async () => {
  mkdirSync(OUTPUT, { recursive: true });
  // Reuse the existing interactive visual builder, outside Playwright's loader.
  execFileSync(process.execPath, [
    resolve(ROOT, "playwright/visual/fixtures/buildSupplierNavigation.ts"), OUTPUT,
    "playwright/visual/fixtures/saleCancellationFixture.ts",
    "playwright/visual/fixtures/saleCancellationHooks.ts",
  ], { cwd: ROOT, stdio: "inherit", timeout: 120_000 });
  bundle = readFileSync(resolve(OUTPUT, "fixture.js"), "utf8");
  // Same application stylesheet compilation as deal-money/refund-approval-queue.
  const here = createRequire(__filename);
  const tailwindEntry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(tailwindEntry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(tailwindEntry).resolve("postcss"));
  const input = resolve(ROOT, "app/globals.css");
  css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), { from: input })).css;
  expect(css).toContain("--background");
});

type CapturedRequest = { name: string; args: Record<string, unknown> };
async function openFixture(page: Page, locale: Locale, legacy: boolean, refuses = false) {
  const requests: CapturedRequest[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // Same route-fulfilled reserved host as supplier-navigation; nothing leaves Chromium.
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://sale.test") return route.abort("blockedbyclient");
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (url.pathname === "/mutation") {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ status: refuses ? 400 : 200, contentType: "application/json", body: "{}" });
    }
    if (url.pathname !== "/") return route.abort("blockedbyclient");
    await route.fulfill({ contentType: "text/html", body:
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script src="/fixture.js"></script></body></html>`,
    });
  });
  await page.addInitScript(value => localStorage.setItem("autoflow-locale", value), locale);
  await page.goto(`https://sale.test/${legacy ? "?legacy=1" : ""}`);
  await expect(page.getByRole("combobox", { name: TEXT.status[locale], exact: true })).toBeVisible();
  return { requests, errors };
}

async function chooseCancellation(page: Page, locale: Locale) {
  await page.getByRole("combobox", { name: TEXT.status[locale], exact: true }).click();
  await page.getByRole("option", { name: TEXT.cancelled[locale], exact: true }).click();
  await expect(page.getByRole("combobox", { name: TEXT.status[locale], exact: true })).toHaveText(TEXT.cancelled[locale]);
}

async function enterNativeInvalidPrice(page: Page, locale: Locale) {
  const price = page.getByLabel(TEXT.price[locale]);
  await price.fill("");
  // An unfinished exponent is a real keyboard edit which Chromium rejects natively.
  // Off-step stored numbers are unsuitable: HTML uses the value attribute as its step base.
  await price.press("e");
  expect(await price.evaluate((input: HTMLInputElement) => input.validity.badInput), "unfinished price is natively invalid").toBe(true);
  return price;
}

async function assertLayout(page: Page, locale: Locale, width: number) {
  expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(locale === "ar" ? "rtl" : "ltr");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "no horizontal page scroll").toBeLessThanOrEqual(0);
  const save = page.getByRole("button", { name: TEXT.save[locale], exact: true });
  await save.scrollIntoViewIfNeeded();
  const box = await save.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

async function cancellationCase(browser: Browser, testInfo: TestInfo, locale: Locale, width: number, legacy: boolean) {
    const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
    const page = await context.newPage();
    try {
      const { requests, errors } = await openFixture(page, locale, legacy);
      if (legacy) {
        await expect(page.getByLabel(TEXT.warranty[locale], { exact: true })).toHaveValue("450.5");
        await expect(page.getByLabel(TEXT.term[locale], { exact: true })).toHaveValue("0");
        await enterNativeInvalidPrice(page, locale);
      }
      await chooseCancellation(page, locale);
      await page.screenshot({ path: testInfo.outputPath("cancel-status.png"), fullPage: true });
      await assertLayout(page, locale, width);
      await page.screenshot({ path: testInfo.outputPath("cancel-ready.png"), fullPage: true });
      await page.getByRole("button", { name: TEXT.save[locale], exact: true }).click();
      await expect.poll(() => requests.length, { message: "cancellation reaches the mutation boundary exactly once" }).toBe(1);
      expect(requests).toEqual([{ name: "sales:update", args: {
        orgId: "fixture-org", saleId: "fixture-sale", status: "CANCELLED",
      } }]);
      await expect(page.getByText(TEXT.success[locale], { exact: true })).toBeVisible();
      await expect(page.getByText(TEXT.success[locale], { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
}

async function ordinaryEditCase(browser: Browser, locale: Locale, width: number) {
  const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
  const page = await context.newPage();
  try {
    const { requests, errors } = await openFixture(page, locale, true);
    await page.getByLabel(TEXT.fees[locale], { exact: true }).fill("25");
    await assertLayout(page, locale, width);
    // A real click must be stopped by native constraint validation before React submits.
    const price = await enterNativeInvalidPrice(page, locale);
    await price.evaluate((input: HTMLInputElement) => {
      input.addEventListener("invalid", () => input.dataset.nativeRejected = "yes", { once: true });
    });
    await page.getByRole("button", { name: TEXT.save[locale], exact: true }).click();
    await expect(price).toHaveAttribute("data-native-rejected", "yes");
    expect(requests).toEqual([]);
    // Once the native problem is fixed, the application's warranty-term rule still applies.
    await price.fill("1000");
    await page.getByLabel(TEXT.warranty[locale], { exact: true }).fill("450");
    await page.getByRole("button", { name: TEXT.save[locale], exact: true }).click();
    await expect(page.getByText("A warranty term (in months) is required when a warranty premium is charged", { exact: true })).toBeVisible();
    expect(requests).toEqual([]);
    await page.getByLabel(TEXT.term[locale], { exact: true }).fill("24");
    await page.getByRole("button", { name: TEXT.save[locale], exact: true }).click();
    await expect(page.getByText(TEXT.success[locale], { exact: true })).toBeVisible();
    await expect(page.getByText(TEXT.success[locale], { exact: true })).toBeInViewport({ ratio: 1 });
    expect(requests).toEqual([{ name: "sales:update", args: {
      orgId: "fixture-org", saleId: "fixture-sale", salePrice: 1000,
      saleDate: 1793491200000, status: "COMPLETED", taxRate: 0, taxAmount: 0,
      dealerFees: 25, downPayment: 0, tradeInVehicleId: "__undefined__", tradeInValue: 0,
      apr: 0, termMonths: 0, warrantySold: 450, warrantyCost: 0, warrantyTermMonths: 24,
      gapSold: 0, gapCost: 0, gapTermMonths: 0, supplierSettlementRoute: "THROUGH_DEALERSHIP",
    } }]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}

async function refusalCase(browser: Browser, testInfo: TestInfo, locale: Locale, width: number) {
  const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
  const page = await context.newPage();
  try {
    const { requests, errors } = await openFixture(page, locale, false, true);
    await chooseCancellation(page, locale);
    await page.getByRole("button", { name: TEXT.save[locale], exact: true }).click();
    await expect(page.getByText(TEXT.refusal[locale], { exact: true })).toBeVisible();
    await expect(page.getByText(TEXT.refusal[locale], { exact: true })).toBeInViewport({ ratio: 1 });
    expect(requests).toEqual([{ name: "sales:update", args: {
      orgId: "fixture-org", saleId: "fixture-sale", status: "CANCELLED",
    } }]);
    await expect(page.getByText(TEXT.success[locale], { exact: true })).toHaveCount(0);
    await expect(page.getByText("synthetic server refusal", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertLayout(page, locale, width);
    await page.screenshot({ path: testInfo.outputPath("cancel-refused.png"), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}

// Literal registrations bind each executed case to one permanent scenario record.
// The scenario-library parser intentionally refuses loop-generated registrations.
test("cash cancellation sends only status intent · en · 390px", async ({ browser }, info) => { await cancellationCase(browser, info, "en", 390, false); });
test("legacy warranty cancellation bypasses native and term validation · en · 390px", async ({ browser }, info) => { await cancellationCase(browser, info, "en", 390, true); });
test("ordinary edit retains native and warranty-term constraints and full payload · en · 390px", async ({ browser }) => { await ordinaryEditCase(browser, "en", 390); });
test("backend cancellation refusal is localized without success · en · 390px", async ({ browser }, info) => { await refusalCase(browser, info, "en", 390); });
test("cash cancellation sends only status intent · en · 1280px", async ({ browser }, info) => { await cancellationCase(browser, info, "en", 1280, false); });
test("legacy warranty cancellation bypasses native and term validation · en · 1280px", async ({ browser }, info) => { await cancellationCase(browser, info, "en", 1280, true); });
test("ordinary edit retains native and warranty-term constraints and full payload · en · 1280px", async ({ browser }) => { await ordinaryEditCase(browser, "en", 1280); });
test("backend cancellation refusal is localized without success · en · 1280px", async ({ browser }, info) => { await refusalCase(browser, info, "en", 1280); });
test("cash cancellation sends only status intent · ar · 390px", async ({ browser }, info) => { await cancellationCase(browser, info, "ar", 390, false); });
test("legacy warranty cancellation bypasses native and term validation · ar · 390px", async ({ browser }, info) => { await cancellationCase(browser, info, "ar", 390, true); });
test("ordinary edit retains native and warranty-term constraints and full payload · ar · 390px", async ({ browser }) => { await ordinaryEditCase(browser, "ar", 390); });
test("backend cancellation refusal is localized without success · ar · 390px", async ({ browser }, info) => { await refusalCase(browser, info, "ar", 390); });
test("cash cancellation sends only status intent · ar · 1280px", async ({ browser }, info) => { await cancellationCase(browser, info, "ar", 1280, false); });
test("legacy warranty cancellation bypasses native and term validation · ar · 1280px", async ({ browser }, info) => { await cancellationCase(browser, info, "ar", 1280, true); });
test("ordinary edit retains native and warranty-term constraints and full payload · ar · 1280px", async ({ browser }) => { await ordinaryEditCase(browser, "ar", 1280); });
test("backend cancellation refusal is localized without success · ar · 1280px", async ({ browser }, info) => { await refusalCase(browser, info, "ar", 1280); });
