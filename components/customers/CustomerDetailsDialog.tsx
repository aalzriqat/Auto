"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Id } from "@/convex/_generated/dataModel";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

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

  const relations = useQuery(
    api.customers.getRelations,
    activeOrgId && customerId
      ? { orgId: activeOrgId, customerId: customerId }
      : "skip"
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0">
        <div className="p-6 pb-2">
          <DialogHeader>
            <DialogTitle className="text-xl">
              {customer ? `${customer.firstName} ${customer.lastName}` : "Customer Details"}
            </DialogTitle>
            <DialogDescription>
              Contact information and full interaction history.
            </DialogDescription>
          </DialogHeader>
        </div>

        {customer === undefined ? (
          <div className="py-8 text-center text-muted-foreground p-6">Loading...</div>
        ) : customer === null ? (
          <div className="py-8 text-center text-muted-foreground p-6">Customer not found.</div>
        ) : (
          <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
            <div className="px-6 border-b">
              <TabsList className="bg-transparent h-12 p-0 -mb-px">
                <TabsTrigger 
                  value="overview" 
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  Overview
                </TabsTrigger>
                <TabsTrigger 
                  value="leads_sales" 
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  Leads & Sales
                  {relations && (relations.leads.length > 0 || relations.sales.length > 0) && (
                    <Badge variant="secondary" className="ml-2 text-xs px-1.5 py-0.5">{relations.leads.length + relations.sales.length}</Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger 
                  value="tasks" 
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  Tasks
                  {relations?.tasks && relations.tasks.length > 0 && (
                    <Badge variant="secondary" className="ml-2 text-xs px-1.5 py-0.5">{relations.tasks.length}</Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea className="flex-1 p-6">
              <TabsContent value="overview" className="m-0 focus-visible:outline-none">
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-muted-foreground">First Name</span>
                      <p className="text-sm font-semibold">{customer.firstName}</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-muted-foreground">Last Name</span>
                      <p className="text-sm font-semibold">{customer.lastName}</p>
                    </div>
                  </div>

                  <Separator />

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-muted-foreground">Phone</span>
                      <p className="text-sm">{customer.phone || "N/A"}</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-muted-foreground">WhatsApp</span>
                      <p className="text-sm">{customer.whatsapp || "N/A"}</p>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <span className="text-sm font-medium text-muted-foreground">Email</span>
                    <p className="text-sm">{customer.email || "N/A"}</p>
                  </div>

                  <Separator />

                  <div className="space-y-1">
                    <span className="text-sm font-medium text-muted-foreground">National ID</span>
                    <p className="text-sm">{customer.nationalId || "N/A"}</p>
                  </div>

                  <div className="space-y-1">
                    <span className="text-sm font-medium text-muted-foreground">Address</span>
                    <p className="text-sm">{customer.address || "N/A"}</p>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="leads_sales" className="m-0 focus-visible:outline-none space-y-6">
                <div>
                  <h3 className="font-semibold text-sm mb-3">Past Purchases</h3>
                  {!relations ? (
                    <p className="text-sm text-muted-foreground">Loading...</p>
                  ) : relations.sales.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">No sales recorded for this customer.</p>
                  ) : (
                    <div className="space-y-3">
                      {relations.sales.map((sale) => (
                        <div key={sale._id} className="bg-muted/30 p-3 rounded-lg border text-sm">
                          <div className="flex justify-between items-start mb-2">
                            <span className="font-medium">{sale.vehicleDesc}</span>
                            <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">{sale.status}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-muted-foreground text-xs">
                            <p>Sale Date: {format(sale.saleDate, "PP")}</p>
                            <p>Price: <span className="font-medium text-foreground">${sale.salePrice.toLocaleString()}</span></p>
                            <p>Salesperson: {sale.salespersonName}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <Separator />

                <div>
                  <h3 className="font-semibold text-sm mb-3">Active & Past Leads</h3>
                  {!relations ? (
                    <p className="text-sm text-muted-foreground">Loading...</p>
                  ) : relations.leads.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">No leads associated with this customer.</p>
                  ) : (
                    <div className="space-y-3">
                      {relations.leads.map((lead) => (
                        <div key={lead._id} className="bg-muted/30 p-3 rounded-lg border text-sm">
                          <div className="flex justify-between items-start mb-1">
                            <span className="font-medium">{lead.vehicleDesc}</span>
                            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">{lead.stage}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mb-2">Source: {lead.source} • Assigned: {lead.assignedUserName}</p>
                          {lead.notes && <p className="text-xs italic">"{lead.notes}"</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="tasks" className="m-0 focus-visible:outline-none">
                <h3 className="font-semibold text-sm mb-3">Associated Tasks & Communication</h3>
                {!relations ? (
                  <p className="text-sm text-muted-foreground">Loading...</p>
                ) : relations.tasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No tasks assigned for this customer.</p>
                ) : (
                  <div className="space-y-3">
                    {relations.tasks.map((task) => (
                      <div key={task._id} className="bg-muted/30 p-3 rounded-lg border text-sm">
                        <div className="flex justify-between items-start mb-1">
                          <span className="font-medium">{task.title}</span>
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            task.status === "COMPLETED" ? "bg-green-100 text-green-800" :
                            task.status === "CANCELLED" ? "bg-red-100 text-red-800" :
                            "bg-yellow-100 text-yellow-800"
                          }`}>
                            {task.status}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground mb-2">
                          <p>Due: {format(task.dueDate, "PP p")}</p>
                          <p>Assignee: {task.assignedUserName}</p>
                        </div>
                        {task.description && <p className="text-xs italic">"{task.description}"</p>}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </ScrollArea>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
