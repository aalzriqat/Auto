/// <reference types="cypress" />
import "@testing-library/cypress/add-commands";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      login(): Chainable<void>;
    }
  }
}

/**
 * Signs in against Clerk's hosted <SignIn/> using the same QA fixture and
 * field ids proven to work by the existing TestSprite-generated scripts
 * (testsprite_tests/TC001_*.py, TC009_*.py): #identifier-field,
 * #password-field, then a "Continue" button. Cached per spec run via
 * cy.session so only the first test actually drives the sign-in form.
 * Forces English locale via onBeforeLoad — LanguageProvider defaults to
 * Arabic/RTL on an empty localStorage, and cy.session persists that
 * localStorage snapshot into every restored session otherwise.
 */
Cypress.Commands.add("login", () => {
  const user = Cypress.env("E2E_LOGIN_USER") as string | undefined;
  const password = Cypress.env("E2E_LOGIN_PASSWORD") as string | undefined;
  if (!user || !password) {
    throw new Error("CYPRESS_E2E_LOGIN_USER and CYPRESS_E2E_LOGIN_PASSWORD must be set to run the E2E suite.");
  }

  cy.session(
    "autoflow-qa-session",
    () => {
      cy.visit("/sign-in", {
        onBeforeLoad(win) {
          win.localStorage.setItem("autoflow-locale", "en");
        },
      });
      cy.get("#identifier-field", { timeout: 15_000 }).should("be.visible").type(user);
      // Clerk shows the password field on the same screen for some
      // identifiers (combined form) but only after clicking "Continue" for
      // others (two-step form) — handle both rather than assuming one.
      cy.get("body").then(($body) => {
        if ($body.find("#password-field:visible").length === 0) {
          cy.contains("button", "Continue").click();
        }
      });
      cy.get("#password-field", { timeout: 15_000 }).should("be.visible").type(password, { log: false });
      cy.contains("button", "Continue").click();
      cy.url({ timeout: 30_000 }).should("match", /\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/);
    },
    {
      validate() {
        cy.window().its("localStorage").invoke("getItem", "autoflow-locale").should("eq", "en");
      },
    }
  );
});

export {};
