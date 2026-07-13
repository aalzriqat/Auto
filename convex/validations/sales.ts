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
  warrantyCost: z.number().min(0).optional(),
  warrantyTermMonths: z.number().min(1).max(360).optional(),
  gapSold: z.number().min(0).optional(),
  gapCost: z.number().min(0).optional(),
  gapTermMonths: z.number().min(1).max(360).optional(),
});

function downPaymentDoesNotExceedSalePrice(data: { downPayment?: number; salePrice?: number }) {
    if (
      data.downPayment !== undefined &&
      data.salePrice !== undefined &&
      data.downPayment > data.salePrice
    ) {
      return false;
    }
    return true;
}

const downPaymentRefinement = {
  message: "Down payment cannot exceed the sale price",
  path: ["downPayment"],
};

function warrantyTermRequiredWhenSold(data: { warrantySold?: number; warrantyTermMonths?: number }) {
  return !data.warrantySold || (data.warrantyTermMonths ?? 0) > 0;
}

const warrantyTermRefinement = {
  message: "A warranty term (in months) is required when a warranty premium is charged",
  path: ["warrantyTermMonths"],
};

function gapTermRequiredWhenSold(data: { gapSold?: number; gapTermMonths?: number }) {
  return !data.gapSold || (data.gapTermMonths ?? 0) > 0;
}

const gapTermRefinement = {
  message: "A GAP term (in months) is required when a GAP premium is charged",
  path: ["gapTermMonths"],
};

export const CreateSaleSchema = BaseSaleSchema.extend({
  status: z.literal("COMPLETED"),
})
  .refine(downPaymentDoesNotExceedSalePrice, downPaymentRefinement)
  .refine(warrantyTermRequiredWhenSold, warrantyTermRefinement)
  .refine(gapTermRequiredWhenSold, gapTermRefinement);

export const CreateDraftSaleSchema = BaseSaleSchema.extend({
  status: z.literal("PENDING").optional(),
})
  .refine(downPaymentDoesNotExceedSalePrice, downPaymentRefinement)
  .refine(warrantyTermRequiredWhenSold, warrantyTermRefinement)
  .refine(gapTermRequiredWhenSold, gapTermRefinement);

export const UpdateSaleSchema = BaseSaleSchema.partial().extend({
  orgId: z.string().min(1, "Organization ID is required"),
  saleId: z.string().min(1, "Sale ID is required"),
}).refine(downPaymentDoesNotExceedSalePrice, downPaymentRefinement);
