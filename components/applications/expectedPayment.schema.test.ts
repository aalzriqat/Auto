import { describe, expect, test } from "vitest";
import { registerExpectedPaymentSchema } from "./expectedPayment.schema";

describe("registerExpectedPaymentSchema face (SCRUM-447 D1)", () => {
  const base = { method: "CHEQUE", expectedDate: "2026-10-01", bank: "Arab Bank", chequeNumber: "77" } as const;

  test("a cheque requires the printed face as a plain decimal", () => {
    expect(registerExpectedPaymentSchema.safeParse(base).success).toBe(false);
    expect(registerExpectedPaymentSchema.safeParse({ ...base, faceAmount: "20,000" }).success).toBe(false);
    expect(registerExpectedPaymentSchema.safeParse({ ...base, faceAmount: "-5" }).success).toBe(false);
    expect(registerExpectedPaymentSchema.safeParse({ ...base, faceAmount: "20000.500" }).success).toBe(true);
  });

  test("other methods need no face", () => {
    expect(
      registerExpectedPaymentSchema.safeParse({ method: "BANK_TRANSFER", expectedDate: "2026-10-01" }).success
    ).toBe(true);
  });
});
