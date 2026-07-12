import { createVehicle, expectVisibleTableCell } from "../support/utils";

describe("vehicles", () => {
  beforeEach(() => {
    cy.login();
  });

  it("can add a new vehicle to inventory and see it in the list", () => {
    createVehicle().then(({ model }) => {
      cy.get('input[placeholder^="Search"]:not([readonly])')
        .first()
        .clear()
        .type(model);
      expectVisibleTableCell(model);
    });
  });
});
