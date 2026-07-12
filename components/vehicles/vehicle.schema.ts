import * as z from "zod";
import { Doc } from "@/convex/_generated/dataModel";

export const vehicleSchema = z.object({
  vin: z.string()
    .max(17, "VIN must be at most 17 characters")
    .refine((vin) => !vin || !/[IOQ]/i.test(vin), "VIN cannot contain the letters I, O, or Q")
    .optional(),
  make: z.string().min(1, "Make is required"),
  model: z.string().min(1, "Model is required"),
  year: z.coerce.number().min(1900).max(new Date().getFullYear() + 1),
  trim: z.string().optional(),
  mileage: z.coerce.number().min(0, "Mileage cannot be negative"),
  color: z.string().min(1, "Color is required"),
  fuelType: z.string().min(1, "Fuel Type is required"),
  transmission: z.string().min(1, "Transmission is required"),
  purchasePrice: z.coerce.number().min(0).optional(),
  minimumProfit: z.coerce.number().min(0).optional(),
  sellingPrice: z.coerce.number().min(0),
  status: z.enum(["AVAILABLE", "RESERVED", "SOLD", "IN_INSPECTION", "IN_REPAIR", "ARCHIVED", "SOURCING"]).optional(),
  sourceType: z.enum(["STOCK", "SOURCED"]).optional(),
  sourcedFromName: z.string().optional(),
  sourceCost: z.coerce.number().min(0).optional(),
  notes: z.string().optional(),
  imageIds: z.array(z.string()).optional(),
  // The dealer-facing form only lets the user pick NONE/SELF_REPORTED —
  // PARTNER_VERIFIED is included here purely so the form can read/display an
  // existing partner-verified vehicle's status; the update/requestUpdate
  // mutations reject PARTNER_VERIFIED outright, and VehicleDialog strips this
  // field from the submitted payload whenever it's locked at that value.
  inspectionStatus: z.enum(["NONE", "SELF_REPORTED", "PARTNER_VERIFIED"]).optional(),
  accidentDisclosed: z.boolean().optional(),
  ownerCount: z.coerce.number().int().min(0, "Owner count cannot be negative").optional(),
  dealerGuarantee: z.boolean().optional(),
});

export type VehicleFormValues = z.infer<typeof vehicleSchema>;

export interface VehicleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicle?: Doc<"vehicles"> | null;
  canCreate?: boolean;
  canEdit?: boolean;
}
