"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";

interface CustomerDetailsDialogProps {
  customerId: Id<"customers"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CustomerDetailsDialog({
  customerId,
  open,
  onOpenChange,
}: CustomerDetailsDialogProps) {
  const { activeOrgId } = useOrg();
  const customer = useQuery(
    api.customers.get,
    activeOrgId && customerId
      ? { orgId: activeOrgId, customerId: customerId }
      : "skip"
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl">Customer Details</DialogTitle>
          <DialogDescription>
            Contact and personal information for this customer.
          </DialogDescription>
        </DialogHeader>

        {customer === undefined ? (
          <div className="py-8 text-center text-muted-foreground">
            Loading...
          </div>
        ) : customer === null ? (
          <div className="py-8 text-center text-muted-foreground">
            Customer not found.
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <span className="text-sm font-medium text-muted-foreground">
                  First Name
                </span>
                <p className="text-sm font-semibold">{customer.firstName}</p>
              </div>
              <div className="space-y-1">
                <span className="text-sm font-medium text-muted-foreground">
                  Last Name
                </span>
                <p className="text-sm font-semibold">{customer.lastName}</p>
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <span className="text-sm font-medium text-muted-foreground">
                  Phone
                </span>
                <p className="text-sm">{customer.phone || "N/A"}</p>
              </div>
              <div className="space-y-1">
                <span className="text-sm font-medium text-muted-foreground">
                  WhatsApp
                </span>
                <p className="text-sm">{customer.whatsapp || "N/A"}</p>
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-sm font-medium text-muted-foreground">
                Email
              </span>
              <p className="text-sm">{customer.email || "N/A"}</p>
            </div>

            <Separator />

            <div className="space-y-1">
              <span className="text-sm font-medium text-muted-foreground">
                National ID
              </span>
              <p className="text-sm">{customer.nationalId || "N/A"}</p>
            </div>

            <div className="space-y-1">
              <span className="text-sm font-medium text-muted-foreground">
                Address
              </span>
              <p className="text-sm">{customer.address || "N/A"}</p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
