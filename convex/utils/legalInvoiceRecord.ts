import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { assertExpectedEconomicsStamp, financeCorrectionClosed, throwStaleDealCorrection } from "./financeCorrectionState";

export function describeLegalInvoiceRecord(
  amountMinor: number | undefined,
  number: string | undefined,
  date: number | undefined,
  issuedTo: string | undefined,
  other: string | undefined,
  by: string,
  issuer: string | undefined,
): string {
  return `${amountMinor ?? "unrecorded"} (invoice ${number || "unrecorded"} dated ${date ?? "unrecorded"} to ${issuedTo ?? "unrecorded"}${other ? ` — ${other}` : ""}, issued by ${by}${issuer ? ` — ${issuer}` : ""})`;
}

export function nextLegalInvoiceRevision(
  app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId" | "economicsRevision" | "legalInvoiceRevision" | "legalInvoiceAmountMinor">,
  expected: { expectedEconomicsStamp?: string; expectedInvoiceRevision?: number },
  replacing: boolean,
): number | null {
  if (financeCorrectionClosed(app)) {
    throw new ConvexError("This deal is closed. Its invoice can no longer be changed.");
  }
  assertExpectedEconomicsStamp(app, expected.expectedEconomicsStamp, replacing);
  if (app.legalInvoiceAmountMinor !== undefined && !replacing) return null;
  const revision = app.legalInvoiceRevision ?? 0;
  if ((replacing || expected.expectedInvoiceRevision !== undefined) && expected.expectedInvoiceRevision !== revision) {
    throwStaleDealCorrection("This invoice changed since you opened the correction. Review the current invoice first.");
  }
  const next = revision + 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new ConvexError("The invoice revision could not be verified.");
  }
  return next;
}

export function readLegalInvoiceRecipient(args: {
  legalInvoiceNumber: string;
  issuedTo: "CUSTOMER" | "FINANCE_COMPANY" | "OTHER";
  issuedToOther?: string;
}) {
  const invoiceNumber = args.legalInvoiceNumber.trim();
  if (!invoiceNumber) throw new ConvexError("Record the invoice number.");
  const issuedToOther = args.issuedToOther?.trim();
  if (args.issuedTo === "OTHER" && !issuedToOther) {
    throw new ConvexError("Say who the invoice was issued to.");
  }
  return { invoiceNumber, issuedToOther };
}
