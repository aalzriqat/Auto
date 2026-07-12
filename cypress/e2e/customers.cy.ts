import { createCustomer } from "../support/utils";

describe("customers", () => {
  beforeEach(() => {
    cy.login();
  });

  it("can create a new customer and see it in the list", () => {
    createCustomer().then(({ firstName, lastName }) => {
      cy.findAllByText(`${firstName} ${lastName}`).should(($matches) => {
        expect($matches.filter(":visible").length).to.be.greaterThan(0);
      });
    });
  });
});
