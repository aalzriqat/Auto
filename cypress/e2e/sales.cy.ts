import { createVehicle, gotoOrgRoute, testDataSuffix } from "../support/utils";

describe("sales", () => {
  beforeEach(() => {
    cy.login();
  });

  it("can record a cash sale end to end via the sales wizard", () => {
    // Self-contained: creates its own vehicle+customer rather than picking
    // from whatever real inventory exists in the shared QA org, so this test
    // never depletes stock and never depends on other specs' run order.
    createVehicle().then(({ model }) => {
      const lastName = `Buyer-${testDataSuffix()}`;

      gotoOrgRoute("sales");
      cy.get("#btn-new-cash-sale").click();

      // Step 1 — vehicle + price
      cy.findByRole("button", { name: /Select an available vehicle/ }).click();
      cy.focused().type(model);
      cy.findByRole("button", { name: new RegExp(model) }).click();
      cy.findByRole("button", { name: "Next" }).click();

      // Step 2 — customer (inline create form uses hard-coded English
      // labels, not t(), so these are stable regardless of app locale)
      cy.findByRole("button", { name: "Create a new customer" }).click();
      cy.findByLabelText("First Name").type("Cypress");
      cy.findByLabelText("Last Name").type(lastName);
      cy.findByRole("button", { name: "Create & Select" }).click();
      cy.findByRole("button", { name: "Next" }).click();

      // Step 3 — review + generate the quote (this only creates a Quote
      // row, not a Sale yet — completeFromQuote below is what sells it)
      cy.findByRole("button", { name: "Generate Quote" }).click();
      cy.findByText("Quote generated and saved!").should("be.visible");

      // Step 4 — complete the sale. "Done & Close" alone (as the old
      // TestSprite-generated TC009 script did) only closes the wizard after
      // a quote — it never calls sales.completeFromQuote, so no sale is
      // actually recorded unless "Submit Sale" is clicked.
      cy.findByText("Quote Generated Successfully!").should("be.visible");
      cy.findByRole("button", { name: "Submit Sale" }).click();

      cy.findByText("Cash sale completed successfully").should("be.visible");
      cy.findByRole("link", { name: "Sale Completed ✓" }).should("be.visible");
    });
  });
});
