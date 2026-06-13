"use client";

import { useState } from "react";
import { usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { PaymentType } from "../types";

import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

import  CustomerSearch  from "../components/CustomerSearch";
import { CustomerCreateForm } from "../components/CustomerCreateForm";
import { CustomerBanner } from "../components/CustomerBanner";

import { toast } from "@/components/ui/sonner";

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
  const createCustomer = useMutation(api.customers.create);

  const [showCreateForm, setShowCreateForm] = useState(false);

  const { results: customers } = usePaginatedQuery(
    api.customers.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const handleCreateCustomer = async (data: any) => {
    if (!activeOrgId) return;

    try {
      const id = await createCustomer({
        orgId: activeOrgId,
        ...data,
      });

      const newCustomer: Doc<"customers"> = {
        _id: id as Id<"customers">,
        _creationTime: Date.now(),
        orgId: activeOrgId as Id<"organizations">,
        ...data,
      };

      onSelectCustomer(newCustomer);
      setShowCreateForm(false);

      toast.success("Customer created");
    } catch (err: any) {
      toast.error(err.message || "Failed to create customer");
    }
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
          selectedCustomer={selectedCustomer}
          onSelect={onSelectCustomer}
          onCreateNew={() => setShowCreateForm(true)}
          accentClass={accentClass}
        />
      )}

      {/* CREATE FORM */}
      {showCreateForm && (
        <CustomerCreateForm
          onCreated={handleCreateCustomer}
          onCancel={() => setShowCreateForm(false)}
          paymentType={paymentType}
        />
      )}

      {/* FOOTER */}
      <div className="flex justify-between pt-4 border-t">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 me-2" />
          Back
        </Button>

        <Button
          onClick={onNext}
          disabled={!selectedCustomer}
          className={cn(nextBtnClass)}
        >
          Next
          <ArrowRight className="w-4 h-4 ms-2" />
        </Button>
      </div>
    </div>
  );
}