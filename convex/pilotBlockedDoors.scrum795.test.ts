import { afterEach, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { commonEn, commonAr } from "../lib/i18n/domains/common";
import {
  CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED,
  SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED,
} from "./utils/customerCreditPayoutContainment";

// SCRUM-795 / SCRUM-760 decision B: the customer-credit payout doors and the sale-invoice receipt doors
// are excluded from the pilot and must refuse on the server. The behavioural suites that exercise these
// doors (chequeCancelledSaleCredit, dealUnwind, scrum486Certification) mock the switch module so they can
// also test the open state. This file mocks nothing: the real shipped constants and the real public
// mutations. The guard in each door runs after authentication and before any read, so a document id that
// names a row of another table is enough to prove the refusal precedes the lookup (a lookup would answer
// with a not-found or a validation error instead of the pilot code).

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed() {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Blocked doors dealer", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "blocked_doors_owner", email: "owner@example.com" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: "BLOCKEDVIN", make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 10500,
      status: "AVAILABLE", sourceType: "STOCK",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Buyer" });
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: userId, salePrice: 10500,
      saleDate: Date.now(), status: "COMPLETED", commissionAmount: 0,
    });
    return { orgId, userId, vehicleId, customerId, saleId };
  });
  const as = t.withIdentity({ subject: "blocked_doors_owner" });
  return { t, as, ...ids };
}

afterEach(() => vi.useRealTimers());

async function snapshot(s: Seed) {
  return {
    tables: await dbSnapshot(s.t, Object.keys(schema.tables)),
    scheduled: await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
  };
}

async function refused(s: Seed, code: string, call: () => Promise<unknown>) {
  const before = await snapshot(s);
  const result = await refusalDataOf(call());
  expect(result?.code, result?.message ?? "Mutation succeeded instead of refusing").toBe(code);
  expect(result?.message).toContain("Nothing has been changed.");
  const english: Record<string, string> = commonEn;
  const arabic: Record<string, string> = commonAr;
  expect(english[`ServerError_${code}`]).toBe(result?.message);
  expect(arabic[`ServerError_${code}`]).toMatch(/[؀-ۿ]/);
  expect(await snapshot(s)).toEqual(before);
}

// The guard precedes every lookup, so these ids only have to pass the argument validator: convex-test reads
// the table from the id suffix and no such row exists. A door that looked the row up first would answer with
// a not-found error instead of the pilot code, and the assertion on the code would fail.
const missingId = <T extends "receiptMovements" | "retainedCreditRefundRequests" | "invoiceReceiptApplications">(table: T) =>
  `99999${table}` as Id<T>;
const receiptMovementId = () => missingId("receiptMovements");
const refundRequestId = () => missingId("retainedCreditRefundRequests");
const receiptApplicationId = () => missingId("invoiceReceiptApplications");

test("the shipped switches for the excluded payout and receipt doors are ON", () => {
  expect(CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED).toBe(true);
  expect(SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED).toBe(true);
});

test("requestRetainedCreditRefund refuses the customer-credit payout without writes", async () => {
  const s = await seed();
  await refused(s, "CUSTOMER_CREDIT_PAYOUT_DISABLED", () => s.as.mutation(api.retainedCreditRefunds.requestRetainedCreditRefund, {
    orgId: s.orgId, receiptMovementId: receiptMovementId(), amountMinor: 1000, method: "BANK_TRANSFER", reason: "Customer asked for the money back",
  }));
});

test("respondToRetainedCreditRefund APPROVED refuses the customer-credit payout without writes", async () => {
  const s = await seed();
  await refused(s, "CUSTOMER_CREDIT_PAYOUT_DISABLED", () => s.as.mutation(api.retainedCreditRefunds.respondToRetainedCreditRefund, {
    orgId: s.orgId, requestId: refundRequestId(), status: "APPROVED", idempotencyKey: crypto.randomUUID(),
  }));
});

test("executeRetainedCreditRefund refuses the customer-credit payout without writes", async () => {
  const s = await seed();
  await refused(s, "CUSTOMER_CREDIT_PAYOUT_DISABLED", () => s.as.mutation(api.retainedCreditRefunds.executeRetainedCreditRefund, {
    orgId: s.orgId, requestId: refundRequestId(), reference: "PV-1", paidAt: Date.now() - 1000, idempotencyKey: crypto.randomUUID(),
  }));
});

test("registerSaleInvoiceCheque refuses the sale-invoice receipt without writes", async () => {
  const s = await seed();
  await refused(s, "SALE_INVOICE_RECEIPT_DOORS_DISABLED", () => s.as.mutation(api.collections.registerSaleInvoiceCheque, {
    orgId: s.orgId, saleId: s.saleId, bank: "Test Bank", chequeNumber: "000123", chequeDate: Date.now(), amountMinor: 1000,
  }));
});

test("reserveSaleInvoiceReceipt refuses the sale-invoice receipt without writes", async () => {
  const s = await seed();
  await refused(s, "SALE_INVOICE_RECEIPT_DOORS_DISABLED", () => s.as.mutation(api.collections.reserveSaleInvoiceReceipt, {
    orgId: s.orgId, saleId: s.saleId, receiptMovementId: receiptMovementId(), amountMinor: 1000, idempotencyKey: crypto.randomUUID(),
  }));
});

test("activateSaleInvoiceReceipt refuses the sale-invoice receipt without writes", async () => {
  const s = await seed();
  await refused(s, "SALE_INVOICE_RECEIPT_DOORS_DISABLED", () => s.as.mutation(api.collections.activateSaleInvoiceReceipt, {
    orgId: s.orgId, applicationId: receiptApplicationId(), amountMinor: 1000, idempotencyKey: crypto.randomUUID(),
  }));
});

test("recordPayment bound to a sale invoice refuses the receipt without writes", async () => {
  const s = await seed();
  await refused(s, "SALE_INVOICE_RECEIPT_DOORS_DISABLED", () => s.as.mutation(api.collections.recordPayment, {
    orgId: s.orgId, customerId: s.customerId, invoiceSaleId: s.saleId, amount: 10, method: "CASH",
    paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
  }));
});
