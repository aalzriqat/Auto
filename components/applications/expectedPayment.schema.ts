import * as z from "zod";

export const expectedPaymentMethodSchema = z.enum(["CASH", "INTERNAL_INSTALLMENT", "CHEQUE", "BANK_TRANSFER"]);

export const registerExpectedPaymentSchema = z
  .object({
    method: expectedPaymentMethodSchema,
    expectedDate: z.string().min(1, "Expected date is required"),
    bank: z.string().optional(),
    chequeNumber: z.string().optional(),
  })
  .refine((data) => data.method !== "CHEQUE" || !!data.bank?.trim(), {
    message: "Bank is required for a cheque payment",
    path: ["bank"],
  })
  .refine((data) => data.method !== "CHEQUE" || !!data.chequeNumber?.trim(), {
    message: "Cheque number is required for a cheque payment",
    path: ["chequeNumber"],
  });

export type RegisterExpectedPaymentFormValues = z.infer<typeof registerExpectedPaymentSchema>;
