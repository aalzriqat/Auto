import { useQuery } from "convex/react";
import {
  ExternalLink,
  Printer,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
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
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { TestDriveDialog } from "@/components/test_drives/TestDriveDialog";
import { WorkOrderDialog } from "@/components/work_orders/WorkOrderDialog";

interface VehicleDetailsDialogProps {
  vehicle: Doc<"vehicles"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canViewPurchasePrice: boolean;
}

export function VehicleDetailsDialog({
  vehicle,
  open,
  onOpenChange,
  canViewPurchasePrice,
}: VehicleDetailsDialogProps) {
  const { activeOrgId } = useOrg();
  
  const relations = useQuery(
    api.vehicles.getRelations,
    activeOrgId && vehicle ? { orgId: activeOrgId, vehicleId: vehicle._id } : "skip"
  );
  
  const [testDriveOpen, setTestDriveOpen] = useState(false);
  const [selectedTestDrive, setSelectedTestDrive] = useState(null);
  
  const [workOrderOpen, setWorkOrderOpen] = useState(false);
  const [selectedWorkOrder, setSelectedWorkOrder] = useState(null);

  if (!vehicle) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-0">
        <div className="p-6 pb-2">
          <DialogHeader>
            <DialogTitle className="text-xl">
              {vehicle.year} {vehicle.make} {vehicle.model}
            </DialogTitle>
            <DialogDescription>
              Detailed information and related records for this vehicle.
            </DialogDescription>
          </DialogHeader>
        </div>

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
                value="expenses" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
              >
                Expenses
                {relations?.expenses && relations.expenses.length > 0 && (
                  <Badge variant="secondary" className="ml-2 text-xs px-1.5 py-0.5">{relations.expenses.length}</Badge>
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
              <TabsTrigger 
                value="test_drives" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
              >
                Test Drives
                {relations?.testDrives && relations.testDrives.length > 0 && (
                  <Badge variant="secondary" className="ml-2 text-xs px-1.5 py-0.5">{relations.testDrives.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="work_orders" 
                className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
              >
                Work Orders
                {relations?.workOrders && relations.workOrders.length > 0 && (
                  <Badge variant="secondary" className="ml-2 text-xs px-1.5 py-0.5">{relations.workOrders.length}</Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="flex-1 p-6">
            <TabsContent value="overview" className="m-0 focus-visible:outline-none">
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">VIN</span>
                  <p className="font-mono text-sm font-semibold bg-muted px-2 py-1 rounded inline-block">{vehicle.vin}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">Status</span>
                  <p className="text-sm font-semibold">{vehicle.status}</p>
                </div>

                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">Make</span>
                  <p className="text-sm">{vehicle.make}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">Model</span>
                  <p className="text-sm">{vehicle.model}</p>
                </div>

                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">Year</span>
                  <p className="text-sm">{vehicle.year}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">Trim</span>
                  <p className="text-sm">{vehicle.trim || "N/A"}</p>
                </div>

                <div className="col-span-2">
                  <Separator className="my-2" />
                </div>

                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">Color</span>
                  <p className="text-sm">{vehicle.color}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">Mileage</span>
                  <p className="text-sm">{vehicle.mileage.toLocaleString()} miles</p>
                </div>

                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">Transmission</span>
                  <p className="text-sm">{vehicle.transmission}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">Fuel Type</span>
                  <p className="text-sm">{vehicle.fuelType}</p>
                </div>

                <div className="col-span-2">
                  <Separator className="my-2" />
                </div>

                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">Selling Price</span>
                  <p className="text-sm font-bold text-green-500">${vehicle.sellingPrice.toLocaleString()}</p>
                </div>
                {canViewPurchasePrice && vehicle.purchasePrice !== undefined && (
                  <div className="space-y-1">
                    <span className="text-sm font-medium text-muted-foreground">Purchase Price</span>
                    <p className="text-sm font-medium">${vehicle.purchasePrice.toLocaleString()}</p>
                  </div>
                )}

                {vehicle.notes && (
                  <div className="col-span-2 space-y-1 mt-2 bg-muted/50 p-3 rounded-lg border">
                    <span className="text-sm font-medium text-muted-foreground block mb-1">Notes</span>
                    <p className="text-sm whitespace-pre-wrap">{vehicle.notes}</p>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="leads_sales" className="m-0 focus-visible:outline-none space-y-6">
              <div>
                <h3 className="font-semibold text-sm mb-3">Sales Record</h3>
                {!relations ? (
                  <p className="text-sm text-muted-foreground">Loading...</p>
                ) : relations.sales.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No sales recorded for this vehicle.</p>
                ) : (
                  <div className="space-y-3">
                    {relations.sales.map((sale) => (
                      <div key={sale._id} className="bg-muted/30 p-3 rounded-lg border text-sm">
                        <div className="flex justify-between items-start mb-2">
                          <span className="font-medium">{sale.customerName}</span>
                          <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">{sale.status}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-muted-foreground text-xs mt-2">
                          <p>Sale Date: {format(sale.saleDate, "PP")}</p>
                          <p>Price: <span className="font-medium text-foreground">${sale.salePrice.toLocaleString()}</span></p>
                          <p>Salesperson: {sale.salespersonName}</p>
                        </div>
                        <div className="mt-3 flex justify-end border-t border-border/50 pt-2">
                          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => window.open(`/sales/${sale._id}/print`, '_blank')}>
                            <Printer className="h-3 w-3 mr-1" /> Print Bill of Sale
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              <div>
                <h3 className="font-semibold text-sm mb-3">Associated Leads</h3>
                {!relations ? (
                  <p className="text-sm text-muted-foreground">Loading...</p>
                ) : relations.leads.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No leads currently interested in this vehicle.</p>
                ) : (
                  <div className="space-y-3">
                    {relations.leads.map((lead) => (
                      <div key={lead._id} className="bg-muted/30 p-3 rounded-lg border text-sm">
                        <div className="flex justify-between items-start mb-1">
                          <span className="font-medium">{lead.customerName}</span>
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

            <TabsContent value="expenses" className="m-0 focus-visible:outline-none">
              <h3 className="font-semibold text-sm mb-3">Vehicle Expenses</h3>
              {!relations ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : relations.expenses.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No expenses recorded for this vehicle.</p>
              ) : (
                <div className="space-y-3">
                  {relations.expenses.map((exp) => (
                    <div key={exp._id} className="bg-muted/30 p-3 rounded-lg border text-sm flex justify-between items-center">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <p className="font-medium">{exp.title}</p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${exp.status === "PAID" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}`}>
                            {exp.status}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">{format(exp.date, "PP")} • {exp.category}</p>
                        {(exp.vendor || exp.payerName) && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {exp.vendor && <span>Vendor: {exp.vendor}</span>}
                            {exp.vendor && exp.payerName && <span> • </span>}
                            {exp.payerName && <span>Paid By: {exp.payerName}</span>}
                          </p>
                        )}
                        {exp.notes && <p className="text-xs mt-1 italic">{exp.notes}</p>}
                      </div>
                      <span className="font-semibold text-destructive">${exp.amount.toLocaleString()}</span>
                    </div>
                  ))}
                  <div className="pt-2 border-t flex justify-between items-center">
                    <span className="text-sm font-semibold">Total Expenses</span>
                    <span className="font-bold text-destructive">
                      ${relations.expenses.reduce((sum, e) => sum + e.amount, 0).toLocaleString()}
                    </span>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="tasks" className="m-0 focus-visible:outline-none">
              <h3 className="font-semibold text-sm mb-3">Associated Tasks</h3>
              {!relations ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : relations.tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No tasks assigned for this vehicle.</p>
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
            <TabsContent value="test_drives" className="m-0 focus-visible:outline-none">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-sm">Test Drives Record</h3>
                <Button size="sm" onClick={() => { setSelectedTestDrive(null); setTestDriveOpen(true); }}>Log Test Drive</Button>
              </div>
              {!relations ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : !relations.testDrives || relations.testDrives.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No test drives recorded.</p>
              ) : (
                <div className="space-y-3">
                  {relations.testDrives.map((td: any) => (
                    <div key={td._id} className="bg-muted/30 p-3 rounded-lg border text-sm">
                      <div className="flex justify-between items-start mb-2">
                        <span className="font-medium">{td.customerName}</span>
                        <span className={`text-xs px-2 py-0.5 rounded ${td.endTime ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}`}>
                          {td.endTime ? 'Completed' : 'In Progress'}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-muted-foreground text-xs">
                        <p>Salesperson: {td.salespersonName}</p>
                        <p>Demo Plate: {td.demoPlateNumber || "N/A"}</p>
                        <p>Started: {format(td.startTime, "PP p")}</p>
                        {td.endTime && <p>Ended: {format(td.endTime, "PP p")}</p>}
                      </div>
                      {td.notes && (
                        <p className="text-xs mt-2 italic border-t pt-2 border-border/50">"{td.notes}"</p>
                      )}
                      {!td.endTime && (
                        <div className="mt-3 flex justify-end">
                          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { setSelectedTestDrive(td); setTestDriveOpen(true); }}>
                            Complete Drive
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
            <TabsContent value="work_orders" className="m-0 focus-visible:outline-none">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-sm">Service & Work Orders</h3>
                <Button size="sm" onClick={() => { setSelectedWorkOrder(null); setWorkOrderOpen(true); }}>New Work Order</Button>
              </div>
              {!relations ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : !relations.workOrders || relations.workOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No work orders recorded.</p>
              ) : (
                <div className="space-y-3">
                  {relations.workOrders.map((wo: any) => (
                    <div key={wo._id} className="bg-muted/30 p-4 rounded-lg border text-sm hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => { setSelectedWorkOrder(wo); setWorkOrderOpen(true); }}>
                      <div className="flex justify-between items-start mb-2">
                        <span className="font-semibold">{wo.title}</span>
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                          wo.status === 'COMPLETED' ? 'bg-green-100 text-green-800' : 
                          wo.status === 'IN_PROGRESS' ? 'bg-amber-100 text-amber-800' : 
                          'bg-gray-100 text-gray-800'
                        }`}>
                          {wo.status}
                        </span>
                      </div>
                      
                      <div className="flex justify-between items-center mt-3 pt-3 border-t border-border/50">
                        <span className="text-muted-foreground text-xs">{wo.tasks.length} task{wo.tasks.length !== 1 && 's'}</span>
                        <span className="font-semibold text-primary">Total: ${wo.totalCost.toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </DialogContent>
      {vehicle && (
        <>
          <TestDriveDialog 
            open={testDriveOpen} 
            onOpenChange={setTestDriveOpen} 
            vehicleId={vehicle._id} 
            testDrive={selectedTestDrive} 
          />
          <WorkOrderDialog 
            open={workOrderOpen} 
            onOpenChange={setWorkOrderOpen} 
            vehicleId={vehicle._id} 
            workOrder={selectedWorkOrder} 
          />
        </>
      )}
    </Dialog>
  );
}
