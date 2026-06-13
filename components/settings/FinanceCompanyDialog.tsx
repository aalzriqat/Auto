"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Id } from "@/convex/_generated/dataModel";

export function FinanceCompanyDialog({
  open,
  onOpenChange,
  company,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company?: {
    _id: Id<"financeCompanies">;
    name: string;
    profitRate: number;
    maxTermMonths: number;
    gracePeriodMonths: number;
    insuranceRate?: number;
    adminFees?: number;
    includesCommissionInDebt?: boolean;
    maxFinancingLTV?: number;
    isActive: boolean;
  };
}) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  
  const createCompany = useMutation(api.finance.createCompany);
  const updateCompany = useMutation(api.finance.updateCompany);

  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: company?.name || "",
    profitRate: company?.profitRate || 0,
    maxTermMonths: company?.maxTermMonths || 72,
    gracePeriodMonths: company?.gracePeriodMonths || 0,
    insuranceRate: company?.insuranceRate || 0,
    adminFees: company?.adminFees || 0,
    includesCommissionInDebt: company?.includesCommissionInDebt || false,
    maxFinancingLTV: company?.maxFinancingLTV || 100,
    isActive: company?.isActive ?? true,
  });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrgId) return;

    setIsLoading(true);
    try {
      if (company) {
        await updateCompany({
          id: company._id,
          orgId: activeOrgId,
          ...formData,
        });
        toast.success(t("CompanyUpdatedSuccess" as any));
      } else {
        await createCompany({
          orgId: activeOrgId,
          ...formData,
        });
        toast.success(t("CompanyCreatedSuccess" as any));
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || t("AnErrorOccurred" as any));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>
            {company ? t("Edit Company" as any) : t("Add Company" as any)}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4 pt-4">
          <div className="grid gap-2">
            <Label>{t("Company Name" as any)}</Label>
            <Input
              required
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>{t("Profit Rate" as any)}</Label>
              <Input
                type="number"
                step="0.01"
                required
                value={formData.profitRate}
                onChange={(e) => setFormData({ ...formData, profitRate: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("Max Term (Months)" as any)}</Label>
              <Input
                type="number"
                required
                value={formData.maxTermMonths}
                onChange={(e) => setFormData({ ...formData, maxTermMonths: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>{t("Grace Period (Months)" as any)}</Label>
              <Input
                type="number"
                required
                value={formData.gracePeriodMonths}
                onChange={(e) => setFormData({ ...formData, gracePeriodMonths: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("Insurance Rate" as any)}</Label>
              <Input
                type="number"
                step="0.01"
                value={formData.insuranceRate}
                onChange={(e) => setFormData({ ...formData, insuranceRate: parseFloat(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>{t("Admin Fees" as any)}</Label>
              <Input
                type="number"
                value={formData.adminFees}
                onChange={(e) => setFormData({ ...formData, adminFees: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("MaxFinancingLTV" as any)}</Label>
              <Input
                type="number"
                step="1"
                value={formData.maxFinancingLTV}
                onChange={(e) => setFormData({ ...formData, maxFinancingLTV: parseFloat(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div className="flex flex-col gap-3 pt-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="includesCommissionInDebt"
                className="w-4 h-4"
                checked={formData.includesCommissionInDebt}
                onChange={(e) => setFormData({ ...formData, includesCommissionInDebt: e.target.checked })}
              />
              <Label htmlFor="includesCommissionInDebt">{t("CapitalizesCommissionIntoDebt" as any)}</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isActive"
                className="w-4 h-4"
                checked={formData.isActive}
                onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
              />
              <Label htmlFor="isActive">{t("Is Active" as any)}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("Cancel" as any)}
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? t("Saving..." as any) : t("Save" as any)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
