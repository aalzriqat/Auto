import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

interface GuarantorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: Id<"customers">;
  guarantor?: any; // null for create, object for edit
}

export function GuarantorDialog({ open, onOpenChange, customerId, guarantor }: GuarantorDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const addGuarantor = useMutation(api.guarantors.add);
  const updateGuarantor = useMutation(api.guarantors.update);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    nationalId: "",
    phone: "",
    relationship: "",
    income: 0,
  });

  useEffect(() => {
    if (guarantor) {
      setFormData({
        firstName: guarantor.firstName || "",
        lastName: guarantor.lastName || "",
        nationalId: guarantor.nationalId || "",
        phone: guarantor.phone || "",
        relationship: guarantor.relationship || "",
        income: guarantor.income || 0,
      });
    } else {
      setFormData({
        firstName: "",
        lastName: "",
        nationalId: "",
        phone: "",
        relationship: "",
        income: 0,
      });
    }
  }, [guarantor, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrgId) return;

    if (!formData.firstName || !formData.lastName || !formData.nationalId || !formData.phone) {
      toast.error("Please fill in all required fields.");
      return;
    }

    setIsSubmitting(true);
    try {
      if (guarantor) {
        await updateGuarantor({
          orgId: activeOrgId,
          guarantorId: guarantor._id,
          firstName: formData.firstName,
          lastName: formData.lastName,
          nationalId: formData.nationalId,
          phone: formData.phone,
          relationship: formData.relationship,
          income: formData.income,
        });
        toast.success("Guarantor updated successfully");
      } else {
        await addGuarantor({
          orgId: activeOrgId,
          customerId,
          firstName: formData.firstName,
          lastName: formData.lastName,
          nationalId: formData.nationalId,
          phone: formData.phone,
          relationship: formData.relationship,
          income: formData.income,
        });
        toast.success("Guarantor added successfully");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "An error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{guarantor ? "Edit Guarantor" : "Add Guarantor"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>First Name <span className="text-red-500">*</span></Label>
              <Input
                required
                value={formData.firstName}
                onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Last Name <span className="text-red-500">*</span></Label>
              <Input
                required
                value={formData.lastName}
                onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
              />
            </div>
          </div>
          
          <div className="space-y-2">
            <Label>National ID <span className="text-red-500">*</span></Label>
            <Input
              required
              value={formData.nationalId}
              onChange={(e) => setFormData({ ...formData, nationalId: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>Phone Number <span className="text-red-500">*</span></Label>
            <Input
              required
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Relationship</Label>
              <Input
                placeholder="e.g. Brother, Friend"
                value={formData.relationship}
                onChange={(e) => setFormData({ ...formData, relationship: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Income (JOD)</Label>
              <Input
                type="number"
                value={formData.income || ""}
                onChange={(e) => setFormData({ ...formData, income: parseFloat(e.target.value) || 0 })}
              />
            </div>
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
