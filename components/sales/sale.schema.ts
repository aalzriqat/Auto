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

  // Consigned (SOURCED) vehicles only: where the buyer's money went. Ignored
  // server-side for dealer-owned stock, which has no supplier to settle with.
  supplierSettlementRoute: z.enum(["THROUGH_DEALERSHIP", "DIRECT_TO_SUPPLIER"]).optional(),
}).refine(
  (data) => !data.warrantySold || (data.warrantyTermMonths ?? 0) > 0,
  { message: "A warranty term (in months) is required when a warranty premium is charged", path: ["warrantyTermMonths"] }
).refine(
  (data) => !data.gapSold || (data.gapTermMonths ?? 0) > 0,
  { message: "A GAP term (in months) is required when a GAP premium is charged", path: ["gapTermMonths"] }
  // Both of the following mirror refusals the backend makes at COMPLETION only
  // (SCRUM-22, `assertCompletableSaleAmounts`). The server is the control —
  // these exist so an operator meets the problem on the field that caused it
  // rather than as a failed save with no field path, the same reason the two
  // term refines above exist.
  //
  // Scoped to COMPLETED deliberately. A PENDING draft is a deal in progress and
  // may legitimately carry no agreed price yet; the backend permits that, and a
  // client that forbids a state the backend allows is a worse defect than the
  // missing hint. These are also compared in major units here, which is only a
  // hint — the authoritative comparison happens in canonical minor units, so
  // the client cannot see a value that rounds to nothing.
).refine(
  (data) => data.status !== "COMPLETED" || (data.taxAmount ?? 0) <= data.salePrice,
  { message: "The sales tax cannot be more than the sale price", path: ["taxAmount"] }
).refine(
  (data) => data.status !== "COMPLETED" || data.salePrice > 0,
  { message: "A completed sale needs a price greater than zero", path: ["salePrice"] }
);

export type SaleFormValues = z.infer<typeof saleSchema>;

export interface SaleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale?: (Doc<"sales"> & { vehicle?: any, customer?: any, salesperson?: any }) | null;
}
