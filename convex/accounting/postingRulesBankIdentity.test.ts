import { describe, expect, test } from "vitest";
import { ruleCashDrawerDeposited, ruleCommissionPaid, ruleExpensePosted } from "./postingRules";

describe("queued paid-expense bank identity", () => {
  const base = { expenseId: "expense-1", amountMinor: 1_000, currency: "JOD" };

  test("refuses legacy bank-funded events without a physical bank before producing journal lines", () => {
    expect(() => ruleExpensePosted({ ...base, paymentMethod: "BANK_TRANSFER" }))
      .toThrow(/physical bank account/i);
    expect(() => ruleExpensePosted({
      ...base, paymentMethod: "CHEQUE", costBearer: "SUPPLIER", vehicleId: "vehicle-1",
    })).toThrow(/physical bank account/i);
  });

  test("keeps the bank on both ordinary and supplier-borne bank credits", () => {
    for (const payload of [
      { ...base, paymentMethod: "BANK_TRANSFER", bankAccountId: "bank-1" },
      { ...base, paymentMethod: "CHEQUE", costBearer: "SUPPLIER" as const, vehicleId: "vehicle-1", bankAccountId: "bank-1" },
    ]) {
      const bankLine = ruleExpensePosted(payload).lines.find((line) => line.accountSystemKey === "BANK_ACCOUNT");
      expect(bankLine?.bankAccountId).toBe("bank-1");
      expect(bankLine?.creditMinor).toBe(1_000);
    }
  });

  test("refuses a physical bank on a cash expense", () => {
    expect(() => ruleExpensePosted({ ...base, paymentMethod: "CASH", bankAccountId: "bank-1" }))
      .toThrow(/non-bank/i);
  });
});

describe("queued cash drawer deposit bank identity", () => {
  test("refuses a legacy deposit without a physical bank", () => {
    expect(() => ruleCashDrawerDeposited({ sessionId: "drawer-1", amountMinor: 1_000, currency: "JOD" }))
      .toThrow(/physical bank account/i);
  });

  test("keeps the selected bank only on the bank debit", () => {
    const result = ruleCashDrawerDeposited({
      sessionId: "drawer-1", amountMinor: 1_000, currency: "JOD", bankAccountId: "bank-1",
    });
    expect(result.lines.find((line) => line.accountSystemKey === "BANK_ACCOUNT"))
      .toMatchObject({ bankAccountId: "bank-1", debitMinor: 1_000 });
    expect(result.lines.find((line) => line.accountSystemKey === "CASH_ON_HAND")?.bankAccountId)
      .toBeUndefined();
  });
});

describe("queued direct commission payment bank identity", () => {
  const base = {
    saleId: "sale-1", salespersonId: "staff-1", amountMinor: 1_000, currency: "JOD",
  };

  test("refuses bank-funded and issued-cheque payments without a physical bank", () => {
    for (const paymentMethod of ["BANK_TRANSFER", "CHEQUE"]) {
      expect(() => ruleCommissionPaid({ ...base, paymentMethod }))
        .toThrow(/physical bank account/i);
    }
  });

  test("retains the bank on the payment credit and refuses one on cash", () => {
    const result = ruleCommissionPaid({ ...base, paymentMethod: "CHEQUE", bankAccountId: "bank-1" });
    expect(result.lines.find((line) => line.accountSystemKey === "BANK_ACCOUNT"))
      .toMatchObject({ bankAccountId: "bank-1", creditMinor: 1_000 });
    expect(() => ruleCommissionPaid({ ...base, paymentMethod: "CASH", bankAccountId: "bank-1" }))
      .toThrow(/non-bank/i);
  });
});
