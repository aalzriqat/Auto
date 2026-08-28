"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { ArrowLeft, Car, CheckSquare, FileText, Mail, MessageCircle, Pencil, Phone, User } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useOrg } from "@/components/providers/OrgProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { buildWhatsAppDeepLink } from "@/lib/whatsappDeepLink";
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
    ? buildWhatsAppDeepLink(customer.whatsapp || customer.phone || "", `Hello ${customer.firstName}`)
    : null;
  // eslint-disable-next-line react-hooks/purity -- Use one timestamp for every overdue badge in this render.
  const currentTime = Date.now();

  if (lead === undefined) {
    return <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">Loading lead workspace…</div>;
  }

  if (lead === null) {
    return <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">Lead not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.back()} aria-label="Back to leads">
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{customer ? `${customer.firstName} ${customer.lastName}` : "Unknown customer"}</h1>
              <Badge>{lead.stage.replaceAll("_", " ")}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "No vehicle selected"} · {lead.source}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {customer?.phone && <Button asChild variant="outline" size="sm"><a href={`tel:${customer.phone}`}><Phone className="h-4 w-4 me-2" />Call</a></Button>}
          {whatsAppUrl && <Button asChild variant="outline" size="sm"><a href={whatsAppUrl} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4 me-2" />WhatsApp</a></Button>}
          {customer?.email && <Button asChild variant="outline" size="sm"><a href={`mailto:${customer.email}`}><Mail className="h-4 w-4 me-2" />Email</a></Button>}
          {canCreateQuote && vehicle && <Button variant="secondary" size="sm" onClick={() => router.push(`/${activeOrgId}/sales?leadId=${lead._id}&customerId=${lead.customerId}&vehicleId=${vehicle._id}`)}><FileText className="h-4 w-4 me-2" />New quote</Button>}
          {canEdit && <Button size="sm" onClick={() => setIsEditOpen(true)}><Pencil className="h-4 w-4 me-2" />Edit lead</Button>}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">Stage</p><p className="mt-1 font-medium">{lead.stage.replaceAll("_", " ")}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">Owner</p><p className="mt-1 font-medium">{lead.assignedUser?.name || lead.assignedUser?.email || "Unassigned"}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">Created</p><p className="mt-1 font-medium">{new Date(lead._creationTime).toLocaleDateString()}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">Last activity</p><p className="mt-1 font-medium">{new Date(lead.updatedAt ?? lead._creationTime).toLocaleDateString()}</p></div>
      </div>

      <Tabs defaultValue="activity" className="rounded-xl border bg-card">
        <div className="overflow-x-auto border-b px-4">
          <TabsList className="h-12 w-max justify-start bg-transparent p-0">
            <TabsTrigger value="activity">Timeline & stage history</TabsTrigger>
            <TabsTrigger value="context">Customer & vehicle</TabsTrigger>
            <TabsTrigger value="messages">Messages</TabsTrigger>
            <TabsTrigger value="work">Tasks & quotes{(leadTasks.length + leadQuotes.length) > 0 && <Badge variant="secondary" className="ms-2">{leadTasks.length + leadQuotes.length}</Badge>}</TabsTrigger>
          </TabsList>
        </div>
        <div className="p-5">
          <TabsContent value="activity" className="m-0">
            <LeadActivityTrail orgId={activeOrgId!} leadId={lead._id} canAddUpdates={canEdit} />
          </TabsContent>
          <TabsContent value="context" className="m-0 grid gap-4 lg:grid-cols-2">
            <section className="rounded-lg border p-4">
              <h2 className="flex items-center gap-2 font-semibold"><User className="h-4 w-4" />Customer</h2>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-xs text-muted-foreground">Name</dt><dd>{customer ? `${customer.firstName} ${customer.lastName}` : "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Phone</dt><dd>{customer?.phone || "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Email</dt><dd className="truncate">{customer?.email || "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Address</dt><dd>{customer?.address || "—"}</dd></div>
              </dl>
            </section>
            <section className="rounded-lg border p-4">
              <h2 className="flex items-center gap-2 font-semibold"><Car className="h-4 w-4" />Vehicle interest</h2>
              {vehicle ? (
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-xs text-muted-foreground">Vehicle</dt><dd>{vehicle.year} {vehicle.make} {vehicle.model}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">VIN</dt><dd className="font-mono text-xs">{vehicle.vin || "Pending"}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Price</dt><dd>{vehicle.sellingPrice.toLocaleString()} JOD</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Status</dt><dd>{vehicle.status}</dd></div>
                </dl>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">No vehicle has been selected for this lead.</p>
              )}
            </section>
          </TabsContent>
          <TabsContent value="messages" className="m-0">
            <LeadCustomerMessages orgId={activeOrgId!} leadId={lead._id} />
          </TabsContent>
          <TabsContent value="work" className="m-0 grid gap-5 lg:grid-cols-2">
            <section>
              <h2 className="mb-3 flex items-center gap-2 font-semibold"><CheckSquare className="h-4 w-4" />Tasks</h2>
              {leadTasks.length === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No tasks linked to this lead.</p>
              ) : (
                <div className="space-y-2">
                  {leadTasks.map((task) => {
                    const overdue = task.status === "PENDING" && task.dueDate < currentTime;
                    return (
                      <div key={task._id} className="rounded-lg border p-3 text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-medium">{task.title}</p>
                          <Badge variant={overdue ? "destructive" : "outline"}>{overdue ? "Overdue" : task.status}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">Due {new Date(task.dueDate).toLocaleString()} · {task.assignedUserName}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            <section>
              <h2 className="mb-3 flex items-center gap-2 font-semibold"><FileText className="h-4 w-4" />Quotes</h2>
              {leadQuotes.length === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No quotes linked to this lead.</p>
              ) : (
                <div className="space-y-2">
                  {leadQuotes.map((quote) => (
                    <div key={quote._id} className="rounded-lg border p-3 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium">{quote.vehicleDesc}</p>
                        <Badge variant="outline">{quote.status}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {quote.totalFinancedAmount?.toLocaleString() ?? quote.vehiclePrice?.toLocaleString() ?? "—"} JOD · {new Date(quote.createdAt).toLocaleDateString()}
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
