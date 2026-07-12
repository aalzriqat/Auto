import { gotoOrgRoute, testDataSuffix } from "../support/utils";

describe("expenses", () => {
  beforeEach(() => {
    cy.login();
  });

  it("can record a new operational expense", () => {
    const title = `Cypress test expense ${testDataSuffix()}`;

    gotoOrgRoute("expenses").then(() => {
      cy.findByRole("button", { name: "Record Expense" }).click();

      cy.findByRole("dialog").within(() => {
        cy.findByText("Record Expense").should("be.visible");

        // Date/category/status/payment-method all have valid defaults
        // (today / OTHER / PAID / CASH) — only title and amount are required.
        cy.findByLabelText("Title / Description").type(title);
        cy.findByLabelText("Amount ($)").type("42");

        cy.findByRole("button", { name: "Record Expense" }).click();
      });

      cy.findByText("Expense recorded successfully!").should("be.visible");
    });
  });
});
