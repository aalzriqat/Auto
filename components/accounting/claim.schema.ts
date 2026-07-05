import * as z from "zod";

export const newClaimSchema = z.object({
  financingEntity: z.string().min(1, "Financing entity is required"),
  buyerName: z.string().min(1, "Buyer name is required"),
  amount: z.coerce.number().positive("Claim amount must be greater than zero"),
  claimDate: z.string().min(1, "Claim date is required"),
  notes: z.string().optional(),
});

export type NewClaimFormValues = z.infer<typeof newClaimSchema>;
