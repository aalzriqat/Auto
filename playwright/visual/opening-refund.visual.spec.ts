import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import { newContainedContext } from "../containedContext";

/** SCRUM-956 c25206. Render real dialogs offline, with shipped policy and EN/AR dictionaries. */
const ROOT = resolve(__dirname, "../..");
const OUTPUT = resolve(ROOT, "test-results/opening-refund-visual");
type Locale = "en" | "ar";
type State = "fresh" | "cash" | "bank" | "custody" | "loading" | "unavailable" | "refusal" | "return";
const TEXT = {
  reserve: { en: "Reserve for refund", ar: "حجز العربون للردّ" },
  continue: { en: "Continue refund", ar: "متابعة ردّ العربون" },
  cash: { en: "Cash", ar: "نقدي" },
  bank: { en: "Bank transfer", ar: "تحويل بنكي" },
  record: { en: "Record refund", ar: "تسجيل ردّ العربون" },
  cancel: { en: "Cancel", ar: "إلغاء" },
  cancelReservation: { en: "Cancel unpaid reservation", ar: "إلغاء الحجز غير المدفوع" },
  cancelReason: { en: "Why was the refund cancelled?", ar: "لماذا أُلغي ردّ العربون؟" },
  unpaid: { en: "Confirm no payout was made", ar: "تأكيد عدم دفع أي مبلغ" },
  recoveryReason: { en: "How did you verify that payment control was transferred?", ar: "كيف تحققت من نقل صلاحية الدفع؟" },
  custody: { en: "Confirm transfer of payment control", ar: "تأكيد نقل صلاحية الدفع" },
  reference: { en: "Receipt or bank transfer reference", ar: "مرجع الإيصال أو التحويل البنكي" },
  paidDate: { en: "Payout date and time (UTC)", ar: "تاريخ ووقت الدفع (UTC)" },
  loading: { en: "Loading...", ar: "جاري التحميل..." },
  unavailable: { en: "The approver who reserved this refund can continue it.", ar: "يمكن لمن حجز ردّ العربون متابعة العملية." },
  bankReturn: { en: "Record returned deposit refund", ar: "تسجيل حوالة ردّ عربون مرتجعة" },
  original: { en: "Original refund transfer reference", ar: "مرجع حوالة ردّ العربون الأصلية" },
  credit: { en: "Bank credit reference", ar: "مرجع القيد الدائن البنكي" },
  evidence: { en: "Bank portal or statement evidence reference", ar: "مرجع الإثبات من بوابة البنك أو كشف الحساب" },
  verified: {
    en: "I checked the original payout and returned credit against a bank-issued source outside this import.",
    ar: "تحققت من الحوالة الأصلية والقيد المرتجع بالرجوع إلى مصدر صادر عن البنك خارج هذا الاستيراد.",
  },
  refusal: {
    en: "Opening deposit refunds are cash only during the pilot. Bank reservations, payouts and returns are unavailable. Nothing has been changed.",
    ar: "استرداد العربون الافتتاحي نقداً فقط خلال المرحلة التجريبية. الحجز والصرف والإرجاع عبر البنك غير متاحة. لم يتم تغيير أي شيء.",
  },
} as const;
let bundle = "";
let css = "";

test.beforeAll(async () => {
  mkdirSync(OUTPUT, { recursive: true });
  execFileSync(process.execPath, [resolve(ROOT, "playwright/visual/fixtures/buildOpeningRefund.ts"), OUTPUT], {
    cwd: ROOT, stdio: "inherit", timeout: 120_000,
  });
  bundle = readFileSync(resolve(OUTPUT, "fixture.js"), "utf8");
  const here = createRequire(__filename);
  const tailwindEntry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(tailwindEntry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(tailwindEntry).resolve("postcss"));
  const input = resolve(ROOT, "app/globals.css");
  css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), { from: input })).css;
  expect(css).toContain("--background");
});

