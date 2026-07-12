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
const orgRoutePattern = /^\/[^/]+\/(dashboard|sales|leads|accounting)$/;
const e2eLocalStorage = {
  "autoflow-locale": "en",
  dealer_website_onboarding_seen_v1: "1",
  feature_spotlight_seen_v3: "1",
  global_search_onboarding_seen_v1: "1",
  messenger_onboarding_seen_v1: "1",
};

type PostPasswordState = "org" | "verification" | "onboarding";

function seedE2ELocalStorage(win: Window): void {
  Object.entries(e2eLocalStorage).forEach(([key, value]) => {
    win.localStorage.setItem(key, value);
  });
}

function verificationCodeFor(): string {
  const configuredCode = Cypress.env("E2E_LOGIN_VERIFICATION_CODE") as
    | string
    | undefined;
  return configuredCode || "424242";
}

function waitForPostPasswordState(
  attempt = 0,
): Cypress.Chainable<PostPasswordState> {
  if (attempt > 60) {
    throw new Error("Timed out waiting for Clerk sign-in to finish.");
  }

  const state = cy.location("pathname", { timeout: 1_000 }).then((pathname) => {
    if (orgRoutePattern.test(pathname)) {
      return "org";
    }
    if (pathname.startsWith("/sign-in/factor")) {
      return "verification";
    }
    if (pathname === "/dashboard") {
      return cy.get("body", { log: false }).then(($body) => {
        if (
          $body.find("#orgName").length > 0 ||
          $body.text().includes("Welcome to AutoFlow")
        ) {
          return "onboarding";
        }
        return cy
          .wait(500, { log: false })
          .then(() => waitForPostPasswordState(attempt + 1));
      });
    }
    return cy
      .wait(500, { log: false })
      .then(() => waitForPostPasswordState(attempt + 1));
  });

  return state as unknown as Cypress.Chainable<PostPasswordState>;
}

function findVerificationSubmitButton(
  $body: JQuery<HTMLElement>,
): JQuery<HTMLElement> {
  return $body
    .find("button")
    .filter((_, element) =>
      /^(Continue|Verify)\b/i.test(element.textContent?.trim() ?? ""),
    )
    .filter(":enabled:visible")
    .first();
}

function clickVerificationSubmitButton(): void {
  cy.get("body").then(($body) => {
    const button = findVerificationSubmitButton($body);
    if (button.length > 0) {
      cy.wrap(button).click();
    }
  });
}

function clickVerificationSubmitIfStillSigningIn(): void {
  cy.location("pathname", { timeout: 5_000 }).then((pathname) => {
    if (pathname.startsWith("/sign-in")) {
      clickVerificationSubmitButton();
    }
  });
}

function completeVerificationIfNeeded(): void {
  waitForPostPasswordState().then((state) => {
    if (state !== "verification") return;

    const verificationCode = verificationCodeFor();
    cy.get(
      'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code"], input[type="tel"]',
      { timeout: 15_000 },
    )
      .should(($inputs) => {
        expect($inputs.filter(":visible").length).to.be.greaterThan(0);
      })
      .then(($inputs) => {
        cy.wrap($inputs.filter(":visible").first())
          .click()
          .type(verificationCode, { log: false });
      });

    clickVerificationSubmitIfStillSigningIn();
  });
}

function completeOnboardingIfNeeded(): void {
  waitForPostPasswordState().then((state) => {
    if (state !== "onboarding") return;

    cy.findByLabelText(/^Dealership Name\b/, { timeout: 15_000 }).type(
      `AutoFlow Cypress QA ${Date.now()}`,
    );
    cy.findByRole("button", { name: /^Continue/ }).click();

    cy.findByRole("heading", { name: "Currency" }).should("be.visible");
    cy.findByRole("button", { name: /^Continue/ }).click();

    cy.findByRole("heading", { name: "Lead Sources" }).should("be.visible");
    cy.findByRole("button", { name: "Load Default Lead Sources" }).click();

    cy.findByRole("heading", { name: "Pipeline" }).should("be.visible");
    cy.findByRole("button", { name: "Load Default Pipeline" }).click();

    cy.findByRole("heading", { name: "You're All Set" }).should("be.visible");
    cy.findByRole("button", { name: "Go to Dashboard" }).click();
  });
}

Cypress.Commands.add("login", () => {
  const user = Cypress.env("E2E_LOGIN_USER") as string | undefined;
  const password = Cypress.env("E2E_LOGIN_PASSWORD") as string | undefined;
  if (!user || !password) {
    throw new Error(
      "CYPRESS_E2E_LOGIN_USER and CYPRESS_E2E_LOGIN_PASSWORD must be set to run the E2E suite.",
    );
  }

  cy.session(
    "autoflow-qa-session",
    () => {
      cy.visit("/sign-in", {
        onBeforeLoad(win) {
          seedE2ELocalStorage(win);
        },
      });
      cy.get("#identifier-field", { timeout: 15_000 })
        .should("be.visible")
        .type(user);
      // Clerk shows the password field on the same screen for some
      // identifiers (combined form) but only after clicking "Continue" for
      // others (two-step form) — handle both rather than assuming one.
      cy.get("body").then(($body) => {
        if ($body.find("#password-field:visible").length === 0) {
          cy.contains("button", "Continue").click();
        }
      });
      cy.get("#password-field", { timeout: 15_000 })
        .should("be.visible")
        .type(password, { log: false });
      cy.contains("button", "Continue").click();
      completeVerificationIfNeeded();
      completeOnboardingIfNeeded();
      // Matched against pathname specifically (not the full URL string) — a
      // regex without a leading anchor can accidentally match "host:port" as
      // the orgId segment against the bare Clerk-fallback /dashboard URL.
      cy.location("pathname", { timeout: 30_000 }).should(
        "match",
        orgRoutePattern,
      );
    },
    {
      validate() {
        cy.window().then((win) => {
          seedE2ELocalStorage(win);
          expect(win.localStorage.getItem("autoflow-locale")).to.eq("en");
          expect(win.localStorage.getItem("feature_spotlight_seen_v3")).to.eq(
            "1",
          );
        });
      },
    },
  );
});

export {};
