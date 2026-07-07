describe("dashboard landing", () => {
  beforeEach(() => {
    cy.login();
  });

  it("a signed-in user lands on an authenticated org route with the top nav visible", () => {
    cy.visit("/dashboard");

    // Role-dependent: owners land on /{orgId}/dashboard, other roles get
    // bounced to their own section (sales/leads/accounting) by OrgProvider.
    cy.url({ timeout: 15_000 }).should("match", /\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/);
    cy.findByRole("banner").should("be.visible");
  });
});
