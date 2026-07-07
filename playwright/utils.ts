import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Every authenticated route is scoped under /{orgId}/... and the QA fixture's
 * orgId isn't known ahead of time, so resolve it once by landing on the
 * role-dependent entry point and reading it back out of the URL.
 */
export async function resolveOrgId(page: Page): Promise<string> {
  await page.goto("/dashboard");
  await page.waitForURL(/\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/);
  const match = page.url().match(/\/([^/]+)\/(dashboard|sales|leads|accounting)/);
  if (!match) {
    throw new Error(`Could not resolve orgId from URL: ${page.url()}`);
  }
  return match[1];
}

export async function gotoOrgRoute(page: Page, path: string): Promise<void> {
  const orgId = await resolveOrgId(page);
  await page.goto(`/${orgId}/${path}`);
}

/** Unique-ish suffix for test data so repeated CI runs don't collide. */
export function testDataSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

/**
 * Creates a vehicle through the real UI (not the API) so the sales/leads
 * specs always have a fresh, distinctively-named vehicle to select without
 * depleting or depending on whatever real inventory exists in the shared QA
 * org. Returns the model string used, so callers can search for it later.
 */
export async function createVehicle(page: Page, opts?: { model?: string }): Promise<{ make: string; model: string }> {
  const model = opts?.model ?? `E2E-${testDataSuffix()}`;
  const make = "Playwright";

  await gotoOrgRoute(page, "vehicles");
  await page.getByRole("button", { name: "Add Vehicle", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Add Vehicle")).toBeVisible();

  await dialog.getByLabel("Make").fill(make);
  await dialog.getByLabel("Model").fill(model);
  await dialog.getByLabel("Year").fill("2024");
  await dialog.getByLabel("Color").fill("Black");
  await dialog.getByLabel("Mileage").fill("100");
  await dialog.getByLabel("Selling Price (JOD)").fill("15000");

  await dialog.getByRole("button", { name: /^(Add Vehicle|Submit for Approval)$/ }).click();
  await expect(page.getByText(/Vehicle added successfully|Creation request submitted for approval/)).toBeVisible();

  return { make, model };
}

/** Creates a customer through the real UI. Returns the name used so callers can search for it later. */
export async function createCustomer(page: Page, opts?: { lastName?: string }): Promise<{ firstName: string; lastName: string }> {
  const firstName = "Playwright";
  const lastName = opts?.lastName ?? `Tester-${testDataSuffix()}`;

  await gotoOrgRoute(page, "customers");
  await page.getByRole("button", { name: "Add Customer", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Add Customer")).toBeVisible();

  await dialog.getByLabel("First Name").fill(firstName);
  await dialog.getByLabel("Last Name").fill(lastName);

  await dialog.getByRole("button", { name: "Add Customer", exact: true }).click();
  await expect(page.getByText("Customer added successfully")).toBeVisible();

  return { firstName, lastName };
}
