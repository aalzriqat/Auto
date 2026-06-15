import * as z from "zod";

export const step1Schema = z.object({
  vehicleId: z.string().min(1),
  vehiclePrice: z.coerce.number().min(1),
  desiredProfit: z.coerce.number().min(0),
  downPayment: z.coerce.number().min(0),
  termMonths: z.coerce.number().min(0),
  vehicleCondition: z.string().optional(),
});

export const newCustomerSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  nationalId: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
});