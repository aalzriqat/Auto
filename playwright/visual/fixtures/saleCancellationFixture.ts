import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../../../components/providers/LanguageProvider";
import { SaleDialog } from "../../../components/sales/SaleDialog";
import { Toaster } from "../../../components/ui/sonner";
import type { Doc, Id } from "../../../convex/_generated/dataModel";

// Synthetic document IDs cross the same typed boundary as the existing visual fixtures.
const query = new URLSearchParams(location.search);
const sale = {
  _id: "fixture-sale" as Id<"sales">, _creationTime: 0,
  orgId: "fixture-org" as Id<"organizations">,
  vehicleId: "fixture-car" as Id<"vehicles">,
  customerId: "fixture-customer" as Id<"customers">,
  salespersonId: "fixture-salesperson" as Id<"users">,
  salePrice: 1000, saleDate: 1793491200000,
  status: query.has("cancelled") ? "CANCELLED" : "COMPLETED", financingType: "CASH", taxAmount: 0,
  ...(query.has("linked") ? { applicationId: "fixture-application" as Id<"financeApplications"> } : {}),
  warrantySold: query.has("legacy") ? 450.5 : 0,
  warrantyTermMonths: 0,
} satisfies Doc<"sales">;

function Fixture() {
  const [open, setOpen] = useState(true);
  return createElement(LanguageProvider, null,
    createElement(SaleDialog, { open, onOpenChange: setOpen, sale }),
    createElement(Toaster, { duration: Infinity }),
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
createRoot(root).render(createElement(Fixture));
