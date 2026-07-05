import * as z from "zod";

export const capitalizeAssetSchema = z
  .object({
    name: z.string().min(1, "Asset name is required"),
    purchaseDate: z.string().min(1, "Purchase date is required"),
    cost: z.coerce.number().positive("Purchase value must be greater than zero"),
    salvageValue: z.coerce.number().min(0, "Salvage value must be zero or greater"),
    usefulLifeMonths: z.coerce.number().int().positive("Useful life must be a positive number of months"),
    paymentMethod: z.enum(["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"]),
    notes: z.string().optional(),
  })
  .refine((data) => data.salvageValue < data.cost, {
    message: "Salvage value must be less than purchase value",
    path: ["salvageValue"],
  });

export type CapitalizeAssetFormValues = z.infer<typeof capitalizeAssetSchema>;

export const impairAssetSchema = z.object({
  amount: z.coerce.number().positive("Impairment amount must be greater than zero"),
});

export type ImpairAssetFormValues = z.infer<typeof impairAssetSchema>;

export const disposeAssetSchema = z.object({
  proceeds: z.coerce.number().min(0, "Proceeds must be zero or greater"),
  occurredAt: z.string().min(1, "Disposal date is required"),
});

export type DisposeAssetFormValues = z.infer<typeof disposeAssetSchema>;
