import * as z from "zod";

export const contactFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200, "Name is too long"),
  email: z.string().trim().email("Invalid email address").max(320, "Email is too long"),
  subject: z.string().trim().min(1, "Subject is required").max(200, "Subject is too long"),
  message: z.string().trim().min(1, "Message is required").max(5000, "Message is too long (5000 characters max)"),
});

export type ContactFormValues = z.infer<typeof contactFormSchema>;
