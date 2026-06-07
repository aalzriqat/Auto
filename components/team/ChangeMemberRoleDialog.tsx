import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ChangeMemberRoleDialog({
  member,
  open,
  onOpenChange,
}: {
  member: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  
  const updateRole = useMutation(api.memberships.updateRole);
  const roles = useQuery(api.roles.list, activeOrgId ? { orgId: activeOrgId } : "skip");

  const [selectedRoleId, setSelectedRoleId] = useState<string>(member?.roleId || "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSave = async () => {
    if (!activeOrgId || !member || !selectedRoleId) return;
    
    setIsSubmitting(true);
    try {
      await updateRole({
        orgId: activeOrgId,
        membershipId: member._id,
        newRoleId: selectedRoleId as any,
      });
      toast.success(t("RoleUpdated" as any) || "Member's role updated successfully");
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to update member's role");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ChangeRole" as any) || "Change Role"} - {member?.userName}</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>{t("SelectNewRole" as any) || "Select New Role"}</Label>
            <Select 
              value={selectedRoleId} 
              onValueChange={setSelectedRoleId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                {roles?.map((role) => (
                  <SelectItem key={role._id} value={role._id}>
                    {t(role.name as any) || role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("Cancel" as any) || "Cancel"}
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting || selectedRoleId === member?.roleId}>
            {isSubmitting ? "Saving..." : (t("Save" as any) || "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
