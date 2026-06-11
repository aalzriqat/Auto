import { useQuery } from "convex/react";
import {
  ExternalLink,
  Printer,
  Banknote,
  CheckSquare,
  Wrench,
  Users,
  Car,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { TestDriveDialog } from "@/components/test_drives/TestDriveDialog";
import { WorkOrderDialog } from "@/components/work_orders/WorkOrderDialog";
import { VehicleValuationsTab } from "@/components/vehicles/VehicleValuationsTab";
import { EmptyState } from "@/components/ui/empty-state";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";

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
  const { t } = useLanguage();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();

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
        <div className="p-6 pb-2 shrink-0">
          <DialogHeader>
            <DialogTitle className="text-xl">
              {vehicle.year} {vehicle.make} {vehicle.model}
            </DialogTitle>
            <DialogDescription>
              {t("VehicleDetailsDesc" as any) || "Detailed information and related records for this vehicle."}
            </DialogDescription>
          </DialogHeader>
        </div>

        <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
          <div className="px-6 border-b overflow-x-auto [&::-webkit-scrollbar]:hidden shrink-0">
            <TabsList className="bg-transparent h-12 p-0 -mb-px flex w-max min-w-full justify-start">
              {(!permissionsLoading && hasPermission(PERMISSIONS.VIEW_VEHICLE_INFO)) && (
                <TabsTrigger
                  value="overview"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("Overview" as any)}
                </TabsTrigger>
              )}
              {(!permissionsLoading && hasPermission(PERMISSIONS.VIEW_VEHICLE_LEADS)) && (
                <TabsTrigger
                  value="leads_sales"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("LeadsSales" as any) || "Leads & Sales"}
                  {relations && (relations.leads.length > 0 || relations.sales.length > 0) && (
                    <Badge variant="secondary" className="ms-2 text-xs px-1.5 py-0.5">{relations.leads.length + relations.sales.length}</Badge>
                  )}
                </TabsTrigger>
              )}
              {(!permissionsLoading && hasPermission(PERMISSIONS.VIEW_VEHICLE_EXPENSES)) && (
                <TabsTrigger
                  value="expenses"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("Expenses" as any)}
                  {relations?.expenses && relations.expenses.length > 0 && (
                    <Badge variant="secondary" className="ms-2 text-xs px-1.5 py-0.5">{relations.expenses.length}</Badge>
                  )}
                </TabsTrigger>
              )}
              {(!permissionsLoading && hasPermission(PERMISSIONS.VIEW_VEHICLE_TASKS)) && (
                <TabsTrigger
                  value="tasks"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("Tasks" as any)}
                  {relations?.tasks && relations.tasks.length > 0 && (
                    <Badge variant="secondary" className="ms-2 text-xs px-1.5 py-0.5">{relations.tasks.length}</Badge>
                  )}
                </TabsTrigger>
              )}
              {(!permissionsLoading && hasPermission(PERMISSIONS.VIEW_VEHICLE_TEST_DRIVES)) && (
                <TabsTrigger
                  value="test_drives"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("TestDrives" as any)}
                  {relations?.testDrives && relations.testDrives.length > 0 && (
                    <Badge variant="secondary" className="ms-2 text-xs px-1.5 py-0.5">{relations.testDrives.length}</Badge>
                  )}
                </TabsTrigger>
              )}
              {(!permissionsLoading && hasPermission(PERMISSIONS.VIEW_VEHICLE_WORK_ORDERS)) && (
                <TabsTrigger
                  value="work_orders"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("WorkOrders" as any)}
                  {relations?.workOrders && relations.workOrders.length > 0 && (
                    <Badge variant="secondary" className="ms-2 text-xs px-1.5 py-0.5">{relations.workOrders.length}</Badge>
                  )}
                </TabsTrigger>
              )}
              {(!permissionsLoading && hasPermission(PERMISSIONS.VIEW_VEHICLE_VALUATIONS)) && (
                <TabsTrigger
                  value="valuations"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("Valuations" as any)}
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 p-6">
            <TabsContent value="overview" className="m-0 focus-visible:outline-none">
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("VIN" as any)}</span>
                  <p className="font-mono text-sm font-semibold bg-muted px-2 py-1 rounded inline-block">{vehicle.vin}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("Status" as any)}</span>
                  <p className="text-sm font-semibold">
                    {vehicle.status === "AVAILABLE" ? t("StatusAvailable" as any) :
                      vehicle.status === "RESERVED" ? t("StatusReserved" as any) :
                        vehicle.status === "SOLD" ? t("StatusSold" as any) :
                          vehicle.status === "IN_INSPECTION" ? t("StatusInInspection" as any) :
                            vehicle.status === "IN_REPAIR" ? t("StatusInRepair" as any) :
                              vehicle.status === "ARCHIVED" ? t("StatusArchived" as any) : vehicle.status}
                  </p>
                </div>

                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("Make" as any) || "Make"}</span>
                  <p className="text-sm">{vehicle.make}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("Model" as any) || "Model"}</span>
                  <p className="text-sm">{vehicle.model}</p>
                </div>

                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("Year" as any)}</span>
                  <p className="text-sm">{vehicle.year}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("Trim" as any) || "Trim"}</span>
                  <p className="text-sm">{vehicle.trim || "N/A"}</p>
                </div>

                <div className="col-span-2">
                  <Separator className="my-2" />
                </div>

                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("Color" as any) || "Color"}</span>
                  <p className="text-sm">{vehicle.color}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("Mileage" as any) || "Mileage"}</span>
                  <p className="text-sm">{vehicle.mileage.toLocaleString()}</p>
                </div>

                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("Transmission" as any) || "Transmission"}</span>
                  <p className="text-sm">{vehicle.transmission}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("FuelType" as any) || "Fuel Type"}</span>
                  <p className="text-sm">{vehicle.fuelType}</p>
                </div>

                <div className="col-span-2">
                  <Separator className="my-2" />
                </div>

                <div className="space-y-1">
                  <span className="text-sm font-medium text-muted-foreground">{t("SellingPrice" as any) || "Selling Price"}</span>
                  <p className="text-sm font-bold text-green-500">{vehicle.sellingPrice.toLocaleString()} JOD</p>
                </div>
                {canViewPurchasePrice && vehicle.purchasePrice !== undefined && (
                  <div className="space-y-1">
                    <span className="text-sm font-medium text-muted-foreground">{t("PurchasePrice" as any) || "Purchase Price"}</span>
                    <p className="text-sm font-medium">{vehicle.purchasePrice.toLocaleString()} JOD</p>
                  </div>
                )}

                {vehicle.notes && (
                  <div className="col-span-2 space-y-1 mt-2 bg-muted/50 p-3 rounded-lg border">
                    <span className="text-sm font-medium text-muted-foreground block mb-1">{t("Notes" as any)}</span>
                    <p className="text-sm whitespace-pre-wrap">{vehicle.notes}</p>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="leads_sales" className="m-0 focus-visible:outline-none space-y-6">
              <div>
                <h3 className="font-semibold text-sm mb-3">{t("SalesRecord" as any) || "Sales Record"}</h3>
                {!relations ? (
                  <div className="space-y-3">
                    <Skeleton className="h-[100px] w-full rounded-lg" />
                    <Skeleton className="h-[100px] w-full rounded-lg" />
                  </div>
                ) : relations.sales.length === 0 ? (
                  <EmptyState icon={Banknote} title={t("NoSales" as any) || "No sales recorded for this vehicle."} />
                ) : (
                  <div className="space-y-3">
                    {relations.sales.map((sale) => (
                      <div key={sale._id} className="bg-muted/30 p-3 rounded-lg border text-sm">
                        <div className="flex justify-between items-start mb-2">
                          <span className="font-medium">{sale.customerName}</span>
                          <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">{sale.status}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-muted-foreground text-xs mt-2">
                          <p>{t("SaleDate" as any) || "Sale Date"}: {format(sale.saleDate, "PP")}</p>
                          <p>{t("Price" as any)}: <span className="font-medium text-foreground">{sale.salePrice.toLocaleString()} JOD</span></p>
                          <p>{t("Salesperson" as any)}: {sale.salespersonName}</p>
                        </div>
                        <div className="mt-3 flex justify-end border-t border-border/50 pt-2">
                          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => window.open(`/sales/${sale._id}/print`, '_blank')}>
                            <Printer className="h-3 w-3 me-1" /> {t("PrintBillOfSale" as any) || "Print Bill of Sale"}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              <div>
                <h3 className="font-semibold text-sm mb-3">{t("AssociatedLeads" as any) || "Associated Leads"}</h3>
                {!relations ? (
                  <div className="space-y-3">
                    <Skeleton className="h-[80px] w-full rounded-lg" />
                    <Skeleton className="h-[80px] w-full rounded-lg" />
                  </div>
                ) : relations.leads.length === 0 ? (
                  <EmptyState icon={Users} title={t("NoLeads" as any) || "No leads currently interested in this vehicle."} />
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
              <h3 className="font-semibold text-sm mb-3">{t("VehicleExpenses" as any) || "Vehicle Expenses"}</h3>
              {!relations ? (
                <div className="space-y-3">
                  <Skeleton className="h-[80px] w-full rounded-lg" />
                  <Skeleton className="h-[80px] w-full rounded-lg" />
                </div>
              ) : relations.expenses.length === 0 ? (
                <EmptyState icon={Banknote} title={t("NoExpenses" as any) || "No expenses recorded for this vehicle."} />
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
                      <span className="font-semibold text-destructive">{exp.amount.toLocaleString()} JOD</span>
                    </div>
                  ))}
                  <div className="pt-2 border-t flex justify-between items-center">
                    <span className="text-sm font-semibold">{t("TotalExpenses" as any) || "Total Expenses"}</span>
                    <span className="font-bold text-destructive">
                      {relations.expenses.reduce((sum, e) => sum + e.amount, 0).toLocaleString()} JOD
                    </span>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="tasks" className="m-0 focus-visible:outline-none">
              <h3 className="font-semibold text-sm mb-3">{t("AssociatedTasks" as any) || "Associated Tasks"}</h3>
              {!relations ? (
                <div className="space-y-3">
                  <Skeleton className="h-[80px] w-full rounded-lg" />
                  <Skeleton className="h-[80px] w-full rounded-lg" />
                </div>
              ) : relations.tasks.length === 0 ? (
                <EmptyState icon={CheckSquare} title={t("NoTasks" as any) || "No tasks assigned for this vehicle."} />
              ) : (
                <div className="space-y-3">
                  {relations.tasks.map((task) => (
                    <div key={task._id} className="bg-muted/30 p-3 rounded-lg border text-sm">
                      <div className="flex justify-between items-start mb-1">
                        <span className="font-medium">{task.title}</span>
                        <span className={`text-xs px-2 py-0.5 rounded ${task.status === "COMPLETED" ? "bg-green-100 text-green-800" :
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
                <h3 className="font-semibold text-sm">{t("TestDrivesRecord" as any) || "Test Drives Record"}</h3>
                <Button size="sm" onClick={() => { setSelectedTestDrive(null); setTestDriveOpen(true); }}>{t("LogTestDrive" as any) || "Log Test Drive"}</Button>
              </div>
              {!relations ? (
                <div className="space-y-3 mt-4">
                  <Skeleton className="h-[120px] w-full rounded-lg" />
                  <Skeleton className="h-[120px] w-full rounded-lg" />
                </div>
              ) : !relations.testDrives || relations.testDrives.length === 0 ? (
                <EmptyState icon={Car} title={t("NoTestDrives" as any) || "No test drives recorded."} />
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
                        <p>{t("Salesperson" as any)}: {td.salespersonName}</p>
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
                            {t("CompleteDrive" as any)}
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
                <h3 className="font-semibold text-sm">{t("ServiceWorkOrders" as any) || "Service & Work Orders"}</h3>
                <Button size="sm" onClick={() => { setSelectedWorkOrder(null); setWorkOrderOpen(true); }}>{t("NewWorkOrder" as any) || "New Work Order"}</Button>
              </div>
              {!relations ? (
                <div className="space-y-3 mt-4">
                  <Skeleton className="h-[100px] w-full rounded-lg" />
                  <Skeleton className="h-[100px] w-full rounded-lg" />
                </div>
              ) : !relations.workOrders || relations.workOrders.length === 0 ? (
                <EmptyState icon={Wrench} title={t("NoWorkOrders" as any) || "No work orders recorded."} />
              ) : (
                <div className="space-y-3">
                  {relations.workOrders.map((wo: any) => (
                    <div key={wo._id} className="bg-muted/30 p-4 rounded-lg border text-sm hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => { setSelectedWorkOrder(wo); setWorkOrderOpen(true); }}>
                      <div className="flex justify-between items-start mb-2">
                        <span className="font-semibold">{wo.title}</span>
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${wo.status === 'COMPLETED' ? 'bg-green-100 text-green-800' :
                            wo.status === 'IN_PROGRESS' ? 'bg-amber-100 text-amber-800' :
                              'bg-gray-100 text-gray-800'
                          }`}>
                          {wo.status}
                        </span>
                      </div>

                      <div className="flex justify-between items-center mt-3 pt-3 border-t border-border/50">
                        <span className="text-muted-foreground text-xs">{wo.tasks.length} task{wo.tasks.length !== 1 && 's'}</span>
                        <span className="font-semibold text-primary">{t("Total" as any)}: {wo.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
            <TabsContent value="valuations" className="m-0 focus-visible:outline-none p-4">
              <VehicleValuationsTab vehicleId={vehicle._id} />
            </TabsContent>
          </div>
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
