import { z } from "zod";

export const CreateVehicleSchema = z.object({
  orgId: z.string().min(1, "Organization ID is required"),
  branchId: z.string().optional(),
  vin: z.string()
    .min(1, "VIN is required")
    .max(17, "VIN cannot exceed 17 characters")
    .refine((vin) => !/[IOQ]/i.test(vin), "VIN cannot contain the letters I, O, or Q"),
  make: z.string().min(1, "Make is required"),
  model: z.string().min(1, "Model is required"),
  year: z.number().min(1900, "Year must be valid").max(2100, "Year must be valid"),
  trim: z.string().optional(),
  mileage: z.number().min(0, "Mileage cannot be negative"),
  color: z.string().min(1, "Color is required"),
  fuelType: z.string().min(1, "Fuel type is required"),
  transmission: z.string().min(1, "Transmission is required"),
  purchasePrice: z.number().min(0, "Purchase price cannot be negative").optional(),
  minimumProfit: z.number().min(0, "Minimum profit cannot be negative").optional(),
  sellingPrice: z.number().min(0, "Selling price cannot be negative"),
  status: z.enum([
    "AVAILABLE",
    "RESERVED",
    "SOLD",
    "IN_INSPECTION",
    "IN_REPAIR",
    "ARCHIVED",
  ]),
  notes: z.string().max(2000, "Notes cannot exceed 2000 characters").optional(),
  imageIds: z.array(z.string()).optional(),
});

export const UpdateVehicleSchema = CreateVehicleSchema.partial().extend({
  orgId: z.string().min(1, "Organization ID is required"),
  vehicleId: z.string().min(1, "Vehicle ID is required"),
});
