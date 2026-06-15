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
import { toast } from "@/components/ui/sonner";
import { SearchableSelect } from "@/components/ui/searchable-select";

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
      toast.success(t("RoleUpdatedSuccess" as any));
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || t("RoleUpdateFail" as any));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ChangeRole" as any)} - {member?.userName}</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>{t("SelectNewRole" as any)}</Label>
            <SearchableSelect
              value={selectedRoleId}
              onValueChange={setSelectedRoleId}
              placeholder={t("SelectARole" as any)}
              options={roles?.map((role) => ({
                value: role._id,
                label: t(role.name as any) || role.name,
              })) ?? []}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("Cancel" as any)}
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting || selectedRoleId === member?.roleId}>
            {isSubmitting ? t("Saving" as any) : t("Save" as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
