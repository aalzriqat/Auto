import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../../../components/providers/LanguageProvider";
import { OpeningDepositRefundDialog } from "../../../components/customers/OpeningDepositRefundDialog";
import { OpeningRefundReturnDialog } from "../../../components/accounting/bankAccounts/OpeningRefundReturnDialog";
import type { Id } from "../../../convex/_generated/dataModel";

function Fixture() {
  const [open, setOpen] = useState(true);
  const state = new URLSearchParams(location.search).get("state");
  if (!open) return createElement("p", null, "Synthetic dialog closed");
  const orgId = "synthetic-org" as Id<"organizations">;
  const onClose = () => setOpen(false);
  return createElement(LanguageProvider, null, state === "return"
    ? createElement(OpeningRefundReturnDialog, { orgId, onClose,
      line: { id: "synthetic-line" as Id<"bankStatementLines">, description: "Synthetic bank credit", amountLabel: "100.00 USD" } })
    : createElement(OpeningDepositRefundDialog, { orgId, onClose, depositId: "synthetic-deposit" as Id<"deposits">,
      amountLabel: "100.00 USD", currency: "USD", reserved: !["fresh", "refusal"].includes(state ?? "fresh") }));
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
createRoot(root).render(createElement(Fixture));
