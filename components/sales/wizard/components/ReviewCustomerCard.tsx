"use client";

import { Doc } from "@/convex/_generated/dataModel";
import { User, Phone, Mail, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/components/providers/LanguageProvider";

interface ReviewCustomerCardProps {
  customer: Doc<"customers">;
  className?: string;
}

export default function ReviewCustomerCard({
  customer,
  className,
}: ReviewCustomerCardProps) {
  const { t } = useLanguage();

  return (
    <div className={cn("rounded-xl border bg-muted/20 p-4 space-y-3", className)}>
      {/* Header */}
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        <User className="w-3.5 h-3.5" />
        {t("Customer" as any)}
      </div>

      {/* Name */}
      <div>
        <p className="font-semibold text-base">
          {customer.firstName} {customer.lastName}
        </p>
      </div>

      {/* Contact details */}
      <div className="space-y-1.5 text-sm">
        {customer.phone && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Phone className="w-3.5 h-3.5" />
            <span>{customer.phone}</span>
          </div>
        )}

        {customer.email && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Mail className="w-3.5 h-3.5" />
            <span>{customer.email}</span>
          </div>
        )}

        {customer.nationalId && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <CreditCard className="w-3.5 h-3.5" />
            <span>{customer.nationalId}</span>
          </div>
        )}
      </div>
    </div>
  );
}