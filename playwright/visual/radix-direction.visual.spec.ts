import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Browser, type TestInfo } from "@playwright/test";
import { newContainedContext } from "../containedContext";
const ROOT = resolve(__dirname, "../..");
const RUN = resolve(ROOT, "test-results/radix-direction", `run-${Date.now()}-${process.pid}`);
let bundle: string;
let css: string;
test.beforeAll(() => {
  mkdirSync(RUN, { recursive: true });
  execFileSync(process.execPath, [resolve(ROOT, "playwright/visual/fixtures/buildRadixDirection.ts"), RUN], {
    cwd: ROOT, stdio: "inherit", timeout: 120_000,
  });
  bundle = readFileSync(resolve(RUN, "fixture.js"), "utf8");
  css = readFileSync(resolve(RUN, "fixture.css"), "utf8");
});
type Variant = Readonly<{ locale: "ar" | "en"; width: number }>;
async function replay(browser: Browser, testInfo: TestInfo, { locale, width }: Variant) {
  const direction = locale === "ar" ? "rtl" : "ltr";
  const context = await newContainedContext(browser, { viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("**/*", route => {
      const url = route.request().url();
      if (url.endsWith("/fixture.js")) return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle });
      if (url.endsWith("/fixture.css")) return route.fulfill({ contentType: "text/css", body: css });
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    });
    await page.addInitScript(saved => localStorage.setItem("autoflow-locale", saved), locale);
    await page.goto("https://direction.test/vehicle/deposits");
    const trigger = page.getByRole("combobox", { name: locale === "ar" ? "طريقة الدفع" : "Payment Method", exact: true, includeHidden: true });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const popup = page.getByRole("listbox", { name: "", exact: true });
    await expect(popup).toBeVisible();
    await expect(popup).toHaveCSS("opacity", "1");
    expect(await popup.evaluate(element => document.getElementById("root")?.contains(element))).toBe(false);
    const measured = {
      trigger: await trigger.evaluate(element => getComputedStyle(element).direction),
      popup: await popup.evaluate(element => getComputedStyle(element).direction),
    };
    console.log(`DIRECTION ${locale} ${width}: ${JSON.stringify(measured)}`);
    await page.screenshot({ path: testInfo.outputPath("select-open.png") });
    await expect.soft(trigger).toHaveCSS("direction", direction);
    await expect.soft(popup).toHaveCSS("direction", direction);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: locale === "ar" ? "English" : "العربية", exact: true }).click();
    const switched = page.getByRole("combobox", { name: locale === "ar" ? "Payment Method" : "طريقة الدفع", exact: true, includeHidden: true });
    await switched.click();
    const nextDirection = direction === "rtl" ? "ltr" : "rtl";
    await expect.soft(switched).toHaveCSS("direction", nextDirection);
    await expect.soft(page.getByRole("listbox", { name: "", exact: true })).toHaveCSS("direction", nextDirection);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}
test("Arabic Select trigger and portal follow RTL at 1280px", async ({ browser }, info) => { await replay(browser, info, { locale: "ar", width: 1280 }); });
test("Arabic Select trigger and portal follow RTL at 390px", async ({ browser }, info) => { await replay(browser, info, { locale: "ar", width: 390 }); });
test("English Select trigger and portal follow LTR at 1280px", async ({ browser }, info) => { await replay(browser, info, { locale: "en", width: 1280 }); });
test("English Select trigger and portal follow LTR at 390px", async ({ browser }, info) => { await replay(browser, info, { locale: "en", width: 390 }); });
