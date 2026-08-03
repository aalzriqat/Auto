"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { PaymentType } from "../types";

import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

import  CustomerSearch  from "../components/CustomerSearch";
import { CustomerCreateForm } from "../components/CustomerCreateForm";
import { CustomerBanner } from "../components/CustomerBanner";

// ─────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────

interface Step2CustomerProps {
  paymentType: PaymentType;
  selectedCustomer: Doc<"customers"> | null;
  onSelectCustomer: (c: Doc<"customers"> | null) => void;
  onNext: () => void;
  onBack: () => void;
}

// ─────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────

export default function Step2Customer({
  paymentType,
  selectedCustomer,
  onSelectCustomer,
  onNext,
  onBack,
}: Step2CustomerProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");

  // Searched server-side. The previous approach loaded one fixed page of
  // `customers.list` and filtered it in the browser, which silently hid every
  // customer outside that page — including the most recently added ones,
  // since `list` is ordered oldest-first.
  const customers = useQuery(
    api.customers.search,
    activeOrgId ? { orgId: activeOrgId, search: customerQuery } : "skip"
  );

  // CustomerCreateForm already creates the customer and returns the full Doc.
  // We just accept it here and update wizard state — no second mutation call.
  const handleCustomerCreated = (customer: Doc<"customers">) => {
    onSelectCustomer(customer);
    setShowCreateForm(false);
  };

  const isCash = paymentType === "CASH";

  const accentClass = isCash
    ? "border-teal-500 bg-teal-500/10"
    : "border-indigo-500 bg-indigo-500/10";

  const nextBtnClass = isCash
    ? "bg-teal-600 hover:bg-teal-700"
    : "bg-indigo-600 hover:bg-indigo-700";

  return (
    <div className="space-y-6">

      {/* Selected Customer Banner */}
      {selectedCustomer && !showCreateForm && (
        <CustomerBanner
          customer={selectedCustomer}
          paymentType={paymentType}
          onClear={() => onSelectCustomer(null)}
        />
      )}

      {/* SEARCH MODE */}
      {!showCreateForm && (
        <CustomerSearch
          customers={customers}
          query={customerQuery}
          onQueryChange={setCustomerQuery}
          selectedCustomer={selectedCustomer}
          onSelect={onSelectCustomer}
          onCreateNew={() => setShowCreateForm(true)}
          accentClass={accentClass}
        />
      )}

      {/* CREATE FORM */}
      {showCreateForm && (
        <CustomerCreateForm
          onCreated={handleCustomerCreated}
          onCancel={() => setShowCreateForm(false)}
          paymentType={paymentType}
        />
      )}

      {/* FOOTER */}
      <div className="flex flex-col-reverse sm:flex-row justify-between gap-3 pt-4 border-t">
        <Button variant="outline" onClick={onBack} className="w-full sm:w-auto">
          <ArrowLeft className="w-4 h-4 me-2" />
          {t("Back")}
        </Button>

        <Button
          onClick={onNext}
          disabled={!selectedCustomer}
          className={cn(nextBtnClass, "w-full sm:w-auto")}
        >
          {t("Next")}
          <ArrowRight className="w-4 h-4 ms-2" />
        </Button>
      </div>
    </div>
  );
}