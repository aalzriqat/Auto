import { createCustomer, gotoOrgRoute } from "../support/utils";

describe("leads", () => {
  beforeEach(() => {
    cy.login();
  });

  it("can create a lead tied to a customer", () => {
    createCustomer().then(({ firstName, lastName }) => {
      const customerName = `${firstName} ${lastName}`;

      gotoOrgRoute("leads");
      cy.findByRole("button", { name: "Add Lead" }).click();

      cy.findByRole("dialog").within(() => {
        cy.findByText("Add Lead").should("be.visible");

        // Customer is a custom SearchableSelect (components/ui/searchable-select.tsx):
        // a plain button trigger that opens a popover with an auto-focused
        // search input and plain <button> results — no ARIA combobox/option
        // roles, so type into whatever's focused rather than locating the input.
        cy.findByRole("button", { name: "Select a customer" }).click();
        cy.focused().type(lastName);
        cy.findByRole("button", { name: new RegExp(customerName) }).click();

        cy.findByRole("button", { name: "Create Lead" }).click();
      });

      cy.findByText("Lead added successfully").should("be.visible");
    });
  });
});
