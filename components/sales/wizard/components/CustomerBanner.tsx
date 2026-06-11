"use client";

import { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PaymentType } from "../types";

interface CustomerBannerProps {
  customer: Doc<"customers">;
  paymentType: PaymentType;
  onClear: () => void;
}

export function CustomerBanner({
  customer,
  paymentType,
  onClear,
}: CustomerBannerProps) {
  const isCash = paymentType === "CASH";

  const accentClass = isCash
    ? "border-teal-500/30 bg-teal-500/10"
    : "border-indigo-500/30 bg-indigo-500/10";

  const avatarClass = isCash ? "text-teal-400" : "text-indigo-400";

  return (
    <div
      className={cn(
        "rounded-xl border p-4 flex items-center gap-3",
        accentClass
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "w-10 h-10 rounded-full bg-muted flex items-center justify-center text-base font-bold",
          avatarClass
        )}
      >
        {customer.firstName[0]}
        {customer.lastName[0]}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="font-semibold">
          {customer.firstName} {customer.lastName}
        </p>

        <p className="text-sm text-muted-foreground">
          {[customer.phone, customer.nationalId]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {/* Clear */}
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground"
        onClick={onClear}
      >
        <X className="w-4 h-4" />
      </Button>
    </div>
  );
}