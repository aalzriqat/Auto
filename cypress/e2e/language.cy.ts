describe("language switcher", () => {
  beforeEach(() => {
    cy.login();
  });

  it("switching to Arabic flips the document to RTL", () => {
    cy.visit("/dashboard");
    cy.url({ timeout: 15_000 }).should("match", /\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/);

    // The saved session forces English (autoflow-locale=en), so we start on
    // "EN" and toggle to Arabic. LanguageSwitcher's accessible name is just
    // the locale code — the "Switch Language" text is a tooltip (title
    // attribute), not the button's name.
    cy.findByRole("button", { name: /^(EN|AR)$/ }).as("toggle");
    cy.get("@toggle").should("have.text", "EN");

    cy.get("@toggle").click();

    cy.get("@toggle").should("have.text", "AR");
    cy.get("html").should("have.attr", "dir", "rtl");
    cy.get("html").should("have.attr", "lang", "ar");
  });
});
