/**
 * SCRUM-724 F2: unmocked pin of the sale-invoice receipt doors switch. Other suites
 * mock this module to exercise the doors, so none of them proves the shipped value.
 * This file mocks nothing: it imports the real constant and function.
 */
import { describe, expect, test } from "vitest";
import {
  SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED,
  assertSaleInvoiceReceiptDoorsAllowed,
} from "./customerCreditPayoutContainment";

describe("sale-invoice receipt doors containment switch", () => {
  test("the switch is ON in this build and the guard refuses", () => {
    expect(SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED).toBe(true);
    expect(() => assertSaleInvoiceReceiptDoorsAllowed()).toThrow();
  });
});