type Request = { name: string; args: Record<string, unknown> };
async function openFixture(page: Page, locale: Locale, state: State) {
  const requests: Request[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://opening-refund.test") return route.abort("blockedbyclient");
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (url.pathname === "/mutation") {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ status: state === "refusal" ? 400 : 200, contentType: "application/json", body: "{}" });
    }
    if (url.pathname !== "/") return route.abort("blockedbyclient");
    return route.fulfill({ contentType: "text/html", body:
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script src="/fixture.js"></script></body></html>`,
    });
  });
  await page.addInitScript(value => localStorage.setItem("autoflow-locale", value), locale);
  await page.goto(`https://opening-refund.test/?state=${state}`);
  const refundTitle = ["fresh", "refusal"].includes(state) ? TEXT.reserve : TEXT.continue;
  const title = state === "return" ? TEXT.bankReturn : refundTitle;
  await expect(page.getByRole("heading", { name: title[locale], exact: true })).toBeVisible();
  return { requests, errors };
}

// Adapted from PR 823's private assertLayout: it cannot be imported from another spec.
// Test computed direction on the actual portal, its text control and footer, not just html/body.
async function assertLayout(page: Page, locale: Locale, width: number) {
  const dialog = page.getByRole("dialog");
  const direction = locale === "ar" ? "rtl" : "ltr";
  const submit = dialog.locator('button[type="submit"]');
  await expect(dialog).toHaveCSS("direction", direction);
  // Loading/unavailable states contain no editable field; assert their real status text instead.
  const inputs = dialog.locator('input:not([type="datetime-local"])');
  const control = await inputs.count() > 0 ? inputs.first() : dialog.getByRole("status").or(dialog.getByRole("alert")).first();
  await expect(control).toHaveCSS("direction", direction);
  await expect(submit.locator("..")).toHaveCSS("direction", direction);
  expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(direction);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth - element.clientWidth), {
    message: "no internal horizontal overflow",
  }).toBeLessThanOrEqual(0);
  await expect.poll(() => dialog.evaluate(element => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left: left >= 0, right: right <= window.innerWidth, top: top >= 0, bottom: bottom <= window.innerHeight };
  }), { message: "dialog stays inside the viewport" }).toEqual({ left: true, right: true, top: true, bottom: true });
  await submit.scrollIntoViewIfNeeded();
  const box = await submit.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

