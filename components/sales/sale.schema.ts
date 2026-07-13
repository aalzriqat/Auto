import * as z from "zod";
import { Doc } from "@/convex/_generated/dataModel";

export const saleSchema = z.object({
  vehicleId: z.string().min(1, "Vehicle is required"),
  customerId: z.string().min(1, "Customer is required"),
  salespersonId: z.string().min(1, "Salesperson is required"),
  salePrice: z.coerce.number().min(0, "Sale price must be positive"),
  saleDate: z.string().min(1, "Sale date is required"),
  status: z.enum(["PENDING", "COMPLETED", "CANCELLED"]),

  // Deal Structuring
  taxRate: z.coerce.number().min(0).optional(),
  taxAmount: z.coerce.number().min(0).optional(),
  dealerFees: z.coerce.number().min(0).optional(),
  downPayment: z.coerce.number().min(0).optional(),
  tradeInVehicleId: z.string().optional(),
  tradeInValue: z.coerce.number().min(0).optional(),
  financingType: z.enum(["CASH", "FINANCED", "LEASE"]).optional(),
  loanAmount: z.coerce.number().min(0).optional(),
  apr: z.coerce.number().min(0).optional(),
  termMonths: z.coerce.number().min(0).optional(),
  warrantySold: z.coerce.number().min(0).optional(),
  warrantyCost: z.coerce.number().min(0).optional(),
  warrantyTermMonths: z.coerce.number().min(0).max(360).optional(),
  gapSold: z.coerce.number().min(0).optional(),
  gapCost: z.coerce.number().min(0).optional(),
  gapTermMonths: z.coerce.number().min(0).max(360).optional(),
}).refine(
  (data) => !data.warrantySold || (data.warrantyTermMonths ?? 0) > 0,
  { message: "A warranty term (in months) is required when a warranty premium is charged", path: ["warrantyTermMonths"] }
).refine(
  (data) => !data.gapSold || (data.gapTermMonths ?? 0) > 0,
  { message: "A GAP term (in months) is required when a GAP premium is charged", path: ["gapTermMonths"] }
);

export type SaleFormValues = z.infer<typeof saleSchema>;

export interface SaleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale?: (Doc<"sales"> & { vehicle?: any, customer?: any, salesperson?: any }) | null;
}
