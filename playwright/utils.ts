import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { randomInt } from "node:crypto";

/**
 * Every authenticated route is scoped under /{orgId}/... and the QA fixture's
 * orgId isn't known ahead of time, so resolve it once by landing on the
 * role-dependent entry point and reading it back out of the URL.
 */
export async function resolveOrgId(page: Page): Promise<string> {
  const currentOrgRoute = new URL(page.url()).pathname.match(
    /^\/([^/]+)\/(dashboard|sales|leads|accounting|vehicles|customers|expenses)$/,
  );
  if (currentOrgRoute) return currentOrgRoute[1];

  await page.goto("/dashboard");
  await page.waitForURL(/\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/);
  await expect(page.getByRole("banner")).toBeVisible();

  const match = page
    .url()
    .match(/\/([^/]+)\/(dashboard|sales|leads|accounting)/);
  if (!match) {
    throw new Error(`Could not resolve orgId from URL: ${page.url()}`);
  }
  return match[1];
}

export async function gotoOrgRoute(page: Page, path: string): Promise<void> {
  const orgId = await resolveOrgId(page);
  const targetPath = `/${orgId}/${path}`;
  if (new URL(page.url()).pathname === targetPath) return;

  const navLink = page.locator(`a[href="${targetPath}"]`).first();
  if (await navLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await navLink.click();
  } else {
    await page.goto(targetPath);
  }

  await expect(page).toHaveURL((url) => url.pathname === targetPath, {
    timeout: 30_000,
  });
}

/** Unique-ish suffix for test data so repeated CI runs don't collide. */
export function testDataSuffix(): string {
  return `${Date.now()}-${randomInt(0, 10_000)}`;
}

/** 17-character, VIN-safe test identifier: only allowed letters/digits, unique enough for CI. */
function testVin(): string {
  const timePart = Date.now().toString().slice(-10);
  const randomPart = randomInt(0, 10_000).toString().padStart(4, "0");

  return `E2E${timePart}${randomPart}`;
}

export async function searchCurrentTable(
  page: Page,
  searchTerm: string,
): Promise<void> {
  const searchInput = page
    .locator('main input[placeholder^="Search"]:not([readonly])')
    .first();
  await expect(searchInput).toBeVisible();
  await searchInput.fill(searchTerm);
}

export async function expectVisibleTableCell(
  page: Page,
  textOrPattern: string | RegExp,
): Promise<void> {
  await expect(
    page.locator("td").filter({ hasText: textOrPattern }).first(),
  ).toBeVisible();
}

/**
 * Creates a vehicle through the real UI (not the API) so the sales/leads
 * specs always have a fresh, distinctively-named vehicle to select without
 * depleting or depending on whatever real inventory exists in the shared QA
 * org. Returns the model string used, so callers can search for it later.
 */
export async function createVehicle(
  page: Page,
  opts?: { model?: string },
): Promise<{ make: string; model: string; vin: string }> {
  const model = opts?.model ?? `E2E-${testDataSuffix()}`;
  const make = "Playwright";
  const vin = testVin();

  await gotoOrgRoute(page, "vehicles");
  await page.getByRole("button", { name: "Add Vehicle", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Add Vehicle" }),
  ).toBeVisible();

  await dialog.getByPlaceholder("17-character VIN").fill(vin);
  await dialog.getByLabel("Make").fill(make);
  await dialog.getByLabel("Model").fill(model);
  await dialog.getByLabel("Year").fill("2024");
  await dialog.getByLabel("Color").fill("Black");
  await dialog.getByLabel("Mileage").fill("100");
  await dialog.getByLabel("Selling Price (JOD)").fill("15000");

  await dialog
    .getByRole("button", { name: /^(Add Vehicle|Submit for Approval)$/ })
    .click();
  await expect(
    page.getByText(
      /Vehicle added successfully|Creation request submitted for approval/,
    ),
  ).toBeVisible();
  await expect(dialog).not.toBeVisible();

  return { make, model, vin };
}

/** Creates a customer through the real UI. Returns the name used so callers can search for it later. */
export async function createCustomer(
  page: Page,
  opts?: { lastName?: string },
): Promise<{ firstName: string; lastName: string }> {
  const firstName = "Playwright";
  const lastName = opts?.lastName ?? `Tester-${testDataSuffix()}`;

  await gotoOrgRoute(page, "customers");
  await page.getByRole("button", { name: "Add Customer", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Add Customer" }),
  ).toBeVisible();

  await dialog.getByLabel("First Name").fill(firstName);
  await dialog.getByLabel("Last Name").fill(lastName);

  await dialog
    .getByRole("button", { name: "Add Customer", exact: true })
    .click();
  await expect(page.getByText("Customer added successfully")).toBeVisible();

  return { firstName, lastName };
}