async function prepareState(page: Page, info: TestInfo, locale: Locale, width: number, state: State) {
  const dialog = page.getByRole("dialog");
  const submit = dialog.locator('button[type="submit"]');
  if (state === "fresh" || state === "refusal") {
    await expect(dialog.getByRole("radio")).toHaveCount(1);
    await expect(dialog.getByRole("radio", { name: TEXT.cash[locale], exact: true })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: TEXT.bank[locale], exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("combobox")).toHaveCount(0);
    await expect(submit).toHaveText(TEXT.reserve[locale]);
    await expect(submit).toBeEnabled();
  } else if (state === "cash") {
    await expect(dialog.getByText(TEXT.cash[locale], { exact: true })).toBeVisible();
    await expect(submit).toBeDisabled();
    await page.getByLabel(TEXT.reference[locale], { exact: true }).fill("SYNTHETIC-CASH-956");
    const paidDate = page.getByLabel(TEXT.paidDate[locale], { exact: true });
    await expect(paidDate).toHaveValue("");
    await expect(submit).toBeDisabled();
    await paidDate.fill("2026-06-10T12:15:30");
    await expect(submit).toHaveText(TEXT.record[locale]);
    await expect(submit).toBeEnabled();
  } else if (state === "bank") {
    await expect(dialog.getByRole("alert")).toHaveText(TEXT.refusal[locale]);
    await expect(submit).toHaveText(TEXT.record[locale]);
    await expect(submit).toBeDisabled();
    await expect(dialog.getByLabel(TEXT.reference[locale], { exact: true })).toHaveCount(0);
    await assertLayout(page, locale, width);
    await page.screenshot({ path: info.outputPath("bank-refusal.png"), fullPage: true });
    await dialog.getByRole("button", { name: TEXT.cancelReservation[locale], exact: true }).click();
    await expect(submit).toBeDisabled();
    await page.getByLabel(TEXT.cancelReason[locale], { exact: true }).fill("Synthetic unpaid cancellation");
    await expect(submit).toHaveText(TEXT.unpaid[locale]);
    await expect(submit).toBeEnabled();
  } else if (state === "custody") {
    await expect(dialog.getByText(TEXT.cash[locale], { exact: true })).toBeVisible();
    await expect(submit).toHaveText(TEXT.custody[locale]);
    await expect(submit).toBeDisabled();
    await page.getByLabel(TEXT.recoveryReason[locale], { exact: true }).fill("Synthetic owner verified control transfer");
    await expect(submit).toBeEnabled();
    await expect(dialog.getByLabel(TEXT.reference[locale], { exact: true })).toHaveCount(0);
  } else if (state === "return") {
    await expect(dialog.getByRole("alert")).toHaveText(TEXT.refusal[locale]);
    await page.getByLabel(TEXT.original[locale], { exact: true }).fill("SYNTHETIC-ORIGINAL");
    await page.getByLabel(TEXT.credit[locale], { exact: true }).fill("SYNTHETIC-CREDIT");
    await page.getByLabel(TEXT.evidence[locale], { exact: true }).fill("SYNTHETIC-BANK-EVIDENCE");
    await page.getByRole("checkbox", { name: TEXT.verified[locale], exact: true }).check();
    await expect(submit).toHaveText(TEXT.bankReturn[locale]);
    await expect(submit).toBeDisabled();
  } else {
    await expect(dialog.getByRole("status")).toHaveText(TEXT[state][locale]);
    await expect(submit).toHaveText(TEXT.record[locale]);
    await expect(submit).toBeDisabled();
  }
}

