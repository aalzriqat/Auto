"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Id } from "@/convex/_generated/dataModel";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
import { Send, FileText, Phone, MessageCircle, Mail, Plus, ReceiptText, Car, CheckSquare, CircleDollarSign } from "lucide-react";
import { CustomerFinancialsTab } from "@/components/customers/CustomerFinancialsTab";
import { QuotePrintTemplate } from "@/components/sales/QuotePrintTemplate";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { toast } from "@/components/ui/sonner";
import { downloadElementAsPdf } from "@/lib/htmlToPdf";
import { QuoteDepositManager } from "@/components/deposits/QuoteDepositManager";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { getErrorMessage } from "@/lib/errors";
import { buildWhatsAppDeepLink } from "@/lib/whatsappDeepLink";

interface CustomerActivityItem {
  id: string;
  kind: "lead" | "sale" | "quote" | "task";
  title: string;
  detail: string;
  status: string;
  timestamp: number;
}

interface CustomerDetailsDialogProps {
  customerId: Id<"customers"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CustomerActivityIcon({ kind }: Readonly<Pick<CustomerActivityItem, "kind">>) {
  switch (kind) {
    case "sale":
      return <CircleDollarSign className="h-4 w-4" />;
    case "lead":
      return <Car className="h-4 w-4" />;
    case "quote":
      return <FileText className="h-4 w-4" />;
    default:
      return <CheckSquare className="h-4 w-4" />;
  }
}

function CustomerActivityTimeline({
  items,
  isLoading,
  loadingLabel,
}: Readonly<{
  items: CustomerActivityItem[];
  isLoading: boolean;
  loadingLabel: string;
}>) {
  if (isLoading) return <p className="text-sm text-muted-foreground">{loadingLabel}</p>;
  if (items.length === 0) {
    return <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">No customer activity yet.</p>;
  }

  return (
    <div className="relative space-y-0 before:absolute before:bottom-4 before:start-[17px] before:top-4 before:w-px before:bg-border">
      {items.map((activity) => (
        <div key={activity.id} className="relative flex gap-3 py-3">
          <span className="z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-background">
            <CustomerActivityIcon kind={activity.kind} />
          </span>
          <div className="min-w-0 flex-1 rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><p className="text-sm font-medium">{activity.title}</p><p className="text-xs text-muted-foreground">{activity.detail}</p></div>
              <Badge variant="outline">{activity.status}</Badge>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{format(activity.timestamp, "PP p")}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function CustomerDetailsDialog({
  customerId,
  open,
  onOpenChange,
}: CustomerDetailsDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const router = useRouter();
  // This dialog is reachable with VIEW_CUSTOMERS alone — RECEPTION has that and
  // not VIEW_SALES. `deposits.quoteAllocation` requires VIEW_SALES and throws,
  // and convex/react rethrows a query error during render, so mounting it
  // unconditionally replaced the whole page with the error boundary for that
  // role. The server guard stays strict; the surface just stops asking.
  const { hasPermission } = usePermissions();
  const canViewSales = hasPermission(PERMISSIONS.VIEW_SALES);
  const canCreateLead = hasPermission(PERMISSIONS.CREATE_LEADS) || hasPermission(PERMISSIONS.CREATE_LEADS_REQUEST);
  const canCreateQuote = canViewSales && (
    hasPermission(PERMISSIONS.CREATE_SALES) || hasPermission(PERMISSIONS.CREATE_SALES_REQUEST)
  );
  const [printingQuoteId, setPrintingQuoteId] = useState<Id<"quotes"> | null>(null);

  const orgSettings = useOrgSettings();
  const logoUrl = useQuery(
    api.orgSettings.getLogoUrl,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const orgBranding = {
    name: orgSettings?.dealershipName,
    legalName: orgSettings?.legalCompanyName,
    logoUrl,
    primaryColor: orgSettings?.primaryColor,
    address: orgSettings?.dealershipAddress,
    phone: orgSettings?.dealershipPhone,
    currencySymbol: orgSettings?.currencySymbol,
  };

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

  async function handleDownloadQuote(quote: any) {
    setPrintingQuoteId(quote._id);
    // Wait for the (now-mounted) print template to actually paint before capturing it.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const saved = await downloadElementAsPdf("pdf-quote-content", `Quote_${customer?.firstName ?? ""}.pdf`);
    if (saved) {
      toast.success(t("QuotePDFGenerated" as any));
    } else {
      toast.error(t("FailedGeneratePDF" as any));
    }
    setPrintingQuoteId(null);
  }

  const printingQuote = relations?.quotes?.find((q: any) => q._id === printingQuoteId);
  const activityItems = useMemo<CustomerActivityItem[]>(() => {
    if (!relations) return [];
    return [
      ...relations.leads.map((lead) => ({
        id: `lead-${lead._id}`,
        kind: "lead" as const,
        title: `Lead · ${lead.vehicleDesc}`,
        detail: `${lead.source} · ${lead.assignedUserName}`,
        status: lead.stage,
        timestamp: lead.updatedAt ?? lead._creationTime,
      })),
      ...relations.sales.map((sale) => ({
        id: `sale-${sale._id}`,
        kind: "sale" as const,
        title: `Sale · ${sale.vehicleDesc}`,
        detail: `${sale.salePrice.toLocaleString()} JOD · ${sale.salespersonName}`,
        status: sale.status,
        timestamp: sale.saleDate,
      })),
      ...relations.quotes.map((quote) => ({
        id: `quote-${quote._id}`,
        kind: "quote" as const,
        title: `Quote · ${quote.vehicleDesc}`,
        detail: `${quote.totalFinancedAmount?.toLocaleString() ?? quote.vehiclePrice?.toLocaleString() ?? "—"} JOD`,
        status: quote.status,
        timestamp: quote.createdAt,
      })),
      ...relations.tasks.map((task) => ({
        id: `task-${task._id}`,
        kind: "task" as const,
        title: `Task · ${task.title}`,
        detail: `${task.assignedUserName} · due ${format(task.dueDate, "PP p")}`,
        status: task.status,
        timestamp: task._creationTime,
      })),
    ].sort((first, second) => second.timestamp - first.timestamp);
  }, [relations]);

  const whatsAppUrl = customer
    ? buildWhatsAppDeepLink(customer.whatsapp || customer.phone || "", `Hello ${customer.firstName}`)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-0">
        <div className="p-6 pb-2 shrink-0">
          <DialogHeader>
            <DialogTitle className="text-xl">
              {customer ? `${customer.firstName} ${customer.lastName}` : (t("CustomerDetails" as any))}
            </DialogTitle>
            <DialogDescription>
              {t("CustomerDetailsDialogDesc" as any)}
            </DialogDescription>
          </DialogHeader>
          {customer && (
            <div className="mt-4 flex flex-wrap gap-2">
              {customer.phone && <Button asChild variant="outline" size="sm"><a href={`tel:${customer.phone}`}><Phone className="h-4 w-4 me-2" />Call</a></Button>}
              {whatsAppUrl && <Button asChild variant="outline" size="sm"><a href={whatsAppUrl} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4 me-2" />WhatsApp</a></Button>}
              {customer.email && <Button asChild variant="outline" size="sm"><a href={`mailto:${customer.email}`}><Mail className="h-4 w-4 me-2" />Email</a></Button>}
              {canCreateLead && <Button size="sm" onClick={() => { onOpenChange(false); router.push(`/${activeOrgId}/leads?customerId=${customer._id}`); }}><Plus className="h-4 w-4 me-2" />New lead</Button>}
              {canCreateQuote && <Button variant="secondary" size="sm" onClick={() => { onOpenChange(false); router.push(`/${activeOrgId}/sales?customerId=${customer._id}`); }}><ReceiptText className="h-4 w-4 me-2" />New quote</Button>}
            </div>
          )}
        </div>

        {customer === undefined ? (
          <div className="py-8 text-center text-muted-foreground p-6">{t("Loading" as any)}</div>
        ) : customer === null ? (
          <div className="py-8 text-center text-muted-foreground p-6">{t("NoCustomers" as any)}</div>
        ) : (
          <Tabs defaultValue="activity" className="flex-1 flex flex-col min-h-0">
            <div className="px-6 border-b overflow-x-auto [&::-webkit-scrollbar]:hidden shrink-0">
              <TabsList className="bg-transparent h-12 p-0 -mb-px flex w-max min-w-full justify-start">
                <TabsTrigger
                  value="activity"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  Activity
                  {activityItems.length > 0 && <Badge variant="secondary" className="ms-2 text-xs px-1.5 py-0.5">{activityItems.length}</Badge>}
                </TabsTrigger>
                <TabsTrigger
                  value="deals"
                  className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none h-12 px-6"
                >
                  Deals
                  {relations && (relations.leads.length > 0 || relations.sales.length > 0 || relations.quotes.length > 0) && (
                    <Badge variant="secondary" className="ms-2 text-xs px-1.5 py-0.5">{relations.leads.length + relations.sales.length + relations.quotes.length}</Badge>
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
              <TabsContent value="activity" className="m-0 focus-visible:outline-none space-y-5">
                <div className="grid grid-cols-1 gap-3 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div><p className="text-xs text-muted-foreground">Phone</p><p className="text-sm font-medium">{customer.phone || "—"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Email</p><p className="text-sm font-medium truncate">{customer.email || "—"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Source</p><p className="text-sm font-medium">{customer.source || "Direct"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Customer since</p><p className="text-sm font-medium">{format(customer.createdAt ?? customer._creationTime, "PP")}</p></div>
                </div>

                <CustomerActivityTimeline items={activityItems} isLoading={!relations} loadingLabel={t("Loading")} />
              </TabsContent>

              <TabsContent value="deals" className="m-0 rounded-lg border p-4 focus-visible:outline-none space-y-6">
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
                          {lead.notes && <p className="text-xs italic">&ldquo;{lead.notes}&rdquo;</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <Separator />
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

                        <div className={`grid grid-cols-2 ${quote.companyId ? "md:grid-cols-4" : ""} gap-4 bg-muted/50 p-3 rounded-md`}>
                          <div>
                            <p className="text-xs text-muted-foreground">{t("VehiclePrice" as any)}</p>
                            <p className="font-medium">{quote.vehiclePrice?.toLocaleString()} JOD</p>
                          </div>
                          {quote.companyId && (
                            <div>
                              <p className="text-xs text-muted-foreground">{t("DownPayment" as any)}</p>
                              <p className="font-medium">{quote.downPayment?.toLocaleString()} JOD</p>
                            </div>
                          )}
                          {quote.companyId && (
                            <div>
                              <p className="text-xs text-muted-foreground">{t("Term" as any)}</p>
                              <p className="font-medium">{quote.termMonths} Months</p>
                            </div>
                          )}
                          {quote.companyId && (
                            <div>
                              <p className="text-xs text-muted-foreground">{t("ProfitRate" as any)}</p>
                              <p className="font-medium">{quote.profitRateApplied || 0}%</p>
                            </div>
                          )}
                        </div>

                        <div className={`grid grid-cols-2 ${quote.companyId ? "md:grid-cols-3" : ""} gap-4 border-t pt-3`}>
                          <div>
                            <p className="text-xs text-muted-foreground">{t("TotalAmountDueFinanced" as any)}</p>
                            <p className="font-medium">{quote.totalFinancedAmount?.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</p>
                          </div>
                          {quote.companyId && (
                            <div>
                              <p className="text-xs text-muted-foreground">{t("TotalProfit" as any)}</p>
                              <p className="font-medium text-orange-600">{quote.totalProfit?.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</p>
                            </div>
                          )}
                          {quote.companyId && (
                            <div className="bg-primary/10 -m-2 p-2 rounded-md text-center">
                              <p className="text-xs text-primary font-medium">{t("MonthlyInstallment" as any)}</p>
                              <p className="text-lg font-bold text-primary">{quote.monthlyInstallment?.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-xs font-normal">JOD</span></p>
                            </div>
                          )}
                        </div>

                        {/* The عربون against this quote, for the life of the
                            deal — not only in the wizard session that took it.
                            A share released by a cancelled sale or a car
                            leaving the deal has to be decided somewhere, and
                            the deposits screen deliberately refuses to pay one
                            out: it belongs to the car it was put against. */}
                        {activeOrgId && canViewSales && (
                          <div className="border-t pt-3">
                            <QuoteDepositManager orgId={activeOrgId} quoteId={quote._id} />
                          </div>
                        )}

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
                              handleDownloadQuote(quote);
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
                                await createApplication({
                                  orgId: activeOrgId!,
                                  quoteId: quote._id,
                                });
                                toast.success(t("ApplicationCreatedSuccess" as any));
                              } catch (error) {
                                toast.error(getErrorMessage(error));
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

              <TabsContent value="financials" className="m-0 focus-visible:outline-none p-4">
                <CustomerFinancialsTab customer={customer} />
              </TabsContent>
            </div>
          </Tabs>
        )}

        {printingQuote && customer && (
          <QuotePrintTemplate
            paymentType={printingQuote.companyId ? "INSTALLMENT" : "CASH"}
            wizardData={{} as any}
            selectedVehicle={printingQuote.vehicle ?? undefined}
            selectedCustomer={customer}
            selectedResult={{
              totalFinancedAmount: printingQuote.totalFinancedAmount,
              recipientName: printingQuote.recipientName || `${customer.firstName} ${customer.lastName}`,
            }}
            dateStr={format(printingQuote.createdAt, "PP")}
            orgBranding={orgBranding}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
