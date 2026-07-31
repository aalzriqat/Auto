declare global {
  interface ImportMeta {
    glob: any;
  }
}
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// Reproduces the EXACT argument shape components/sales/wizard/steps/Step1QuoteSetup.tsx
// sends from handleRequestApproval, including the optional wizardSnapshot fields that
// are `undefined` when no finance company has been picked yet.
//
// The three profit-approval E2E specs all failed with the wizard still showing the
// "Request Profit Approval" button after it was clicked, meaning this mutation threw and
// handleRequestApproval's catch-less try/finally swallowed it. This pins down whether the
// throw comes from the arguments themselves.

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Wizard Args Org", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "wiz_sales", email: "wiz@test.com", name: "Wiz Sales" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:vehicles"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Playwright",
      model: "E2E-APPROVAL",
      status: "AVAILABLE",
      vin: "WIZARDARGS001",
      year: 2024,
      mileage: 100,
      color: "Black",
      fuelType: "Petrol",
      transmission: "Automatic",
      sellingPrice: 15000,
      minimumProfit: 5000,
    })
  );

  return { t, orgId, vehicleId, asSalesperson: t.withIdentity({ subject: "wiz_sales" }) };
}

describe("approvals.requestProfitApproval — the wizard's real argument shape", () => {
  it("accepts the snapshot the wizard sends when no finance company is selected", async () => {
    const { t, orgId, vehicleId, asSalesperson } = await setup();

    await asSalesperson.mutation(api.approvals.requestProfitApproval, {
      orgId,
      vehicleId,
      requestedProfit: 100,
      minimumProfit: 5000,
      wizardSnapshot: {
        paymentType: "INSTALLMENT",
        vehiclePrice: 15000,
        desiredProfit: 100,
        downPayment: 0,
        termMonths: 84,
        // Every one of these is `undefined` in the wizard until the salesperson
        // interacts with the finance panel — which the E2E specs never do.
        selectedCompanyId: undefined,
        manualProfitRate: undefined,
        manualInsuranceRate: undefined,
        manualExecutionCommission: undefined,
        manualExecutionFees: undefined,
        manualIncludesCommissionInDebt: undefined,
      },
    });

    const rows = await t.run((ctx) => ctx.db.query("profitApprovalRequests").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].requestedProfit).toBe(100);
  });

  it("checkPendingApproval then reports the request the wizard is waiting on", async () => {
    const { orgId, vehicleId, asSalesperson } = await setup();

    await asSalesperson.mutation(api.approvals.requestProfitApproval, {
      orgId,
      vehicleId,
      requestedProfit: 100,
      minimumProfit: 5000,
      wizardSnapshot: {
        paymentType: "INSTALLMENT",
        vehiclePrice: 15000,
        desiredProfit: 100,
        downPayment: 0,
        termMonths: 84,
        selectedCompanyId: undefined,
        manualProfitRate: undefined,
        manualInsuranceRate: undefined,
        manualExecutionCommission: undefined,
        manualExecutionFees: undefined,
        manualIncludesCommissionInDebt: undefined,
      },
    });

    // This is what drives the wizard's "Approval request is currently pending" branch:
    // status PENDING *and* requestedProfit strictly equal to the entered profit.
    const pending = await asSalesperson.query(api.approvals.checkPendingApproval, {
      orgId,
      vehicleId,
    });
    expect(pending?.status).toBe("PENDING");
    expect(pending?.requestedProfit).toBe(100);
  });
});
