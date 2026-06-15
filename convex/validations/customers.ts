import { z } from "zod";

export const CreateCustomerSchema = z.object({
  orgId: z.string().min(1, "Organization ID is required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email("Invalid email address").optional().or(z.literal("")),
  nationalId: z.string().optional(),
  address: z.string().optional(),
  employment: z
    .object({
      employer: z.string().min(1, "Employer name is required"),
      title: z.string().optional(),
      salary: z.number().min(0, "Salary cannot be negative"),
      hireDate: z.number().optional(),
    })
    .optional(),
  financials: z
    .object({
      totalMonthlyDebt: z.number().min(0, "Monthly debt cannot be negative"),
      dbr: z.number().min(0).max(100, "DBR must be between 0 and 100").optional(),
    })
    .optional(),
});

export const UpdateCustomerSchema = CreateCustomerSchema.partial().extend({
  orgId: z.string().min(1, "Organization ID is required"),
  customerId: z.string().min(1, "Customer ID is required"),
});
