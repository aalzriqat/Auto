import { AccountingClient } from "@/components/accounting/AccountingClient";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Accounting & Finance | AutoFlow",
  description: "Manage general ledger, assets, equity, and claims",
};

export default function AccountingPage() {
  return <AccountingClient />;
}
