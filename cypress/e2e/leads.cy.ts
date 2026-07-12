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

          // Customer is a custom SearchableSelect (components/ui/searchable-select.tsx):
          // a plain button trigger that opens a popover with an auto-focused
          // search input and plain <button> results — no ARIA combobox/option
          // roles, so type into whatever's focused rather than locating the input.
          cy.findByRole("button", { name: "Select customer" }).click();
          cy.focused().type(lastName);
          cy.findByRole("button", { name: new RegExp(customerName) }).click();

          cy.findByRole("button", { name: /^(Add Lead|Create Lead)$/ }).click();
        });

        cy.findByText("Lead added successfully").should("be.visible");
      });
    });
  });
});
