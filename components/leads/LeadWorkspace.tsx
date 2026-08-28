"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { ArrowLeft, Car, CheckSquare, FileText, Mail, MessageCircle, Pencil, Phone, User } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { buildWhatsAppDeepLink } from "@/lib/whatsappDeepLink";
import { interpolate } from "@/lib/i18n/interpolate";
import { translateLeadSourceLabel } from "@/lib/i18n/defaultLabels";
import { translateLeadStage, translateVehicleStatus, translateWorkflowStatus } from "@/lib/i18n/statusLabels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LeadActivityTrail } from "@/components/leads/LeadActivityTrail";
import { LeadCustomerMessages } from "@/components/leads/LeadCustomerMessages";
import { LeadDialog } from "@/components/leads/LeadDialog";

interface LeadWorkspaceProps {
  leadId: Id<"leads">;
}

export function LeadWorkspace({ leadId }: Readonly<LeadWorkspaceProps>) {
  const router = useRouter();
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();
  const localeCode = locale === "ar" ? "ar-JO" : "en-US";
  const { hasPermission } = usePermissions();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const canEdit = hasPermission(PERMISSIONS.EDIT_LEADS);
  const canViewCustomers = hasPermission(PERMISSIONS.VIEW_CUSTOMERS);
  const canCreateQuote = hasPermission(PERMISSIONS.VIEW_SALES) && (
    hasPermission(PERMISSIONS.CREATE_SALES) || hasPermission(PERMISSIONS.CREATE_SALES_REQUEST)
  );

  const lead = useQuery(
    api.leads.get,
    activeOrgId ? { orgId: activeOrgId, leadId } : "skip"
  );
  const relations = useQuery(
    api.customers.getRelations,
    activeOrgId && lead?.customerId && canViewCustomers
      ? { orgId: activeOrgId, customerId: lead.customerId }
      : "skip"
  );

  const leadTasks = useMemo(
    () => relations?.tasks?.filter((task) => task.leadId === leadId) ?? [],
    [leadId, relations]
  );
  const leadQuotes = useMemo(
    () => relations?.quotes?.filter((quote) => quote.leadId === leadId) ?? [],
    [leadId, relations]
  );
  const customer = lead?.customer;
  const vehicle = lead?.vehicle;
  const whatsAppUrl = customer
    ? buildWhatsAppDeepLink(
        customer.whatsapp || customer.phone || "",
        interpolate(t("LeadWhatsAppGreeting"), { name: customer.firstName })
      )
    : null;
  // eslint-disable-next-line react-hooks/purity -- Use one timestamp for every overdue badge in this render.
  const currentTime = Date.now();

  if (lead === undefined) {
    return <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">{t("LoadingLeadWorkspace")}</div>;
  }

  if (lead === null) {
    return <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">{t("LeadNotFound")}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.back()} aria-label={t("BackToLeads")}>
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{customer ? `${customer.firstName} ${customer.lastName}` : t("UnknownCustomer")}</h1>
              <Badge>{translateLeadStage(lead.stage, t)}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : t("NoVehicleSelected")} · {translateLeadSourceLabel(lead.source, locale)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {customer?.phone && <Button asChild variant="outline" size="sm"><a href={`tel:${customer.phone}`}><Phone className="h-4 w-4 me-2" />{t("Call")}</a></Button>}
          {whatsAppUrl && <Button asChild variant="outline" size="sm"><a href={whatsAppUrl} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4 me-2" />{t("WhatsApp")}</a></Button>}
          {customer?.email && <Button asChild variant="outline" size="sm"><a href={`mailto:${customer.email}`}><Mail className="h-4 w-4 me-2" />{t("Email")}</a></Button>}
          {canCreateQuote && vehicle && <Button variant="secondary" size="sm" onClick={() => router.push(`/${activeOrgId}/sales?leadId=${lead._id}&customerId=${lead.customerId}&vehicleId=${vehicle._id}`)}><FileText className="h-4 w-4 me-2" />{t("NewQuote")}</Button>}
          {canEdit && <Button size="sm" onClick={() => setIsEditOpen(true)}><Pencil className="h-4 w-4 me-2" />{t("EditLead")}</Button>}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">{t("Stage")}</p><p className="mt-1 font-medium">{translateLeadStage(lead.stage, t)}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">{t("LeadOwner")}</p><p className="mt-1 font-medium">{lead.assignedUser?.name || lead.assignedUser?.email || t("NoAssigned")}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">{t("CreatedAt")}</p><p className="mt-1 font-medium">{new Date(lead._creationTime).toLocaleDateString(localeCode)}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">{t("LeadLastActivity")}</p><p className="mt-1 font-medium">{new Date(lead.updatedAt ?? lead._creationTime).toLocaleDateString(localeCode)}</p></div>
      </div>

      <Tabs defaultValue="activity" className="rounded-xl border bg-card">
        <div className="overflow-x-auto border-b px-4">
          <TabsList className="h-12 w-max justify-start bg-transparent p-0">
            <TabsTrigger value="activity">{t("TimelineStageHistory")}</TabsTrigger>
            <TabsTrigger value="context">{t("CustomerVehicle")}</TabsTrigger>
            <TabsTrigger value="messages">{t("Messages")}</TabsTrigger>
            <TabsTrigger value="work">{t("TasksQuotes")}{(leadTasks.length + leadQuotes.length) > 0 && <Badge variant="secondary" className="ms-2">{leadTasks.length + leadQuotes.length}</Badge>}</TabsTrigger>
          </TabsList>
        </div>
        <div className="p-5">
          <TabsContent value="activity" className="m-0">
            <LeadActivityTrail orgId={activeOrgId!} leadId={lead._id} canAddUpdates={canEdit} />
          </TabsContent>
          <TabsContent value="context" className="m-0 grid gap-4 lg:grid-cols-2">
            <section className="rounded-lg border p-4">
              <h2 className="flex items-center gap-2 font-semibold"><User className="h-4 w-4" />{t("Customer")}</h2>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-xs text-muted-foreground">{t("Name")}</dt><dd>{customer ? `${customer.firstName} ${customer.lastName}` : "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("Phone")}</dt><dd>{customer?.phone || "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("Email")}</dt><dd className="truncate">{customer?.email || "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("Address")}</dt><dd>{customer?.address || "—"}</dd></div>
              </dl>
            </section>
            <section className="rounded-lg border p-4">
              <h2 className="flex items-center gap-2 font-semibold"><Car className="h-4 w-4" />{t("VehicleOfInterest")}</h2>
              {vehicle ? (
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-xs text-muted-foreground">{t("Vehicle")}</dt><dd>{vehicle.year} {vehicle.make} {vehicle.model}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t("VIN")}</dt><dd className="font-mono text-xs">{vehicle.vin || t("VinPending")}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t("Price")}</dt><dd>{vehicle.sellingPrice.toLocaleString(localeCode)} {t("JOD")}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t("Status")}</dt><dd>{translateVehicleStatus(vehicle.status, t)}</dd></div>
                </dl>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">{t("NoVehicleSelectedForLead")}</p>
              )}
            </section>
          </TabsContent>
          <TabsContent value="messages" className="m-0">
            <LeadCustomerMessages orgId={activeOrgId!} leadId={lead._id} />
          </TabsContent>
          <TabsContent value="work" className="m-0 grid gap-5 lg:grid-cols-2">
            <section>
              <h2 className="mb-3 flex items-center gap-2 font-semibold"><CheckSquare className="h-4 w-4" />{t("Tasks")}</h2>
              {leadTasks.length === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t("NoTasksLinkedToLead")}</p>
              ) : (
                <div className="space-y-2">
                  {leadTasks.map((task) => {
                    const overdue = task.status === "PENDING" && task.dueDate < currentTime;
                    return (
                      <div key={task._id} className="rounded-lg border p-3 text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-medium">{task.title}</p>
                          <Badge variant={overdue ? "destructive" : "outline"}>{overdue ? t("Overdue") : translateWorkflowStatus(task.status, t)}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{interpolate(t("DueDateLine"), {
                          date: new Date(task.dueDate).toLocaleString(localeCode),
                          assignee: task.assignedUserName || t("NoAssigned"),
                        })}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            <section>
              <h2 className="mb-3 flex items-center gap-2 font-semibold"><FileText className="h-4 w-4" />{t("Quotes")}</h2>
              {leadQuotes.length === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t("NoQuotesLinkedToLead")}</p>
              ) : (
                <div className="space-y-2">
                  {leadQuotes.map((quote) => (
                    <div key={quote._id} className="rounded-lg border p-3 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium">{quote.vehicleDesc}</p>
                        <Badge variant="outline">{translateWorkflowStatus(quote.status, t)}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {quote.totalFinancedAmount?.toLocaleString(localeCode) ?? quote.vehiclePrice?.toLocaleString(localeCode) ?? "—"} {t("JOD")} · {new Date(quote.createdAt).toLocaleDateString(localeCode)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </TabsContent>
        </div>
      </Tabs>

      <LeadDialog open={isEditOpen} onOpenChange={setIsEditOpen} lead={lead} />
    </div>
  );
}
