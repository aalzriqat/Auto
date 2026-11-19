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
  taxes: { en: "Taxes (JOD)", ar: "الضرائب (دينار اردني)" },
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
type SaleVariant = "completed" | "cancelled" | "cancelled-linked";
type LayoutCase = { locale: Locale; width: number };
async function openFixture({
  page, locale, legacy = false, refuses = false, variant = "completed",
}: Pick<LayoutCase, "locale"> & { page: Page; legacy?: boolean; refuses?: boolean; variant?: SaleVariant }) {
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
  const query = new URLSearchParams();
  if (legacy) query.set("legacy", "1");
  if (variant !== "completed") query.set("cancelled", "1");
  if (variant === "cancelled-linked") query.set("linked", "1");
  await page.goto(`https://sale.test/?${query}`);
  await expect(page.getByRole("combobox", { name: TEXT.status[locale], exact: true })).toBeVisible();
  return { requests, errors };
}

async function chooseCancellation({ page, locale }: { page: Page; locale: Locale }) {
  await page.getByRole("combobox", { name: TEXT.status[locale], exact: true }).click();
  await page.getByRole("option", { name: TEXT.cancelled[locale], exact: true }).click();
  await expect(page.getByRole("combobox", { name: TEXT.status[locale], exact: true })).toHaveText(TEXT.cancelled[locale]);
}

async function enterNativeInvalidPrice({ page, locale }: { page: Page; locale: Locale }) {
  const price = page.getByLabel(TEXT.price[locale]);
  await price.fill("");
  // An unfinished exponent is a real keyboard edit which Chromium rejects natively.
  // Off-step stored numbers are unsuitable: HTML uses the value attribute as its step base.
  await price.press("e");
  expect(await price.evaluate((input: HTMLInputElement) => input.validity.badInput), "unfinished price is natively invalid").toBe(true);
  return price;
}

async function assertLayout({ page, locale, width }: LayoutCase & { page: Page }) {
  const dialog = page.getByRole("dialog");
  const save = dialog.getByRole("button", { name: TEXT.save[locale], exact: true });
  // Assert the rendered dialog and its descendants: body direction cannot detect overrides.
  // https://playwright.dev/docs/api/class-locatorassertions#locator-assertions-to-have-css
  const direction = locale === "ar" ? "rtl" : "ltr";
  await expect(dialog).toHaveCSS("direction", direction);
  await expect(dialog.getByLabel(TEXT.price[locale])).toHaveCSS("direction", direction);
  await expect(save.locator("..")).toHaveCSS("direction", direction);
  expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(locale === "ar" ? "rtl" : "ltr");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "no horizontal page scroll").toBeLessThanOrEqual(0);
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth - element.clientWidth), {
    message: "no horizontal scroll inside the dialog",
  }).toBeLessThanOrEqual(0);
  await expect.poll(() => dialog.evaluate(element => {
    const { left, right } = element.getBoundingClientRect();
    return { left: left >= 0, right: right <= window.innerWidth };
  }), { message: "dialog stays within the horizontal viewport" }).toEqual({ left: true, right: true });
  await save.scrollIntoViewIfNeeded();
  const box = await save.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

