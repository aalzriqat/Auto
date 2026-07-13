/// <reference types="cypress" />
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

let testDataCounter = 0;
const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const CLERK_CONVEX_TOKEN_TIMEOUT_MS = 30_000;
const CLERK_CONVEX_TOKEN_RETRY_MS = 500;

type PublishedDealerWebsite = {
  orgId: Id<"organizations">;
  host: string;
  vehicleModel: string;
  vehicleSlug: string;
};

type ClerkWindow = Window & {
  Clerk?: {
    loaded?: Promise<unknown>;
    session?: {
      getToken: (options?: { template?: string }) => Promise<string | null>;
    };
  };
};

function nextTestDataCounter(): number {
  testDataCounter += 1;
  if (testDataCounter > 9_999) testDataCounter = 1;
  return testDataCounter;
}

/** Unique-ish suffix for test data so repeated CI runs don't collide. */
export function testDataSuffix(): string {
  return `${Date.now()}-${nextTestDataCounter()}`;
}

/** 17-character, VIN-safe test identifier: only allowed letters/digits, unique enough for CI. */
function testVin(): string {
  const timePart = Date.now().toString().slice(-10);
  const counterPart = nextTestDataCounter().toString().padStart(4, "0");

  return `E2E${timePart}${counterPart}`;
}

async function readClerkConvexToken(win: Window): Promise<string | null> {
  const clerk = (win as ClerkWindow).Clerk;
  if (clerk?.loaded) await clerk.loaded;

  return (await clerk?.session?.getToken({ template: "convex" })) ?? null;
}

function waitForClerkConvexToken(
  startedAt = Date.now(),
): Cypress.Chainable<string> {
  return cy
    .window({ log: false })
    .then((win) => readClerkConvexToken(win))
    .then((token) => {
      if (token) return token;

      if (Date.now() - startedAt >= CLERK_CONVEX_TOKEN_TIMEOUT_MS) {
        throw new Error(
          "Unable to read Clerk Convex token from the authenticated browser session.",
        );
      }

      return cy
        .wait(CLERK_CONVEX_TOKEN_RETRY_MS, { log: false })
        .then(() => waitForClerkConvexToken(startedAt));
    }) as Cypress.Chainable<string>;
}

function getConvexClient(): Cypress.Chainable<ConvexHttpClient> {
  const convexUrl = Cypress.env("NEXT_PUBLIC_CONVEX_URL") as string | undefined;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL must be set to seed dealer-site E2E data.");
  }

  return waitForClerkConvexToken().then((token) => {
    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(token);
    return client;
  });
}

