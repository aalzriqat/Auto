import { AccountingClient } from "@/components/accounting/AccountingClient";
import { Metadata } from "next";
import { RoleGuard } from "@/components/auth/RoleGuard";

export const metadata: Metadata = {
  title: "Accounting & Finance | AutoFlow",
  description: "Manage general ledger, assets, equity, and claims",
};

export default function AccountingPage() {
  return (
    <RoleGuard permissions={["view:settings"]}>
      <AccountingClient />
    </RoleGuard>
  );
}
