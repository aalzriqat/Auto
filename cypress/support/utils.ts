/// <reference types="cypress" />

/** Unique-ish suffix for test data so repeated CI runs don't collide. */
export function testDataSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

/**
 * Every authenticated route is scoped under /{orgId}/... and the QA fixture's
 * orgId isn't known ahead of time, so resolve it once by landing on the
 * role-dependent entry point and reading it back out of the URL.
 */
export function gotoOrgRoute(path: string): void {
  cy.visit("/dashboard");
  cy.url({ timeout: 30_000 })
    .should("match", /\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/)
    .then((url) => {
      const match = url.match(/\/([^/]+)\/(dashboard|sales|leads|accounting)/);
      if (!match) throw new Error(`Could not resolve orgId from URL: ${url}`);
      cy.visit(`/${match[1]}/${path}`);
    });
}

/**
 * Creates a vehicle through the real UI (not the API) so the sales/leads
 * specs always have a fresh, distinctively-named vehicle to select without
 * depleting or depending on whatever real inventory exists in the shared QA
 * org. Yields the model string used, so callers can search for it later.
 */
export function createVehicle(modelOverride?: string): Cypress.Chainable<{ make: string; model: string }> {
  const model = modelOverride ?? `E2E-${testDataSuffix()}`;
  const make = "Playwright";

  gotoOrgRoute("vehicles");
  cy.findByRole("button", { name: "Add Vehicle" }).click();

  return cy.findByRole("dialog").within(() => {
    cy.findByText("Add Vehicle").should("be.visible");
    cy.findByLabelText("Make").type(make);
    cy.findByLabelText("Model").type(model);
    cy.findByLabelText("Year").clear().type("2024");
    cy.findByLabelText("Color").type("Black");
    cy.findByLabelText("Mileage").clear().type("100");
    cy.findByLabelText("Selling Price (JOD)").type("15000");
    cy.findByRole("button", { name: /^(Add Vehicle|Submit for Approval)$/ }).click();
  }).then(() => {
    cy.findByText(/Vehicle added successfully|Creation request submitted for approval/).should("be.visible");
    return { make, model };
  });
}

/** Creates a customer through the real UI. Yields the name used so callers can search for it later. */
export function createCustomer(lastNameOverride?: string): Cypress.Chainable<{ firstName: string; lastName: string }> {
  const firstName = "Playwright";
  const lastName = lastNameOverride ?? `Tester-${testDataSuffix()}`;

  gotoOrgRoute("customers");
  cy.findByRole("button", { name: "Add Customer" }).click();

  return cy.findByRole("dialog").within(() => {
    cy.findByText("Add Customer").should("be.visible");
    cy.findByLabelText("First Name").type(firstName);
    cy.findByLabelText("Last Name").type(lastName);
    cy.findByRole("button", { name: "Add Customer" }).click();
  }).then(() => {
    cy.findByText("Customer added successfully").should("be.visible");
    return { firstName, lastName };
  });
}
