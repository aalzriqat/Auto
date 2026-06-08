"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Plus, Pencil, Trash2 } from "lucide-react";
import { FinanceCompanyDialog } from "@/components/settings/FinanceCompanyDialog";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Id } from "@/convex/_generated/dataModel";
import { DocumentRuleDialog } from "@/components/settings/DocumentRuleDialog";
import { FileCheck } from "lucide-react";

export default function FinanceCompaniesPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  
  const companies = useQuery(api.finance.listCompanies, activeOrgId ? { orgId: activeOrgId } : "skip");
  const deleteCompany = useMutation(api.finance.deleteCompany);
  
  const rules = useQuery(api.documents.listRules, activeOrgId ? { orgId: activeOrgId } : "skip");
  const removeRule = useMutation(api.documents.removeRule);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isRuleDialogOpen, setIsRuleDialogOpen] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState<any>(undefined);

  const handleDelete = async (id: Id<"financeCompanies">) => {
    if (!activeOrgId) return;
    if (confirm(t("DeleteCompanyConfirm" as any))) {
      try {
        await deleteCompany({ id, orgId: activeOrgId });
        toast.success(t("CompanyDeletedSuccess" as any));
      } catch (error: any) {
        toast.error(error.message || t("DeleteFail" as any));
      }
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4">
        <Button onClick={() => {
            setSelectedCompany(undefined);
            setIsDialogOpen(true);
          }}>
            <Plus className="mr-2 h-4 w-4" />
            {t("Add Company" as any)}
          </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            {t("Finance Companies" as any)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Company Name" as any)}</TableHead>
                  <TableHead>{t("Profit Rate" as any)}</TableHead>
                  <TableHead>{t("Max Term (Months)" as any)}</TableHead>
                  <TableHead>{t("Grace Period (Months)" as any)}</TableHead>
                  <TableHead>{t("Status" as any)}</TableHead>
                  <TableHead className="text-right">{t("Actions" as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {companies === undefined ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center">{t("Loading" as any)}</TableCell>
                  </TableRow>
                ) : companies.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      {t("NoFinanceCompaniesFound" as any)}
                    </TableCell>
                  </TableRow>
                ) : (
                  companies.map((company) => (
                    <TableRow key={company._id}>
                      <TableCell className="font-medium">{company.name}</TableCell>
                      <TableCell>{company.profitRate}%</TableCell>
                      <TableCell>{company.maxTermMonths}</TableCell>
                      <TableCell>{company.gracePeriodMonths}</TableCell>
                      <TableCell>
                        <Badge variant={company.isActive ? "default" : "secondary"}>
                          {company.isActive ? t("Active" as any) : t("Inactive" as any)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setSelectedCompany(company);
                            setIsDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-red-500 hover:text-red-600"
                          onClick={() => handleDelete(company._id)}
                        >
                          <Trash2 className="h-4 w-4" />
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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="flex items-center gap-2">
            <FileCheck className="h-5 w-5" />
            {t("Document Requirements" as any)}
          </CardTitle>
          <Button size="sm" onClick={() => setIsRuleDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t("Add Rule" as any)}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Document Name" as any)}</TableHead>
                  <TableHead>{t("Applies To" as any)}</TableHead>
                  <TableHead>{t("Required" as any)}</TableHead>
                  <TableHead className="text-right">{t("Actions" as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules === undefined ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center">{t("Loading" as any)}</TableCell>
                  </TableRow>
                ) : rules.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      {t("No document rules defined." as any)}
                    </TableCell>
                  </TableRow>
                ) : (
                  rules.map((rule) => {
                    const company = rule.companyId ? companies?.find(c => c._id === rule.companyId) : null;
                    return (
                      <TableRow key={rule._id}>
                        <TableCell className="font-medium">{rule.documentName}</TableCell>
                        <TableCell>
                          {rule.companyId ? (
                            <Badge variant="outline">{company?.name || t("UnknownCompany" as any)}</Badge>
                          ) : (
                            <Badge>{t("AllCompanies" as any)}</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={rule.isRequired ? "default" : "secondary"}>
                            {rule.isRequired ? t("YesText" as any) : t("NoText" as any)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-red-500 hover:text-red-600"
                            onClick={async () => {
                              if (confirm(t("RemoveRuleConfirm" as any))) {
                                await removeRule({ orgId: activeOrgId!, ruleId: rule._id });
                                toast.success(t("RuleRemovedSuccess" as any));
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <FinanceCompanyDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        company={selectedCompany}
      />

      <DocumentRuleDialog
        open={isRuleDialogOpen}
        onOpenChange={setIsRuleDialogOpen}
      />
    </div>
  );
}
