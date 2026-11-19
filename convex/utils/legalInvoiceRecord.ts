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
import { ConvexError } from "convex/values";

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
