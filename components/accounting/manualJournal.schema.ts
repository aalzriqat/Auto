import * as z from "zod";

export const manualJournalLineSchema = z.object({
  id: z.string(),
  accountId: z.string().min(1, "Account is required"),
  side: z.enum(["DEBIT", "CREDIT"]),
  amount: z.coerce.number().positive("Amount must be greater than zero"),
});

export const manualJournalSchema = z.object({
  // SCRUM-50: the date the entry belongs to. Held as the raw "YYYY-MM-DD" of
  // the date input and converted with dateInputToMs at submit, so the calendar
  // day the preparer picked is the day the ledger stores.
  accountingDate: z.string().min(1, "Accounting date is required"),
  memo: z.string().min(1, "Memo is required"),
  lines: z.array(manualJournalLineSchema).min(2, "Add at least two lines"),
});

export type ManualJournalLineValues = z.infer<typeof manualJournalLineSchema>;
export type ManualJournalFormValues = z.infer<typeof manualJournalSchema>;
