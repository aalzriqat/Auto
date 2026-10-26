import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { newContainedContext } from "../containedContext";
import { captureWithDiagnostics } from "./browserCaptureDiagnostics";

/**
 * SCRUM-724: the mounted operator money UI, painted. EN and AR x 390px and 1280px.
 *
 * jsdom proves the wiring; it cannot prove the panel's forms fit a phone, that
 * the disabled money actions actually LOOK disabled next to their reason, or
 * that the section mirrors under RTL. The markup comes from
 * `components/applications/cockpit/DealMoneyVisualFixture.test.tsx` (the real
 * deal client with the real `DealInvoiceReceiptsPanel`, the real `CollectionsTab`,
 * real dictionaries) and is painted under the app's own compiled `globals.css`.
 *
 * Asserted (oracle-independent): the hand-written EN/AR literals below paint;
 * each gated money action is disabled (or enabled) as the state demands; the
 * page never scrolls sideways; the computed direction is the one asked for. A
 * screenshot per combination goes to `test-results/deal-money-visual/`.
 *
 * Limits (this is a STATIC bridge, not a signed-in session): Next fonts are not
 * loaded, the app shell is not reproduced, the cockpit is a placeholder box,
 * and Convex/Clerk are stubbed in the fixture.
 */

const ROOT = resolve(__dirname, "../..");
const OUT_DIR = resolve(ROOT, "test-results/deal-money-visual");
const FIXTURES = resolve(OUT_DIR, "fixtures");

const LOCALES = ["en", "ar"] as const;
type Locale = (typeof LOCALES)[number];
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
] as const;

/** Hand-written literals (lib/i18n/domains/sales.ts, common.ts): independent of the render. */
const LITERAL = {
  title: { en: "Customer money after completion", ar: "أموال العميل بعد إتمام البيع" },
  balance: { en: "Customer invoice balance", ar: "المتبقي على فاتورة العميل" },
  doorsReason: {
    en: "Recording or applying customer credit against this sale's invoice is not available during the pilot.",
    ar: "تسجيل رصيد العميل أو تطبيقه على فاتورة هذا البيع غير متاح خلال المرحلة التجريبية.",
  },
  payoutReason: {
    en: "Paying customer credit out is not available during the pilot. The credit stays on the customer's account. You can still reject or cancel a request.",
    ar: "دفع أرصدة العملاء غير متاح خلال المرحلة التجريبية. يبقى الرصيد في حساب العميل. ما زال بإمكانك رفض الطلب أو إلغاؤه.",
  },
  exceeds: {
    en: "The invoice can no longer cover this cheque, so it cannot be deposited. Return it to the customer.",
    ar: "لم تعد الفاتورة تغطي هذا الشيك، لذلك لا يمكن إيداعه. أعده إلى العميل.",
  },
  coded: {
    en: "Recording or applying customer credit against a sale invoice is not available during the pilot. Nothing has been changed.",
    ar: "تسجيل رصيد العميل أو تطبيقه على فاتورة البيع غير متاح خلال المرحلة التجريبية. لم يتم تغيير أي شيء.",
  },
  loadFailed: {
    en: "Customer money for this sale could not be loaded. The rest of the deal is unaffected. Reload the page to try again.",
    ar: "تعذّر تحميل أموال العميل لهذه الصفقة. باقي الصفقة لم يتأثر. أعد تحميل الصفحة للمحاولة مجدداً.",
  },
  refundsHeading: { en: "Customer credit refunds", ar: "ردّ أرصدة العملاء" },
  cockpit: { en: "[deal cockpit]", ar: "[deal cockpit]" },
} as const;
type Literal = keyof typeof LITERAL;

const BUTTON = {
  record: { en: "Record customer receipt", ar: "تسجيل دفعة العميل" },
  activate: { en: "Try activation", ar: "محاولة التفعيل" },
  requestRefund: { en: "Request refund", ar: "طلب ردّ" },
  deposit: { en: "Mark deposited", ar: "تأكيد الإيداع" },
  clear: { en: "Mark cleared", ar: "تأكيد التحصيل" },
  execute: { en: "Record payout", ar: "تسجيل الدفع" },
  approve: { en: "Approve", ar: "موافقة" },
  reject: { en: "Reject", ar: "رفض" },
} as const;
type Button = keyof typeof BUTTON;

const APPROVALS_TAB = { en: "Approvals", ar: "الموافقات" } as const;

/** "disabled" | "enabled" per button; "absent" = must not render at all. */
type ButtonState = "disabled" | "enabled" | "absent";

