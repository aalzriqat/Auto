declare global {
  interface ImportMeta {
    glob: any;
  }
}
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { wizardSnapshotValidator } from "./approvals";

// Reproduces the EXACT argument shape components/sales/wizard/steps/Step1QuoteSetup.tsx
// sends from handleRequestApproval.
//
// "Exact" is the whole point, and an earlier version of this file got it wrong in the
// one way that hid the bug: it sent `undefined` for the three execution-commission
// fields, reasoning that they are untouched until the salesperson opens the finance
// panel. They are not. The wizard holds them in useState with non-optional
// initialisers —
//
//     useState(initialData.manualExecutionCommission || 0)      -> 0
//     useState(initialData.manualExecutionFees || 0)            -> 0
//     useState(initialData.manualIncludesCommissionInDebt ?? true) -> true
//
// — so they are always present on the wire, and Convex strips `undefined` before it
// ever reaches ctx.db.insert. Sending `undefined` therefore exercised a payload the
// wizard can never produce, and the extra-field schema mismatch it triggers went
// unseen. Keep these as literal 0/0/true.
const WIZARD_SNAPSHOT = {
  paymentType: "INSTALLMENT",
  vehiclePrice: 15000,
  desiredProfit: 100,
  downPayment: 0,
  termMonths: 84,
  // Genuinely undefined until a finance company is picked.
  selectedCompanyId: undefined,
  manualProfitRate: 0,
  manualInsuranceRate: 0,
  manualExecutionCommission: 0,
  manualExecutionFees: 0,
  manualIncludesCommissionInDebt: true,
} as const;

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
      wizardSnapshot: { ...WIZARD_SNAPSHOT },
    });

    const rows = await t.run((ctx) => ctx.db.query("profitApprovalRequests").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].requestedProfit).toBe(100);
  });

  it("persists the execution-commission fields it accepted", async () => {
    const { t, orgId, vehicleId, asSalesperson } = await setup();

    await asSalesperson.mutation(api.approvals.requestProfitApproval, {
      orgId,
      vehicleId,
      requestedProfit: 100,
      minimumProfit: 5000,
      wizardSnapshot: { ...WIZARD_SNAPSHOT },
    });

    // The snapshot exists to let the salesperson resume the quote after a manager
    // approves it, so a field the args validator accepts but the table drops would
    // silently resume the deal with different numbers.
    const rows = await t.run((ctx) => ctx.db.query("profitApprovalRequests").collect());
    expect(rows[0].wizardSnapshot).toMatchObject({
      manualExecutionCommission: 0,
      manualExecutionFees: 0,
      manualIncludesCommissionInDebt: true,
    });
  });

  it("checkPendingApproval then reports the request the wizard is waiting on", async () => {
    const { orgId, vehicleId, asSalesperson } = await setup();

    await asSalesperson.mutation(api.approvals.requestProfitApproval, {
      orgId,
      vehicleId,
      requestedProfit: 100,
      minimumProfit: 5000,
      wizardSnapshot: { ...WIZARD_SNAPSHOT },
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

  // This drift has now shipped twice — once on `wizardDrafts.wizardData`
  // (c906211c) and once here, where it disabled three E2E specs for weeks. The
  // args validator and the table schema are edited in different files, and
  // nothing but this assertion connects them: `tsc` sees both as valid, and a
  // mutation test only catches it if its fixture happens to send the field.
  it("keeps the args validator and the table schema in step", () => {
    const tableSnapshot = (schema.tables.profitApprovalRequests as any).validator
      .fields.wizardSnapshot;

    expect((tableSnapshot as any).json).toEqual((wizardSnapshotValidator as any).json);
  });

  it("re-requesting at a new profit patches the existing PENDING row", async () => {
    const { t, orgId, vehicleId, asSalesperson } = await setup();

    for (const requestedProfit of [100, 250]) {
      await asSalesperson.mutation(api.approvals.requestProfitApproval, {
        orgId,
        vehicleId,
        requestedProfit,
        minimumProfit: 5000,
        wizardSnapshot: { ...WIZARD_SNAPSHOT, desiredProfit: requestedProfit },
      });
    }

    // The patch branch writes wizardSnapshot too, so it validates against the table
    // schema independently of the insert branch above.
    const rows = await t.run((ctx) => ctx.db.query("profitApprovalRequests").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].requestedProfit).toBe(250);
  });
});
