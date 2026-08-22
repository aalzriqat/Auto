"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileText, Eye, Search, LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { format } from "date-fns";
import { ApplicationDetailsDialog } from "@/components/applications/ApplicationDetailsDialog";
import { useTableControls } from "@/hooks/useTableControls";
import { SortableColumnHeader } from "@/components/ui/sortable-column-header";

type ApplicationBadgeVariant = "default" | "secondary" | "destructive" | "outline";

export function ApplicationClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const { results: applications, status: applicationsStatus, loadMore: loadMoreApplications } = usePaginatedQuery(api.applications.list, activeOrgId ? { orgId: activeOrgId } : "skip", { initialNumItems: 100 });

  const [selectedAppId, setSelectedAppId] = useState<any>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // `confirmDisbursement` — the only mutation that settles finance-company AR —
  // lives in this dialog, and the dialog used to be reachable only by finding
  // the row and clicking it. Accounting's finance-company AR queue reports the
  // outstanding balance but deliberately cannot settle it, so it needs to send
  // the accountant to the door that can; a link is only an answer if it opens.
  //
  // The parameter is arbitrary URL input, so it is resolved server-side before
  // anything mounts: handing a raw string to a `v.id()` query argument throws
  // an argument-validation error into the React tree, and `?application=garbage`
  // would take the page down instead of simply showing nothing.
  const searchParams = useSearchParams();
  const candidateApplicationId = searchParams.get("application");
  const resolvedApplicationId = useQuery(
    api.applications.resolveApplicationId,
    activeOrgId && candidateApplicationId
      ? { orgId: activeOrgId, candidateId: candidateApplicationId }
      : "skip"
  );
  useEffect(() => {
    // Only drives the dialog while a candidate is in the URL. Navigating the
    // parameter away must not leave the previous deal on screen, but with no
    // candidate at all this must keep its hands off the row-click path.
    if (!candidateApplicationId) return;
    if (!resolvedApplicationId) {
      setIsDialogOpen(false);
      setSelectedAppId(null);
      return;
    }
    setSelectedAppId(resolvedApplicationId);
    setIsDialogOpen(true);
  }, [candidateApplicationId, resolvedApplicationId]);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const statusValueFor = (app: { status: string; hasPendingDepositResolution?: boolean }) =>
    app.hasPendingDepositResolution ? "DEPOSIT_PENDING" : app.status;
  const statusLabelForValue = (status: string) => {
    switch (status) {
      case "DEPOSIT_PENDING":
        return t("DepositPending");
      case "PENDING_DOCS":
        return t("PendingDocs");
      case "UNDER_REVIEW":
        return t("UnderReview");
      case "APPROVED":
        return t("Approved");
      case "REJECTED":
        return t("Rejected");
      case "CLOSED":
        return t("Closed");
      case "CANCELLED":
        return t("Cancelled");
      default:
        return status;
    }
  };
  const statusLabelFor = (app: { status: string; hasPendingDepositResolution?: boolean }) =>
    statusLabelForValue(statusValueFor(app));
  const badgeVariantFor = (app: { status: string; hasPendingDepositResolution?: boolean }): ApplicationBadgeVariant => {
    if (statusValueFor(app) === "DEPOSIT_PENDING") return "outline";
    if (app.status === "APPROVED") return "default";
    if (app.status === "REJECTED" || app.status === "CANCELLED") return "destructive";
    if (app.status === "UNDER_REVIEW") return "secondary";
    return "outline";
  };

  const {
    search: searchQuery,
    setSearch: setSearchQuery,
    sortKey,
    sortDir,
    toggleSort,
    rows: sortedApplications,
  } = useTableControls({
    data: applications,
    searchFields: (app) => [app.customerName, app.vehicleDesc, app.companyName],
    sortAccessors: {
      amount: (app) => app.financedAmount,
      date: (app) => app.createdAt,
      status: (app) => statusValueFor(app),
    },
    pagination: { status: applicationsStatus, loadMore: loadMoreApplications, batchSize: 100 },
  });

  const statusOptions = Array.from(new Set((applications ?? []).map((app) => statusValueFor(app))));

  const filteredApplications = sortedApplications?.filter(
    (app) => statusFilter === "ALL" || statusValueFor(app) === statusFilter
  );

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t("ActiveApplications" as any)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-2 mb-4">
            <div className="flex items-center w-full max-w-sm space-x-2 relative">
              <Search className="h-4 w-4 text-muted-foreground absolute ms-3" />
              <Input
                placeholder={t("Search" as any)}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ps-9"
              />
            </div>
            {statusOptions.length > 0 && (
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue placeholder={t("Status" as any)} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t("AllStatuses" as any)}</SelectItem>
                  {statusOptions.map((status) => (
                    <SelectItem key={status} value={status}>{statusLabelForValue(status)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Customer" as any)}</TableHead>
                  <TableHead>{t("Vehicle" as any)}</TableHead>
                  <TableHead>{t("Company" as any)}</TableHead>
                  <SortableColumnHeader label={t("Amount" as any)} sortKey="amount" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableColumnHeader label={t("Status" as any)} sortKey="status" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableColumnHeader label={t("Date" as any)} sortKey="date" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <TableHead>{t("Employee" as any)}</TableHead>
                  <TableHead className="text-right">{t("Actions" as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredApplications === undefined ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center">{t("LoadingApplications" as any)}</TableCell>
                  </TableRow>
                ) : filteredApplications.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      {t("NoApplicationsFound" as any)}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredApplications.map((app) => (
                    <TableRow key={app._id}>
                      <TableCell className="font-medium">{app.customerName}</TableCell>
                      <TableCell>{app.vehicleDesc}</TableCell>
                      {/* A real financier name renders as itself; the cases
                          with no name to show come back as a key so they read
                          in the operator's own language. */}
                      <TableCell>
                        {app.companyLabelKey ? t(app.companyLabelKey as any) : app.companyName}
                      </TableCell>
                      <TableCell>{app.financedAmount.toLocaleString()} {t("JOD" as any)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={badgeVariantFor(app)}
                          className={statusValueFor(app) === "DEPOSIT_PENDING" ? "border-amber-500/60 bg-amber-500/10 text-amber-700" : ""}
                        >
                          {statusLabelFor(app)}
                        </Badge>
                      </TableCell>
                      <TableCell>{format(app.createdAt, "PP")}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{app.salespersonName}</TableCell>
                      <TableCell className="text-right">
                        {/* The dialog stays the review surface — approving,
                            documents, disbursement. The cockpit is the deal's
                            own page: where it stands, what it is worth, and who
                            holds the money. Two jobs, so two entry points
                            rather than one dialog that grew a second identity. */}
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/${activeOrgId}/applications/${app._id}/deal`}>
                            <LayoutDashboard className="h-4 w-4 me-2" />
                            {t("DealCockpitTitle")}
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelectedAppId(app._id);
                            setIsDialogOpen(true);
                          }}
                        >
                          <Eye className="h-4 w-4 me-2" />
                          {t("ReviewApp" as any)}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {selectedAppId && (
        <ApplicationDetailsDialog
          applicationId={selectedAppId}
          open={isDialogOpen}
          onOpenChange={setIsDialogOpen}
        />
      )}
    </div>
  );
}
