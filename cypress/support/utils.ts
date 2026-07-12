/// <reference types="cypress" />

/** Unique-ish suffix for test data so repeated CI runs don't collide. */
export function testDataSuffix(): string {
  return `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0] % 10_000}`;
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

/**
 * Creates a vehicle through the real UI (not the API) so the sales/leads
 * specs always have a fresh, distinctively-named vehicle to select without
 * depleting or depending on whatever real inventory exists in the shared QA
 * org. Yields the model string used, so callers can search for it later.
 */
export function createVehicle(
  modelOverride?: string,
): Cypress.Chainable<{ make: string; model: string }> {
  const model = modelOverride ?? `E2E-${testDataSuffix()}`;
  const make = "Playwright";

  return gotoOrgRoute("vehicles").then(() => {
    cy.findByRole("button", { name: "Add Vehicle" }).click();

    return cy
      .findByRole("dialog")
      .within(() => {
        cy.findByRole("heading", { name: "Add Vehicle" }).should("be.visible");
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
          .then(() => ({ make, model }));
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
          .then(() => ({ firstName, lastName }));
      });
  });
}