const STATES: ReadonlyArray<{
  name: string;
  shows: readonly Literal[];
  absent?: readonly Literal[];
  buttons?: Partial<Record<Button, ButtonState>>;
}> = [
  {
    name: "deal-pilot-manager",
    shows: ["cockpit", "title", "balance", "doorsReason", "payoutReason", "exceeds"],
    buttons: { record: "disabled", activate: "disabled", requestRefund: "disabled", deposit: "enabled", clear: "enabled" },
  },
  {
    name: "deal-flags-absent",
    shows: ["title", "doorsReason", "payoutReason"],
    buttons: { record: "disabled", activate: "disabled", requestRefund: "disabled" },
  },
  {
    name: "deal-open-manager",
    shows: ["title", "balance", "exceeds"],
    absent: ["doorsReason", "payoutReason"],
    buttons: { record: "enabled", activate: "enabled", requestRefund: "enabled", deposit: "enabled" },
  },
  {
    name: "deal-viewer",
    shows: ["title", "balance"],
    absent: ["doorsReason", "payoutReason"],
    buttons: { record: "absent", activate: "absent", requestRefund: "absent", deposit: "absent", clear: "absent" },
  },
  { name: "deal-no-finance", shows: ["cockpit"], absent: ["title", "balance"] },
  { name: "deal-coded-refusal", shows: ["title", "coded"] },
  { name: "deal-refund-form", shows: ["title"] },
  { name: "deal-query-failed", shows: ["cockpit", "loadFailed"], absent: ["title"] },
  {
    name: "approvals-accountant-pilot",
    shows: ["refundsHeading", "payoutReason"],
    buttons: { execute: "disabled", approve: "absent" },
  },
  {
    name: "approvals-manager-pilot",
    shows: ["refundsHeading", "payoutReason"],
    buttons: { approve: "disabled", reject: "enabled", execute: "absent" },
  },
  {
    name: "approvals-both-open",
    shows: ["refundsHeading"],
    absent: ["payoutReason"],
    buttons: { approve: "enabled", reject: "enabled", execute: "enabled" },
  },
];

let css = "";

test.beforeAll(async () => {
  mkdirSync(FIXTURES, { recursive: true });
  execFileSync(
    process.execPath,
    [
      resolve(ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      "components/applications/cockpit/DealMoneyVisualFixture.test.tsx",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, DEAL_MONEY_VISUAL_FIXTURE: "1", DEAL_MONEY_VISUAL_FIXTURE_DIR: FIXTURES },
      stdio: "inherit",
    },
  );
  const here = createRequire(__filename);
  const tailwindEntry = here.resolve("@tailwindcss/postcss");
  const tailwindModule = here(tailwindEntry);
  const tailwind = typeof tailwindModule === "function" ? tailwindModule : tailwindModule.default;
  const postcss = here(createRequire(tailwindEntry).resolve("postcss"));
  const input = resolve(ROOT, "app/globals.css");
  css = (await postcss([tailwind({ base: ROOT })]).process(readFileSync(input, "utf8"), { from: input })).css;
  expect(css).toContain("--background");
});

function documentFor(name: string, locale: Locale): string {
  const file = resolve(FIXTURES, `${name}-${locale}.html`);
  expect(existsSync(file), `bridge did not write ${file}`).toBe(true);
  const body = readFileSync(file, "utf8");
  const dir = locale === "ar" ? "rtl" : "ltr";
  return `<!doctype html>
<html dir="${dir}" lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body class="${locale === "ar" ? "font-cairo" : "font-inter"} antialiased"><main class="p-3 sm:p-4 md:p-6" data-testid="surface">${body}</main></body></html>`;
}

for (const locale of LOCALES) {
  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      test(`${state.name} · ${locale} · ${viewport.name}px`, async ({ browser }, testInfo) => {
        const context = await newContainedContext(browser, { viewport: { width: viewport.width, height: viewport.height } });
        const page = await context.newPage();
        try {
          const file = resolve(FIXTURES, `page-${state.name}-${locale}-${viewport.name}.html`);
          writeFileSync(file, documentFor(state.name, locale));
          await page.goto(`file:///${file.replace(/\\/g, "/")}`);

          const dir = locale === "ar" ? "rtl" : "ltr";
          expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(dir);

          for (const key of state.shows) {
            await expect(page.getByText(LITERAL[key][locale], { exact: true }).first(), `${key} paints`).toBeVisible();
          }
          for (const key of state.absent ?? []) {
            await expect(page.getByText(LITERAL[key][locale], { exact: true }), `${key} is absent`).toHaveCount(0);
          }
          // No raw server English ever reaches the operator.
          await expect(page.getByText("(server English)")).toHaveCount(0);

          for (const [key, want] of Object.entries(state.buttons ?? {}) as Array<[Button, ButtonState]>) {
            const buttons = page.getByRole("button", { name: BUTTON[key][locale], exact: true });
            if (want === "absent") {
              await expect(buttons, `${key} is not offered`).toHaveCount(0);
              continue;
            }
            const first = buttons.first();
            await expect(first, `${key} is shown`).toBeVisible();
            if (want === "disabled") await expect(first, `${key} is disabled`).toBeDisabled();
            else await expect(first, `${key} is enabled`).toBeEnabled();
          }

          if (state.name.startsWith("approvals-")) {
            // The Approvals sub-tab (where the refund queue lives) must be reachable on a
            // phone: scrolled into view inside its strip, it lands inside the viewport.
            const trigger = page.getByRole("tab", { name: APPROVALS_TAB[locale], exact: true });
            await trigger.scrollIntoViewIfNeeded();
            const box = await trigger.boundingBox();
            expect(box, "Approvals tab has a box").not.toBeNull();
            expect(box!.x, "Approvals tab starts inside the viewport").toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width, "Approvals tab ends inside the viewport").toBeLessThanOrEqual(viewport.width);
          }

          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, "sideways scroll").toBeLessThanOrEqual(0);

          const image = await captureWithDiagnostics(page, {
            path: resolve(OUT_DIR, `shot-${state.name}-${locale}-${viewport.name}.png`),
            fullPage: true,
          }, () => testInfo.outputPath("capture-failure.json"),
          () => testInfo.outputPath("capture-document.json"));
          const retainedImage = testInfo.outputPath("native-deal-capture.png");
          writeFileSync(retainedImage, image, { flag: "wx" });
          await testInfo.attach("native-deal-capture", { path: retainedImage, contentType: "image/png" });
        } finally {
          await context.close();
        }
      });
    }
  }
}
