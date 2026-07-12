import { createCustomer, expectVisibleTableCell } from "../support/utils";

describe("customers", () => {
  beforeEach(() => {
    cy.login();
  });

  it("can create a new customer and see it in the list", () => {
    createCustomer().then(({ firstName, lastName }) => {
      expectVisibleTableCell(new RegExp(`${firstName}\\s+${lastName}`));
    });
  });
});
