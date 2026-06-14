"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Id } from "@/convex/_generated/dataModel";
import { useState } from "react";
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
import { Send, FileText, CheckCircle } from "lucide-react";
import { CustomerFinancialsTab } from "@/components/customers/CustomerFinancialsTab";
import { generateFinanceQuote } from "@/lib/pdf";
import { toast } from "@/components/ui/sonner";

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
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState("overview");

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

  const createApplication = useMutation(api.applications.createFromQuote);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0">
        <div className="p-6 pb-2 shrink-0">
          <DialogHeader>
            <DialogTitle className="text-xl">
              {customer ? `${customer.firstName} ${customer.lastName}` : (t("CustomerDetails" as any))}
            </DialogTitle>
            <DialogDescription>
              {t("CustomerDetailsDialogDesc" as any)}
            </DialogDescription>
          </DialogHeader>
        </div>

        {customer === undefined ? (
          <div className="py-8 text-center text-muted-foreground p-6">{t("Loading" as any)}</div>
        ) : customer === null ? (
          <div className="py-8 text-center text-muted-foreground p-6">{t("NoCustomers" as any)}</div>
        ) : (
          <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
            <div className="px-6 border-b overflow-x-auto [&::-webkit-scrollbar]:hidden shrink-0">
              <TabsList className="bg-transparent h-12 p-0 -mb-px flex w-max min-w-full justify-start">
                <TabsTrigger
                  value="overview"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("Overview" as any)}
                </TabsTrigger>
                <TabsTrigger
                  value="leads_sales"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("LeadsSales" as any)}
                  {relations && (relations.leads.length > 0 || relations.sales.length > 0) && (
                    <Badge variant="secondary" className="ms-2 text-xs px-1.5 py-0.5">{relations.leads.length + relations.sales.length}</Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="quotes"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("Quotes" as any)}
                  {relations && relations.quotes?.length > 0 && (
                    <Badge variant="secondary" className="ms-2 text-xs px-1.5 py-0.5">{relations.quotes.length}</Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="tasks"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("Tasks" as any)}
                  {relations?.tasks && relations.tasks.length > 0 && (
                    <Badge variant="secondary" className="ms-2 text-xs px-1.5 py-0.5">{relations.tasks.length}</Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="financials"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  {t("Financials" as any)}
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0 p-6">
              <TabsContent value="overview" className="m-0 focus-visible:outline-none">
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-muted-foreground">{t("FirstName" as any)}</span>
                      <p className="text-sm font-semibold">{customer.firstName}</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-muted-foreground">{t("LastName" as any)}</span>
                      <p className="text-sm font-semibold">{customer.lastName}</p>
                    </div>
                  </div>

                  <Separator />

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-muted-foreground">{t("Phone" as any)}</span>
                      <p className="text-sm">{customer.phone || (t("NA" as any))}</p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-muted-foreground">{t("WhatsApp" as any)}</span>
                      <p className="text-sm">{customer.whatsapp || (t("NA" as any))}</p>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <span className="text-sm font-medium text-muted-foreground">{t("Email" as any)}</span>
                    <p className="text-sm">{customer.email || (t("NA" as any))}</p>
                  </div>

                  <Separator />

                  <div className="space-y-1">
                    <span className="text-sm font-medium text-muted-foreground">{t("NationalIDPassport" as any)}</span>
                    <p className="text-sm">{customer.nationalId || (t("NA" as any))}</p>
                  </div>

                  <div className="space-y-1">
                    <span className="text-sm font-medium text-muted-foreground">{t("Address" as any)}</span>
                    <p className="text-sm">{customer.address || (t("NA" as any))}</p>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="leads_sales" className="m-0 focus-visible:outline-none space-y-6">
                <div>
                  <h3 className="font-semibold text-sm mb-3">{t("PastPurchases" as any)}</h3>
                  {!relations ? (
                    <p className="text-sm text-muted-foreground">{t("Loading" as any)}</p>
                  ) : relations.sales.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">{t("NoSalesCustomer" as any)}</p>
                  ) : (
                    <div className="space-y-3">
                      {relations.sales.map((sale) => (
                        <div key={sale._id} className="bg-muted/30 p-3 rounded-lg border text-sm">
                          <div className="flex justify-between items-start mb-2">
                            <span className="font-medium">{sale.vehicleDesc}</span>
                            <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">{sale.status}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-muted-foreground text-xs">
                            <p>{t("SaleDate" as any)}: {format(sale.saleDate, "PP")}</p>
                            <p>{t("Price" as any)}: <span className="font-medium text-foreground">{sale.salePrice.toLocaleString()} JOD</span></p>
                            <p>{t("Salesperson" as any)}: {sale.salespersonName}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <Separator />

                <div>
                  <h3 className="font-semibold text-sm mb-3">{t("ActivePastLeads" as any)}</h3>
                  {!relations ? (
                    <p className="text-sm text-muted-foreground">{t("Loading" as any)}</p>
                  ) : relations.leads.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">{t("NoLeadsCustomer" as any)}</p>
                  ) : (
                    <div className="space-y-3">
                      {relations.leads.map((lead) => (
                        <div key={lead._id} className="bg-muted/30 p-3 rounded-lg border text-sm">
                          <div className="flex justify-between items-start mb-1">
                            <span className="font-medium">{lead.vehicleDesc}</span>
                            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">{lead.stage}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mb-2">{t("Source" as any)}: {lead.source} • {t("Assigned" as any)}: {lead.assignedUserName}</p>
                          {lead.notes && <p className="text-xs italic">"{lead.notes}"</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </TabsContent>

              <TabsContent value="quotes" className="m-0 focus-visible:outline-none">
                <h3 className="font-semibold text-sm mb-3">{t("GeneratedQuotes" as any)}</h3>
                {!relations ? (
                  <p className="text-sm text-muted-foreground">{t("Loading" as any)}</p>
                ) : !relations.quotes || relations.quotes.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">{t("NoQuotesCustomer" as any)}</p>
                ) : (
                  <div className="space-y-4">
                    {relations.quotes.map((quote: any) => (
                      <div key={quote._id} className="bg-card shadow-sm p-4 rounded-lg border text-sm flex flex-col space-y-3">
                        <div className="flex justify-between items-start">
                          <div>
                            <span className="font-semibold text-base">{quote.vehicleDesc}</span>
                            <p className="text-xs text-muted-foreground">{quote.companyName}</p>
                          </div>
                          <span className={`text-xs px-2 py-1 rounded-full font-medium ${quote.status === "ACCEPTED" ? "bg-green-100 text-green-800" :
                            quote.status === "EXPIRED" ? "bg-red-100 text-red-800" :
                              "bg-blue-100 text-blue-800"
                            }`}>
                            {quote.status}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 bg-muted/50 p-3 rounded-md">
                          <div>
                            <p className="text-xs text-muted-foreground">{t("VehiclePrice" as any)}</p>
                            <p className="font-medium">{quote.vehiclePrice?.toLocaleString()} JOD</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t("DownPayment" as any)}</p>
                            <p className="font-medium">{quote.downPayment?.toLocaleString()} JOD</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t("Term" as any)}</p>
                            <p className="font-medium">{quote.termMonths} Months</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t("ProfitRate" as any)}</p>
                            <p className="font-medium">{quote.profitRateApplied || 0}%</p>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 border-t pt-3">
                          <div>
                            <p className="text-xs text-muted-foreground">{t("FinancedAmount" as any)}</p>
                            <p className="font-medium">{quote.totalFinancedAmount?.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">{t("TotalProfit" as any)}</p>
                            <p className="font-medium text-orange-600">{quote.totalProfit?.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</p>
                          </div>
                          <div className="bg-primary/10 -m-2 p-2 rounded-md text-center">
                            <p className="text-xs text-primary font-medium">{t("MonthlyInstallment" as any)}</p>
                            <p className="text-lg font-bold text-primary">{quote.monthlyInstallment?.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-xs font-normal">JOD</span></p>
                          </div>
                        </div>

                        <div className="flex justify-between items-center text-xs text-muted-foreground pt-2">
                          <div className="flex flex-col gap-0.5">
                            <p>{t("GeneratedOn" as any)}: {format(quote.createdAt, "PP p")}</p>
                            {quote.createdByUserName && (
                              <p>{t("GeneratedBy" as any) || "Generated By"}: {quote.createdByUserName}</p>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                            size="sm"
                            className="h-8 gap-1 text-primary hover:text-primary/80"
                            onClick={(e) => {
                              e.stopPropagation();
                              try {
                                generateFinanceQuote(
                                  "AutoFlow Dealership",
                                  `${customer.firstName} ${customer.lastName}`,
                                  quote.vehicleDesc,
                                  quote.companyName,
                                  quote.vehiclePrice || 0,
                                  quote.downPayment || 0,
                                  quote.termMonths,
                                  quote.profitRateApplied || 0,
                                  quote.totalFinancedAmount || 0,
                                  quote.totalProfit || 0,
                                  quote.monthlyInstallment || 0,
                                  quote.vehicleId.vin || "N/A"
                                );
                                toast.success(t("QuotePDFGenerated" as any));
                              } catch (err) {
                                toast.error(t("FailedGeneratePDF" as any));
                              }
                            }}
                          >
                            <FileText className="w-4 h-4" />
                            {t("DownloadPDF" as any)}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                const appId = await createApplication({
                                  orgId: activeOrgId!,
                                  quoteId: quote._id,
                                });
                                toast.success(t("ApplicationCreatedSuccess" as any));
                              } catch (err: any) {
                                toast.error(err.message || t("ApplicationCreateFail" as any));
                              }
                            }}
                          >
                            <Send className="w-4 h-4" />
                            {t("SubmitApplication" as any)}
                          </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="tasks" className="m-0 focus-visible:outline-none">
                <h3 className="font-semibold text-sm mb-3">{t("AssociatedTasksComm" as any)}</h3>
                {!relations ? (
                  <p className="text-sm text-muted-foreground">{t("Loading" as any)}</p>
                ) : relations.tasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">{t("NoTasksCustomer" as any)}</p>
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
                          <p>{t("Due" as any)}: {format(task.dueDate, "PP p")}</p>
                          <p>{t("Assignee" as any)}: {task.assignedUserName}</p>
                        </div>
                        {task.description && <p className="text-xs italic">"{task.description}"</p>}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="financials" className="m-0 focus-visible:outline-none p-4">
                <CustomerFinancialsTab customer={customer} />
              </TabsContent>
            </div>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
