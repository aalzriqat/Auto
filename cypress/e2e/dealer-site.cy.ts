import {
  ensurePublishedDealerWebsite,
  ensureTurnstileToken,
  expectVisibleTableCell,
  gotoOrgRoute,
} from "../support/utils";

describe("public dealer website", () => {
  beforeEach(() => {
    cy.login();
  });

  it("contact, financing, and vehicle inquiry forms create CRM leads", () => {
    ensurePublishedDealerWebsite().then((site) => {
      const now = Date.now();
      const submissions = [
        {
          path: "/contact",
          buttonName: "Send message",
          firstName: "Public",
          lastName: `Contact-${now}`,
          emailPrefix: "contact",
          message: "I want to speak with sales.",
        },
        {
          path: "/finance",
          buttonName: "Request financing",
          firstName: "Public",
          lastName: `Finance-${now}`,
          emailPrefix: "finance",
          message: "Please send financing details.",
        },
        {
          path: `/inventory/${site.vehicleSlug}`,
          buttonName: "Send inquiry",
          firstName: "Public",
          lastName: `Vehicle-${now}`,
          emailPrefix: "vehicle",
          message: `I am interested in ${site.vehicleModel}.`,
        },
      ];

      for (const item of submissions) {
        cy.visit(`/dealer-site${item.path}?host=${encodeURIComponent(site.host)}`);

        cy.findByPlaceholderText("First name").should("be.visible").type(item.firstName);
        cy.findByPlaceholderText("Last name").type(item.lastName);
        cy.findByPlaceholderText("Email").type(
          `${item.emailPrefix}-${item.lastName.toLowerCase()}@example.com`,
        );
        cy.findByPlaceholderText("Message").type(item.message);
        ensureTurnstileToken();

        cy.findByRole("button", { name: item.buttonName }).click();
        cy.findByRole("heading", { name: "Thank you!" }).should("be.visible");
      }

      gotoOrgRoute("leads").then(() => {
        for (const item of submissions) {
          cy.get('main input[placeholder^="Search"]:not([readonly])')
            .first()
            .clear()
            .type(item.lastName);
          expectVisibleTableCell(item.lastName);
        }
      });
    });
  });
});
