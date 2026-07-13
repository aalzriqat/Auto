import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { randomInt } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const CLERK_CONVEX_TOKEN_TIMEOUT_MS = 30_000;

type ClerkWindow = Window & {
  Clerk?: {
    loaded?: Promise<unknown>;
    session?: {
      getToken: (options?: { template?: string }) => Promise<string | null>;
    };
  };
};

export type PublishedDealerWebsite = {
  orgId: Id<"organizations">;
  host: string;
  vehicleModel: string;
  vehicleSlug: string;
};

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

async function authenticatedConvexClient(page: Page): Promise<ConvexHttpClient> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL must be set to seed dealer-site E2E data.");
  }

  await page.waitForFunction(
    () => Boolean((window as ClerkWindow).Clerk?.session?.getToken),
    undefined,
    { timeout: 15_000 },
  );
  const token = await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const clerk = (window as ClerkWindow).Clerk;
          if (clerk?.loaded) await clerk.loaded;
          return (await clerk?.session?.getToken({ template: "convex" })) ?? null;
        }),
      { timeout: CLERK_CONVEX_TOKEN_TIMEOUT_MS },
    )
    .not.toBeNull()
    .then(() =>
      page.evaluate(async () => {
        const clerk = (window as ClerkWindow).Clerk;
        return (await clerk?.session?.getToken({ template: "convex" })) ?? null;
      }),
    );
  if (!token) throw new Error("Unable to read Clerk Convex token from the authenticated browser session.");

  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  return client;
}

export async function ensurePublishedDealerWebsite(
  page: Page,
): Promise<PublishedDealerWebsite> {
  const orgId = (await resolveOrgId(page)) as Id<"organizations">;
  const client = await authenticatedConvexClient(page);
  const suffix = `${Date.now().toString(36)}-${randomInt(0, 10_000).toString(36)}`;
  const subdomainSlug = `e2e-${suffix}`;
  const host = `${subdomainSlug}.autoflowdealer.com`;
  const vehicleModel = `DealerSite-${suffix}`;

  await client.mutation(api.websites.startSetup, { orgId });
  await client.mutation(api.vehicles.create, {
    orgId,
    vin: testVin(),
    make: "Public",
    model: vehicleModel,
    year: 2024,
    mileage: 100,
    color: "Silver",
    fuelType: "Gasoline",
    transmission: "Automatic",
    sellingPrice: 25_000,
    status: "AVAILABLE",
    sourceType: "STOCK",
  });
  await client.mutation(api.websites.saveDraft, {
    orgId,
    subdomainSlug,
    templateId: "modern-showroom",
    defaultLanguage: "en",
    supportedLanguages: ["en", "ar"],
    heroTitle: "E2E public inventory",
    heroSubtitle: "Browser-tested public lead forms.",
    sections: [
      { sectionKey: "forms.contact", enabled: true },
      { sectionKey: "forms.financing", enabled: true },
      { sectionKey: "forms.vehicleInquiry", enabled: true },
      { sectionKey: "inventory.availableVehicles", enabled: true },
      { sectionKey: "vehicle.makeModelYear", enabled: true },
      { sectionKey: "vehicle.price", enabled: true },
    ],
  });
  await client.mutation(api.websites.publish, { orgId });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const site = await client.query(api.websites.resolveDomain, { host });
    const vehicle = site?.vehicles.find(
      (item: { model: string; slug: string }) => item.model === vehicleModel,
    );
    if (vehicle) {
      return { orgId, host, vehicleModel, vehicleSlug: vehicle.slug };
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Published dealer site did not include ${vehicleModel}.`);
}

export async function ensureTurnstileToken(form: Locator): Promise<void> {
  const tokenInput = form.locator('input[name="cf-turnstile-response"]').first();
  const hasGeneratedToken = await expect
    .poll(
      async () => {
        if ((await tokenInput.count()) === 0) return "";
        return await tokenInput.inputValue().catch(() => "");
      },
      { timeout: 15_000 },
    )
    .not.toBe("")
    .then(
      () => true,
      () => false,
    );

  if (hasGeneratedToken) return;

  await form.evaluate((formElement, token) => {
    let input = formElement.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = "cf-turnstile-response";
      formElement.appendChild(input);
    }
    input.value = token;
  }, TURNSTILE_DUMMY_TOKEN);
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
