import { z } from "zod";

const BaseSaleSchema = z.object({
  orgId: z.string().min(1, "Organization ID is required"),
  vehicleId: z.string().min(1, "Vehicle ID is required"),
  customerId: z.string().min(1, "Customer ID is required"),
  salespersonId: z.string().min(1, "Salesperson ID is required"),
  salePrice: z.number().min(0, "Sale price cannot be negative"),
  saleDate: z.number(),
  status: z.enum(["PENDING", "COMPLETED", "CANCELLED"]).optional(),
  quoteId: z.string().optional(),
  taxRate: z.number().min(0).max(100).optional(),
  taxAmount: z.number().min(0).optional(),
  dealerFees: z.number().min(0).optional(),
  downPayment: z.number().min(0).optional(),
  tradeInVehicleId: z.string().optional(),
  tradeInValue: z.number().min(0).optional(),
  financingType: z.enum(["CASH", "FINANCED", "LEASE"]).optional(),
  loanAmount: z.number().min(0).optional(),
  apr: z.number().min(0).max(100).optional(),
  termMonths: z.number().min(1).max(360).optional(),
  warrantySold: z.number().min(0).optional(),
  gapSold: z.number().min(0).optional(),
});

export const CreateSaleSchema = BaseSaleSchema.refine(
  (data) => {
    if (
      data.downPayment !== undefined &&
      data.salePrice !== undefined &&
      data.downPayment > data.salePrice
    ) {
      return false;
    }
    return true;
  },
  {
    message: "Down payment cannot exceed the sale price",
    path: ["downPayment"],
  }
);

export const UpdateSaleSchema = BaseSaleSchema.partial().extend({
  orgId: z.string().min(1, "Organization ID is required"),
  saleId: z.string().min(1, "Sale ID is required"),
}).refine(
  (data) => {
    if (
      data.downPayment !== undefined &&
      data.salePrice !== undefined &&
      data.downPayment > data.salePrice
    ) {
      return false;
    }
    return true;
  },
  {
    message: "Down payment cannot exceed the sale price",
    path: ["downPayment"],
  }
);
