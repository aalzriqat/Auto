import * as z from "zod";

export const expectedPaymentMethodSchema = z.enum(["CASH", "INTERNAL_INSTALLMENT", "CHEQUE", "BANK_TRANSFER"]);

export const registerExpectedPaymentSchema = z
  .object({
    method: expectedPaymentMethodSchema,
    expectedDate: z.string().min(1, "Expected date is required"),
    bank: z.string().optional(),
    chequeNumber: z.string().optional(),
    // SCRUM-447 D1: the face printed on the instrument, a decimal string.
    // Never derived from the quote.
    faceAmount: z.string().optional(),
  })
  .refine((data) => data.method !== "CHEQUE" || !!data.bank?.trim(), {
    message: "Bank is required for a cheque payment",
    path: ["bank"],
  })
  .refine((data) => data.method !== "CHEQUE" || !!data.chequeNumber?.trim(), {
    message: "Cheque number is required for a cheque payment",
    path: ["chequeNumber"],
  })
  .refine((data) => data.method !== "CHEQUE" || /^\d+(\.\d+)?$/.test(data.faceAmount?.trim() ?? ""), {
    message: "Enter the face amount printed on the cheque",
    path: ["faceAmount"],
  });

export type RegisterExpectedPaymentFormValues = z.infer<typeof registerExpectedPaymentSchema>;
