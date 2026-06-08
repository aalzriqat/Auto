import * as z from "zod";
import { Doc } from "@/convex/_generated/dataModel";

export const vehicleSchema = z.object({
  vin: z.string().min(17, "VIN must be at least 17 characters").max(17, "VIN must be exactly 17 characters"),
  make: z.string().min(1, "Make is required"),
  model: z.string().min(1, "Model is required"),
  year: z.coerce.number().min(1900).max(new Date().getFullYear() + 1),
  trim: z.string().optional(),
  mileage: z.coerce.number().min(0, "Mileage cannot be negative"),
  color: z.string().min(1, "Color is required"),
  fuelType: z.string().min(1, "Fuel Type is required"),
  transmission: z.string().min(1, "Transmission is required"),
  purchasePrice: z.coerce.number().min(0).optional(),
  sellingPrice: z.coerce.number().min(0),
  status: z.enum(["AVAILABLE", "RESERVED", "SOLD", "IN_INSPECTION", "IN_REPAIR", "ARCHIVED"]).optional(),
  notes: z.string().optional(),
  imageIds: z.array(z.string()).optional(),
});

export type VehicleFormValues = z.infer<typeof vehicleSchema>;

export interface VehicleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicle?: Doc<"vehicles"> | null;
  canCreate?: boolean;
  canEdit?: boolean;
}
