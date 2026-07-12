describe("language switcher", () => {
  beforeEach(() => {
    cy.login();
  });

  it("switching to Arabic flips the document to RTL", () => {
    cy.visit("/dashboard");
    cy.url({ timeout: 15_000 }).should(
      "match",
      /\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/,
    );

    // The saved session forces English (autoflow-locale=en), so we start on
    // "en" and toggle to Arabic. CSS uppercases the rendered label, but the
    // accessible name and DOM text remain the lowercase locale code.
    cy.findByRole("button", { name: /^(en|ar)$/i }).as("toggle");
    cy.get("@toggle").should(($button) => {
      expect($button.text().trim().toLowerCase()).to.eq("en");
    });

    cy.get("@toggle").click();

    cy.get("@toggle").should(($button) => {
      expect($button.text().trim().toLowerCase()).to.eq("ar");
    });
    cy.get("html").should("have.attr", "dir", "rtl");
    cy.get("html").should("have.attr", "lang", "ar");
  });
});
