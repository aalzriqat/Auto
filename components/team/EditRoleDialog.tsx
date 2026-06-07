import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
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
import { RolePermissionsEditor } from "@/components/team/RolePermissionsEditor";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";

export function EditRoleDialog({
  role,
  open,
  onOpenChange,
}: {
  role: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  
  const updateRole = useMutation(api.roles.update);

  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (role) {
      setName(t(role.name as any) || role.name);
      setPermissions(role.permissions || []);
    }
  }, [role]);

  const handleSave = async () => {
    if (!activeOrgId || !role) return;
    
    setIsSubmitting(true);
    try {
      await updateRole({
        orgId: activeOrgId,
        roleId: role._id,
        name: role.name === "OWNER" ? undefined : name,
        permissions,
      });
      toast.success(t("RoleUpdated" as any) || "Role updated successfully");
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to update role");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle>{t("EditRole" as any) || "Edit Role"} - {t(role?.name as any) || role?.name}</DialogTitle>
        </DialogHeader>
        
        <ScrollArea className="flex-1 px-6 py-4">
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="role-name">{t("RoleName" as any) || "Role Name"}</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={role?.name === "OWNER"}
              />
              {role?.name === "OWNER" && (
                <p className="text-xs text-muted-foreground">{t("OwnerRoleCannotBeRenamed" as any) || "The OWNER role cannot be renamed."}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t("Permissions" as any) || "Permissions"}</Label>
              <RolePermissionsEditor 
                selectedPermissions={permissions}
                onChange={setPermissions}
              />
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="px-6 py-4 border-t bg-muted/50">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("Cancel" as any) || "Cancel"}
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : (t("Save" as any) || "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
