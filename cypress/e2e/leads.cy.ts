import { createCustomer, gotoOrgRoute } from "../support/utils";

describe("leads", () => {
  beforeEach(() => {
    cy.login();
  });

  it("can create a lead tied to a customer", () => {
    createCustomer().then(({ firstName, lastName }) => {
      const customerName = `${firstName} ${lastName}`;

      gotoOrgRoute("leads").then(() => {
        cy.findByRole("button", { name: "Add Lead" }).click();

        cy.findByRole("dialog").within(() => {
          cy.findByRole("heading", { name: "Add Lead" }).should("be.visible");

          cy.findByRole("button", { name: "Select customer" }).click();
          cy.get('input[placeholder^="Search"]').first().clear().type(lastName);
          cy.findByRole("button", { name: new RegExp(customerName) })
            .should("be.visible")
            .click();

          cy.findByRole("button", { name: /^(Add Lead|Create Lead)$/ }).click();
        });

        cy.findByText("Lead added successfully").should("be.visible");
      });
    });
  });
});
