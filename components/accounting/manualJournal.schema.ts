import * as z from "zod";

export const manualJournalLineSchema = z.object({
  id: z.string(),
  accountId: z.string().min(1, "Account is required"),
  side: z.enum(["DEBIT", "CREDIT"]),
  amount: z.coerce.number().positive("Amount must be greater than zero"),
});

export const manualJournalSchema = z.object({
  memo: z.string().min(1, "Memo is required"),
  // The date the adjustment belongs to, as `yyyy-MM-dd`. Required with no
  // default (SCRUM-50): a manual journal that inherits a date from whenever it
  // happened to be approved is the defect this form exists to prevent, and a
  // prefilled "today" is the same mistake made one step earlier.
  accountingDate: z.string().min(1, "Accounting date is required"),
  lines: z.array(manualJournalLineSchema).min(2, "Add at least two lines"),
});

export type ManualJournalLineValues = z.infer<typeof manualJournalLineSchema>;
export type ManualJournalFormValues = z.infer<typeof manualJournalSchema>;
