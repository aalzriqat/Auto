import { describe, expect, test } from "vitest";
import { applicationReason, mergeDealRows, type ApplicationListRow, type SaleListRow } from "./dealRows";

const t = (key: string) => key;
const fmt = (major: number) => `${major} JD`;

function app(overrides: Partial<ApplicationListRow> = {}): ApplicationListRow {
  return {
    _id: "app_1",
    status: "UNDER_REVIEW",
    createdAt: 1_000,
    updatedAt: 2_000,
    customerName: "Test Customer",
    vehicleDesc: "2024 Kia Sportage",
    companyName: "Jordan Auto Finance",
    companyLabelKey: null,
    salespersonName: "Sales One",
    financedAmount: 15_000,
    hasPendingDepositResolution: false,
    companyId: "company_1",
    ...overrides,
  };
}

function sale(overrides: Partial<SaleListRow> = {}): SaleListRow {
  return {
    _id: "sale_1",
    status: "PENDING",
    saleDate: 3_000,
    salePrice: 12_000,
    customerName: "Cash Customer",
    vehicleSummary: "2023 Hyundai Tucson",
    salespersonName: "Sales Two",
    ...overrides,
  };
}

describe("queue reasons come from served facts only", () => {
  test("a held deposit awaiting resolution outranks the status", () => {
    expect(applicationReason(app({ status: "CANCELLED", hasPendingDepositResolution: true }))).toEqual({
      reason: "DEPOSIT_PENDING",
      waitingOn: "DEALERSHIP",
    });
  });

  test("status → reason and who is waited on", () => {
    expect(applicationReason(app({ status: "PENDING_DOCS" }))).toEqual({ reason: "DOCS_PENDING", waitingOn: "DEALERSHIP" });
    expect(applicationReason(app({ status: "UNDER_REVIEW" }))).toEqual({ reason: "AWAITING_DECISION", waitingOn: "OTHERS" });
    expect(applicationReason(app({ status: "APPROVED" }))).toEqual({ reason: "READY_FOR_HANDOVER", waitingOn: "DEALERSHIP" });
    expect(applicationReason(app({ status: "REJECTED" }))).toEqual({ reason: null, waitingOn: "NONE" });
  });

  test("a closed deal waits on the financier's payment only with a named financier, through the dealership, and no receipt yet", () => {
    expect(applicationReason(app({ status: "CLOSED" }))).toEqual({ reason: "AWAITING_RECEIPT", waitingOn: "OTHERS" });
    expect(applicationReason(app({ status: "CLOSED", disbursedAt: 5_000 }))).toEqual({ reason: null, waitingOn: "NONE" });
    expect(applicationReason(app({ status: "CLOSED", companyId: undefined }))).toEqual({ reason: null, waitingOn: "NONE" });
    expect(applicationReason(app({ status: "CLOSED", supplierSettlementRoute: "DIRECT_TO_SUPPLIER" }))).toEqual({
      reason: null,
      waitingOn: "NONE",
    });
  });
});

describe("one entry per deal", () => {
  test("a finalized financed deal's sale row is the same deal and is not listed twice", () => {
    const rows = mergeDealRows(
      [app({ status: "CLOSED" })],
      [sale({ _id: "sale_fin", status: "COMPLETED", applicationId: "app_1" }), sale()],
      "org1",
      t,
      fmt
    );
    expect(rows.map((row) => row.key)).toEqual(["app_app_1", "sale_sale_1"]);
    expect(rows[0].href).toBe("/org1/applications/app_1/deal");
    expect(rows[1].href).toBe("/org1/sales/sale_1/deal");
  });

  test("a cash sale in progress is the dealership's move; a nameless financier is the translated key", () => {
    const rows = mergeDealRows([app({ companyLabelKey: "UnnamedFinanceProvider" })], [sale()], "org1", t, fmt);
    expect(rows[0].financierLabel).toBe("UnnamedFinanceProvider");
    expect(rows[1]).toMatchObject({ kind: "CASH", reason: "CASH_PENDING", waitingOn: "DEALERSHIP", amountLabel: "12000 JD" });
  });

  test("a financed row with no recorded financed amount shows no amount rather than zero", () => {
    const rows = mergeDealRows([app({ financedAmount: 0 })], [], "org1", t, fmt);
    expect(rows[0].amountLabel).toBeNull();
  });
});
