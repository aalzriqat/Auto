import { useState, useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toast } from "@/components/ui/sonner";

interface DocumentRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DocumentRuleDialog({ open, onOpenChange }: DocumentRuleDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const addRule = useMutation(api.documents.addRule);
  const companies = useQuery(api.finance.listCompanies, activeOrgId ? { orgId: activeOrgId } : "skip");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    documentName: "",
    isRequired: true,
    companyId: "GLOBAL" as string,
    description: "",
  });

  useEffect(() => {
    if (!open) {
      setFormData({
        documentName: "",
        isRequired: true,
        companyId: "GLOBAL",
        description: "",
      });
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrgId) return;

    if (!formData.documentName) {
      toast.error(t("DocumentNameRequired" as any));
      return;
    }

    setIsSubmitting(true);
    try {
      await addRule({
        orgId: activeOrgId,
        companyId: formData.companyId === "GLOBAL" ? undefined : formData.companyId as Id<"financeCompanies">,
        documentName: formData.documentName,
        isRequired: formData.isRequired,
        description: formData.description,
      });
      toast.success(t("RuleAddedSuccess" as any));
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || t("RuleAddFail" as any));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t("Add Document Rule" as any)}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>{t("Document Name" as any)} <span className="text-red-500">*</span></Label>
            <Input
              required
              placeholder={t("e.g. Salary Certificate" as any)}
              value={formData.documentName}
              onChange={(e) => setFormData({ ...formData, documentName: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("Applies To" as any)}</Label>
            <SearchableSelect
              value={formData.companyId}
              onValueChange={(value) => setFormData({ ...formData, companyId: value })}
              placeholder={t("Select scope" as any)}
              options={[
                { value: "GLOBAL", label: t("All Finance Companies" as any) },
                ...(companies?.map(c => ({ value: c._id, label: c.name })) ?? []),
              ]}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("Description (Optional)" as any)}</Label>
            <Input
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            />
          </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isRequired"
                checked={formData.isRequired}
                onChange={(e) => setFormData({ ...formData, isRequired: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              />
              <Label htmlFor="isRequired">{t("Is this document strictly required?" as any)}</Label>
            </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("Cancel" as any)}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t("Saving..." as any) : t("Save" as any)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