async function refundCase(browser: Browser, info: TestInfo, locale: Locale, width: number, state: State) {
  const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
  const page = await context.newPage();
  try {
    const { requests, errors } = await openFixture(page, locale, state);
    const dialog = page.getByRole("dialog");
    const submit = dialog.locator('button[type="submit"]');
    await expect(dialog.getByRole("button", { name: TEXT.cancel[locale], exact: true })).toBeEnabled();
    await prepareState(page, info, locale, width, state);
    await assertLayout(page, locale, width);
    await page.screenshot({ path: info.outputPath(`${state}-ready.png`), fullPage: true });
    if (["fresh", "cash", "bank", "custody", "refusal"].includes(state)) {
      await submit.click();
      await expect.poll(() => requests.length).toBe(1);
      const operation = { fresh: "openingDepositRefunds:reserveOpeningRefund", cash: "openingDepositRefunds:recordOpeningRefund",
        bank: "openingDepositRefunds:cancelOpeningRefundReservation", custody: "openingRefundCustody:recoverOpeningRefundCustody",
        refusal: "openingDepositRefunds:reserveOpeningRefund" };
      expect(requests[0].name).toBe(operation[state as keyof typeof operation]);
      if (state === "fresh" || state === "refusal") expect(requests[0].args).toMatchObject({ method: "CASH" });
      if (state === "cash") expect(requests[0].args).toMatchObject({
        reservationKey: "synthetic-reservation", payoutReference: "SYNTHETIC-CASH-956", payoutAt: Date.UTC(2026, 5, 10, 12, 15, 30),
      });
      if (state === "bank") expect(requests[0].args).toMatchObject({ confirmedUnpaid: true, reason: "Synthetic unpaid cancellation" });
      if (state === "custody") expect(requests[0].args).toMatchObject({ confirmedPaymentControlTransferred: true });
      if (state === "refusal") {
        await expect(dialog.getByRole("alert")).toHaveText(TEXT.refusal[locale]);
        await assertLayout(page, locale, width);
      }
    } else {
      // Even programmatic submission of completed return evidence cannot call the transport.
      await dialog.locator("form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(requests).toEqual([]);
    }
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${state}.png`), fullPage: true });
    expect(requests).toHaveLength(["fresh", "cash", "bank", "custody", "refusal"].includes(state) ? 1 : 0);
  } finally {
    await context.close();
  }
}

test("956 cash-only fresh refund has no bank choice · en · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "en", 1280, "fresh"); });

test("956 reserved cash refund is ready for payout · en · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "en", 1280, "cash"); });

test("956 historical bank refund refuses payout and permits unpaid cancellation · en · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "en", 1280, "bank"); });

test("956 owner custody recovery requires transfer evidence · en · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "en", 1280, "custody"); });

test("956 loading reservation cannot pay · en · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "en", 1280, "loading"); });

test("956 unavailable reservation cannot pay · en · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "en", 1280, "unavailable"); });

test("956 coded server refusal is localized · en · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "en", 1280, "refusal"); });

test("956 bank return remains refused after complete evidence · en · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "en", 1280, "return"); });

test("956 cash-only fresh refund has no bank choice · en · 390px", async ({ browser }, info) => { await refundCase(browser, info, "en", 390, "fresh"); });

test("956 reserved cash refund is ready for payout · en · 390px", async ({ browser }, info) => { await refundCase(browser, info, "en", 390, "cash"); });

test("956 historical bank refund refuses payout and permits unpaid cancellation · en · 390px", async ({ browser }, info) => { await refundCase(browser, info, "en", 390, "bank"); });

test("956 owner custody recovery requires transfer evidence · en · 390px", async ({ browser }, info) => { await refundCase(browser, info, "en", 390, "custody"); });

test("956 loading reservation cannot pay · en · 390px", async ({ browser }, info) => { await refundCase(browser, info, "en", 390, "loading"); });

test("956 unavailable reservation cannot pay · en · 390px", async ({ browser }, info) => { await refundCase(browser, info, "en", 390, "unavailable"); });

test("956 coded server refusal is localized · en · 390px", async ({ browser }, info) => { await refundCase(browser, info, "en", 390, "refusal"); });

test("956 bank return remains refused after complete evidence · en · 390px", async ({ browser }, info) => { await refundCase(browser, info, "en", 390, "return"); });

test("956 cash-only fresh refund has no bank choice · ar · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 1280, "fresh"); });

test("956 reserved cash refund is ready for payout · ar · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 1280, "cash"); });

test("956 historical bank refund refuses payout and permits unpaid cancellation · ar · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 1280, "bank"); });

test("956 owner custody recovery requires transfer evidence · ar · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 1280, "custody"); });

test("956 loading reservation cannot pay · ar · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 1280, "loading"); });

test("956 unavailable reservation cannot pay · ar · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 1280, "unavailable"); });

test("956 coded server refusal is localized · ar · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 1280, "refusal"); });

test("956 bank return remains refused after complete evidence · ar · 1280px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 1280, "return"); });

test("956 cash-only fresh refund has no bank choice · ar · 390px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 390, "fresh"); });

test("956 reserved cash refund is ready for payout · ar · 390px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 390, "cash"); });

test("956 historical bank refund refuses payout and permits unpaid cancellation · ar · 390px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 390, "bank"); });

test("956 owner custody recovery requires transfer evidence · ar · 390px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 390, "custody"); });

test("956 loading reservation cannot pay · ar · 390px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 390, "loading"); });

test("956 unavailable reservation cannot pay · ar · 390px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 390, "unavailable"); });

test("956 coded server refusal is localized · ar · 390px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 390, "refusal"); });

test("956 bank return remains refused after complete evidence · ar · 390px", async ({ browser }, info) => { await refundCase(browser, info, "ar", 390, "return"); });
