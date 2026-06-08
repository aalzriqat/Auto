import * as z from "zod";

export const quoteSchema = z.object({
  vehicleId: z.string().min(1, "Vehicle is required"),
  customerId: z.string().min(1, "Customer is required"),
  vehiclePrice: z.coerce.number().min(0, "Price must be positive"),
  downPayment: z.coerce.number().min(0, "Down payment must be positive"),
  termMonths: z.coerce.number().min(0),
});

export type QuoteFormValues = z.infer<typeof quoteSchema>;

export interface QuoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultVehicleId?: string;
  defaultCustomerId?: string;
}
