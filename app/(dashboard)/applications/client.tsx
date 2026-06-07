"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
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

  const applications = useQuery(api.applications.list, activeOrgId ? { orgId: activeOrgId } : "skip");

  const [selectedAppId, setSelectedAppId] = useState<any>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t("ActiveApplications" as any) || "Active Applications"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Customer" as any) || "Customer"}</TableHead>
                  <TableHead>{t("Vehicle" as any) || "Vehicle"}</TableHead>
                  <TableHead>{t("Company" as any) || "Company"}</TableHead>
                  <TableHead>{t("Amount" as any) || "Amount"}</TableHead>
                  <TableHead>{t("Status" as any) || "Status"}</TableHead>
                  <TableHead>{t("Date" as any) || "Date"}</TableHead>
                  <TableHead className="text-right">{t("Actions" as any) || "Actions"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {applications === undefined ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center">{t("LoadingApplications" as any) || "Loading..."}</TableCell>
                  </TableRow>
                ) : applications.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      {t("NoApplicationsFound" as any) || "No applications found."}
                    </TableCell>
                  </TableRow>
                ) : (
                  applications.map((app) => (
                    <TableRow key={app._id}>
                      <TableCell className="font-medium">{app.customerName}</TableCell>
                      <TableCell>{app.vehicleDesc}</TableCell>
                      <TableCell>{app.companyName}</TableCell>
                      <TableCell>{app.financedAmount.toLocaleString()} {t("JOD" as any) || "JOD"}</TableCell>
                      <TableCell>
                        <Badge variant={
                          app.status === "APPROVED" ? "default" :
                          app.status === "REJECTED" ? "destructive" :
                          app.status === "UNDER_REVIEW" ? "secondary" : "outline"
                        }>
                          {app.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{format(app.createdAt, "PP")}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelectedAppId(app._id);
                            setIsDialogOpen(true);
                          }}
                        >
                          <Eye className="h-4 w-4 mr-2" />
                          {t("ReviewApp" as any) || "Review"}
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
