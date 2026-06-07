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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

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
      toast.error("Document name is required");
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
      toast.success("Rule added successfully");
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to add rule");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add Document Rule</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Document Name <span className="text-red-500">*</span></Label>
            <Input
              required
              placeholder="e.g. Salary Certificate"
              value={formData.documentName}
              onChange={(e) => setFormData({ ...formData, documentName: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>Applies To</Label>
            <Select
              value={formData.companyId}
              onValueChange={(value) => setFormData({ ...formData, companyId: value })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="GLOBAL">All Finance Companies</SelectItem>
                {companies?.map(c => (
                  <SelectItem key={c._id} value={c._id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Description (Optional)</Label>
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
              <Label htmlFor="isRequired">Is this document strictly required?</Label>
            </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