async function cancellationCase({
  browser, testInfo, locale, width, legacy,
}: LayoutCase & { browser: Browser; testInfo: TestInfo; legacy: boolean }) {
    const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
    const page = await context.newPage();
    try {
      const { requests, errors } = await openFixture({ page, locale, legacy });
      if (legacy) {
        await expect(page.getByLabel(TEXT.warranty[locale], { exact: true })).toHaveValue("450.5");
        await expect(page.getByLabel(TEXT.term[locale], { exact: true })).toHaveValue("0");
        await enterNativeInvalidPrice({ page, locale });
      }
      await chooseCancellation({ page, locale });
      await page.screenshot({ path: testInfo.outputPath("cancel-status.png"), fullPage: true });
      await assertLayout({ page, locale, width });
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

async function ordinaryEditCase({ browser, locale, width }: LayoutCase & { browser: Browser }) {
  const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
  const page = await context.newPage();
  try {
    const { requests, errors } = await openFixture({ page, locale, legacy: true });
    await page.getByLabel(TEXT.fees[locale], { exact: true }).fill("25");
    await assertLayout({ page, locale, width });
    // A real click must be stopped by native constraint validation before React submits.
    const price = await enterNativeInvalidPrice({ page, locale });
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

const CANCELLED_EDIT_CASES = [
  { locale: "en", width: 390 },
  { locale: "en", width: 1280 },
  { locale: "ar", width: 390 },
  { locale: "ar", width: 1280 },
] as const;

async function cancelledEditCase({ browser, info, locale, width }: LayoutCase & { browser: Browser; info: TestInfo }) {
  // SCRUM-476 G1: keeping CANCELLED selected must save edits for both link variants.
  for (const variant of ["cancelled", "cancelled-linked"] as const) {
    await test.step(variant, async () => {
      const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        const { requests, errors } = await openFixture({ page, locale, variant });
        await expect(page.getByRole("combobox", { name: TEXT.status[locale], exact: true })).toHaveText(TEXT.cancelled[locale]);
        await page.getByRole("spinbutton", { name: `${TEXT.price[locale]} *`, exact: true }).fill("13750");
        await page.getByRole("spinbutton", { name: TEXT.taxes[locale], exact: true }).fill("600");
        await page.getByRole("spinbutton", { name: TEXT.fees[locale], exact: true }).fill("125");
        await page.screenshot({ path: info.outputPath(`${variant}-edited.png`), fullPage: true });
        await assertLayout({ page, locale, width });
        await page.getByRole("button", { name: TEXT.save[locale], exact: true }).click();
        await expect(page.getByText(TEXT.success[locale], { exact: true })).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect.soft(requests).toEqual([{ name: "sales:update", args: {
          orgId: "fixture-org", saleId: "fixture-sale", salePrice: 13750,
          saleDate: 1793491200000, status: "CANCELLED", taxRate: 0, taxAmount: 600,
          dealerFees: 125, downPayment: 0, tradeInVehicleId: "__undefined__", tradeInValue: 0,
          apr: 0, termMonths: 0, warrantySold: 0, warrantyCost: 0, warrantyTermMonths: 0,
          gapSold: 0, gapCost: 0, gapTermMonths: 0, supplierSettlementRoute: "THROUGH_DEALERSHIP",
        } }]);
        expect.soft(requests).not.toContainEqual({ name: "sales:update", args: {
          orgId: "fixture-org", saleId: "fixture-sale", status: "CANCELLED",
        } });
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    });
  }
}

async function refusalCase({ browser, testInfo, locale, width }: LayoutCase & { browser: Browser; testInfo: TestInfo }) {
  const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
  const page = await context.newPage();
  try {
    const { requests, errors } = await openFixture({ page, locale, refuses: true });
    await chooseCancellation({ page, locale });
    await page.getByRole("button", { name: TEXT.save[locale], exact: true }).click();
    await expect(page.getByText(TEXT.refusal[locale], { exact: true })).toBeVisible();
    await expect(page.getByText(TEXT.refusal[locale], { exact: true })).toBeInViewport({ ratio: 1 });
    expect(requests).toEqual([{ name: "sales:update", args: {
      orgId: "fixture-org", saleId: "fixture-sale", status: "CANCELLED",
    } }]);
    await expect(page.getByText(TEXT.success[locale], { exact: true })).toHaveCount(0);
    await expect(page.getByText("synthetic server refusal", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertLayout({ page, locale, width });
    await page.screenshot({ path: testInfo.outputPath("cancel-refused.png"), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}

// Literal registrations bind each executed case to one permanent scenario record.
// The scenario-library parser intentionally refuses loop-generated registrations.
test("cash cancellation sends only status intent · en · 390px", async ({ browser }, info) => { await cancellationCase({ browser, testInfo: info, locale: "en", width: 390, legacy: false }); });
test("legacy warranty cancellation bypasses native and term validation · en · 390px", async ({ browser }, info) => { await cancellationCase({ browser, testInfo: info, locale: "en", width: 390, legacy: true }); });
test("ordinary edit retains native and warranty-term constraints and full payload · en · 390px", async ({ browser }) => { await ordinaryEditCase({ browser, locale: "en", width: 390 }); });
test("backend cancellation refusal is localized without success · en · 390px", async ({ browser }, info) => { await refusalCase({ browser, testInfo: info, locale: "en", width: 390 }); });
test("cash cancellation sends only status intent · en · 1280px", async ({ browser }, info) => { await cancellationCase({ browser, testInfo: info, locale: "en", width: 1280, legacy: false }); });
test("legacy warranty cancellation bypasses native and term validation · en · 1280px", async ({ browser }, info) => { await cancellationCase({ browser, testInfo: info, locale: "en", width: 1280, legacy: true }); });
test("ordinary edit retains native and warranty-term constraints and full payload · en · 1280px", async ({ browser }) => { await ordinaryEditCase({ browser, locale: "en", width: 1280 }); });
test("backend cancellation refusal is localized without success · en · 1280px", async ({ browser }, info) => { await refusalCase({ browser, testInfo: info, locale: "en", width: 1280 }); });
test("cash cancellation sends only status intent · ar · 390px", async ({ browser }, info) => { await cancellationCase({ browser, testInfo: info, locale: "ar", width: 390, legacy: false }); });
test("legacy warranty cancellation bypasses native and term validation · ar · 390px", async ({ browser }, info) => { await cancellationCase({ browser, testInfo: info, locale: "ar", width: 390, legacy: true }); });
test("ordinary edit retains native and warranty-term constraints and full payload · ar · 390px", async ({ browser }) => { await ordinaryEditCase({ browser, locale: "ar", width: 390 }); });
test("backend cancellation refusal is localized without success · ar · 390px", async ({ browser }, info) => { await refusalCase({ browser, testInfo: info, locale: "ar", width: 390 }); });
test("cash cancellation sends only status intent · ar · 1280px", async ({ browser }, info) => { await cancellationCase({ browser, testInfo: info, locale: "ar", width: 1280, legacy: false }); });
test("legacy warranty cancellation bypasses native and term validation · ar · 1280px", async ({ browser }, info) => { await cancellationCase({ browser, testInfo: info, locale: "ar", width: 1280, legacy: true }); });
test("ordinary edit retains native and warranty-term constraints and full payload · ar · 1280px", async ({ browser }) => { await ordinaryEditCase({ browser, locale: "ar", width: 1280 }); });
test("backend cancellation refusal is localized without success · ar · 1280px", async ({ browser }, info) => { await refusalCase({ browser, testInfo: info, locale: "ar", width: 1280 }); });
test("an already-cancelled sale saves its edits · en · 390px", async ({ browser }, info) => { await cancelledEditCase({ browser, info, ...CANCELLED_EDIT_CASES[0] }); });
test("an already-cancelled sale saves its edits · en · 1280px", async ({ browser }, info) => { await cancelledEditCase({ browser, info, ...CANCELLED_EDIT_CASES[1] }); });
test("an already-cancelled sale saves its edits · ar · 390px", async ({ browser }, info) => { await cancelledEditCase({ browser, info, ...CANCELLED_EDIT_CASES[2] }); });
test("an already-cancelled sale saves its edits · ar · 1280px", async ({ browser }, info) => { await cancelledEditCase({ browser, info, ...CANCELLED_EDIT_CASES[3] }); });
