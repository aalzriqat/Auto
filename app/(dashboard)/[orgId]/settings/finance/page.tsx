"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Building2, Plus, Pencil, Trash2, ChevronUp, ChevronDown, Loader2, Tag } from "lucide-react";
import { FinanceCompanyDialog } from "@/components/settings/FinanceCompanyDialog";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Id } from "@/convex/_generated/dataModel";
import { DocumentRuleDialog } from "@/components/settings/DocumentRuleDialog";
import { FileCheck } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { translateCustomerStatusLabel } from "@/lib/i18n/defaultLabels";

export default function FinanceCompaniesPage() {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();

  const companies = useQuery(api.finance.listCompanies, activeOrgId ? { orgId: activeOrgId } : "skip");
  const deleteCompany = useMutation(api.finance.deleteCompany);

  const rules = useQuery(api.documents.listRules, activeOrgId ? { orgId: activeOrgId } : "skip");
  const removeRule = useMutation(api.documents.removeRule);

  const customerStatuses = useQuery(api.orgCustomerStatuses.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const seedStatuses = useMutation(api.orgCustomerStatuses.seed);
  const createStatus = useMutation(api.orgCustomerStatuses.create);
  const updateStatus = useMutation(api.orgCustomerStatuses.update);
  const removeStatus = useMutation(api.orgCustomerStatuses.remove);
  const reorderStatuses = useMutation(api.orgCustomerStatuses.reorder);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isRuleDialogOpen, setIsRuleDialogOpen] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState<any>(undefined);

  const [newStatusLabel, setNewStatusLabel] = useState("");
  const [isAddingStatus, setIsAddingStatus] = useState(false);
  const [showAddStatusInput, setShowAddStatusInput] = useState(false);

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

  const handleSeedStatuses = async () => {
    if (!activeOrgId) return;
    try {
      await seedStatuses({ orgId: activeOrgId });
      toast.success(t("DefaultStatusesLoaded" as any));
    } catch (error: any) {
      toast.error(error.message || t("DefaultStatusesLoadFail" as any));
    }
  };

  const handleAddStatus = async () => {
    if (!activeOrgId || !newStatusLabel.trim()) return;
    setIsAddingStatus(true);
    try {
      await createStatus({ orgId: activeOrgId, label: newStatusLabel.trim() });
      setNewStatusLabel("");
      setShowAddStatusInput(false);
      toast.success(t("CustomerStatusAdded" as any));
    } catch (error: any) {
      toast.error(error.message || t("CustomerStatusAddFail" as any));
    } finally {
      setIsAddingStatus(false);
    }
  };

  const handleToggleStatusActive = async (statusId: Id<"orgCustomerStatuses">, isActive: boolean) => {
    if (!activeOrgId) return;
    try {
      await updateStatus({ orgId: activeOrgId, statusId, isActive });
    } catch (error: any) {
      toast.error(error.message || t("CustomerStatusUpdateFail" as any));
    }
  };

  const handleDeleteStatus = async (statusId: Id<"orgCustomerStatuses">) => {
    if (!activeOrgId) return;
    if (!confirm(t("CustomerStatusDeleteConfirm" as any))) return;
    try {
      await removeStatus({ orgId: activeOrgId, statusId });
      toast.success(t("CustomerStatusDeleted" as any));
    } catch (error: any) {
      toast.error(error.message || t("CustomerStatusDeleteFail" as any));
    }
  };

  const handleMoveStatusUp = async (index: number) => {
    if (!activeOrgId || !customerStatuses || index === 0) return;
    const orderedIds = customerStatuses.map((s) => s._id);
    [orderedIds[index - 1], orderedIds[index]] = [orderedIds[index], orderedIds[index - 1]];
    try {
      await reorderStatuses({ orgId: activeOrgId, orderedIds });
    } catch (error: any) {
      toast.error(error.message || t("ReorderFail" as any));
    }
  };

  const handleMoveStatusDown = async (index: number) => {
    if (!activeOrgId || !customerStatuses || index === customerStatuses.length - 1) return;
    const orderedIds = customerStatuses.map((s) => s._id);
    [orderedIds[index], orderedIds[index + 1]] = [orderedIds[index + 1], orderedIds[index]];
    try {
      await reorderStatuses({ orgId: activeOrgId, orderedIds });
    } catch (error: any) {
      toast.error(error.message || t("ReorderFail" as any));
    }
  };

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4">
        <Button onClick={() => {
            setSelectedCompany(undefined);
            setIsDialogOpen(true);
          }}>
            <Plus className="me-2 h-4 w-4" />
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
          <div className="rounded-md border overflow-x-auto">
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
            <Plus className="me-2 h-4 w-4" />
            {t("Add Rule" as any)}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-x-auto">
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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Tag className="h-5 w-5" />
              {t("CustomerStatusesCardTitle" as any)}
            </CardTitle>
            <CardDescription className="mt-1">{t("CustomerStatusesCardDesc" as any)}</CardDescription>
          </div>
          <div className="flex gap-2 shrink-0">
            {customerStatuses !== undefined && customerStatuses.length === 0 && (
              <Button variant="outline" size="sm" onClick={handleSeedStatuses}>
                {t("LoadDefaults" as any)}
              </Button>
            )}
            <Button size="sm" onClick={() => setShowAddStatusInput(true)}>
              <Plus className="me-2 h-4 w-4" />
              {t("AddStatus" as any)}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {showAddStatusInput && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-dashed border-border bg-muted/30">
              <Input
                placeholder={t("StatusLabelPlaceholder" as any)}
                value={newStatusLabel}
                onChange={(e) => setNewStatusLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddStatus();
                  if (e.key === "Escape") { setShowAddStatusInput(false); setNewStatusLabel(""); }
                }}
                autoFocus
                className="flex-1"
              />
              <Button size="sm" onClick={handleAddStatus} disabled={isAddingStatus || !newStatusLabel.trim()}>
                {isAddingStatus ? <Loader2 className="h-4 w-4 animate-spin" /> : t("AddNew" as any)}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setShowAddStatusInput(false); setNewStatusLabel(""); }}>
                {t("Cancel" as any)}
              </Button>
            </div>
          )}

          {customerStatuses === undefined ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              {t("Loading" as any)}
            </div>
          ) : customerStatuses.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              {t("NoCustomerStatusesYet" as any)}
            </div>
          ) : (
            customerStatuses.map((status, index) => (
              <div
                key={status._id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="flex flex-col gap-0.5">
                  <button
                    onClick={() => handleMoveStatusUp(index)}
                    disabled={index === 0}
                    className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleMoveStatusDown(index)}
                    disabled={index === customerStatuses.length - 1}
                    className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>

                <span className="flex-1 text-sm font-medium">{translateCustomerStatusLabel(status.label, locale)}</span>

                <Switch
                  checked={status.isActive}
                  onCheckedChange={(checked) => handleToggleStatusActive(status._id, checked)}
                />

                <Button
                  variant="ghost"
                  size="icon"
                  className="text-red-500 hover:text-red-600 h-8 w-8"
                  onClick={() => handleDeleteStatus(status._id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
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
