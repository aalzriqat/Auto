import { createVehicle } from "../support/utils";

describe("vehicles", () => {
  beforeEach(() => {
    cy.login();
  });

  it("can add a new vehicle to inventory and see it in the list", () => {
    createVehicle().then(({ model }) => {
      // The vehicles list is a live Convex query — the new row should appear
      // without a manual reload once the dialog closes.
      cy.findAllByText(model).should(($matches) => {
        expect($matches.filter(":visible").length).to.be.greaterThan(0);
      });
    });
  });
});
