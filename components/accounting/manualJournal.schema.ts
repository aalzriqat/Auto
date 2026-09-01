import * as z from "zod";

export const manualJournalLineSchema = z.object({
  id: z.string(),
  accountId: z.string().min(1, "Account is required"),
  side: z.enum(["DEBIT", "CREDIT"]),
  amount: z.coerce.number().positive("Amount must be greater than zero"),
});

export const manualJournalSchema = z.object({
  memo: z.string().min(1, "Memo is required"),
  lines: z.array(manualJournalLineSchema).min(2, "Add at least two lines"),
});

export type ManualJournalLineValues = z.infer<typeof manualJournalLineSchema>;
export type ManualJournalFormValues = z.infer<typeof manualJournalSchema>;
