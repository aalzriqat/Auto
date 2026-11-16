import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider, useLanguage } from "../../../components/providers/LanguageProvider";
import { HeldDepositActions } from "../../../components/vehicles/HeldDepositActions";
import type { PaymentMethod } from "../../../components/payments/PaymentMethodSelect";
import "../../../app/globals.css";

function DepositSurface() {
  const { t, setLocale } = useLanguage();
  const [method, setMethod] = useState<PaymentMethod>();
  return createElement("main", { className: "p-6 max-w-lg" },
    createElement("button", { onClick: () => setLocale("ar") }, "العربية"),
    createElement("button", { onClick: () => setLocale("en") }, "English"),
    createElement("section", { className: "bg-card border rounded-lg p-3 mt-4", "aria-label": "Deposit" },
      createElement("p", { className: "text-sm font-semibold mb-3" }, createElement("bdi", { dir: "ltr" }, "500 JOD")),
      createElement(HeldDepositActions, {
        orgId: undefined, method, bankAccountId: "", onMethodChange: setMethod,
        onBankChange: () => undefined, busy: false, onRefund: () => undefined,
        onForfeit: () => undefined, t,
      }),
    ),
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
createRoot(root).render(createElement(LanguageProvider, null, createElement(DepositSurface)));
