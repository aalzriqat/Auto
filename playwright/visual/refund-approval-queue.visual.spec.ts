import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { newContainedContext } from "../containedContext";

/**
 * SCRUM-831: the manager's customer-credit refund approval queue on the Approvals
 * page, painted. EN and AR x 390px and 1280px, under the permission sets of the
 * shipped default MANAGER and ACCOUNTANT role templates.
 *
 * jsdom proves the wiring; it cannot prove the rows fit a phone, that the paused
 * Approve action LOOKS disabled beside its reason, or that the row mirrors under
 * RTL. The markup comes from
 * `components/accounting/RefundApprovalQueueVisualFixture.test.tsx` (the real
 * Approvals page and queue, real dictionaries) and is painted under the app's own
 * compiled `globals.css`.
 *
 * Asserted (oracle-independent): the hand-written EN/AR literals below paint; each
 * action is disabled, enabled or absent as the state demands and sits inside the
 * viewport; the page never scrolls sideways; the computed direction is the one
 * asked for. A screenshot per combination goes to `test-results/refund-approval-visual/`.
 *
 * Limits (a STATIC bridge, not a signed-in session): Next fonts are not loaded,
 * the app shell is not reproduced, and Convex/Clerk are stubbed in the fixture.
 */

const ROOT = resolve(__dirname, "../..");
const OUT_DIR = resolve(ROOT, "test-results/refund-approval-visual");
const FIXTURES = resolve(OUT_DIR, "fixtures");

const LOCALES = ["en", "ar"] as const;
type Locale = (typeof LOCALES)[number];
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
] as const;

/** Hand-written literals (lib/i18n/domains/sales.ts, common.ts): independent of the render. */
const LITERAL = {
  title: { en: "Customer credit refunds awaiting approval", ar: "طلبات ردّ رصيد العملاء بانتظار الموافقة" },
  loading: { en: "Loading refund requests…", ar: "جارٍ تحميل طلبات الردّ…" },
  empty: {
    en: "No customer credit refunds are waiting for your approval.",
    ar: "لا توجد طلبات ردّ أرصدة بانتظار موافقتك.",
  },
  own: {
    en: "You requested this refund, so a different approver must decide it.",
    ar: "أنت من قدّم طلب الردّ هذا، لذلك يجب أن يبتّ فيه موافق آخر.",
  },
  paused: {
    en: "Approving is paused: paying customer credit out is not available during the pilot. The credit stays on the customer's account. You can still reject a request.",
    ar: "الموافقة متوقفة: دفع أرصدة العملاء غير متاح خلال المرحلة التجريبية. يبقى الرصيد في حساب العميل. ما زال بإمكانك رفض الطلب.",
  },
  loadMore: { en: "Load more requests", ar: "تحميل المزيد من الطلبات" },
  loadingMore: { en: "Loading more requests…", ar: "جارٍ تحميل المزيد من الطلبات…" },
  loadFailed: {
    en: "Customer credit refunds could not be loaded. Reload the page to try again.",
    ar: "تعذّر تحميل طلبات ردّ رصيد العملاء. أعد تحميل الصفحة للمحاولة مجدداً.",
  },
  customer: { en: "Layla Haddad", ar: "Layla Haddad" },
  reason: {
    en: "Customer withdrew from the purchase and asked for the cheque amount back.",
    ar: "Customer withdrew from the purchase and asked for the cheque amount back.",
  },
} as const;
type Literal = keyof typeof LITERAL;

const BUTTON = {
  approve: { en: "Approve", ar: "موافقة" },
  reject: { en: "Reject", ar: "رفض" },
  execute: { en: "Record payout", ar: "تسجيل الدفع" },
  cancel: { en: "Cancel request", ar: "إلغاء الطلب" },
  loadMore: { en: "Load more requests", ar: "تحميل المزيد من الطلبات" },
  loadingMore: { en: "Loading more requests…", ar: "جارٍ تحميل المزيد من الطلبات…" },
} as const;
type Button = keyof typeof BUTTON;

/** "disabled" | "enabled" per button; "absent" = must not render at all. */
type ButtonState = "disabled" | "enabled" | "absent";

const STATES: ReadonlyArray<{
  name: string;
  shows: readonly Literal[];
  absent?: readonly Literal[];
  buttons?: Partial<Record<Button, ButtonState>>;
}> = [
  {
    name: "manager-pilot",
    shows: ["title", "paused", "own", "customer", "reason"],
    buttons: { approve: "disabled", reject: "enabled", execute: "absent", cancel: "absent" },
  },
  {
    name: "manager-open",
    shows: ["title", "own", "customer", "reason"],
    absent: ["paused"],
    buttons: { approve: "enabled", reject: "enabled", execute: "absent", cancel: "absent", loadMore: "absent" },
  },
  {
    name: "manager-more",
    shows: ["title", "customer", "reason"],
    absent: ["empty", "loadingMore"],
    buttons: { approve: "enabled", reject: "enabled", loadMore: "enabled", loadingMore: "absent" },
  },
  {
    name: "manager-loading-more",
    shows: ["title", "customer", "loadingMore"],
    absent: ["empty", "loadMore"],
    buttons: { approve: "enabled", loadMore: "absent", loadingMore: "disabled" },
  },
  {
    name: "manager-empty",
    shows: ["title", "empty"],
    absent: ["paused", "own"],
    buttons: { approve: "absent", reject: "absent", loadMore: "absent" },
  },
  { name: "manager-loading", shows: ["loading"], absent: ["title", "empty"], buttons: { approve: "absent" } },
  {
    name: "manager-failed",
    shows: ["loadFailed"],
    absent: ["title", "empty"],
    buttons: { approve: "absent" },
  },
  {
    name: "accountant",
    shows: [],
    absent: ["title", "empty", "loading", "loadFailed", "customer"],
    buttons: { approve: "absent", reject: "absent", execute: "absent" },
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
      "components/accounting/RefundApprovalQueueVisualFixture.test.tsx",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, REFUND_APPROVAL_VISUAL_FIXTURE: "1", REFUND_APPROVAL_VISUAL_FIXTURE_DIR: FIXTURES },
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
      test(`${state.name} · ${locale} · ${viewport.name}px`, async ({ browser }) => {
        const context = await newContainedContext(browser, { viewport: { width: viewport.width, height: viewport.height } });
        const page = await context.newPage();
        try {
          const file = resolve(FIXTURES, `page-${state.name}-${locale}-${viewport.name}.html`);
          writeFileSync(file, documentFor(state.name, locale));
          await page.goto(`file:///${file.replace(/\\/g, "/")}`);

          const dir = locale === "ar" ? "rtl" : "ltr";
          expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(dir);

          for (const key of state.shows) {
            // The reason shares its paragraph with a "Reason:" label, so it matches as a substring.
            await expect(
              page.getByText(LITERAL[key][locale], { exact: key !== "reason" }).first(), `${key} paints`,
            ).toBeVisible();
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
            // A decision control must be fully reachable on a phone, not clipped by the row.
            const box = await first.boundingBox();
            expect(box, `${key} has a box`).not.toBeNull();
            expect(box!.x, `${key} starts inside the viewport`).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width, `${key} ends inside the viewport`).toBeLessThanOrEqual(viewport.width);
          }

          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, "sideways scroll").toBeLessThanOrEqual(0);

          await page.screenshot({
            path: resolve(OUT_DIR, `shot-${state.name}-${locale}-${viewport.name}.png`),
            fullPage: true,
          });
        } finally {
          await context.close();
        }
      });
    }
  }
}
