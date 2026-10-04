import { test, expect, type Page } from "@playwright/test";
import { resolveOrgId } from "../utils";

/**
 * A cheap check on every screen (SCRUM-595): open each dashboard route,
 * read-only, at desktop and phone width, and fail on what a user would see as
 * broken — an uncaught exception, the error boundary, or a raw `NaN` /
 * `undefined` / `[object Object]` rendered as text. Horizontal overflow at
 * phone width is recorded as an annotation, not a failure.
 *
 * It only navigates; it never clicks. That is not strictly read-only: like any
 * signed-in visit, the dashboard's mount effects still run — e.g.
 * FloatingMessenger marks incoming direct messages delivered
 * (`directMessages.markDelivered`). Run it only against QA data on a
 * disposable preview or localhost, never production.
 */

const ROUTES = [
  "dashboard",
  "accounting",
  "applications",
  "approvals",
  "commissions",
  "customers",
  "deals",
  "expenses",
  "leads",
  "marketplace/requests",
  "messages",
  "notifications",
  "payroll",
  "reports",
  "sales",
  "sales/sales",
  "settings/billing",
  "settings/branches",
  "settings/commission",
  "settings/custom-fields",
  "settings/feedback",
  "settings/finance",
  "settings/general",
  "settings/integrations",
  "settings/lead-sources",
  "settings/marketplace",
  "settings/pipeline",
  "settings/valuation-companies",
  "settings/website",
  "social-inbox",
  "sourcing",
  "tasks",
  "team",
  "vehicles",
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 375, height: 812 },
];

const BROKEN_TEXT = /\bNaN\b|\bundefined\b|\[object Object\]/;
const ERROR_BOUNDARY = /Something went wrong|Application error|حدث خطأ ما/i;

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  // Convex keeps a websocket open, so "networkidle" never comes. Wait for the
  // loading skeletons to go, bounded.
  await page
    .locator('[aria-busy="true"], [data-loading="true"]')
    .first()
    .waitFor({ state: "detached", timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(1_500);
}

/**
 * Document scrollWidth alone misses overflow the app shell clips (overflow-x
 * hidden, or an inner scrolling pane). Measure content instead: text, controls
 * and media past the viewport edge that no horizontally scrollable ancestor
 * lets the user reach. Text-less decoration (glows, gradients) is ignored.
 */
async function findCutOffContent(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const reachable = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth) return true;
      }
      return false;
    };
    const isContent = (el: Element): boolean =>
      /^(a|button|input|select|textarea|img|svg|video|canvas)$/i.test(el.tagName) ||
      Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (!isContent(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
      if (getComputedStyle(el).visibility === "hidden" || reachable(el)) continue;
      const label = el.getAttribute("data-testid") || el.getAttribute("aria-label") || (el.textContent ?? "").trim().slice(0, 30);
      out.push(`${el.tagName.toLowerCase()}[${label}] +${Math.round(r.right - vw)}px`);
      if (out.length >= 5) break;
    }
    return { doc: document.documentElement.scrollWidth - vw, out };
  });
}

test.describe("screen audit: the cut-off detector itself", () => {
  // Positive control: a detector that never fires proves nothing.
  test("flags content pushed past a 375px viewport, ignores scrollable and decorative overflow", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.setContent(`
      <body style="margin:0;overflow-x:hidden">
        <p id="cut" style="width:600px">QA-OVERFLOW-CONTROL</p>
        <div style="overflow-x:auto;width:375px"><p style="width:600px">scrollable-table</p></div>
        <div style="position:relative;overflow:hidden;width:375px;height:40px">
          <div style="position:absolute;left:300px;width:200px;height:40px;background:red"></div>
        </div>
      </body>`);
    const found = await findCutOffContent(page);
    expect(found.out.join("; ")).toContain("QA-OVERFLOW-CONTROL");
    expect(found.out.join("; ")).not.toContain("scrollable-table");
    expect(found.out).toHaveLength(1);
  });
});

test.describe("screen audit: every dashboard screen renders without visible breakage", () => {
  test.describe.configure({ timeout: 120_000 });

  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      test(`${viewport.name} /${route}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const orgId = await resolveOrgId(page);
        const uncaught: string[] = [];
        page.on("pageerror", (e) => uncaught.push(e.message));

        const response = await page.goto(`/${orgId}/${route}`);
        expect(response?.status() ?? 200, `HTTP status for /${route}`).toBeLessThan(400);
        await settle(page);

        await page.screenshot({
          path: test.info().outputPath(`${viewport.name}-${route.replace(/\//g, "_")}.png`),
          fullPage: true,
        });

        const text = await page.locator("main, body").first().innerText();
        expect(uncaught, `uncaught exceptions on /${route}`).toEqual([]);
        expect(text, `error boundary on /${route}`).not.toMatch(ERROR_BOUNDARY);
        const broken = text.match(BROKEN_TEXT);
        expect(broken?.[0] ?? null, `raw value rendered as text on /${route}`).toBeNull();

        if (viewport.name === "phone") {
          const offenders = await findCutOffContent(page);
          if (offenders.doc > 1 || offenders.out.length > 0) {
            test.info().annotations.push({
              type: "advisory",
              description: `/${route} at 375px: document overflow ${offenders.doc}px; unreachable: ${offenders.out.join("; ") || "none"}`,
            });
          }
        }
      });
    }
  }
});
