import * as z from "zod";

export const prepaidCorrectionSchema = z
  .object({
    refundAmount: z.coerce.number().min(0, "Refund cannot be negative").default(0),
    refundPaymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"]).optional(),
    writeOffAmount: z.coerce.number().min(0, "Write-off cannot be negative").default(0),
    changeTerm: z.boolean().default(false),
    newTermMonths: z.coerce.number().int().min(1).max(600).optional(),
    reason: z.string().min(1, "A reason is required"),
  })
  .refine((v) => v.refundAmount === 0 || !!v.refundPaymentMethod, {
    message: "Select how the refund was received",
    path: ["refundPaymentMethod"],
  })
  .refine((v) => !v.changeTerm || v.newTermMonths !== undefined, {
    message: "Enter the new term in months",
    path: ["newTermMonths"],
  })
  .refine((v) => v.refundAmount > 0 || v.writeOffAmount > 0 || v.changeTerm, {
    message: "Enter a refund, write-off, or new term",
    path: ["refundAmount"],
  });

export type PrepaidCorrectionFormValues = z.infer<typeof prepaidCorrectionSchema>;