function waitForPublishedVehicle(
  client: ConvexHttpClient,
  host: string,
  vehicleModel: string,
): Cypress.Chainable<{ slug: string }> {
  return cy.then(async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const site = await client.query(api.websites.resolveDomain, { host });
      const vehicle = site?.vehicles.find(
        (item: { model: string; slug: string }) => item.model === vehicleModel,
      );
      if (vehicle) return { slug: vehicle.slug };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Published dealer site did not include ${vehicleModel}.`);
  });
}

export function ensurePublishedDealerWebsite(): Cypress.Chainable<PublishedDealerWebsite> {
  return gotoOrgRoute("dashboard").then((orgId) => {
    return getConvexClient().then((client) => {
      const suffix = `${Date.now().toString(36)}-${nextTestDataCounter().toString(36)}`;
      const subdomainSlug = `e2e-${suffix}`;
      const host = `${subdomainSlug}.autoflowdealer.com`;
      const vehicleModel = `DealerSite-${suffix}`;

      return cy
        .wrap(client.mutation(api.websites.startSetup, { orgId: orgId as Id<"organizations"> }), {
          log: false,
        })
        .then(() =>
          cy.wrap(
            client.mutation(api.vehicles.create, {
              orgId: orgId as Id<"organizations">,
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
            }),
            { log: false },
          ),
        )
        .then(() =>
          cy.wrap(
            client.mutation(api.websites.saveDraft, {
              orgId: orgId as Id<"organizations">,
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
            }),
            { log: false },
          ),
        )
        .then(() =>
          cy.wrap(client.mutation(api.websites.publish, { orgId: orgId as Id<"organizations"> }), {
            log: false,
          }),
        )
        .then(() => waitForPublishedVehicle(client, host, vehicleModel))
        .then(({ slug }) => ({
          orgId: orgId as Id<"organizations">,
          host,
          vehicleModel,
          vehicleSlug: slug,
        }));
    });
  });
}

export function ensureTurnstileToken(): Cypress.Chainable<JQuery<HTMLFormElement>> {
  return cy.get("form").first().then(($form) => {
    const formElement = $form.get(0) as HTMLFormElement;
    const input = $form.find('input[name="cf-turnstile-response"]') as unknown as JQuery<HTMLInputElement>;
    if (input.length > 0 && input.val()) {
      return cy.wrap($form as JQuery<HTMLFormElement>);
    }

    let tokenInput: HTMLInputElement | undefined = input.get(0);
    if (!tokenInput) {
      tokenInput = document.createElement("input");
      tokenInput.type = "hidden";
      tokenInput.name = "cf-turnstile-response";
      formElement.appendChild(tokenInput);
    }
    tokenInput.value = TURNSTILE_DUMMY_TOKEN;
    return cy.wrap($form as JQuery<HTMLFormElement>);
  });
}

/**
 * Every authenticated route is scoped under /{orgId}/... and the QA fixture's
 * orgId isn't known ahead of time, so resolve it once by landing on the
 * role-dependent entry point and reading it back out of the URL.
 */
export function gotoOrgRoute(path: string): Cypress.Chainable<string> {
  return cy
    .visit("/dashboard")
    .then(() => cy.location("pathname", { timeout: 30_000 }))
    .should("match", /^\/[^/]+\/(dashboard|sales|leads|accounting)$/)
    .then((pathname) => {
      const match = pathname.match(
        /^\/([^/]+)\/(dashboard|sales|leads|accounting)$/,
      );
      if (!match)
        throw new Error(`Could not resolve orgId from path: ${pathname}`);

      const orgId = match[1];
      const targetPath = `/${orgId}/${path}`;

      return cy
        .visit(targetPath)
        .then(() => cy.location("pathname", { timeout: 30_000 }))
        .should("eq", targetPath)
        .then(() => orgId);
    });
}

export function expectVisibleTableCell(
  textOrPattern: string | RegExp,
): Cypress.Chainable<JQuery<HTMLBodyElement>> {
  const maxAttempts = 60;
  const maxLoadMoreClicks = 20;
  const retryDelayMs = 250;
  const matches =
    typeof textOrPattern === "string"
      ? (text: string) => text.includes(textOrPattern)
      : (text: string) => textOrPattern.test(text);

  function findLoadedCell(
    attempt = 0,
    loadMoreClicks = 0,
  ): Cypress.Chainable<JQuery<HTMLBodyElement>> {
    return cy.get("body").then(($body): void => {
      const matchingCells = $body.find("td").filter((_, cell) => {
        const normalizedText = Cypress.$(cell).text().replace(/\s+/g, " ");
        return matches(normalizedText);
      });

      if (matchingCells.length > 0) {
        const rect = matchingCells[0].getBoundingClientRect();

        expect(rect.width).to.be.greaterThan(0);
        expect(rect.height).to.be.greaterThan(0);
        return;
      }

      const loadMoreButton = $body.find("button").filter((_, button) => {
        const $button = Cypress.$(button);
        return (
          /load more/i.test($button.text()) &&
          $button.is(":visible") &&
          !$button.is(":disabled")
        );
      });

      if (loadMoreButton.length > 0 && loadMoreClicks < maxLoadMoreClicks) {
        cy.wrap(loadMoreButton.first()).click();
        cy.wait(retryDelayMs);
        findLoadedCell(attempt + 1, loadMoreClicks + 1);
        return;
      }

      if (attempt < maxAttempts) {
        cy.wait(retryDelayMs);
        findLoadedCell(attempt + 1, loadMoreClicks);
        return;
      }

      throw new Error(
        `Could not find a visible table cell matching ${textOrPattern.toString()}`,
      );
    });
  }

  return findLoadedCell();
}

/**
 * Creates a vehicle through the real UI (not the API) so the sales/leads
 * specs always have a fresh, distinctively-named vehicle to select without
 * depleting or depending on whatever real inventory exists in the shared QA
 * org. Yields the model string used, so callers can search for it later.
 */
export function createVehicle(
  modelOverride?: string,
): Cypress.Chainable<{ make: string; model: string; vin: string }> {
  const model = modelOverride ?? `E2E-${testDataSuffix()}`;
  const make = "Playwright";
  const vin = testVin();

  return gotoOrgRoute("vehicles").then(() => {
    cy.findByRole("button", { name: "Add Vehicle" }).click();

    return cy
      .findByRole("dialog")
      .within(() => {
        cy.findByRole("heading", { name: "Add Vehicle" }).should("be.visible");
        cy.findByPlaceholderText("17-character VIN").type(vin);
        cy.findByLabelText(/^Make\b/).type(make);
        cy.findByLabelText(/^Model\b/).type(model);
        cy.findByLabelText(/^Year\b/)
          .clear()
          .type("2024");
        cy.findByLabelText(/^Color\b/).type("Black");
        cy.findByLabelText(/^Mileage\b/)
          .clear()
          .type("100");
        cy.findByLabelText(/^Selling Price \(JOD\)/).type("15000");
        cy.findByRole("button", {
          name: /^(Add Vehicle|Submit for Approval)$/,
        }).click();
      })
      .then(() => {
        return cy
          .findByText(
            /Vehicle added successfully|Creation request submitted for approval/,
          )
          .should("be.visible")
          .then(() => cy.findByRole("dialog").should("not.exist"))
          .then(() => ({ make, model, vin }));
      });
  });
}

/** Creates a customer through the real UI. Yields the name used so callers can search for it later. */
export function createCustomer(
  lastNameOverride?: string,
): Cypress.Chainable<{ firstName: string; lastName: string }> {
  const firstName = "Playwright";
  const lastName = lastNameOverride ?? `Tester-${testDataSuffix()}`;

  return gotoOrgRoute("customers").then(() => {
    cy.findByRole("button", { name: "Add Customer" }).click();

    return cy
      .findByRole("dialog")
      .within(() => {
        cy.findByRole("heading", { name: "Add Customer" }).should("be.visible");
        cy.findByLabelText(/^First Name\b/).type(firstName);
        cy.findByLabelText(/^Last Name\b/).type(lastName);
        cy.findByRole("button", { name: "Add Customer" }).click();
      })
      .then(() => {
        return cy
          .findByText("Customer added successfully")
          .should("be.visible")
          .then(() => cy.findByRole("dialog").should("not.exist"))
          .then(() => ({ firstName, lastName }));
      });
  });
}
