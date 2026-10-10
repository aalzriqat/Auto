import { vi } from "vitest";

// SCRUM-802: the pilot cash-sale containment (CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED) refuses to
// complete a CASH sale whose invoice would stay unpaid. Most of the suite exercises the
// complete-then-collect lifecycle that exists once the invoice receipt resolver (SCRUM-722) lands,
// so by default the switch is OFF here. The tests that pin the containment itself opt back in with
//   vi.mock("./utils/saleDebtContainment", async (importOriginal) => await importOriginal());
// (see convex/scrum802CashSaleContainment.test.ts). Delete this mock when the switch is retired.
vi.mock("./convex/utils/saleDebtContainment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./convex/utils/saleDebtContainment")>()),
  CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: false,
}));
