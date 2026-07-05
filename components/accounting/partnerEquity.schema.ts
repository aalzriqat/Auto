import * as z from "zod";

export const addPartnerSchema = z.object({
  name: z.string().min(1, "Partner name is required"),
  openingContribution: z.coerce.number().min(0, "Opening contribution must be zero or greater"),
  paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"]),
  notes: z.string().optional(),
});

export type AddPartnerFormValues = z.infer<typeof addPartnerSchema>;

export const movementSchema = z.object({
  amount: z.coerce.number().positive("Amount must be greater than zero"),
  paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"]),
  notes: z.string().optional(),
});

export type MovementFormValues = z.infer<typeof movementSchema>;
