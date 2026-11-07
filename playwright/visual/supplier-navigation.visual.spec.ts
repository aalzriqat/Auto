import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

const ROOT = resolve(__dirname, "../..");
let bundle: string;

test.beforeAll(() => {
  const directory = mkdtempSync(resolve(tmpdir(), "autoflow-supplier-navigation-"));
  const fixture = resolve(directory, "fixture.js");
  // Vite's module graph must not enter the Playwright worker's module loader hooks.
  try {
    execFileSync(process.execPath, [resolve(ROOT, "playwright/visual/fixtures/buildSupplierNavigation.ts"), directory], {
      cwd: ROOT, stdio: "inherit", timeout: 120_000,
    });
    bundle = readFileSync(fixture, "utf8");
  } finally {
    rmSync(fixture, { force: true });
    rmdirSync(directory);
  }
});

async function openSupplierFixture(page: Page, mode: "create" | "edit") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.fulfill(route.request().url().endsWith("/fixture.js")
    ? { contentType: "text/javascript", body: bundle }
    : { contentType: "text/html", body: '<html><body><div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script src="/fixture.js"></script></body></html>' }));
  await page.addInitScript(() => localStorage.setItem("autoflow-locale", "en"));
  await page.goto(`https://supplier.test/suppliers/demo?mode=${mode}`);
  expect(errors).toEqual([]);
}

async function dirtyHistoryCase(page: Page, mode: "create" | "edit") {
  await openSupplierFixture(page, mode);
  if (mode === "edit") await page.getByRole("button", { name: "Edit supplier", exact: true }).click();
  const field = page.getByLabel(mode === "edit" ? "Phone (optional)" : "Display name", { exact: true });
  await field.fill(mode === "edit" ? "0792222222" : "Draft supplier");
  page.once("dialog", dialog => dialog.dismiss());
  await page.evaluate(() => history.back());
  await expect(field).toHaveValue(mode === "edit" ? "0792222222" : "Draft supplier");
  await expect(page).toHaveURL(/\/suppliers\/demo/);
  page.once("dialog", dialog => dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page.getByText("Supplier list reached")).toBeVisible();
}

test("dirty supplier creation survives Back until discard is confirmed", async ({ page }) => { await dirtyHistoryCase(page, "create"); });
test("dirty supplier editing survives Back until discard is confirmed", async ({ page }) => { await dirtyHistoryCase(page, "edit"); });

test("successful supplier creation reaches its statement without a discard prompt", async ({ page }) => {
  await openSupplierFixture(page, "create");
  const prompts: string[] = [];
  page.on("dialog", dialog => { prompts.push(dialog.message()); void dialog.dismiss(); });
  await page.getByLabel("Display name", { exact: true }).fill("New supplier");
  await page.getByRole("button", { name: "Add supplier", exact: true }).click();
  await expect(page.getByText("Supplier statement reached")).toBeVisible();
  await expect(page).toHaveURL(/\/suppliers\/created$/);
  expect(prompts).toEqual([]);
});

test("accepting a supplier candidate link asks once and reaches its statement", async ({ page }) => {
  await openSupplierFixture(page, "create");
  await page.getByLabel("Display name", { exact: true }).fill("Duplicate supplier");
  await page.getByRole("button", { name: "Add supplier", exact: true }).click();
  const prompts: string[] = [];
  page.on("dialog", dialog => { prompts.push(dialog.message()); void dialog.accept(); });
  await page.getByRole("link", { name: "Open existing supplier", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByText("Supplier statement reached")).toBeVisible();
  await expect(page).toHaveURL(/\/suppliers\/existing$/);
  expect(prompts).toEqual([]);
});


