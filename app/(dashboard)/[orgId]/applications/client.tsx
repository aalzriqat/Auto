"use client";

import { useState } from "react";
import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText, Eye } from "lucide-react";
import { format } from "date-fns";
import { ApplicationDetailsDialog } from "@/components/applications/ApplicationDetailsDialog";

export function ApplicationClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const { results: applications } = usePaginatedQuery(api.applications.list, activeOrgId ? { orgId: activeOrgId } : "skip", { initialNumItems: 100 });

  const [selectedAppId, setSelectedAppId] = useState<any>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

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
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Customer" as any)}</TableHead>
                  <TableHead>{t("Vehicle" as any)}</TableHead>
                  <TableHead>{t("Company" as any)}</TableHead>
                  <TableHead>{t("Amount" as any)}</TableHead>
                  <TableHead>{t("Status" as any)}</TableHead>
                  <TableHead>{t("Date" as any)}</TableHead>
                  <TableHead>{t("Employee" as any)}</TableHead>
                  <TableHead className="text-right">{t("Actions" as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {applications === undefined ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center">{t("LoadingApplications" as any)}</TableCell>
                  </TableRow>
                ) : applications.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      {t("NoApplicationsFound" as any)}
                    </TableCell>
                  </TableRow>
                ) : (
                  applications.map((app) => (
                    <TableRow key={app._id}>
                      <TableCell className="font-medium">{app.customerName}</TableCell>
                      <TableCell>{app.vehicleDesc}</TableCell>
                      <TableCell>{app.companyName}</TableCell>
                      <TableCell>{app.financedAmount.toLocaleString()} {t("JOD" as any)}</TableCell>
                      <TableCell>
                        <Badge variant={
                          app.status === "APPROVED" ? "default" :
                          app.status === "REJECTED" || app.status === "CANCELLED" ? "destructive" :
                          app.status === "UNDER_REVIEW" ? "secondary" : "outline"
                        }>
                          {app.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{format(app.createdAt, "PP")}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{app.salespersonName}</TableCell>
                      <TableCell className="text-right">
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
